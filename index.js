const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const MOD_PASSWORD = 'desacople2025';

// ── ESTADO COMPARTIDO EN DISCO ────────────────────────────────────────────────
const STATE_FILE = '/tmp/desacople_gs.json';
const EVENTS_FILE = '/tmp/desacople_events.json';
const MOD_ACTIVE_FILE = '/tmp/desacople_mod_active';

function saveGs() {
  try {
    const copy = JSON.parse(JSON.stringify(gs, (k,v) =>
      (k==='timerA'||k==='timerB') ? null : v
    ));
    fs.writeFileSync(STATE_FILE, JSON.stringify(copy), 'utf8');
  } catch(e) { console.error('[SAVE]', e.message); }
}

function loadGs() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const stat = fs.statSync(STATE_FILE);
    if ((Date.now() - stat.mtimeMs) > 7200000) return null; // >2h → stale
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (data && data.phase) return data;
  } catch(e) {}
  return null;
}

function broadcastEvent(eventData) {
  try {
    let events = [];
    try { const e = JSON.parse(fs.readFileSync(EVENTS_FILE,'utf8')); if(Array.isArray(e)) events = e; } catch(e2){}
    events.push({ ...eventData, ts: Date.now() });
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(events.filter(e => Date.now()-e.ts < 5000)));
  } catch(e) {}
}

process.on('uncaughtException', err => console.error('[CRASH]', err.message));
process.on('unhandledRejection', r => console.error('[REJECT]', String(r)));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

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
  universidad:{ bg:'#B5D4F4', text:'#0C447C' },
  gobierno:   { bg:'#FAC775', text:'#633806' },
  empresa:    { bg:'#F4C0D1', text:'#72243E' },
  org_civil:  { bg:'#CECBF6', text:'#3C3489' },
  comunidad:  { bg:'#D3D1C7', text:'#444441' }
};

function makeState() {
  return {
    phase: 'lobby', players: {}, teamA: [], teamB: [],
    scores: { A:0, B:0 }, moderatorId: null,
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

// Cargar estado desde disco al arrancar
let gs = (()=>{
  const saved = loadGs();
  if (!saved) return makeState();
  // Si no hay moderador activo en el estado guardado, resetear
  if (!saved.moderatorId || !saved.players?.[saved.moderatorId]) {
    console.log('[START] Sin moderador activo, iniciando fresco');
    return makeState();
  }
  console.log('[START] PID:', process.pid, '| fase:', saved.phase, '| jugadores:', Object.keys(saved.players).length);
  return saved;
})();
if (!fs.existsSync(STATE_FILE)) saveGs();
try { fs.writeFileSync(EVENTS_FILE, '[]'); } catch(e) {}

// Polling cross-proceso cada 600ms
let lastStateStr = '', lastEventsStr = '';
setInterval(() => {
  try {
    // Sincronizar estado
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      if (raw !== lastStateStr) {
        lastStateStr = raw;
        const fresh = JSON.parse(raw);
        if (fresh?.phase) {
          const oldCount = JSON.stringify(Object.keys(gs.players||{}).sort());
          const newCount = JSON.stringify(Object.keys(fresh.players||{}).sort());
          gs = fresh;
          if (oldCount !== newCount) io.emit('lobbyUpdate', publicState());
        }
      }
    }
    // Relay de eventos de otros procesos
    if (fs.existsSync(EVENTS_FILE)) {
      const raw = fs.readFileSync(EVENTS_FILE, 'utf8');
      if (raw !== lastEventsStr) {
        lastEventsStr = raw;
        const events = JSON.parse(raw);
        if (Array.isArray(events)) {
          events.filter(e => Date.now()-e.ts < 3000).forEach(e => {
            const { _pid, ts, event, ...data } = e;
            if (_pid === process.pid) return;
            if (event === 'p1:mimeHint') {
              if (data.mimeId) io.to(data.mimeId).emit('p1:yourTurn', { role:'mime', word:data.word, hints:data.hints });
              if (data.guesserId) io.to(data.guesserId).emit('p1:yourTurn', { role:'guesser' });
              io.to('team'+data.team).emit('p1:turnUpdate', { team:data.team, turn:{mime:data.mimeId,guesser:data.guesserId}, wordIndex:data.wordIndex||0, scores:data.scores||{A:0,B:0}, passes:data.passes||0 });
            } else {
              io.emit(event, data);
            }
            console.log('[RELAY]', event, 'PID', _pid);
          });
        }
      }
    }
  } catch(e) {}
}, 600);

function shuffle(a){ const r=[...a]; for(let i=r.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[r[i],r[j]]=[r[j],r[i]];} return r; }

function assignPlayerToTeam(socketId) {
  const a = gs.teamA.length, b = gs.teamB.length;
  const team = a <= b ? 'A' : 'B';
  const teamIds = team === 'A' ? gs.teamA : gs.teamB;
  const uniCount = teamIds.filter(id => gs.players[id]?.role === 'universidad').length;
  const maxUni = Math.max(1, Math.round(teamIds.length * 0.2 + 0.5));
  let role;
  if (uniCount < maxUni && teamIds.length < 3) {
    role = 'universidad';
  } else {
    const others = ['gobierno','empresa','org_civil','comunidad'];
    const counts = {}; others.forEach(r => counts[r] = 0);
    teamIds.forEach(id => { const r = gs.players[id]?.role; if(counts[r] !== undefined) counts[r]++; });
    role = others.reduce((a,b) => counts[a] <= counts[b] ? a : b);
  }
  const c = ROLE_COLORS[role] || { bg:'#ddd', text:'#333' };
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

function pick6() { return shuffle(WORD_BANK).slice(0,6).map(w=>w.word); }
function wordData(w) { return WORD_BANK.find(x=>x.word===w) || {word:w,hints:['pista 1','pista 2','empieza con '+w[0].toUpperCase(),w.length+' letras']}; }

const TURN_TIME = 60000; // 60 segundos por turno

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
  const word = (team==='A' ? p1.wordsA : p1.wordsB)[idx];
  const wd = wordData(word);
  const passes = team==='A' ? p1.passesA : p1.passesB;
  // Emitir a sockets locales
  if (turn.mime) io.to(turn.mime).emit('p1:yourTurn', { role:'mime', word, hints:wd.hints });
  if (turn.guesser) io.to(turn.guesser).emit('p1:yourTurn', { role:'guesser' });
  io.to('team'+team).emit('p1:turnUpdate', { team, turn, wordIndex:idx, scores:gs.scores, passes });
  // Broadcast a otros procesos
  saveGs();
  broadcastEvent({ event:'p1:mimeHint', _pid:process.pid, mimeId:turn.mime, guesserId:turn.guesser, word, hints:wd.hints, team, wordIndex:idx, scores:gs.scores, passes });
  p1[tk] = setTimeout(() => doPass(team,'timeout'), TURN_TIME);
}

function doPass(team, src) {
  const p1 = gs.phase1;
  const tk = team==='A' ? 'timerA' : 'timerB';
  if (p1[tk]) { clearTimeout(p1[tk]); p1[tk]=null; }
  if (src !== 'timeout') {
    if (team==='A') { p1.passesA++; gs.scores.A -= 3; }
    else { p1.passesB++; gs.scores.B -= 3; }
  }
  nextTurn(team); startTurn(team);
  io.emit('scores', gs.scores);
}

function finishPhase1Team(team) {
  gs.scores[team] += 20;
  if (team==='A') { gs.phase1.finA=true; gs.phase2.timeA=210; }
  else { gs.phase1.finB=true; gs.phase2.timeB=210; }
  io.emit('p1:teamDone', { team, scores:gs.scores, words: team==='A'?gs.phase1.guessedA:gs.phase1.guessedB });
  if (gs.phase1.finA && gs.phase1.finB) {
    gs.phase='phase2'; saveGs();
    io.emit('phaseChange', { phase:'phase1Done', scores:gs.scores });
    broadcastEvent({ event:'phaseChange', _pid:process.pid, phase:'phase1Done', scores:gs.scores });
  }
}

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
  const allW = team==='A' ? p3.wordsA : p3.wordsB;
  const used = team==='A' ? p3.usedA : p3.usedB;
  if (used.length >= allW.length) { finishPhase3Team(team); return; }
  const teamIds = (team==='A' ? gs.teamA : gs.teamB).filter(id=>id!==fromId);
  const next = teamIds[Math.floor(Math.random()*teamIds.length)] || fromId;
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
    gs.phase='done'; saveGs();
    io.emit('phaseChange', { phase:'phase3Done' });
  }
}

function calcSubScore(team) {
  const p3=gs.phase3;
  const teamIds=team==='A'?gs.teamA:gs.teamB;
  const graph=p3.graph;
  const received=new Set(graph.map(e=>e.to));
  const ghosts=teamIds.filter(id=>!received.has(id)&&gs.players[id]?.role!=='universidad');
  const roles=[...new Set(teamIds.filter(id=>received.has(id)).map(id=>gs.players[id]?.role))];
  const uniq=new Set(roles);
  const crosses=graph.filter(e=>e.fromTeam!==e.toTeam).length;
  const rebounds=graph.filter((e,i)=>i>0&&graph[i-1].from===e.to&&graph[i-1].to===e.from).length;
  const passes=team==='A'?p3.passesA:p3.passesB;
  let sub=0;
  if(uniq.size>=5) sub+=40; else if(uniq.size===4) sub+=20; else if(uniq.size===3) sub+=10; else sub-=10;
  if(roles.includes('comunidad')) sub+=20;
  if(roles.includes('org_civil')) sub+=20;
  sub-=ghosts.length*20; sub-=crosses*10;
  if(rebounds>=2) sub-=15;
  sub-=Math.max(0,passes-3)*5;
  return { sub, ghosts:ghosts.map(id=>gs.players[id]?.name||'?') };
}

io.on('connection', socket => {
  console.log('connected:', socket.id);

  socket.on('join', ({ name, isModerator, password }) => {
    gs = loadGs() || gs;
    const trimName = name.trim();

    // Limpiar mismo socket si ya existe
    if (gs.players[socket.id]) {
      gs.teamA = gs.teamA.filter(id=>id!==socket.id);
      gs.teamB = gs.teamB.filter(id=>id!==socket.id);
      delete gs.players[socket.id];
    }

    // Reconexion: mismo nombre ya existe
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
        try { fs.writeFileSync(MOD_ACTIVE_FILE, String(Date.now())); } catch(e) {}
        socket.emit('joined',{id:socket.id,isModerator:true,isNew:false});
      } else {
        socket.join('team'+p.team);
        socket.emit('joined',{id:socket.id,isModerator:false,isNew:false,role:p.role,roleLabel:p.roleLabel,team:p.team,color:p.color,textColor:p.textColor});
      }
      const phase = gs.phase;
      if (phase==='lobby') socket.emit('restoreState',{phase:'lobby'});
      else if (phase==='phase1') socket.emit('restoreState',{phase:'phase1',state:publicState(),scores:gs.scores});
      else if (phase==='phase2') socket.emit('restoreState',{phase:'phase2',timeA:gs.phase2.timeA,timeB:gs.phase2.timeB,wordsA:gs.phase1.guessedA,wordsB:gs.phase1.guessedB});
      else if (phase==='phase3') socket.emit('restoreState',{phase:'phase3',state:publicState(),wordsA:gs.phase3.wordsA,wordsB:gs.phase3.wordsB});
      saveGs(); io.emit('lobbyUpdate', publicState());
      broadcastEvent({event:'lobbyUpdate',_pid:process.pid,...publicState()});
      console.log('[REJOIN]', trimName, phase);
      return;
    }

    // Validar moderador
    if (isModerator) {
      if (password !== MOD_PASSWORD) { socket.emit('joinError',{msg:'Contraseña incorrecta.'}); return; }
      // Nueva sesión: limpiar estado
      gs = makeState();
      saveGs();
      try { fs.writeFileSync(MOD_ACTIVE_FILE, String(Date.now())); } catch(e) {}
      console.log('[RESET] Nueva sesión por moderador:', trimName);
    } else {
      // Jugadores necesitan moderador activo
      // Verificar que hay moderador activo via archivo (no confiar en estado en disco)
      const modActive = (() => { try { if(!fs.existsSync(MOD_ACTIVE_FILE)) return false; const age=(Date.now()-parseInt(fs.readFileSync(MOD_ACTIVE_FILE,'utf8')))/1000; return age<7200; } catch(e){return false;} })();
      if (!modActive) { socket.emit('joinError',{msg:'Aún no hay moderador. Espera a que el moderador abra la sala.'}); return; }
      if (gs.phase !== 'lobby') { socket.emit('joinError',{msg:'El juego ya inició. No puedes unirte ahora.'}); return; }
    }

    // Nombre duplicado
    if (Object.values(gs.players).some(p=>p.name===trimName&&p.isModerator===!!isModerator)) {
      socket.emit('joinError',{msg:'Ese nombre ya está en uso. Elige otro.'}); return;
    }

    // Nuevo jugador
    const initials = trimName.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);
    gs.players[socket.id] = {id:socket.id,name:trimName,initials,isModerator:!!isModerator,role:null,roleLabel:null,team:null,color:'#ddd',textColor:'#333'};
    if (isModerator) {
      gs.moderatorId=socket.id; socket.join('moderator');
      socket.emit('joined',{id:socket.id,isModerator:true,isNew:true});
    } else {
      assignPlayerToTeam(socket.id);
      const p=gs.players[socket.id]; socket.join('team'+p.team);
      socket.emit('joined',{id:socket.id,isModerator:false,isNew:true,role:p.role,roleLabel:p.roleLabel,team:p.team,color:p.color,textColor:p.textColor});
    }
    socket.emit('restoreState',{phase:'lobby'});
    saveGs(); io.emit('lobbyUpdate', publicState());
    broadcastEvent({event:'lobbyUpdate',_pid:process.pid,...publicState()});
    console.log('[NEW]', trimName, gs.players[socket.id]?.team||'mod');
  });

  socket.on('startGame', () => {
    if (socket.id !== gs.moderatorId) return;
    gs.phase = 'phase1';
    gs.phase1.wordsA = pick6(); gs.phase1.wordsB = pick6();
    gs.phase1.idxA=0; gs.phase1.idxB=0;
    gs.phase1.guessedA=[]; gs.phase1.guessedB=[];
    gs.phase1.passesA=0; gs.phase1.passesB=0;
    gs.phase1.finA=false; gs.phase1.finB=false;
    gs.phase1.queueA=shuffle([...gs.teamA]);
    gs.phase1.queueB=shuffle([...gs.teamB]);
    nextTurn('A'); nextTurn('B');
    const p1data = { phase:'phase1', state:publicState() };
    saveGs();
    io.emit('phaseChange', p1data);
    broadcastEvent({ event:'phaseChange', _pid:process.pid, ...p1data });
    setTimeout(() => { startTurn('A'); startTurn('B'); }, 800);
  });

  socket.on('p1:emoji', ({ emoji }) => {
    const p = gs.players[socket.id]; if(!p) return;
    const turn = p.team==='A' ? gs.phase1.turnA : gs.phase1.turnB;
    if (turn.mime !== socket.id) return;
    io.to('team'+p.team).emit('p1:emoji', { from:socket.id, fromName:p.name, emoji, team:p.team });
  });

  socket.on('p1:guess', ({ guess }) => {
    const p = gs.players[socket.id]; if(!p) return;
    const team = p.team, p1 = gs.phase1;
    const turn = team==='A' ? p1.turnA : p1.turnB;
    if (turn.guesser !== socket.id) return;
    const word = (team==='A'?p1.wordsA:p1.wordsB)[team==='A'?p1.idxA:p1.idxB];
    const correct = guess.trim().toLowerCase() === word.toLowerCase();
    io.to('team'+team).emit('p1:guessResult', { from:socket.id, fromName:p.name, guess, correct, team });
    if (correct) {
      const tk = team==='A'?'timerA':'timerB';
      if (p1[tk]) { clearTimeout(p1[tk]); p1[tk]=null; }
      gs.scores[team] += 10;
      const uniId = (team==='A'?gs.teamA:gs.teamB).find(id=>gs.players[id]?.role==='universidad');
      if (uniId) io.to(uniId).emit('p1:wordRevealed', { word, index:team==='A'?p1.idxA:p1.idxB });
      io.to('team'+team).emit('p1:wordGuessed', { team, wordNum:(team==='A'?p1.idxA:p1.idxB)+1, by:p.name, scores:gs.scores });
      if (team==='A') { p1.guessedA.push(word); p1.idxA++; if(p1.idxA>=6){finishPhase1Team('A');return;} }
      else { p1.guessedB.push(word); p1.idxB++; if(p1.idxB>=6){finishPhase1Team('B');return;} }
      nextTurn(team); startTurn(team);
    }
  });

  socket.on('p1:pass', () => { const p=gs.players[socket.id]; if(!p) return; doPass(p.team,'voluntary'); });

  socket.on('p1:hint', ({ idx }) => {
    const p=gs.players[socket.id]; if(!p) return;
    const team=p.team, p1=gs.phase1, turn=team==='A'?p1.turnA:p1.turnB;
    if(turn.guesser!==socket.id) return;
    const word=(team==='A'?p1.wordsA:p1.wordsB)[team==='A'?p1.idxA:p1.idxB];
    const wd=wordData(word); if(idx>=wd.hints.length) return;
    gs.scores[team]-=5;
    socket.emit('p1:hint',{hint:wd.hints[idx],idx});
    io.emit('scores',gs.scores);
  });

  socket.on('startPhase2', () => {
    if(socket.id!==gs.moderatorId) return;
    gs.phase='phase2'; saveGs();
    const p2data = {phase:'phase2',timeA:gs.phase2.timeA,timeB:gs.phase2.timeB,wordsA:gs.phase1.guessedA,wordsB:gs.phase1.guessedB};
    io.emit('phaseChange', p2data);
    broadcastEvent({event:'phaseChange',_pid:process.pid,...p2data});
  });

  socket.on('p2:submit', ({ text, isAuto }) => {
    const p=gs.players[socket.id]; if(!p||p.role!=='universidad') return;
    const team=p.team;
    if(team==='A'){gs.phase2.declA=text;gs.phase2.autoA=!!isAuto;gs.phase2.finA=true;if(isAuto)gs.scores.A-=50;}
    else{gs.phase2.declB=text;gs.phase2.autoB=!!isAuto;gs.phase2.finB=true;if(isAuto)gs.scores.B-=50;}
    saveGs();
    io.emit('p2:submitted',{team,scores:gs.scores});
    if(gs.phase2.finA&&gs.phase2.finB){
      io.emit('phaseChange',{phase:'phase2Done'});
      broadcastEvent({event:'phaseChange',_pid:process.pid,phase:'phase2Done'});
    }
  });

  socket.on('startPhase3', () => {
    if(socket.id!==gs.moderatorId) return;
    gs.phase='phase3';
    const p3=gs.phase3;
    p3.wordsA=[...gs.phase1.guessedA]; p3.wordsB=[...gs.phase1.guessedB];
    p3.usedA=[]; p3.usedB=[]; p3.storyA=[]; p3.storyB=[]; p3.graph=[];
    p3.passesA=0; p3.passesB=0; p3.finA=false; p3.finB=false;
    const uniA=gs.teamA.find(id=>gs.players[id]?.role==='universidad')||gs.teamA[0];
    const uniB=gs.teamB.find(id=>gs.players[id]?.role==='universidad')||gs.teamB[0];
    p3.turnA=uniA; p3.turnB=uniB; p3.wordA=p3.wordsA[0]; p3.wordB=p3.wordsB[0];
    saveGs();
    const p3data={phase:'phase3',state:publicState(),wordsA:p3.wordsA,wordsB:p3.wordsB};
    io.emit('phaseChange',p3data);
    broadcastEvent({event:'phaseChange',_pid:process.pid,...p3data});
    setTimeout(()=>{startPhase3Turn('A');startPhase3Turn('B');},500);
  });

  socket.on('p3:sentence', ({ text, nextId }) => {
    const p=gs.players[socket.id]; if(!p) return;
    const team=p.team, p3=gs.phase3;
    const cur=team==='A'?p3.turnA:p3.turnB;
    if(cur!==socket.id) return;
    const word=team==='A'?p3.wordA:p3.wordB;
    if(!text.toLowerCase().includes(word.toLowerCase())){socket.emit('error',{msg:'Debes incluir "'+word+'"'});return;}
    const tk=team==='A'?'timerA':'timerB';
    if(p3[tk]){clearTimeout(p3[tk]);p3[tk]=null;}
    const entry={playerId:socket.id,playerName:p.name,playerRole:p.roleLabel,playerColor:p.color,playerTextColor:p.textColor,playerInitials:p.initials,text,word,team,isCross:false};
    if(team==='A'){p3.storyA.push(entry);p3.usedA.push(word);}
    else{p3.storyB.push(entry);p3.usedB.push(word);}
    gs.scores[team]+=5;
    if(nextId) p3.graph.push({from:socket.id,to:nextId,fromTeam:team,toTeam:gs.players[nextId]?.team,isCross:gs.players[nextId]?.team!==team,fromName:p.name});
    const used=team==='A'?p3.usedA:p3.usedB;
    const allW=team==='A'?p3.wordsA:p3.wordsB;
    saveGs();
    io.emit('p3:update',{team,story:team==='A'?p3.storyA:p3.storyB,used,graph:p3.graph,scores:gs.scores});
    if(used.length>=allW.length){finishPhase3Team(team);return;}
    const nextWord=allW[used.length];
    const isCross=nextId&&gs.players[nextId]?.team!==team;
    if(team==='A'){p3.turnA=nextId;p3.wordA=nextWord;}else{p3.turnB=nextId;p3.wordB=nextWord;}
    if(isCross){
      io.to(nextId).emit('p3:crossTurn',{word:nextWord,fromTeam:team});
      io.emit('p3:turnUpdate',{team,cur:nextId,curName:gs.players[nextId]?.name,word:nextWord,isCross:true,story:team==='A'?p3.storyA:p3.storyB,graph:p3.graph});
      p3[tk]=setTimeout(()=>passPhase3(team,nextId,'timeout'),60000);
    } else { startPhase3Turn(team); }
  });

  socket.on('p3:pass', () => { const p=gs.players[socket.id]; if(!p) return; passPhase3(p.team,socket.id,'voluntary'); });

  socket.on('showDashboard', () => {
    if(socket.id!==gs.moderatorId) return;
    const p3=gs.phase3;
    const rA=calcSubScore('A'), rB=calcSubScore('B');
    const fA=gs.scores.A+rA.sub, fB=gs.scores.B+rB.sub;
    const winner = fA>fB?'A':fB>fA?'B':'empate';
    const players = {};
    Object.entries(gs.players).forEach(([id,p])=>{ players[id]={id:p.id,name:p.name,role:p.role,roleLabel:p.roleLabel,team:p.team,initials:p.initials,color:p.color,textColor:p.textColor}; });
    io.emit('dashboard',{scores:gs.scores,subA:rA.sub,subB:rB.sub,finalA:fA,finalB:fB,winner,declA:gs.phase2.declA,declB:gs.phase2.declB,autoA:gs.phase2.autoA,autoB:gs.phase2.autoB,storyA:p3.storyA,storyB:p3.storyB,graph:p3.graph,ghostsA:rA.ghosts,ghostsB:rB.ghosts,wordsA:p3.wordsA,wordsB:p3.wordsB,players});
  });

  socket.on('reset', () => {
    if(socket.id!==gs.moderatorId) return;
    [gs.phase1.timerA,gs.phase1.timerB,gs.phase3.timerA,gs.phase3.timerB].forEach(t=>{if(t)clearTimeout(t);});
    const modPlayer = gs.players[socket.id];
    gs = makeState();
    if (modPlayer) { gs.players[socket.id]=modPlayer; gs.moderatorId=socket.id; }
    saveGs();
    io.emit('reset');
    broadcastEvent({event:'reset',_pid:process.pid});
  });

  socket.on('disconnect', () => {
    const sid = socket.id;
    // Si era el moderador, borrar archivo de sesión activa
    if (sid === gs.moderatorId) { try { fs.unlinkSync(MOD_ACTIVE_FILE); } catch(e){} console.log('[MOD] Moderador desconectado'); }
    setTimeout(() => {
      const fresh = loadGs() || gs;
      if (!fresh.players[sid]) return; // Ya fue reasignado
      gs = fresh;
      delete gs.players[sid];
      gs.teamA = gs.teamA.filter(id=>id!==sid);
      gs.teamB = gs.teamB.filter(id=>id!==sid);
      saveGs();
      io.emit('lobbyUpdate', publicState());
    }, 4000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Desacople running on port', PORT));
