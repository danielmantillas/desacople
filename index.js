'use strict';
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const fs       = require('fs');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MOD_PASSWORD = 'desacople2025';
const TURN_MS      = 60000;
const STATE_FILE   = '/tmp/dscp_state.json';
const EVT_FILE     = '/tmp/dscp_events.json';
const HB_FILE      = '/tmp/dscp_hb';

// ─── SERVIDOR ────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { transports: ['websocket','polling'], cors: { origin:'*' } });
app.use(express.static(path.join(__dirname, 'public')));
process.on('uncaughtException',  err => console.error('[ERR]', err.message));
process.on('unhandledRejection', r   => console.error('[REJ]', String(r)));

// ─── DISCO ────────────────────────────────────────────────────────────────────
let _saveTimer = null, lastStateHash = '';
function diskSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      const raw = JSON.stringify(JSON.parse(JSON.stringify(gs,
        (k,v) => (k==='timerA'||k==='timerB') ? null : v)));
      fs.writeFile(STATE_FILE, raw, () => {});
    } catch(e) {}
  }, 50);
}
function diskSaveSync() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  try {
    const raw = JSON.stringify(JSON.parse(JSON.stringify(gs,
      (k,v) => (k==='timerA'||k==='timerB') ? null : v)));
    fs.writeFileSync(STATE_FILE, raw);
    lastStateHash = raw;
  } catch(e) {}
}
function diskLoad() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const d = JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    return (d && d.phase) ? d : null;
  } catch(e) { return null; }
}

// ─── MODERADOR ACTIVO ────────────────────────────────────────────────────────
// Verificar si hay moderador activo: en memoria O en disco reciente
function hbWrite()  { /* no-op: usamos diskSaveSync */ }
function hbClear()  { /* no-op */ }
function hbActive() { return gs.modActive; } // Solo memoria — ver isModActive()
function isModActive() {
  if (gs.modActive) return true;
  // Verificar disco: estado guardado en los últimos 120 segundos con modActive
  try {
    if (!fs.existsSync(STATE_FILE)) return false;
    const age = Date.now() - fs.statSync(STATE_FILE).mtimeMs;
    if (age > 120000) return false; // más de 2 minutos = sesión vieja
    const d = JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    return !!(d && d.modActive && d.phase === 'lobby');
  } catch(e) { return false; }
}

// Limpiar estado viejo al arrancar
try{ if(fs.existsSync(STATE_FILE)){const _d=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));if(!_d||!_d.modActive)fs.unlinkSync(STATE_FILE);} }catch(e){}

// ─── RELAY TIEMPO REAL ────────────────────────────────────────────────────────
let lastEvtHash = '';
function evtPush(event, data) {
  setImmediate(() => {
    try {
      let arr = [];
      try { arr = JSON.parse(fs.readFileSync(EVT_FILE,'utf8')); } catch(e){}
      arr = arr.filter(e => Date.now()-e.ts < 2000);
      arr.push({ event, data, ts: Date.now(), pid: process.pid });
      fs.writeFile(EVT_FILE, JSON.stringify(arr), () => {});
    } catch(e) {}
  });
}

// ─── PALABRAS ─────────────────────────────────────────────────────────────────
const WORDS = [
  { w:'ecosistema',    h:['todo está conectado','red de vida interdependiente','empieza con E','9 letras'] },
  { w:'carbono',       h:['lo que emite un motor','huella que deja la industria','empieza con C','7 letras'] },
  { w:'resiliencia',   h:['no es resistir, es adaptarse','capacidad de recuperarse del daño','empieza con R','11 letras'] },
  { w:'biodiversidad', h:['no es solo naturaleza','variedad de formas de vida en un lugar','empieza con B','13 letras'] },
  { w:'territorio',    h:['donde ocurre todo','espacio vivido, no solo geográfico','empieza con T','9 letras'] },
  { w:'huella',        h:['lo que dejas al pasar','impacto medible sobre el ambiente','empieza con H','6 letras'] },
  { w:'restauracion',  h:['no es conservar, es devolver','proceso de recuperar lo dañado','empieza con R','12 letras'] },
  { w:'transicion',    h:['no es un destino, es un camino','cambio estructural hacia otro modelo','empieza con T','10 letras'] },
  { w:'campus',        h:['más que edificios','el territorio propio de la universidad','empieza con C','6 letras'] },
  { w:'residuos',      h:['lo que queda después','materiales sin uso que generamos','empieza con R','8 letras'] },
  { w:'comunidad',     h:['no es individuo','grupo que comparte un territorio','empieza con C','9 letras'] },
  { w:'gobernanza',    h:['no es solo gobierno','cómo se toman las decisiones colectivas','empieza con G','10 letras'] },
  { w:'compensacion',  h:['no es solución, es deuda','acción para equilibrar el daño causado','empieza con C','12 letras'] },
  { w:'compromiso',    h:['más que una promesa','obligación asumida voluntariamente','empieza con C','10 letras'] },
  { w:'neutralidad',   h:['el punto de equilibrio','cuando lo que emites equivale a lo que absorbes','empieza con N','11 letras'] }
];
const wFind = w => WORDS.find(x=>x.w===w) ||
  { w, h:['pista 1','pista 2','empieza con '+(w[0]||'?').toUpperCase(), w.length+' letras'] };

const RLABELS = { universidad:'Universidad', gobierno:'Gobierno Local', empresa:'Empresa', org_civil:'Org. Civil', comunidad:'Comunidad' };
const RCOLORS = {
  universidad:{bg:'#B5D4F4',tx:'#0C447C'}, gobierno:{bg:'#FAC775',tx:'#633806'},
  empresa:{bg:'#F4C0D1',tx:'#72243E'}, org_civil:{bg:'#CECBF6',tx:'#3C3489'}, comunidad:{bg:'#D3D1C7',tx:'#444441'}
};

// ─── ESTADO ───────────────────────────────────────────────────────────────────
function makeState() {
  return {
    phase:'lobby', players:{}, teamA:[], teamB:[],
    scores:{A:0,B:0}, moderatorId:null, modActive:false,
    p1:{ wordsA:[],wordsB:[],idxA:0,idxB:0,guessedA:[],guessedB:[],
         queueA:[],queueB:[],turnA:{mime:null,guesser:null},turnB:{mime:null,guesser:null},
         timerA:null,timerB:null,passesA:0,passesB:0,finA:false,finB:false },
    p2:{ declA:null,declB:null,autoA:false,autoB:false,timeA:180,timeB:180,finA:false,finB:false },
    p3:{ storyA:[],storyB:[],wordsA:[],wordsB:[],usedA:[],usedB:[],
         turnA:null,turnB:null,wordA:null,wordB:null,graph:[],
         passesA:0,passesB:0,timerA:null,timerB:null,finA:false,finB:false }
  };
}
let gs = makeState();

// ─── INICIO: descartar estado viejo ──────────────────────────────────────────
lastStateHash = (() => {
  try {
    if (!fs.existsSync(STATE_FILE)) return '';
    const raw = fs.readFileSync(STATE_FILE,'utf8');
    const d   = JSON.parse(raw);
    if (d && d.modActive && d.phase === 'lobby') {
      gs = d; gs.modActive = false; // mod debe reconectar
      console.log('[INIT] lobby previo cargado, esperando moderador'); return raw;
    }
    try { fs.unlinkSync(STATE_FILE); } catch(e){}
    
    return '';
  } catch(e) { return ''; }
})();
try { fs.writeFileSync(EVT_FILE,'[]'); } catch(e){}

// ─── POLLING ESTADO (500ms) ───────────────────────────────────────────────────
let lastPollPhase = gs.phase;
setInterval(() => {
  try {
    const rf = STATE_FILE+'.reset';
    if (fs.existsSync(rf)) {
      try { const ts=parseInt(fs.readFileSync(rf,'utf8')); if(Date.now()-ts<5000){fs.unlinkSync(rf);io.emit('reset');} } catch(e){}
    }
    if (!fs.existsSync(STATE_FILE)) return;
    let raw; try { raw = fs.readFileSync(STATE_FILE,'utf8'); } catch(e){ return; }
    if (raw === lastStateHash) return;
    lastStateHash = raw;
    const fresh = JSON.parse(raw);
    if (!fresh || !fresh.phase || !fresh.modActive) return;
    const oldPl = JSON.stringify(Object.keys(gs.players).sort());
    const newPl = JSON.stringify(Object.keys(fresh.players||{}).sort());
    gs = fresh;
    if (oldPl !== newPl) io.emit('lobbyUpdate', pubState());
    if (lastPollPhase !== gs.phase) {
      console.log('[SYNC]', lastPollPhase, '→', gs.phase);
      if (gs.phase==='phase1') {
        io.emit('phaseChange', { phase:'phase1', state:pubState() });
        setTimeout(syncTurns, 800);
      } else if (gs.phase==='phase2') {
        io.emit('phaseChange', { phase:'phase2', timeA:gs.p2.timeA, timeB:gs.p2.timeB, wordsA:gs.p1.guessedA, wordsB:gs.p1.guessedB });
      } else if (gs.phase==='phase3') {
        io.emit('phaseChange', { phase:'phase3', state:pubState(), wordsA:gs.p3.wordsA, wordsB:gs.p3.wordsB });
      }
      lastPollPhase = gs.phase;
    }
  } catch(e) {}
}, 500);

function syncTurns() {
  ['A','B'].forEach(team => {
    const turn=team==='A'?gs.p1.turnA:gs.p1.turnB, idx=team==='A'?gs.p1.idxA:gs.p1.idxB;
    const words=team==='A'?gs.p1.wordsA:gs.p1.wordsB, passes=team==='A'?gs.p1.passesA:gs.p1.passesB;
    if (!turn||!words.length) return;
    io.to('team'+team).emit('p1:turnUpdate', { team, turn, wordIndex:idx, scores:gs.scores, passes });
    // Enviar p1:yourTurn a sockets locales (cross-proceso)
    // El cliente usa dedup por palabra para no reiniciar timer si ya corre
    const word=words[idx], wd=wFind(word);
    for (const [sid, sock] of io.sockets.sockets) {
      if (sid===turn.mime)    sock.emit('p1:yourTurn',{role:'mime',    word, hints:wd.h});
      if (sid===turn.guesser) sock.emit('p1:yourTurn',{role:'guesser', word});
    }
  });
}

// ─── RELAY EVENTOS (200ms) ────────────────────────────────────────────────────
setInterval(() => {
  try {
    if (!fs.existsSync(EVT_FILE)) return;
    let raw; try { raw=fs.readFileSync(EVT_FILE,'utf8'); } catch(e){ return; }
    if (raw===lastEvtHash) return;
    lastEvtHash=raw;
    const evts=JSON.parse(raw);
    evts.filter(e=>e.pid!==process.pid&&Date.now()-e.ts<2000).forEach(({event,data})=>{
      if      (event==='p1:emoji')       io.to('team'+data.team).emit('p1:emoji',data);
      else if (event==='p1:guessResult') io.to('team'+data.team).emit('p1:guessResult',data);
      else if (event==='p1:wordGuessed') {
        io.to('team'+data.team).emit('p1:wordGuessed',data);
        io.to('team'+(data.team==='A'?'B':'A')).emit('p1:rivalProgress',{team:data.team,count:data.wordNum});
      }
      else if (event==='p1:hint') io.to(data.toId).emit('p1:hint',data);
      else if (event==='reset') io.emit('reset');
    });
  } catch(e){}
}, 200);

// (heartbeat eliminado, se usa estado en disco)

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function shuffle(a){const r=[...a];for(let i=r.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[r[i],r[j]]=[r[j],r[i]];}return r;}
function pick6(){return shuffle(WORDS).slice(0,6).map(x=>x.w);}

function assignTeam(sid) {
  const a=gs.teamA.length, b=gs.teamB.length, team=a<=b?'A':'B';
  const ids=team==='A'?gs.teamA:gs.teamB;
  const uniC=ids.filter(id=>gs.players[id]?.role==='universidad').length;
  let role;
  if (uniC===0&&ids.length<5) role='universidad';
  else {
    const others=['gobierno','empresa','org_civil','comunidad'], cnt={};
    others.forEach(r=>cnt[r]=0);
    ids.forEach(id=>{const r=gs.players[id]?.role;if(cnt[r]!==undefined)cnt[r]++;});
    role=others.reduce((a,b)=>cnt[a]<=cnt[b]?a:b);
  }
  const c=RCOLORS[role], p=gs.players[sid];
  p.role=role;p.roleLabel=RLABELS[role];p.team=team;p.color=c.bg;p.textColor=c.tx;
  (team==='A'?gs.teamA:gs.teamB).push(sid);
}

function pubState() {
  const players={};
  Object.entries(gs.players).forEach(([id,p])=>{
    players[id]={id:p.id,name:p.name,role:p.role,roleLabel:p.roleLabel,team:p.team,
      initials:p.initials,color:p.color,textColor:p.textColor,isModerator:p.isModerator};
  });
  return {phase:gs.phase,players,teamA:gs.teamA,teamB:gs.teamB,scores:gs.scores};
}

// ─── FASE 1 ───────────────────────────────────────────────────────────────────
function nextTurn(team) {
  // Rotación correcta: mime→final, ex-guesser→nuevo mime, ex-obs1→nuevo guesser
  const q=team==='A'?gs.p1.queueA:gs.p1.queueB;
  if (q.length<2) return;
  const old=q.shift(); q.push(old);          // mime va al final
  const mime=q[0], guesser=q.length>1?q[1]:q[0];
  if(team==='A')gs.p1.turnA={mime,guesser};else gs.p1.turnB={mime,guesser};
}

function startTurn(team) {
  const p1=gs.p1, tk=team==='A'?'timerA':'timerB';
  if(p1[tk])clearTimeout(p1[tk]);
  const turn=team==='A'?p1.turnA:p1.turnB;
  const idx=team==='A'?p1.idxA:p1.idxB;
  const words=team==='A'?p1.wordsA:p1.wordsB;
  const passes=team==='A'?p1.passesA:p1.passesB;
  const word=words[idx]; const wd=wFind(word);
  console.log(`[T${team}] ${gs.players[turn.mime]?.name}→${gs.players[turn.guesser]?.name} "${word}"`);
  io.to('team'+team).emit('p1:turnUpdate',{team,turn,wordIndex:idx,scores:gs.scores,passes});
  if(turn.mime)    io.to(turn.mime).emit('p1:yourTurn',{role:'mime',word,hints:wd.h});
  if(turn.guesser) io.to(turn.guesser).emit('p1:yourTurn',{role:'guesser'});
  io.to('moderator').emit('p1:modUpdate',{team,word,idx,mimeName:gs.players[turn.mime]?.name,guesserName:gs.players[turn.guesser]?.name,scores:gs.scores});
  diskSaveSync(); // SYNC: evitar race con el polling
  p1[tk]=setTimeout(()=>doPass(team,'timeout'),TURN_MS);
}

function doPass(team, src) {
  const p1=gs.p1, tk=team==='A'?'timerA':'timerB';
  if(p1[tk]){clearTimeout(p1[tk]);p1[tk]=null;}
  if(src!=='timeout'){gs.scores[team]-=3;if(team==='A')p1.passesA++;else p1.passesB++;}
  // Avanzar a la siguiente palabra NO adivinada
  const words=team==='A'?p1.wordsA:p1.wordsB, guessed=team==='A'?p1.guessedA:p1.guessedB;
  let cur=team==='A'?p1.idxA:p1.idxB;
  for(let i=1;i<=words.length;i++){
    const next=(cur+i)%words.length;
    if(!guessed.includes(words[next])){if(team==='A')p1.idxA=next;else p1.idxB=next;break;}
  }
  nextTurn(team);
  // Guardar ANTES de startTurn para que el polling no sobreescriba el nuevo turno
  diskSaveSync();
  startTurn(team);
  io.emit('scores',gs.scores);
}

function finishP1Team(team) {
  gs.scores[team]+=20;
  if(team==='A'){gs.p1.finA=true;gs.p2.timeA=210;}else{gs.p1.finB=true;gs.p2.timeB=210;}
  const words=team==='A'?gs.p1.guessedA:gs.p1.guessedB;
  io.emit('p1:teamDone',{team,scores:gs.scores,words});
  io.emit('p1:rivalDone',{team,scores:gs.scores});
  if(gs.p1.finA&&gs.p1.finB){
    gs.phase='phase2'; diskSaveSync();
    io.emit('phaseChange',{phase:'phase1Done',scores:gs.scores});
  }
}

// ─── FASE 3 ───────────────────────────────────────────────────────────────────
function startP3Turn(team) {
  const p3=gs.p3, tk=team==='A'?'timerA':'timerB';
  if(p3[tk])clearTimeout(p3[tk]);
  const cur=team==='A'?p3.turnA:p3.turnB, word=team==='A'?p3.wordA:p3.wordB;
  if(cur) io.to(cur).emit('p3:yourTurn',{word,team,story:team==='A'?p3.storyA:p3.storyB,players:Object.values(gs.players).filter(p=>p.team===team)});
  io.emit('p3:turnUpdate',{team,cur,word,curName:gs.players[cur]?.name,story:team==='A'?p3.storyA:p3.storyB});
  p3[tk]=setTimeout(()=>passP3(team,cur,'timeout'),TURN_MS);
}

function passP3(team,fromId,src) {
  const p3=gs.p3, tk=team==='A'?'timerA':'timerB';
  if(p3[tk]){clearTimeout(p3[tk]);p3[tk]=null;}
  if(src!=='timeout'){gs.scores[team]-=3;if(team==='A')p3.passesA++;else p3.passesB++;}
  const used=team==='A'?p3.usedA:p3.usedB, allW=team==='A'?p3.wordsA:p3.wordsB;
  if(used.length>=allW.length){finishP3Team(team);return;}
  const ids=(team==='A'?gs.teamA:gs.teamB).filter(id=>id!==fromId);
  const next=ids.length?ids[Math.floor(Math.random()*ids.length)]:fromId;
  const nw=allW[used.length];
  if(team==='A'){p3.turnA=next;p3.wordA=nw;}else{p3.turnB=next;p3.wordB=nw;}
  startP3Turn(team);
}

function finishP3Team(team) {
  gs.scores[team]+=20;
  if(team==='A')gs.p3.finA=true;else gs.p3.finB=true;
  io.emit('p3:teamDone',{team,scores:gs.scores});
  if(gs.p3.finA&&gs.p3.finB){gs.phase='done';diskSaveSync();io.emit('phaseChange',{phase:'phase3Done'});}
}

function calcSub(team) {
  const p3=gs.p3,ids=team==='A'?gs.teamA:gs.teamB;
  const rcv=new Set(p3.graph.map(e=>e.to));
  const ghosts=ids.filter(id=>!rcv.has(id)&&gs.players[id]?.role!=='universidad');
  const roles=[...new Set(ids.filter(id=>rcv.has(id)).map(id=>gs.players[id]?.role))];
  const crosses=p3.graph.filter(e=>e.fromTeam!==e.toTeam).length;
  const rebounds=p3.graph.filter((e,i)=>i>0&&p3.graph[i-1].from===e.to&&p3.graph[i-1].to===e.from).length;
  const passes=team==='A'?p3.passesA:p3.passesB;
  let s=0;const u=new Set(roles);
  if(u.size>=5)s+=40;else if(u.size===4)s+=20;else if(u.size===3)s+=10;else s-=10;
  if(roles.includes('comunidad'))s+=20;if(roles.includes('org_civil'))s+=20;
  s-=ghosts.length*20;s-=crosses*10;if(rebounds>=2)s-=15;s-=Math.max(0,passes-3)*5;
  return{sub:s,ghosts:ghosts.map(id=>gs.players[id]?.name||'?')};
}

// ─── SOCKETS ──────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[+]', socket.id);

  socket.on('join', ({name='',isModerator=false,password=''}) => {
    try {
      const nm=name.trim(); if(!nm)return;

      // Limpiar socket previo
      if(gs.players[socket.id]){
        gs.teamA=gs.teamA.filter(id=>id!==socket.id);
        gs.teamB=gs.teamB.filter(id=>id!==socket.id);
        delete gs.players[socket.id];
      }

      // Reconexión: mismo nombre
      const prev=Object.entries(gs.players).find(([id,p])=>p.name===nm&&p.isModerator===!!isModerator);
      if(prev){
        const[oid,op]=prev;
        gs.players[socket.id]={...op,id:socket.id};
        delete gs.players[oid];
        gs.teamA=gs.teamA.map(id=>id===oid?socket.id:id);
        gs.teamB=gs.teamB.map(id=>id===oid?socket.id:id);
        if(gs.moderatorId===oid)gs.moderatorId=socket.id;
        const p=gs.players[socket.id];
        if(isModerator){socket.join('moderator');socket.emit('joined',{id:socket.id,isModerator:true,isNew:false});}
        else{socket.join('team'+p.team);socket.emit('joined',{id:socket.id,isModerator:false,isNew:false,role:p.role,roleLabel:p.roleLabel,team:p.team,color:p.color,textColor:p.textColor});}
        const ph=gs.phase;
        if(ph==='lobby') socket.emit('restoreState',{phase:'lobby'});
        else if(ph==='phase1'){
          socket.emit('restoreState',{phase:'phase1',state:pubState(),scores:gs.scores});
          setTimeout(()=>{
            ['A','B'].forEach(t=>{
              const turn=t==='A'?gs.p1.turnA:gs.p1.turnB;
              const idx=t==='A'?gs.p1.idxA:gs.p1.idxB;
              const word=(t==='A'?gs.p1.wordsA:gs.p1.wordsB)[idx];
              if(!word)return;
              if(socket.id===turn?.mime) socket.emit('p1:yourTurn',{role:'mime',word,hints:wFind(word).h});
              if(socket.id===turn?.guesser) socket.emit('p1:yourTurn',{role:'guesser'});
            });
          },300);
        }
        else if(ph==='phase2') socket.emit('restoreState',{phase:'phase2',timeA:gs.p2.timeA,timeB:gs.p2.timeB,wordsA:gs.p1.guessedA,wordsB:gs.p1.guessedB});
        else if(ph==='phase3') socket.emit('restoreState',{phase:'phase3',state:pubState(),wordsA:gs.p3.wordsA,wordsB:gs.p3.wordsB});
        diskSave(); io.emit('lobbyUpdate',pubState());
        console.log('[REJOIN]',nm,ph); return;
      }

      // Nuevo moderador
      if(isModerator){
        if(password!==MOD_PASSWORD){socket.emit('joinError',{msg:'Contraseña incorrecta.'});return;}
        [gs.p1.timerA,gs.p1.timerB,gs.p3.timerA,gs.p3.timerB].forEach(t=>{if(t)clearTimeout(t);});
        gs=makeState(); gs.modActive=true;
        diskSaveSync();
        try{fs.writeFileSync(EVT_FILE,'[]');}catch(e){}
      } else {
        // Verificar moderador activo: memoria O heartbeat
        if(!isModActive()){
          socket.emit('joinError',{msg:'Aún no hay moderador. Espera a que abra la sala.'});return;
        }
        if(!gs.modActive){
          const fresh=diskLoad();
          if(fresh&&fresh.phase==='lobby'&&fresh.modActive){gs=fresh;}
        }
        if(gs.phase!=='lobby'){socket.emit('joinError',{msg:'El juego ya inició.'});return;}
        if(Object.values(gs.players).some(p=>p.name===nm&&!p.isModerator)){
          socket.emit('joinError',{msg:'Ese nombre ya está en uso.'});return;
        }
      }

      // Registrar
      const ini=nm.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);
      gs.players[socket.id]={id:socket.id,name:nm,initials:ini,isModerator:!!isModerator,role:null,roleLabel:null,team:null,color:'#ddd',textColor:'#333'};
      if(isModerator){
        gs.moderatorId=socket.id; socket.join('moderator');
        socket.emit('joined',{id:socket.id,isModerator:true,isNew:true});
      } else {
        assignTeam(socket.id);
        const p=gs.players[socket.id]; socket.join('team'+p.team);
        socket.emit('joined',{id:socket.id,isModerator:false,isNew:true,role:p.role,roleLabel:p.roleLabel,team:p.team,color:p.color,textColor:p.textColor});
      }
      socket.emit('restoreState',{phase:'lobby'});
      diskSave(); io.emit('lobbyUpdate',pubState());
      console.log('[NEW]',nm,gs.players[socket.id]?.team||'mod');
    } catch(e){console.error('[JOIN_ERR]',e.message);}
  });

  socket.on('startGame',()=>{
    if(socket.id!==gs.moderatorId)return;
    gs.phase='phase1';
    gs.p1.wordsA=pick6();gs.p1.wordsB=pick6();
    gs.p1.idxA=0;gs.p1.idxB=0;gs.p1.guessedA=[];gs.p1.guessedB=[];
    gs.p1.passesA=0;gs.p1.passesB=0;gs.p1.finA=false;gs.p1.finB=false;
    gs.p1.queueA=shuffle([...gs.teamA]);gs.p1.queueB=shuffle([...gs.teamB]);
    nextTurn('A');nextTurn('B');
    diskSaveSync();
    io.emit('phaseChange',{phase:'phase1',state:pubState()});
    setTimeout(()=>{startTurn('A');startTurn('B');},800);
  });

  socket.on('p1:emoji',({emoji})=>{
    const p=gs.players[socket.id];if(!p)return;
    const turn=p.team==='A'?gs.p1.turnA:gs.p1.turnB;
    if(turn.mime!==socket.id)return;
    const data={from:socket.id,fromName:p.name,emoji,team:p.team};
    io.to('team'+p.team).emit('p1:emoji',data); evtPush('p1:emoji',data);
  });

  socket.on('p1:guess',({guess})=>{
    try{
      const p=gs.players[socket.id];if(!p)return;
      const team=p.team,p1=gs.p1,turn=team==='A'?p1.turnA:p1.turnB;
      if(turn.guesser!==socket.id)return;
      const idx=team==='A'?p1.idxA:p1.idxB;
      const word=(team==='A'?p1.wordsA:p1.wordsB)[idx];
      const ok=guess.trim().toLowerCase()===word.toLowerCase();
      const grData={from:socket.id,fromName:p.name,guess,correct:ok,team};
      io.to('team'+team).emit('p1:guessResult',grData); evtPush('p1:guessResult',grData);
      if(ok){
        const tk=team==='A'?'timerA':'timerB';
        if(p1[tk]){clearTimeout(p1[tk]);p1[tk]=null;}
        gs.scores[team]+=10;
        const uni=(team==='A'?gs.teamA:gs.teamB).find(id=>gs.players[id]?.role==='universidad');
        if(uni)io.to(uni).emit('p1:wordRevealed',{word,index:idx});
        const wgData={team,wordNum:idx+1,by:p.name,scores:gs.scores};
        io.to('team'+team).emit('p1:wordGuessed',wgData);
        io.to('team'+(team==='A'?'B':'A')).emit('p1:rivalProgress',{team,count:idx+1});
        io.to('moderator').emit('p1:wordGuessed',{...wgData,word});
        evtPush('p1:wordGuessed',wgData);
        if(team==='A'){p1.guessedA.push(word);p1.idxA++;if(p1.idxA>=6){finishP1Team('A');return;}}
        else{p1.guessedB.push(word);p1.idxB++;if(p1.idxB>=6){finishP1Team('B');return;}}
        nextTurn(team);startTurn(team);
      }
    }catch(e){console.error('[GUESS]',e.message);}
  });

  socket.on('p1:pass',()=>{
    const p=gs.players[socket.id];if(!p)return;
    const turn=p.team==='A'?gs.p1.turnA:gs.p1.turnB;
    if(turn.guesser!==socket.id&&turn.mime!==socket.id)return;
    doPass(p.team,'voluntary');
  });

  socket.on('p1:hint',({idx})=>{
    const p=gs.players[socket.id];if(!p)return;
    const team=p.team,p1=gs.p1,turn=team==='A'?p1.turnA:p1.turnB;
    if(turn.guesser!==socket.id)return;
    const word=(team==='A'?p1.wordsA:p1.wordsB)[team==='A'?p1.idxA:p1.idxB];
    const wd=wFind(word);if(idx>=wd.h.length)return;
    gs.scores[team]-=5;
    socket.emit('p1:hint',{hint:wd.h[idx],idx});
    evtPush('p1:hint',{toId:socket.id,hint:wd.h[idx],idx});
    io.to('team'+team).emit('p1:hintUsed',{idx,scores:gs.scores});
    io.emit('scores',gs.scores);
  });

  socket.on('startPhase2',()=>{
    if(socket.id!==gs.moderatorId)return;
    gs.phase='phase2'; diskSaveSync();
    io.emit('phaseChange',{phase:'phase2',timeA:gs.p2.timeA,timeB:gs.p2.timeB,wordsA:gs.p1.guessedA,wordsB:gs.p1.guessedB});
  });

  socket.on('p2:submit',({text,isAuto})=>{
    const p=gs.players[socket.id];if(!p||p.role!=='universidad')return;
    const team=p.team;
    if(team==='A'){gs.p2.declA=text;gs.p2.autoA=!!isAuto;gs.p2.finA=true;if(isAuto)gs.scores.A-=50;}
    else{gs.p2.declB=text;gs.p2.autoB=!!isAuto;gs.p2.finB=true;if(isAuto)gs.scores.B-=50;}
    diskSave(); io.emit('p2:submitted',{team,scores:gs.scores});
    if(gs.p2.finA&&gs.p2.finB)io.emit('phaseChange',{phase:'phase2Done'});
  });

  socket.on('startPhase3',()=>{
    if(socket.id!==gs.moderatorId)return;
    gs.phase='phase3';const p3=gs.p3;
    p3.wordsA=[...gs.p1.guessedA];p3.wordsB=[...gs.p1.guessedB];
    p3.usedA=[];p3.usedB=[];p3.storyA=[];p3.storyB=[];p3.graph=[];
    p3.passesA=0;p3.passesB=0;p3.finA=false;p3.finB=false;
    const uA=gs.teamA.find(id=>gs.players[id]?.role==='universidad')||gs.teamA[0];
    const uB=gs.teamB.find(id=>gs.players[id]?.role==='universidad')||gs.teamB[0];
    p3.turnA=uA;p3.turnB=uB;p3.wordA=p3.wordsA[0];p3.wordB=p3.wordsB[0];
    diskSaveSync();
    io.emit('phaseChange',{phase:'phase3',state:pubState(),wordsA:p3.wordsA,wordsB:p3.wordsB});
    setTimeout(()=>{startP3Turn('A');startP3Turn('B');},500);
  });

  socket.on('p3:sentence',({text,nextId})=>{
    try{
      const p=gs.players[socket.id];if(!p)return;
      const team=p.team,p3=gs.p3;
      if((team==='A'?p3.turnA:p3.turnB)!==socket.id)return;
      const word=team==='A'?p3.wordA:p3.wordB;
      if(!text.toLowerCase().includes(word.toLowerCase())){socket.emit('error',{msg:'Debes incluir "'+word+'"'});return;}
      const tk=team==='A'?'timerA':'timerB';
      if(p3[tk]){clearTimeout(p3[tk]);p3[tk]=null;}
      const ent={playerId:socket.id,playerName:p.name,playerRole:p.roleLabel,playerColor:p.color,playerTextColor:p.textColor,playerInitials:p.initials,text,word,team,isCross:false};
      (team==='A'?p3.storyA:p3.storyB).push(ent);
      (team==='A'?p3.usedA:p3.usedB).push(word);
      gs.scores[team]+=5;
      if(nextId)p3.graph.push({from:socket.id,to:nextId,fromTeam:team,toTeam:gs.players[nextId]?.team,isCross:gs.players[nextId]?.team!==team,fromName:p.name});
      const used=team==='A'?p3.usedA:p3.usedB,allW=team==='A'?p3.wordsA:p3.wordsB;
      diskSave(); io.emit('p3:update',{team,story:team==='A'?p3.storyA:p3.storyB,used,graph:p3.graph,scores:gs.scores});
      if(used.length>=allW.length){finishP3Team(team);return;}
      const nw=allW[used.length],cross=nextId&&gs.players[nextId]?.team!==team;
      if(team==='A'){p3.turnA=nextId;p3.wordA=nw;}else{p3.turnB=nextId;p3.wordB=nw;}
      if(cross){
        io.to(nextId).emit('p3:crossTurn',{word:nw,fromTeam:team});
        io.emit('p3:turnUpdate',{team,cur:nextId,word:nw,curName:gs.players[nextId]?.name,isCross:true,story:team==='A'?p3.storyA:p3.storyB,graph:p3.graph});
        p3[tk]=setTimeout(()=>passP3(team,nextId,'timeout'),TURN_MS);
      } else startP3Turn(team);
    }catch(e){console.error('[P3]',e.message);}
  });

  socket.on('p3:pass',()=>{ const p=gs.players[socket.id];if(!p)return;passP3(p.team,socket.id,'voluntary'); });

  socket.on('showDashboard',()=>{
    if(socket.id!==gs.moderatorId)return;
    const p3=gs.p3,rA=calcSub('A'),rB=calcSub('B');
    const fA=gs.scores.A+rA.sub,fB=gs.scores.B+rB.sub,win=fA>fB?'A':fB>fA?'B':'empate';
    const pl={};Object.entries(gs.players).forEach(([id,p])=>{pl[id]={id:p.id,name:p.name,role:p.role,roleLabel:p.roleLabel,team:p.team,initials:p.initials,color:p.color,textColor:p.textColor};});
    io.emit('dashboard',{scores:gs.scores,subA:rA.sub,subB:rB.sub,finalA:fA,finalB:fB,winner:win,declA:gs.p2.declA,declB:gs.p2.declB,autoA:gs.p2.autoA,autoB:gs.p2.autoB,storyA:p3.storyA,storyB:p3.storyB,graph:p3.graph,ghostsA:rA.ghosts,ghostsB:rB.ghosts,wordsA:p3.wordsA,wordsB:p3.wordsB,players:pl});
  });

  socket.on('reset',()=>{
    if(socket.id!==gs.moderatorId)return;
    [gs.p1.timerA,gs.p1.timerB,gs.p3.timerA,gs.p3.timerB].forEach(t=>{if(t)clearTimeout(t);});
    gs=makeState(); gs.modActive=true;
    diskSaveSync();
    // Propagar reset a otros procesos via evento
    try{
      const resetEvt=[{event:'reset',data:{},ts:Date.now(),pid:process.pid}];
      fs.writeFileSync(EVT_FILE,JSON.stringify(resetEvt));
    }catch(e){}
    io.emit('reset'); console.log('[RESET]');
  });

  socket.on('disconnect',()=>{
    const sid=socket.id,wasMod=sid===gs.moderatorId;
    setTimeout(()=>{
      if(!gs.players[sid])return;
      delete gs.players[sid];
      gs.teamA=gs.teamA.filter(id=>id!==sid);
      gs.teamB=gs.teamB.filter(id=>id!==sid);
      if(wasMod){gs.modActive=false;console.log('[MOD OFF]');}
      diskSave(); io.emit('lobbyUpdate',pubState());
    },5000);
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log('[START] PID:',process.pid,'port:',PORT));
