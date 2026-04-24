const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ==================== ESTADO DEL JUEGO ====================

const ROLES = ['universidad', 'gobierno', 'empresa', 'org_civil', 'comunidad'];
const ROLE_LABELS = {
  universidad: 'Universidad',
  gobierno: 'Gobierno Local',
  empresa: 'Empresa',
  org_civil: 'Org. Civil',
  comunidad: 'Comunidad'
};

const WORD_BANK = [
  { word: 'ecosistema',    hints: ['todo está conectado', 'red de vida interdependiente', 'empieza con E', '9 letras'] },
  { word: 'carbono',       hints: ['lo que emite un motor', 'huella que deja la industria', 'empieza con C', '7 letras'] },
  { word: 'resiliencia',   hints: ['no es resistir, es adaptarse', 'capacidad de recuperarse del daño', 'empieza con R', '11 letras'] },
  { word: 'biodiversidad', hints: ['no es solo naturaleza', 'variedad de formas de vida en un lugar', 'empieza con B', '13 letras'] },
  { word: 'territorio',    hints: ['donde ocurre todo', 'espacio vivido, no solo geográfico', 'empieza con T', '9 letras'] },
  { word: 'huella',        hints: ['lo que dejas al pasar', 'impacto medible sobre el ambiente', 'empieza con H', '6 letras'] },
  { word: 'restauración',  hints: ['no es conservar, es devolver', 'proceso de recuperar lo dañado', 'empieza con R', '12 letras'] },
  { word: 'transición',    hints: ['no es un destino, es un camino', 'cambio estructural hacia otro modelo', 'empieza con T', '10 letras'] },
  { word: 'campus',        hints: ['más que edificios', 'el territorio propio de la universidad', 'empieza con C', '6 letras'] },
  { word: 'residuos',      hints: ['lo que queda después', 'materiales sin uso que generamos', 'empieza con R', '8 letras'] },
  { word: 'comunidad',     hints: ['no es individuo', 'grupo que comparte un territorio', 'empieza con C', '9 letras'] },
  { word: 'gobernanza',    hints: ['no es solo gobierno', 'cómo se toman las decisiones colectivas', 'empieza con G', '10 letras'] },
  { word: 'compensación',  hints: ['no es solución, es deuda', 'acción para equilibrar el daño causado', 'empieza con C', '12 letras'] },
  { word: 'compromiso',    hints: ['más que una promesa', 'obligación asumida voluntariamente', 'empieza con C', '10 letras'] },
  { word: 'neutralidad',   hints: ['el punto de equilibrio', 'cuando lo que emites equivale a lo que absorbes', 'empieza con N', '11 letras'] }
];

// Estado global del juego
let gameState = {
  phase: 'lobby',       // lobby | phase1 | phase2 | phase3 | dashboard
  players: {},          // socketId -> player object
  teamA: [],            // array de socketIds
  teamB: [],            // array de socketIds
  scores: { A: 0, B: 0 },
  phase1: {
    wordsA: [],         // palabras sorteadas para equipo A
    wordsB: [],         // palabras sorteadas para equipo B
    currentIndexA: 0,
    currentIndexB: 0,
    guessedA: [],       // palabras adivinadas equipo A
    guessedB: [],       // palabras adivinadas equipo B
    queueA: [],         // fila de turnos equipo A (socketIds)
    queueB: [],
    turnA: { mime: null, guesser: null },
    turnB: { mime: null, guesser: null },
    timerA: null,
    timerB: null,
    passesA: 0,
    passesB: 0,
    hintsUsedA: 0,
    hintsUsedB: 0,
    finishedA: false,
    finishedB: false
  },
  phase2: {
    declarationA: null,
    declarationB: null,
    isAutoA: false,
    isAutob: false,
    timerA: null,
    timerB: null,
    timeA: 210,   // 3:30 si ganaron fase 1
    timeB: 180,   // 3:00 base
    finishedA: false,
    finishedB: false
  },
  phase3: {
    storyA: [],   // array de { playerId, text, word, isCross }
    storyB: [],
    wordsA: [],   // las 6 palabras del equipo A
    wordsB: [],
    usedWordsA: [],
    usedWordsB: [],
    currentTurnA: null,  // socketId de quien tiene el turno en A
    currentTurnB: null,
    wordForCurrentA: null,
    wordForCurrentB: null,
    graph: [],    // array de { from, to, team, isCross }
    passesA: 0,
    passesB: 0,
    timerA: null,
    timerB: null,
    finishedA: false,
    finishedB: false,
    lastPasserA: null,  // para no bloquear devoluciones (eliminado según diseño)
    lastPasserB: null
  },
  moderatorId: null
};

// ==================== HELPERS ====================

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getPublicState() {
  const players = {};
  Object.entries(gameState.players).forEach(([id, p]) => {
    players[id] = {
      id: p.id,
      name: p.name,
      role: p.role,
      roleLabel: p.roleLabel,
      team: p.team,
      initials: p.initials,
      color: p.color,
      textColor: p.textColor,
      isModerator: p.isModerator
    };
  });
  return {
    phase: gameState.phase,
    players,
    teamA: gameState.teamA,
    teamB: gameState.teamB,
    scores: gameState.scores
  };
}

function getPlayersByTeam(team) {
  return (team === 'A' ? gameState.teamA : gameState.teamB)
    .map(id => gameState.players[id])
    .filter(Boolean);
}

function getRoleColor(role) {
  const colors = {
    universidad: { bg: '#B5D4F4', text: '#0C447C' },
    gobierno:    { bg: '#FAC775', text: '#633806' },
    empresa:     { bg: '#F4C0D1', text: '#72243E' },
    org_civil:   { bg: '#CECBF6', text: '#3C3489' },
    comunidad:   { bg: '#D3D1C7', text: '#444441' }
  };
  return colors[role] || { bg: '#ddd', text: '#333' };
}

function assignRolesAndTeams(players) {
  const ids = Object.keys(players).filter(id => !players[id].isModerator);
  const shuffledIds = shuffle(ids);
  const total = shuffledIds.length;
  const halfA = Math.ceil(total / 2);

  const teamA = shuffledIds.slice(0, halfA);
  const teamB = shuffledIds.slice(halfA);

  // Assign roles ensuring at least one universidad per team
  const assignRolesToTeam = (teamIds) => {
    const roles = [];
    const uniCount = Math.max(1, Math.floor(teamIds.length * 0.2));
    for (let i = 0; i < uniCount; i++) roles.push('universidad');
    const otherRoles = ['gobierno', 'empresa', 'org_civil', 'comunidad'];
    let i = 0;
    while (roles.length < teamIds.length) {
      roles.push(otherRoles[i % otherRoles.length]);
      i++;
    }
    return shuffle(roles);
  };

  const rolesA = assignRolesToTeam(teamA);
  const rolesB = assignRolesToTeam(teamB);

  teamA.forEach((id, i) => {
    const role = rolesA[i];
    const c = getRoleColor(role);
    players[id].role = role;
    players[id].roleLabel = ROLE_LABELS[role];
    players[id].team = 'A';
    players[id].color = c.bg;
    players[id].textColor = c.text;
  });

  teamB.forEach((id, i) => {
    const role = rolesB[i];
    const c = getRoleColor(role);
    players[id].role = role;
    players[id].roleLabel = ROLE_LABELS[role];
    players[id].team = 'B';
    players[id].color = c.bg;
    players[id].textColor = c.text;
  });

  return { teamA, teamB };
}

function pick6Words() {
  return shuffle(WORD_BANK).slice(0, 6).map(w => w.word);
}

function getWordData(word) {
  return WORD_BANK.find(w => w.word === word);
}

function buildQueueForTeam(teamIds) {
  // Filter out universidad for later, put others first, append uni at end so they cycle through
  return shuffle(teamIds);
}

function nextInQueue(queue) {
  if (queue.length === 0) return null;
  const next = queue.shift();
  queue.push(next);
  return next;
}

function advanceTurnForTeam(team) {
  const p1 = gameState.phase1;
  if (team === 'A') {
    const mime = nextInQueue(p1.queueA);
    let guesser = nextInQueue(p1.queueA);
    // mime and guesser can't be same
    if (mime === guesser) guesser = nextInQueue(p1.queueA);
    p1.turnA = { mime, guesser };
  } else {
    const mime = nextInQueue(p1.queueB);
    let guesser = nextInQueue(p1.queueB);
    if (mime === guesser) guesser = nextInQueue(p1.queueB);
    p1.turnB = { mime, guesser };
  }
}

function startTeamTurn(team) {
  const p1 = gameState.phase1;
  const timerKey = team === 'A' ? 'timerA' : 'timerB';

  if (p1[timerKey]) clearTimeout(p1[timerKey]);

  p1[timerKey] = setTimeout(() => {
    // Time's up — auto pass
    handlePass(team, 'timeout');
  }, 30000);

  const turn = team === 'A' ? p1.turnA : p1.turnB;
  const currentIndex = team === 'A' ? p1.currentIndexA : p1.currentIndexB;
  const words = team === 'A' ? p1.wordsA : p1.wordsB;
  const currentWord = words[currentIndex];
  const wordData = getWordData(currentWord);

  // Send word only to mime
  if (turn.mime && gameState.players[turn.mime]) {
    io.to(turn.mime).emit('phase1:yourTurn', {
      role: 'mime',
      word: currentWord,
      hints: wordData ? wordData.hints : []
    });
  }

  // Send guesser notification
  if (turn.guesser && gameState.players[turn.guesser]) {
    io.to(turn.guesser).emit('phase1:yourTurn', {
      role: 'guesser',
      word: null
    });
  }

  // Broadcast turn update to team
  const teamRoom = `team${team}`;
  io.to(teamRoom).emit('phase1:turnUpdate', {
    team,
    turn: { mime: turn.mime, guesser: turn.guesser },
    wordIndex: currentIndex,
    scores: gameState.scores,
    passes: team === 'A' ? p1.passesA : p1.passesB
  });
}

function handlePass(team, source) {
  const p1 = gameState.phase1;
  const timerKey = team === 'A' ? 'timerA' : 'timerB';
  if (p1[timerKey]) { clearTimeout(p1[timerKey]); p1[timerKey] = null; }

  if (source !== 'timeout') {
    if (team === 'A') { p1.passesA++; gameState.scores.A -= 3; }
    else              { p1.passesB++; gameState.scores.B -= 3; }
  }

  // Rotate word back into bank (shuffle back)
  // Word stays available — just advance turn
  advanceTurnForTeam(team);
  startTeamTurn(team);

  io.emit('game:scoresUpdate', gameState.scores);
}

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // JOIN GAME
  socket.on('player:join', ({ name, isModerator }) => {
    const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    gameState.players[socket.id] = {
      id: socket.id,
      name,
      initials,
      isModerator: !!isModerator,
      role: null,
      roleLabel: null,
      team: null,
      color: '#ddd',
      textColor: '#333'
    };

    if (isModerator) {
      gameState.moderatorId = socket.id;
      socket.join('moderator');
    }

    // Broadcast updated lobby
    io.emit('lobby:update', getPublicState());
    socket.emit('player:joined', { id: socket.id, name });
    console.log(`${name} joined (mod: ${isModerator})`);
  });

  // MODERATOR STARTS GAME
  socket.on('moderator:startGame', () => {
    if (socket.id !== gameState.moderatorId) return;

    const { teamA, teamB } = assignRolesAndTeams(gameState.players);
    gameState.teamA = teamA;
    gameState.teamB = teamB;

    // Join team rooms
    teamA.forEach(id => {
      const s = io.sockets.sockets.get(id);
      if (s) s.join('teamA');
    });
    teamB.forEach(id => {
      const s = io.sockets.sockets.get(id);
      if (s) s.join('teamB');
    });

    // Send each player their role
    Object.values(gameState.players).forEach(p => {
      if (!p.isModerator) {
        io.to(p.id).emit('player:roleAssigned', {
          role: p.role,
          roleLabel: p.roleLabel,
          team: p.team,
          color: p.color,
          textColor: p.textColor
        });
      }
    });

    io.emit('game:phaseChange', { phase: 'roleReveal', state: getPublicState() });
    console.log('Game started, roles assigned');
  });

  // MODERATOR STARTS PHASE 1
  socket.on('moderator:startPhase1', () => {
    if (socket.id !== gameState.moderatorId) return;
    gameState.phase = 'phase1';

    // Sort 6 words for each team
    gameState.phase1.wordsA = pick6Words();
    gameState.phase1.wordsB = pick6Words();
    gameState.phase1.currentIndexA = 0;
    gameState.phase1.currentIndexB = 0;
    gameState.phase1.guessedA = [];
    gameState.phase1.guessedB = [];
    gameState.phase1.passesA = 0;
    gameState.phase1.passesB = 0;
    gameState.phase1.finishedA = false;
    gameState.phase1.finishedB = false;

    // Build queues
    gameState.phase1.queueA = buildQueueForTeam([...gameState.teamA]);
    gameState.phase1.queueB = buildQueueForTeam([...gameState.teamB]);

    // Set first turns
    advanceTurnForTeam('A');
    advanceTurnForTeam('B');

    io.emit('game:phaseChange', { phase: 'phase1', state: getPublicState() });

    // Start timers
    startTeamTurn('A');
    startTeamTurn('B');

    console.log('Phase 1 started');
  });

  // PHASE 1: SEND EMOJI HINT
  socket.on('phase1:sendEmoji', ({ emoji }) => {
    const player = gameState.players[socket.id];
    if (!player) return;
    const team = player.team;
    const turn = team === 'A' ? gameState.phase1.turnA : gameState.phase1.turnB;
    if (turn.mime !== socket.id) return;

    io.to(`team${team}`).emit('phase1:emojiReceived', {
      from: socket.id,
      fromName: player.name,
      emoji,
      team
    });
  });

  // PHASE 1: GUESS
  socket.on('phase1:guess', ({ guess }) => {
    const player = gameState.players[socket.id];
    if (!player) return;
    const team = player.team;
    const p1 = gameState.phase1;
    const turn = team === 'A' ? p1.turnA : p1.turnB;
    if (turn.guesser !== socket.id) return;

    const currentIndex = team === 'A' ? p1.currentIndexA : p1.currentIndexB;
    const words = team === 'A' ? p1.wordsA : p1.wordsB;
    const currentWord = words[currentIndex];

    const correct = guess.toLowerCase().trim() === currentWord.toLowerCase().trim();

    io.to(`team${team}`).emit('phase1:guessAttempt', {
      from: socket.id,
      fromName: player.name,
      guess,
      correct,
      team
    });

    if (correct) {
      const timerKey = team === 'A' ? 'timerA' : 'timerB';
      if (p1[timerKey]) { clearTimeout(p1[timerKey]); p1[timerKey] = null; }

      // Add points
      gameState.scores[team] += 10;

      // Universidad sees the real word
      const uniId = (team === 'A' ? gameState.teamA : gameState.teamB)
        .find(id => gameState.players[id]?.role === 'universidad');
      if (uniId) {
        io.to(uniId).emit('phase1:wordRevealed', {
          word: currentWord,
          index: currentIndex
        });
      }

      // Notify team (non-uni see "Palabra X ✓")
      io.to(`team${team}`).emit('phase1:wordGuessed', {
        index: currentIndex,
        wordNumber: currentIndex + 1,
        team,
        byPlayer: player.name,
        scores: gameState.scores
      });

      // Advance word
      if (team === 'A') {
        p1.guessedA.push(currentWord);
        p1.currentIndexA++;
        if (p1.currentIndexA >= 6) {
          p1.finishedA = true;
          endPhase1Team('A');
          return;
        }
      } else {
        p1.guessedB.push(currentWord);
        p1.currentIndexB++;
        if (p1.currentIndexB >= 6) {
          p1.finishedB = true;
          endPhase1Team('B');
          return;
        }
      }

      // Advance turn for next word
      advanceTurnForTeam(team);
      startTeamTurn(team);
    }
  });

  // PHASE 1: PASS
  socket.on('phase1:pass', () => {
    const player = gameState.players[socket.id];
    if (!player) return;
    handlePass(player.team, 'voluntary');
  });

  // PHASE 1: REQUEST HINT
  socket.on('phase1:requestHint', ({ hintIndex }) => {
    const player = gameState.players[socket.id];
    if (!player) return;
    const team = player.team;
    const p1 = gameState.phase1;
    const turn = team === 'A' ? p1.turnA : p1.turnB;
    if (turn.guesser !== socket.id) return;

    const currentIndex = team === 'A' ? p1.currentIndexA : p1.currentIndexB;
    const words = team === 'A' ? p1.wordsA : p1.wordsB;
    const wordData = getWordData(words[currentIndex]);
    if (!wordData || hintIndex >= wordData.hints.length) return;

    gameState.scores[team] -= 5;
    const hint = wordData.hints[hintIndex];

    socket.emit('phase1:hint', { hint, hintIndex });
    io.emit('game:scoresUpdate', gameState.scores);
  });

  // PHASE 2: SUBMIT DECLARATION
  socket.on('phase2:submitDeclaration', ({ text, isAuto }) => {
    const player = gameState.players[socket.id];
    if (!player || player.role !== 'universidad') return;
    const team = player.team;

    if (team === 'A') {
      gameState.phase2.declarationA = text;
      gameState.phase2.isAutoA = !!isAuto;
      gameState.phase2.finishedA = true;
      if (isAuto) gameState.scores.A -= 50;
    } else {
      gameState.phase2.declarationB = text;
      gameState.phase2.isAutoB = !!isAuto;
      gameState.phase2.finishedB = true;
      if (isAuto) gameState.scores.B -= 50;
    }

    io.to(`team${team}`).emit('phase2:declarationReceived', { team });
    io.to('moderator').emit('phase2:declarationMod', { team, text: text.slice(0, 50) + '...' });

    if (gameState.phase2.finishedA && gameState.phase2.finishedB) {
      io.emit('game:phaseChange', { phase: 'phase2Done' });
    }
  });

  // MODERATOR STARTS PHASE 3
  socket.on('moderator:startPhase3', () => {
    if (socket.id !== gameState.moderatorId) return;
    gameState.phase = 'phase3';

    gameState.phase3.wordsA = [...gameState.phase1.guessedA];
    gameState.phase3.wordsB = [...gameState.phase1.guessedB];
    gameState.phase3.usedWordsA = [];
    gameState.phase3.usedWordsB = [];
    gameState.phase3.storyA = [];
    gameState.phase3.storyB = [];
    gameState.phase3.graph = [];
    gameState.phase3.passesA = 0;
    gameState.phase3.passesB = 0;
    gameState.phase3.finishedA = false;
    gameState.phase3.finishedB = false;

    // Universidad starts for each team
    const uniA = gameState.teamA.find(id => gameState.players[id]?.role === 'universidad');
    const uniB = gameState.teamB.find(id => gameState.players[id]?.role === 'universidad');

    gameState.phase3.currentTurnA = uniA || gameState.teamA[0];
    gameState.phase3.currentTurnB = uniB || gameState.teamB[0];

    // First word = first word from phase 2 declaration (first guessed word)
    gameState.phase3.wordForCurrentA = gameState.phase3.wordsA[0];
    gameState.phase3.wordForCurrentB = gameState.phase3.wordsB[0];

    io.emit('game:phaseChange', { phase: 'phase3', state: getPublicState() });

    startPhase3Turn('A');
    startPhase3Turn('B');
  });

  function startPhase3Turn(team) {
    const p3 = gameState.phase3;
    const timerKey = team === 'A' ? 'timerA' : 'timerB';
    if (p3[timerKey]) clearTimeout(p3[timerKey]);

    const currentId = team === 'A' ? p3.currentTurnA : p3.currentTurnB;
    const word = team === 'A' ? p3.wordForCurrentA : p3.wordForCurrentB;
    const story = team === 'A' ? p3.storyA : p3.storyB;

    // Notify player with their turn
    if (currentId) {
      io.to(currentId).emit('phase3:yourTurn', {
        word,
        team,
        storyContext: story.map(s => s.text).join(' ')
      });
    }

    // Broadcast turn to everyone
    io.emit('phase3:turnUpdate', {
      team,
      currentPlayer: currentId,
      currentPlayerName: gameState.players[currentId]?.name,
      word,
      story: team === 'A' ? p3.storyA : p3.storyB
    });

    // 1 minute timer
    p3[timerKey] = setTimeout(() => {
      handlePhase3Pass(team, currentId, 'timeout');
    }, 60000);
  }

  // PHASE 3: SUBMIT SENTENCE
  socket.on('phase3:submitSentence', ({ text, nextPlayerId }) => {
    const player = gameState.players[socket.id];
    if (!player) return;
    const team = player.team;
    const p3 = gameState.phase3;

    const currentTurn = team === 'A' ? p3.currentTurnA : p3.currentTurnB;
    if (currentTurn !== socket.id) return;

    const timerKey = team === 'A' ? 'timerA' : 'timerB';
    if (p3[timerKey]) { clearTimeout(p3[timerKey]); p3[timerKey] = null; }

    const word = team === 'A' ? p3.wordForCurrentA : p3.wordForCurrentB;

    // Verify word is used
    if (!text.toLowerCase().includes(word.toLowerCase())) {
      socket.emit('phase3:error', { message: 'Debes incluir la palabra "' + word + '"' });
      return;
    }

    // Add to story
    const storyEntry = {
      playerId: socket.id,
      playerName: player.name,
      playerRole: player.roleLabel,
      playerColor: player.color,
      playerTextColor: player.textColor,
      playerInitials: player.initials,
      text,
      word,
      team,
      isCross: false
    };

    if (team === 'A') p3.storyA.push(storyEntry);
    else p3.storyB.push(storyEntry);

    // Mark word as used
    if (team === 'A') p3.usedWordsA.push(word);
    else p3.usedWordsB.push(word);

    // Add to graph
    if (nextPlayerId) {
      p3.graph.push({
        from: socket.id,
        to: nextPlayerId,
        fromName: player.name,
        fromRole: player.roleLabel,
        fromTeam: team,
        toTeam: gameState.players[nextPlayerId]?.team,
        isCross: gameState.players[nextPlayerId]?.team !== team
      });
    }

    // Add points
    gameState.scores[team] += 5;

    // Broadcast story update
    io.emit('phase3:storyUpdate', {
      team,
      story: team === 'A' ? p3.storyA : p3.storyB,
      usedWords: team === 'A' ? p3.usedWordsA : p3.usedWordsB,
      graph: p3.graph,
      scores: gameState.scores
    });

    // Check if team finished
    const usedWords = team === 'A' ? p3.usedWordsA : p3.usedWordsB;
    const allWords = team === 'A' ? p3.wordsA : p3.wordsB;
    if (usedWords.length >= allWords.length) {
      endPhase3Team(team);
      return;
    }

    // Get next word
    const nextWordIndex = usedWords.length;
    const nextWord = allWords[nextWordIndex];

    // Set next turn
    let nextPlayer = nextPlayerId;
    let isCrossPlay = false;

    if (!nextPlayer || gameState.players[nextPlayerId]?.team !== team) {
      // Cross team play
      isCrossPlay = true;
      nextPlayer = nextPlayerId;
    }

    if (team === 'A') {
      p3.currentTurnA = nextPlayer;
      p3.wordForCurrentA = nextWord;
    } else {
      p3.currentTurnB = nextPlayer;
      p3.wordForCurrentB = nextWord;
    }

    // If cross team play, notify that player with their team context
    if (isCrossPlay && nextPlayer) {
      const crossTeam = gameState.players[nextPlayer]?.team;
      io.to(nextPlayer).emit('phase3:crossTeamTurn', {
        word: nextWord,
        fromTeam: team,
        toTeam: crossTeam
      });
      // Start timer for cross player
      const crossTimerKey = team === 'A' ? 'timerA' : 'timerB';
      if (p3[crossTimerKey]) clearTimeout(p3[crossTimerKey]);
      p3[crossTimerKey] = setTimeout(() => {
        handlePhase3Pass(team, nextPlayer, 'timeout');
      }, 60000);

      io.emit('phase3:turnUpdate', {
        team,
        currentPlayer: nextPlayer,
        currentPlayerName: gameState.players[nextPlayer]?.name,
        word: nextWord,
        isCross: true,
        story: team === 'A' ? p3.storyA : p3.storyB
      });
    } else {
      startPhase3Turn(team);
    }
  });

  // PHASE 3: PASS
  socket.on('phase3:pass', () => {
    const player = gameState.players[socket.id];
    if (!player) return;
    handlePhase3Pass(player.team, socket.id, 'voluntary');
  });

  function handlePhase3Pass(team, passerId, source) {
    const p3 = gameState.phase3;
    const timerKey = team === 'A' ? 'timerA' : 'timerB';
    if (p3[timerKey]) { clearTimeout(p3[timerKey]); p3[timerKey] = null; }

    if (source !== 'timeout') {
      gameState.scores[team] -= 3;
      if (team === 'A') p3.passesA++;
      else p3.passesB++;
    }

    // System randomly picks next player — can cross to other team
    const allPlayers = [...gameState.teamA, ...gameState.teamB]
      .filter(id => id !== passerId);
    const randomNext = allPlayers[Math.floor(Math.random() * allPlayers.length)];
    const nextTeam = gameState.players[randomNext]?.team;
    const isCross = nextTeam !== team;

    const word = team === 'A' ? p3.wordForCurrentA : p3.wordForCurrentB;

    if (isCross) {
      // Cross team turn
      p3.graph.push({
        from: passerId,
        to: randomNext,
        fromName: gameState.players[passerId]?.name,
        fromTeam: team,
        toTeam: nextTeam,
        isCross: true,
        isPass: true
      });

      io.to(randomNext).emit('phase3:crossTeamTurn', {
        word,
        fromTeam: team
      });

      if (team === 'A') p3.currentTurnA = randomNext;
      else p3.currentTurnB = randomNext;

      io.emit('phase3:turnUpdate', {
        team,
        currentPlayer: randomNext,
        currentPlayerName: gameState.players[randomNext]?.name,
        word,
        isCross: true,
        story: team === 'A' ? p3.storyA : p3.storyB,
        graph: p3.graph
      });

      const crossTimerKey = team === 'A' ? 'timerA' : 'timerB';
      p3[crossTimerKey] = setTimeout(() => {
        handlePhase3Pass(team, randomNext, 'timeout');
      }, 60000);
    } else {
      if (team === 'A') p3.currentTurnA = randomNext;
      else p3.currentTurnB = randomNext;

      startPhase3Turn(team);
    }

    io.emit('game:scoresUpdate', gameState.scores);
  }

  function endPhase1Team(team) {
    const p1 = gameState.phase1;
    const winner = team;
    gameState.scores[team] += 20;

    // Winner gets time bonus in phase 2
    if (team === 'A') {
      gameState.phase2.timeA = 210; // 3:30
      gameState.phase2.timeB = 180;
    } else {
      gameState.phase2.timeB = 210;
      gameState.phase2.timeA = 180;
    }

    io.emit('phase1:teamFinished', {
      team,
      scores: gameState.scores,
      guessedWords: team === 'A' ? p1.guessedA : p1.guessedB,
      passes: team === 'A' ? p1.passesA : p1.passesB
    });

    // Check if both finished
    if (p1.finishedA && p1.finishedB) {
      gameState.phase = 'phase2';
      io.emit('game:phaseChange', { phase: 'phase1Done', winner, scores: gameState.scores });
    }
  }

  function endPhase3Team(team) {
    const p3 = gameState.phase3;
    if (team === 'A') p3.finishedA = true;
    else p3.finishedB = true;

    gameState.scores[team] += 20;

    io.emit('phase3:teamFinished', {
      team,
      story: team === 'A' ? p3.storyA : p3.storyB,
      scores: gameState.scores
    });

    if (p3.finishedA && p3.finishedB) {
      gameState.phase = 'dashboard';
      computeFinalScores();
    }
  }

  function computeFinalScores() {
    const p3 = gameState.phase3;
    const graph = p3.graph;

    // --- SUBYACENTE EQUIPO A ---
    const nodesA = new Set(graph.filter(e => e.fromTeam === 'A').map(e => e.from)
      .concat(graph.filter(e => e.toTeam === 'A' && !e.isCross).map(e => e.to)));
    const rolesA = [...nodesA].map(id => gameState.players[id]?.role).filter(Boolean);
    const uniqueRolesA = new Set(rolesA);
    const ghostsA = gameState.teamA.filter(id => !nodesA.has(id));
    const crossesA = graph.filter(e => e.isCross && e.fromTeam === 'A').length;
    const rebounceA = graph.filter((e, i, arr) =>
      i > 0 && e.from === arr[i-1].to && e.to === arr[i-1].from && e.fromTeam === 'A'
    ).length;

    let subA = 0;
    if (uniqueRolesA.size >= 5) subA += 40;
    else if (uniqueRolesA.size === 4) subA += 20;
    else if (uniqueRolesA.size === 3) subA += 10;
    else subA -= 10;

    if (rolesA.includes('comunidad')) subA += 20;
    if (rolesA.includes('org_civil')) subA += 20;
    subA -= ghostsA.length * 20;
    subA -= crossesA * 10;
    if (rebounceA >= 2) subA -= 15;
    const extraPassesA = Math.max(0, p3.passesA - 3);
    subA -= extraPassesA * 5;

    // --- SUBYACENTE EQUIPO B ---
    const nodesB = new Set(graph.filter(e => e.fromTeam === 'B').map(e => e.from)
      .concat(graph.filter(e => e.toTeam === 'B' && !e.isCross).map(e => e.to)));
    const rolesB = [...nodesB].map(id => gameState.players[id]?.role).filter(Boolean);
    const uniqueRolesB = new Set(rolesB);
    const ghostsB = gameState.teamB.filter(id => !nodesB.has(id));
    const crossesB = graph.filter(e => e.isCross && e.fromTeam === 'B').length;
    const rebounceB = graph.filter((e, i, arr) =>
      i > 0 && e.from === arr[i-1].to && e.to === arr[i-1].from && e.fromTeam === 'B'
    ).length;

    let subB = 0;
    if (uniqueRolesB.size >= 5) subB += 40;
    else if (uniqueRolesB.size === 4) subB += 20;
    else if (uniqueRolesB.size === 3) subB += 10;
    else subB -= 10;

    if (rolesB.includes('comunidad')) subB += 20;
    if (rolesB.includes('org_civil')) subB += 20;
    subB -= ghostsB.length * 20;
    subB -= crossesB * 10;
    if (rebounceB >= 2) subB -= 15;
    const extraPassesB = Math.max(0, p3.passesB - 3);
    subB -= extraPassesB * 5;

    const finalA = gameState.scores.A + subA;
    const finalB = gameState.scores.B + subB;
    const winner = finalA > finalB ? 'A' : finalB > finalA ? 'B' : 'empate';

    io.emit('game:dashboard', {
      scores: gameState.scores,
      subyacenteA: subA,
      subyacenteB: subB,
      finalA,
      finalB,
      winner,
      declarationA: gameState.phase2.declarationA,
      declarationB: gameState.phase2.declarationB,
      isAutoA: gameState.phase2.isAutoA,
      isAutoB: gameState.phase2.isAutoB,
      storyA: p3.storyA,
      storyB: p3.storyB,
      graph: p3.graph,
      ghostsA: ghostsA.map(id => gameState.players[id]?.name),
      ghostsB: ghostsB.map(id => gameState.players[id]?.name),
      wordsA: p3.wordsA,
      wordsB: p3.wordsB,
      players: getPublicState().players
    });
  }

  // DISCONNECT
  socket.on('disconnect', () => {
    const player = gameState.players[socket.id];
    if (player) {
      console.log(`${player.name} disconnected`);
      delete gameState.players[socket.id];
      io.emit('lobby:update', getPublicState());
    }
  });

  // MODERATOR RESET
  socket.on('moderator:reset', () => {
    if (socket.id !== gameState.moderatorId) return;
    gameState = {
      phase: 'lobby',
      players: {},
      teamA: [],
      teamB: [],
      scores: { A: 0, B: 0 },
      phase1: { wordsA:[], wordsB:[], currentIndexA:0, currentIndexB:0, guessedA:[], guessedB:[], queueA:[], queueB:[], turnA:{mime:null,guesser:null}, turnB:{mime:null,guesser:null}, timerA:null, timerB:null, passesA:0, passesB:0, hintsUsedA:0, hintsUsedB:0, finishedA:false, finishedB:false },
      phase2: { declarationA:null, declarationB:null, isAutoA:false, isAutoB:false, timerA:null, timerB:null, timeA:180, timeB:180, finishedA:false, finishedB:false },
      phase3: { storyA:[], storyB:[], wordsA:[], wordsB:[], usedWordsA:[], usedWordsB:[], currentTurnA:null, currentTurnB:null, wordForCurrentA:null, wordForCurrentB:null, graph:[], passesA:0, passesB:0, timerA:null, timerB:null, finishedA:false, finishedB:false, lastPasserA:null, lastPasserB:null },
      moderatorId: null
    };
    io.emit('game:reset');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Desacople server running on port ${PORT}`);
});
