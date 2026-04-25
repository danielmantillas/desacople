const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const MOD_FLAG = '/tmp/dscp_mod_active';
const isModActive = () => { try { return fs.existsSync(MOD_FLAG) && (Date.now()-parseInt(fs.readFileSync(MOD_FLAG,'utf8')))<7200000; } catch(e){ return false; } };
const setModActive = (v) => { try { if(v) fs.writeFileSync(MOD_FLAG,String(Date.now())); else fs.unlinkSync(MOD_FLAG); } catch(e){} };

const MOD_PASSWORD = 'desacople2025';
const TURN_MS = 60000; // 60 segundos por turno

const app = express();
const server = http.createServer(app);
const io = new Server(server, { transports: ['websocket', 'polling'], cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// Captura de errores para evitar crashes
process.on('uncaughtException', err => console.error('[CRASH]', err.message));
process.on('unhandledRejection', r => console.error('[REJECT]', String(r)));

// ── BANCO DE PALABRAS ─────────────────────────────────────────────────────────
const WORD_BANK = [
  { word: 'ecosistema',    hints: ['todo está conectado', 'red de vida interdependiente', 'empieza con E', '9 letras'] },
  { word: 'carbono',       hints: ['lo que emite un motor', 'huella que deja la industria', 'empieza con C', '7 letras'] },
  { word: 'resiliencia',   hints: ['no es resistir, es adaptarse', 'capacidad de recuperarse del daño', 'empieza con R', '11 letras'] },
  { word: 'biodiversidad', hints: ['no es solo naturaleza', 'variedad de formas de vida en un lugar', 'empieza con B', '13 letras'] },
  { word: 'territorio',    hints: ['donde ocurre todo', 'espacio vivido, no solo geográfico', 'empieza con T', '9 letras'] },
  { word: 'huella',        hints: ['lo que dejas al pasar', 'impacto medible sobre el ambiente', 'empieza con H', '6 letras'] },
  { word: 'restauracion',  hints: ['no es conservar, es devolver', 'proceso de recuperar lo dañado', 'empieza con R', '12 letras'] },
  { word: 'transicion',    hints: ['no es un destino, es un camino', 'cambio estructural hacia otro modelo', 'empieza con T', '10 letras'] },
  { word: 'campus',        hints: ['más que edificios', 'el territorio propio de la universidad', 'empieza con C', '6 letras'] },
  { word: 'residuos',      hints: ['lo que queda después', 'materiales sin uso que generamos', 'empieza con R', '8 letras'] },
  { word: 'comunidad',     hints: ['no es individuo', 'grupo que comparte un territorio', 'empieza con C', '9 letras'] },
  { word: 'gobernanza',    hints: ['no es solo gobierno', 'cómo se toman las decisiones colectivas', 'empieza con G', '10 letras'] },
  { word: 'compensacion',  hints: ['no es solución, es deuda', 'acción para equilibrar el daño causado', 'empieza con C', '12 letras'] },
  { word: 'compromiso',    hints: ['más que una promesa', 'obligación asumida voluntariamente', 'empieza con C', '10 letras'] },
  { word: 'neutralidad',   hints: ['el punto de equilibrio', 'cuando lo que emites equivale a lo que absorbes', 'empieza con N', '11 letras'] }
];

const ROLE_LABELS = { universidad:'Universidad', gobierno:'Gobierno Local', empresa:'Empresa', org_civil:'Org. Civil', comunidad:'Comunidad' };
const ROLE_COLORS = {
  universidad: { bg:'#B5D4F4', text:'#0C447C' },
  gobierno:    { bg:'#FAC775', text:'#633806' },
  empresa:     { bg:'#F4C0D1', text:'#72243E' },
  org_civil:   { bg:'#CECBF6', text:'#3C3489' },
  comunidad:   { bg:'#D3D1C7', text:'#444441' }
};

// ── ESTADO DEL JUEGO ──────────────────────────────────────────────────────────
function makeState() {
  return {
    phase: 'lobby',
    players: {}, teamA: [], teamB: [],
    scores: { A:0, B:0 },
    moderatorId: null,
    modActive: false,
    phase1: {
      wordsA:[], wordsB:[], idxA:0, idxB:0,
      guessedA:[], guessedB:[], queueA:[], queueB:[],
      turnA:{ mime:null, guesser:null }, turnB:{ mime:null, guesser:null },
      timerA:null, timerB:null, passesA:0, passesB:0, finA:false, finB:false
    },
    phase2: { declA:null, declB:null, autoA:false, autoB:false, timeA:180, timeB:180, finA:false, finB:false },
    phase3: {
      storyA:[], storyB:[], wordsA:[], wordsB:[], usedA:[], usedB:[],
      turnA:null, turnB:null, wordA:null, wordB:null,
      graph:[], passesA:0, passesB:0, timerA:null, timerB:null, finA:false, finB:false
    }
  };
}

let gs = makeState();

// ── HELPERS ───────────────────────────────────────────────────────────────────
function shuffle(a) { const r=[...a]; for(let i=r.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[r[i],r[j]]=[r[j],r[i]];} return r; }
function pick6() { return shuffle(WORD_BANK).slice(0,6).map(w=>w.word); }
function wordData(w) { return WORD_BANK.find(x=>x.word===w) || {word:w,hints:['pista 1','pista 2','empieza con '+w[0].toUpperCase(),w.length+' letras']}; }

function assignPlayerToTeam(socketId) {
  const a = gs.teamA.length, b = gs.teamB.length;
  const team = a <= b ? 'A' : 'B';
  const teamIds = team === 'A' ? gs.teamA : gs.teamB;
  const uniCount = teamIds.filter(id => gs.players[id]?.role === 'universidad').length;
  let role;
  if (uniCount === 0 && teamIds.length < 4) {
    role = 'universidad';
  } else {
    const others = ['gobierno','empresa','org_civil','comunidad'];
    const counts = {}; others.forEach(r => counts[r] = 0);
    teamIds.forEach(id => { const r = gs.players[id]?.role; if(counts[r]!==undefined) counts[r]++; });
    role = others.reduce((a,b) => counts[a] <= counts[b] ? a : b);
  }
  const c = ROLE_COLORS[role];
  gs.players[socketId].role = role;
  gs.players[socketId].roleLabel = ROLE_LABELS[role];
  gs.players[socketId].team = team;
  gs.players[socketId].color = c.bg;
  gs.players[socketId].textColor = c.text;
  if (team === 'A') gs.teamA.push(socketId);
  else gs.teamB.push(socketId);
}

function publicState() {
  const players = {};
  Object.entries(gs.players).forEach(([id,p]) => {
    players[id] = { id:p.id, name:p.name, role:p.role, roleLabel:p.roleLabel, team:p.team, initials:p.initials, color:p.color, textColor:p.textColor, isModerator:p.isModerator };
  });
  return { phase:gs.phase, players, teamA:gs.teamA, teamB:gs.teamB, scores:gs.scores };
}

// ── FASE 1 ────────────────────────────────────────────────────────────────────
function nextTurn(team) {
  const q = team==='A' ? gs.phase1.queueA : gs.phase1.queueB;
  if (!q.length) return;
  const mime = q.shift(); q.push(mime);
  const guesser = q[0];
  if (team==='A') gs.phase1.turnA = { mime, guesser };
  else gs.phase1.turnB = { mime, guesser };
}

function startTurn(team) {
  const p1 = gs.phase1;
  const tk = team==='A' ? 'timerA' : 'timerB';
  if (p1[tk]) clearTimeout(p1[tk]);
  const turn = team==='A' ? p1.turnA : p1.turnB;
  const idx = team==='A' ? p1.idxA : p1.idxB;
  const words = team==='A' ? p1.wordsA : p1.wordsB;
  const word = words[idx];
  const wd = wordData(word);
  const passes = team==='A' ? p1.passesA : p1.passesB;

  console.log(`[TURN] Equipo ${team} | mime:${gs.players[turn.mime]?.name} guesser:${gs.players[turn.guesser]?.name} | palabra:${word}`);

  // Enviar a todos en el equipo
  io.to('team'+team).emit('p1:turnUpdate', { team, turn, wordIndex:idx, scores:gs.scores, passes });
  // Enviar rol específico
  if (turn.mime) io.to(turn.mime).emit('p1:yourTurn', { role:'mime', word, hints:wd.hints });
  if (turn.guesser) io.to(turn.guesser).emit('p1:yourTurn', { role:'guesser' });
  // Informar al moderador
  io.to('moderator').emit('p1:modUpdate', { team, mimeName:gs.players[turn.mime]?.name, guesserName:gs.players[turn.guesser]?.name, word, idx, scores:gs.scores });

  p1[tk] = setTimeout(() => doPass(team, 'timeout'), TURN_MS);
}

function doPass(team, src) {
  const p1 = gs.phase1;
  const tk = team==='A' ? 'timerA' : 'timerB';
  if (p1[tk]) { clearTimeout(p1[tk]); p1[tk]=null; }
  if (src !== 'timeout') {
    if (team==='A') { p1.passesA++; gs.scores.A -= 3; }
    else { p1.passesB++; gs.scores.B -= 3; }
  }
  nextTurn(team);
  startTurn(team);
  io.emit('scores', gs.scores);
}

function finishPhase1Team(team) {
  gs.scores[team] += 20;
  if (team==='A') { gs.phase1.finA=true; gs.phase2.timeA=210; }
  else { gs.phase1.finB=true; gs.phase2.timeB=210; }
  io.emit('p1:teamDone', { team, scores:gs.scores, words: team==='A'?gs.phase1.guessedA:gs.phase1.guessedB });
  if (gs.phase1.finA && gs.phase1.finB) {
    gs.phase = 'phase2';
    io.emit('phaseChange', { phase:'phase1Done', scores:gs.scores });
  }
}

// ── FASE 3 ────────────────────────────────────────────────────────────────────
function startPhase3Turn(team) {
  const p3 = gs.phase3;
  const tk = team==='A' ? 'timerA' : 'timerB';
  if (p3[tk]) clearTimeout(p3[tk]);
  const cur = team==='A' ? p3.turnA : p3.turnB;
  const word = team==='A' ? p3.wordA : p3.wordB;
  if (cur) io.to(cur).emit('p3:yourTurn', { word, team, story: team==='A'?p3.storyA:p3.storyB, players: Object.values(gs.players).filter(p=>p.team===team) });
  io.emit('p3:turnUpdate', { team, cur, curName:gs.players[cur]?.name, word, story:team==='A'?p3.storyA:p3.storyB });
  p3[tk] = setTimeout(() => passPhase3(team, cur, 'timeout'), 60000);
}

function passPhase3(team, fromId, src) {
  const p3 = gs.phase3;
  const tk = team==='A' ? 'timerA' : 'timerB';
  if (p3[tk]) { clearTimeout(p3[tk]); p3[tk]=null; }
  if (src !== 'timeout') {
    if (team==='A') { p3.passesA++; gs.scores.A-=3; }
    else { p3.passesB++; gs.scores.B-=3; }
  }
  const used = team==='A' ? p3.usedA : p3.usedB;
  const allW = team==='A' ? p3.wordsA : p3.wordsB;
  if (used.length >= allW.length) { finishPhase3Team(team); return; }
  const teamIds = (team==='A' ? gs.teamA : gs.teamB).filter(id=>id!==fromId);
  const next = teamIds.length ? teamIds[Math.floor(Math.random()*teamIds.length)] : fromId;
  const nextWord = allW[used.length];
  if (team==='A') { p3.turnA=next; p3.wordA=nextWord; }
  else { p3.turnB=next; p3.wordB=nextWord; }
  startPhase3Turn(team);
}

function finishPhase3Team(team) {
  gs.scores[team] += 20;
  if (team==='A') gs.phase3.finA=true; else gs.phase3.finB=true;
  io.emit('p3:teamDone', { team, scores:gs.scores });
  if (gs.phase3.finA && gs.phase3.finB) {
    gs.phase = 'done';
    io.emit('phaseChange', { phase:'phase3Done' });
  }
}

function calcSubScore(team) {
  const p3=gs.phase3, teamIds=team==='A'?gs.teamA:gs.teamB;
  const received=new Set(p3.graph.map(e=>e.to));
  const ghosts=teamIds.filter(id=>!received.has(id)&&gs.players[id]?.role!=='universidad');
  const roles=[...new Set(teamIds.filter(id=>received.has(id)).map(id=>gs.players[id]?.role))];
  const crosses=p3.graph.filter(e=>e.fromTeam!==e.toTeam).length;
  const rebounds=p3.graph.filter((e,i)=>i>0&&p3.graph[i-1].from===e.to&&p3.graph[i-1].to===e.from).length;
  const passes=team==='A'?p3.passesA:p3.passesB;
  let sub=0;
  const u=new Set(roles);
  if(u.size>=5)sub+=40; else if(u.size===4)sub+=20; else if(u.size===3)sub+=10; else sub-=10;
  if(roles.includes('comunidad'))sub+=20;
  if(roles.includes('org_civil'))sub+=20;
  sub-=ghosts.length*20; sub-=crosses*10;
  if(rebounds>=2)sub-=15;
  sub-=Math.max(0,passes-3)*5;
  return { sub, ghosts:ghosts.map(id=>gs.players[id]?.name||'?') };
}

// ── SOCKETS ───────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[CONN]', socket.id);

  socket.on('join', ({ name, isModerator, password }) => {
    try {
      const trimName = name.trim();

      // Limpiar mismo socket si ya existe
      if (gs.players[socket.id]) {
        gs.teamA = gs.teamA.filter(id=>id!==socket.id);
        gs.teamB = gs.teamB.filter(id=>id!==socket.id);
        delete gs.players[socket.id];
      }

      // Reconexión: mismo nombre ya existe
      const prev = Object.entries(gs.players).find(([id,p])=>p.name===trimName&&p.isModerator===!!isModerator);
      if (prev) {
        const [oldId, oldP] = prev;
        gs.players[socket.id] = {...oldP, id:socket.id};
        delete gs.players[oldId];
        gs.teamA = gs.teamA.map(id=>id===oldId?socket.id:id);
        gs.teamB = gs.teamB.map(id=>id===oldId?socket.id:id);
        if (gs.moderatorId===oldId) gs.moderatorId=socket.id;
        const p = gs.players[socket.id];
        if (isModerator) {
          socket.join('moderator');
          gs.modActive = true;
          setModActive(true);
          socket.emit('joined', {id:socket.id, isModerator:true, isNew:false});
        } else {
          socket.join('team'+p.team);
          socket.emit('joined', {id:socket.id, isModerator:false, isNew:false, role:p.role, roleLabel:p.roleLabel, team:p.team, color:p.color, textColor:p.textColor});
        }
        // Restaurar fase
        if (gs.phase==='lobby') socket.emit('restoreState', {phase:'lobby'});
        else if (gs.phase==='phase1') {
          socket.emit('restoreState', {phase:'phase1', state:publicState(), scores:gs.scores});
          // Reenviar turno si es mime o guesser
          ['A','B'].forEach(team => {
            const turn = team==='A' ? gs.phase1.turnA : gs.phase1.turnB;
            const idx = team==='A' ? gs.phase1.idxA : gs.phase1.idxB;
            const word = (team==='A'?gs.phase1.wordsA:gs.phase1.wordsB)[idx];
            const wd = wordData(word);
            if (socket.id===turn.mime) socket.emit('p1:yourTurn', {role:'mime', word, hints:wd.hints});
            if (socket.id===turn.guesser) socket.emit('p1:yourTurn', {role:'guesser'});
          });
        }
        else if (gs.phase==='phase2') socket.emit('restoreState', {phase:'phase2', timeA:gs.phase2.timeA, timeB:gs.phase2.timeB, wordsA:gs.phase1.guessedA, wordsB:gs.phase1.guessedB});
        else if (gs.phase==='phase3') socket.emit('restoreState', {phase:'phase3', state:publicState(), wordsA:gs.phase3.wordsA, wordsB:gs.phase3.wordsB});
        io.emit('lobbyUpdate', publicState());
        console.log('[REJOIN]', trimName, gs.phase);
        return;
      }

      // Validar moderador
      if (isModerator) {
        if (password !== MOD_PASSWORD) { socket.emit('joinError', {msg:'Contraseña incorrecta.'}); return; }
        gs = makeState();
        gs.modActive = true;
        setModActive(true);
        console.log('[MOD] Nueva sesión:', trimName);
      } else {
        if (!isModActive()) { socket.emit('joinError', {msg:'Aún no hay moderador. Espera a que abra la sala.'}); return; }
        if (gs.phase !== 'lobby') { socket.emit('joinError', {msg:'El juego ya inició.'}); return; }
        const taken = Object.values(gs.players).some(p=>p.name===trimName&&!p.isModerator);
        if (taken) { socket.emit('joinError', {msg:'Ese nombre ya está en uso.'}); return; }
      }

      // Nuevo jugador
      const initials = trimName.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);
      gs.players[socket.id] = {id:socket.id, name:trimName, initials, isModerator:!!isModerator, role:null, roleLabel:null, team:null, color:'#ddd', textColor:'#333'};
      if (isModerator) {
        gs.moderatorId = socket.id;
        socket.join('moderator');
        socket.emit('joined', {id:socket.id, isModerator:true, isNew:true});
      } else {
        assignPlayerToTeam(socket.id);
        const p = gs.players[socket.id];
        socket.join('team'+p.team);
        socket.emit('joined', {id:socket.id, isModerator:false, isNew:true, role:p.role, roleLabel:p.roleLabel, team:p.team, color:p.color, textColor:p.textColor});
      }
      socket.emit('restoreState', {phase:'lobby'});
      io.emit('lobbyUpdate', publicState());
      console.log('[NEW]', trimName, gs.players[socket.id]?.team||'mod');
    } catch(e) { console.error('[JOIN_ERR]', e.message); }
  });

  socket.on('startGame', () => {
    if (socket.id !== gs.moderatorId) return;
    gs.phase = 'phase1';
    gs.phase1.wordsA = pick6(); gs.phase1.wordsB = pick6();
    gs.phase1.idxA=0; gs.phase1.idxB=0;
    gs.phase1.guessedA=[]; gs.phase1.guessedB=[];
    gs.phase1.passesA=0; gs.phase1.passesB=0;
    gs.phase1.finA=false; gs.phase1.finB=false;
    gs.phase1.queueA = shuffle([...gs.teamA]);
    gs.phase1.queueB = shuffle([...gs.teamB]);
    nextTurn('A'); nextTurn('B');
    io.emit('phaseChange', { phase:'phase1', state:publicState() });
    setTimeout(() => { startTurn('A'); startTurn('B'); }, 800);
  });

  socket.on('p1:emoji', ({ emoji }) => {
    const p = gs.players[socket.id]; if(!p) return;
    const turn = p.team==='A' ? gs.phase1.turnA : gs.phase1.turnB;
    if (turn.mime !== socket.id) return;
    io.to('team'+p.team).emit('p1:emoji', { from:socket.id, fromName:p.name, emoji, team:p.team });
  });

  socket.on('p1:guess', ({ guess }) => {
    try {
      const p = gs.players[socket.id]; if(!p) return;
      const team = p.team, p1 = gs.phase1;
      const turn = team==='A' ? p1.turnA : p1.turnB;
      if (turn.guesser !== socket.id) return;
      const idx = team==='A' ? p1.idxA : p1.idxB;
      const word = (team==='A'?p1.wordsA:p1.wordsB)[idx];
      const correct = guess.trim().toLowerCase() === word.toLowerCase();
      io.to('team'+team).emit('p1:guessResult', { from:socket.id, fromName:p.name, guess, correct, team });
      if (correct) {
        const tk = team==='A'?'timerA':'timerB';
        if (p1[tk]) { clearTimeout(p1[tk]); p1[tk]=null; }
        gs.scores[team] += 10;
        // Solo la Universidad ve la palabra real
        const uniId = (team==='A'?gs.teamA:gs.teamB).find(id=>gs.players[id]?.role==='universidad');
        if (uniId) io.to(uniId).emit('p1:wordRevealed', { word, index:idx });
        io.to('team'+team).emit('p1:wordGuessed', { team, wordNum:idx+1, by:p.name, scores:gs.scores });
        // Informar al equipo rival del progreso (sin revelar la palabra)
        const rival = team==='A'?'B':'A';
        io.to('team'+rival).emit('p1:rivalProgress', { team, count:idx+1 });
        io.to('moderator').emit('p1:wordGuessed', { team, wordNum:idx+1, by:p.name, word, scores:gs.scores });
        if (team==='A') { p1.guessedA.push(word); p1.idxA++; if(p1.idxA>=6){finishPhase1Team('A');return;} }
        else { p1.guessedB.push(word); p1.idxB++; if(p1.idxB>=6){finishPhase1Team('B');return;} }
        nextTurn(team); startTurn(team);
      }
    } catch(e) { console.error('[GUESS_ERR]', e.message); }
  });

  socket.on('p1:pass', () => {
    const p = gs.players[socket.id]; if(!p) return;
    const turn = p.team==='A' ? gs.phase1.turnA : gs.phase1.turnB;
    if (turn.guesser !== socket.id && turn.mime !== socket.id) return;
    doPass(p.team, 'voluntary');
  });

  socket.on('p1:hint', ({ idx }) => {
    const p = gs.players[socket.id]; if(!p) return;
    const team = p.team, p1 = gs.phase1;
    const turn = team==='A' ? p1.turnA : p1.turnB;
    if (turn.guesser !== socket.id) return;
    const word = (team==='A'?p1.wordsA:p1.wordsB)[team==='A'?p1.idxA:p1.idxB];
    const wd = wordData(word);
    if (idx >= wd.hints.length) return;
    gs.scores[team] -= 5;
    socket.emit('p1:hint', { hint:wd.hints[idx], idx });
    // Enviar pista también al mime y al equipo (visible en chat)
    io.to('team'+team).emit('p1:hintUsed', { idx, scores:gs.scores });
    io.emit('scores', gs.scores);
  });

  socket.on('startPhase2', () => {
    if (socket.id !== gs.moderatorId) return;
    gs.phase = 'phase2';
    io.emit('phaseChange', { phase:'phase2', timeA:gs.phase2.timeA, timeB:gs.phase2.timeB, wordsA:gs.phase1.guessedA, wordsB:gs.phase1.guessedB });
  });

  socket.on('p2:submit', ({ text, isAuto }) => {
    const p = gs.players[socket.id]; if(!p||p.role!=='universidad') return;
    const team = p.team;
    if (team==='A') { gs.phase2.declA=text; gs.phase2.autoA=!!isAuto; gs.phase2.finA=true; if(isAuto)gs.scores.A-=50; }
    else { gs.phase2.declB=text; gs.phase2.autoB=!!isAuto; gs.phase2.finB=true; if(isAuto)gs.scores.B-=50; }
    io.emit('p2:submitted', { team, scores:gs.scores });
    if (gs.phase2.finA && gs.phase2.finB) io.emit('phaseChange', { phase:'phase2Done' });
  });

  socket.on('startPhase3', () => {
    if (socket.id !== gs.moderatorId) return;
    gs.phase = 'phase3';
    const p3 = gs.phase3;
    p3.wordsA=[...gs.phase1.guessedA]; p3.wordsB=[...gs.phase1.guessedB];
    p3.usedA=[]; p3.usedB=[]; p3.storyA=[]; p3.storyB=[]; p3.graph=[];
    p3.passesA=0; p3.passesB=0; p3.finA=false; p3.finB=false;
    const uniA = gs.teamA.find(id=>gs.players[id]?.role==='universidad')||gs.teamA[0];
    const uniB = gs.teamB.find(id=>gs.players[id]?.role==='universidad')||gs.teamB[0];
    p3.turnA=uniA; p3.turnB=uniB; p3.wordA=p3.wordsA[0]; p3.wordB=p3.wordsB[0];
    io.emit('phaseChange', { phase:'phase3', state:publicState(), wordsA:p3.wordsA, wordsB:p3.wordsB });
    setTimeout(() => { startPhase3Turn('A'); startPhase3Turn('B'); }, 500);
  });

  socket.on('p3:sentence', ({ text, nextId }) => {
    try {
      const p = gs.players[socket.id]; if(!p) return;
      const team = p.team, p3 = gs.phase3;
      const cur = team==='A' ? p3.turnA : p3.turnB;
      if (cur !== socket.id) return;
      const word = team==='A' ? p3.wordA : p3.wordB;
      if (!text.toLowerCase().includes(word.toLowerCase())) { socket.emit('error', {msg:'Debes incluir "'+word+'"'}); return; }
      const tk = team==='A' ? 'timerA' : 'timerB';
      if (p3[tk]) { clearTimeout(p3[tk]); p3[tk]=null; }
      const entry = { playerId:socket.id, playerName:p.name, playerRole:p.roleLabel, playerColor:p.color, playerTextColor:p.textColor, playerInitials:p.initials, text, word, team, isCross:false };
      if (team==='A') { p3.storyA.push(entry); p3.usedA.push(word); }
      else { p3.storyB.push(entry); p3.usedB.push(word); }
      gs.scores[team] += 5;
      if (nextId) p3.graph.push({from:socket.id, to:nextId, fromTeam:team, toTeam:gs.players[nextId]?.team, isCross:gs.players[nextId]?.team!==team, fromName:p.name});
      const used = team==='A' ? p3.usedA : p3.usedB;
      const allW = team==='A' ? p3.wordsA : p3.wordsB;
      io.emit('p3:update', { team, story:team==='A'?p3.storyA:p3.storyB, used, graph:p3.graph, scores:gs.scores });
      if (used.length >= allW.length) { finishPhase3Team(team); return; }
      const nextWord = allW[used.length];
      const isCross = nextId && gs.players[nextId]?.team !== team;
      if (team==='A') { p3.turnA=nextId; p3.wordA=nextWord; }
      else { p3.turnB=nextId; p3.wordB=nextWord; }
      if (isCross) {
        io.to(nextId).emit('p3:crossTurn', { word:nextWord, fromTeam:team });
        io.emit('p3:turnUpdate', { team, cur:nextId, curName:gs.players[nextId]?.name, word:nextWord, isCross:true, story:team==='A'?p3.storyA:p3.storyB, graph:p3.graph });
        p3[tk] = setTimeout(() => passPhase3(team, nextId, 'timeout'), 60000);
      } else { startPhase3Turn(team); }
    } catch(e) { console.error('[P3_ERR]', e.message); }
  });

  socket.on('p3:pass', () => { const p=gs.players[socket.id]; if(!p) return; passPhase3(p.team, socket.id, 'voluntary'); });

  socket.on('showDashboard', () => {
    if (socket.id !== gs.moderatorId) return;
    const p3 = gs.phase3;
    const rA = calcSubScore('A'), rB = calcSubScore('B');
    const fA = gs.scores.A+rA.sub, fB = gs.scores.B+rB.sub;
    const winner = fA>fB?'A':fB>fA?'B':'empate';
    const players = {};
    Object.entries(gs.players).forEach(([id,p])=>{ players[id]={id:p.id,name:p.name,role:p.role,roleLabel:p.roleLabel,team:p.team,initials:p.initials,color:p.color,textColor:p.textColor}; });
    io.emit('dashboard', { scores:gs.scores, subA:rA.sub, subB:rB.sub, finalA:fA, finalB:fB, winner, declA:gs.phase2.declA, declB:gs.phase2.declB, autoA:gs.phase2.autoA, autoB:gs.phase2.autoB, storyA:p3.storyA, storyB:p3.storyB, graph:p3.graph, ghostsA:rA.ghosts, ghostsB:rB.ghosts, wordsA:p3.wordsA, wordsB:p3.wordsB, players });
  });

  socket.on('reset', () => {
    if (socket.id !== gs.moderatorId) return;
    [gs.phase1.timerA, gs.phase1.timerB, gs.phase3.timerA, gs.phase3.timerB].forEach(t => { if(t) clearTimeout(t); });
    gs = makeState();
    gs.modActive = true;
    setModActive(true);
    io.emit('reset');
    console.log('[RESET] Juego reiniciado');
  });

  socket.on('disconnect', () => {
    const sid = socket.id;
    const wasmod = sid === gs.moderatorId;
    setTimeout(() => {
      if (!gs.players[sid]) return; // Ya reconectó
      delete gs.players[sid];
      gs.teamA = gs.teamA.filter(id=>id!==sid);
      gs.teamB = gs.teamB.filter(id=>id!==sid);
      if (wasmod) { gs.modActive = false; setModActive(false); console.log('[MOD] Moderador desconectado'); }
      io.emit('lobbyUpdate', publicState());
    }, 5000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('[START] Desacople en puerto', PORT, '| PID:', process.pid));
