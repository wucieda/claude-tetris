'use strict';

const COLS = 10;
const ROWS = 20;
const BLOCK = 30;

const COLORS = [
  null,
  '#4dd0e1', // I - cyan
  '#ffd54f', // O - yellow
  '#ba68c8', // T - purple
  '#81c784', // S - green
  '#e57373', // Z - red
  '#7986cb', // J - indigo
  '#90caf9', // L - pale blue
  '#ffb74d', // + (plus pentominó) - naranja
  '#4db6ac', // U (pentominó) - verde azulado
  '#f06292', // Y (pentominó) - rosa
  '#fff176', // 1x1 (recompensa) - dorado
  '#90a4ae', // 3x3 hueca (reto) - gris azulado
];

const PIECES = [
  null,
  [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], // I
  [[2,2],[2,2]],                               // O
  [[0,3,0],[3,3,3],[0,0,0]],                  // T
  [[0,4,4],[4,4,0],[0,0,0]],                  // S
  [[5,5,0],[0,5,5],[0,0,0]],                  // Z
  [[6,0,0],[6,6,6],[0,0,0]],                  // J
  [[0,0,7],[7,7,7],[0,0,0]],                  // L
  [[0,8,0],[8,8,8],[0,8,0]],                  // + (plus pentominó)
  [[9,0,9],[9,9,9],[0,0,0]],                  // U pentominó (2x3 real, enmarcado en 3x3)
  [[0,10,0,0],[10,10,0,0],[0,10,0,0],[0,10,0,0]], // Y pentominó (4x2 real, enmarcado en 4x4 como la I)
  [[11]],                                     // 1x1 (recompensa tras Tetris)
  [[12,12,12],[12,0,12],[12,12,12]],          // 3x3 hueca (pieza reto)
];

const LINE_SCORES = [0, 100, 300, 500, 800];
const RANKING_KEY = 'tetris-ranking';
const LAST_PLAYER_KEY = 'tetris-last-player';
const START_LEVEL_KEY = 'tetris-start-level';
const RANKING_MAX = 10;

// Piezas especiales: tipos 8-10 y 12 aparecen al azar (nunca el 11, que es una
// recompensa exclusiva tras un Tetris — ver clearLines/pendingRewardPiece).
const TYPE_T = 3;
const TYPE_SINGLE = 11;
const SPECIAL_TYPES = [8, 9, 10, 12];
const PENTOMINO_MIN_LEVEL = 2;
const PENTOMINO_CHANCE = 0.12;

const COMBO_BASE = 50;
const TSPIN_BASE = 400;
const B2B_TETRIS_MULT = 0.5;
const PERFECT_CLEAR_BASE = 3000;

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const nextCanvas = document.getElementById('next-canvas');
const nextCtx = nextCanvas.getContext('2d');
const scoreEl = document.getElementById('score');
const linesEl = document.getElementById('lines');
const levelEl = document.getElementById('level');
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlayScore = document.getElementById('overlay-score');
const restartBtn = document.getElementById('restart-btn');
const themeToggleBtn = document.getElementById('theme-toggle');
const nameForm = document.getElementById('name-form');
const nameInput = document.getElementById('player-name-input');
const rankingList = document.getElementById('ranking-list');
const holdCanvas = document.getElementById('hold-canvas');
const holdCtx = holdCanvas.getContext('2d');
const holdSection = document.getElementById('hold-section');
const toastEl = document.getElementById('toast');
const pauseMenuEl = document.getElementById('pause-menu');
const resumeBtn = document.getElementById('resume-btn');
const pauseControlsToggle = document.getElementById('pause-controls-toggle');
const pauseControlsList = document.getElementById('pause-controls-list');
const startLevelSelect = document.getElementById('start-level-select');

let board, current, next, score, lines, level, paused, gameOver, lastTime, dropAccum, dropInterval, animId;
let gridColor, blockHighlight;
let playerName, playerKey, awaitingName;
let heldType, holdLocked;
let combo, lastClearWasTetris, pendingRewardPiece, lastActionWasRotate;
let toastTimer = null;
let audioCtx = null;
let startLevel = 1;

function createBoard() {
  return Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
}

function pieceFromType(type) {
  const shape = PIECES[type].map(row => [...row]);
  return { type, shape, x: Math.floor(COLS / 2) - Math.floor(shape[0].length / 2), y: 0 };
}

// Elige qué tipo sale a continuación: recompensa pendiente (tras Tetris) > pieza
// especial ocasional (a partir de PENTOMINO_MIN_LEVEL) > pieza estándar 1-7.
function pickPieceType() {
  if (pendingRewardPiece) {
    pendingRewardPiece = false;
    return TYPE_SINGLE;
  }
  if (level >= PENTOMINO_MIN_LEVEL && Math.random() < PENTOMINO_CHANCE) {
    return SPECIAL_TYPES[Math.floor(Math.random() * SPECIAL_TYPES.length)];
  }
  return Math.floor(Math.random() * 7) + 1;
}

function randomPiece() {
  return pieceFromType(pickPieceType());
}

function collide(shape, ox, oy) {
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (!shape[r][c]) continue;
      const nx = ox + c;
      const ny = oy + r;
      if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
      if (ny >= 0 && board[ny][nx]) return true;
    }
  }
  return false;
}

function rotateCW(shape) {
  const rows = shape.length, cols = shape[0].length;
  const result = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      result[c][rows - 1 - r] = shape[r][c];
  return result;
}

function tryRotate() {
  const rotated = rotateCW(current.shape);
  const kicks = [0, -1, 1, -2, 2];
  for (const kick of kicks) {
    if (!collide(rotated, current.x + kick, current.y)) {
      current.shape = rotated;
      current.x += kick;
      lastActionWasRotate = true;
      return;
    }
  }
}

// Heurístico simplificado de T-spin (no SRS real, igual de "naive" que el resto
// de la rotación en este proyecto): cuenta como T-spin si la última acción fue
// una rotación exitosa de una pieza T y al menos 3 de las 4 esquinas de su caja
// 3x3 están ocupadas (pared, piso o bloque). Se llama antes de merge() para que
// las esquinas reflejen el tablero tal como estaba cuando la pieza encajó.
function detectTSpin() {
  if (current.type !== TYPE_T || !lastActionWasRotate) return false;
  const corners = [
    [current.x, current.y],
    [current.x + 2, current.y],
    [current.x, current.y + 2],
    [current.x + 2, current.y + 2],
  ];
  let occupied = 0;
  for (const [cx, cy] of corners) {
    if (cx < 0 || cx >= COLS || cy >= ROWS) { occupied++; continue; }
    if (cy >= 0 && board[cy][cx]) occupied++;
  }
  return occupied >= 3;
}

function merge() {
  for (let r = 0; r < current.shape.length; r++)
    for (let c = 0; c < current.shape[r].length; c++)
      if (current.shape[r][c])
        board[current.y + r][current.x + c] = current.shape[r][c];
}

// Velocidad de caída según nivel — misma fórmula usada al subir de nivel
// (clearLines) y al arrancar en un nivel inicial elegido (init).
function dropIntervalForLevel(lvl) {
  return Math.max(100, 1000 - (lvl - 1) * 90);
}

function clearLines(tSpin) {
  let cleared = 0;
  for (let r = ROWS - 1; r >= 0; r--) {
    if (board[r].every(v => v !== 0)) {
      board.splice(r, 1);
      board.unshift(new Array(COLS).fill(0));
      cleared++;
      r++;
    }
  }

  if (!cleared) {
    combo = 0;
    return;
  }

  lines += cleared;
  level = Math.floor(lines / 10) + 1;
  dropInterval = dropIntervalForLevel(level);

  let gained = (LINE_SCORES[cleared] || 0) * level;
  const messages = [];

  combo++;
  if (combo > 1) {
    gained += COMBO_BASE * (combo - 1) * level;
    messages.push(`COMBO x${combo}!`);
  }

  if (tSpin) {
    gained += TSPIN_BASE * cleared * level;
    messages.push('T-SPIN!');
  }

  const isTetris = cleared === 4;
  if (isTetris && lastClearWasTetris) {
    gained += Math.floor((LINE_SCORES[4] || 0) * level * B2B_TETRIS_MULT);
    messages.push('B2B TETRIS!');
  }
  lastClearWasTetris = isTetris;
  if (isTetris) pendingRewardPiece = true;

  const isPerfectClear = board.every(row => row.every(cell => cell === 0));
  if (isPerfectClear) {
    gained += PERFECT_CLEAR_BASE * level;
    messages.push('PERFECT CLEAR!');
  }

  score += gained;
  updateHUD();

  if (messages.length) {
    showToast(messages.join(' '));
    playComboSound(combo, tSpin, isPerfectClear);
  }
}

function ghostY() {
  let gy = current.y;
  while (!collide(current.shape, current.x, gy + 1)) gy++;
  return gy;
}

function hardDrop() {
  const gy = ghostY();
  score += (gy - current.y) * 2;
  current.y = gy;
  lockPiece();
}

function softDrop() {
  if (!collide(current.shape, current.x, current.y + 1)) {
    current.y++;
    score += 1;
    updateHUD();
  } else {
    lockPiece();
  }
}

function lockPiece() {
  const tSpin = detectTSpin();
  merge();
  clearLines(tSpin);
  holdLocked = false;
  holdSection.classList.remove('locked');
  spawn();
}

function spawn() {
  current = next;
  next = randomPiece();
  if (collide(current.shape, current.x, current.y)) {
    endGame();
  }
  drawNext();
}

// Reserva la pieza actual (tecla C/Shift). Una sola vez por pieza: se
// desbloquea recién cuando la pieza en juego se asienta (ver lockPiece).
function holdPiece() {
  if (holdLocked) return;
  holdLocked = true;
  holdSection.classList.add('locked');

  const outgoingType = current.type;
  if (heldType === null) {
    heldType = outgoingType;
    spawn();
  } else {
    const incomingType = heldType;
    heldType = outgoingType;
    current = pieceFromType(incomingType);
    if (collide(current.shape, current.x, current.y)) endGame();
  }
  drawHold();
}

function updateHUD() {
  scoreEl.textContent = score.toLocaleString();
  linesEl.textContent = lines;
  levelEl.textContent = level;
}

// Normaliza el nombre a "Palabra Palabra": "ARIANA", "ariana" y "Ariana" quedan
// todos como "Ariana". `playerKey` (su versión en minúsculas) es la identidad real
// del jugador; `playerName`/lo guardado en el ranking es solo para mostrar.
function toDisplayName(raw) {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function loadRanking() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RANKING_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRanking(ranking) {
  try {
    localStorage.setItem(RANKING_KEY, JSON.stringify(ranking));
  } catch {
    // localStorage no disponible (privado/bloqueado): el ranking no persiste, pero el juego sigue.
  }
}

// Guarda la mejor puntuación de `key` (identidad case-insensitive) y devuelve el
// ranking completo ordenado de mayor a menor.
function recordScore(key, name, finalScore) {
  const ranking = loadRanking();
  const existing = ranking.find(entry => entry.key === key);
  if (existing) {
    existing.name = name;
    existing.score = Math.max(existing.score, finalScore);
  } else {
    ranking.push({ key, name, score: finalScore });
  }
  ranking.sort((a, b) => b.score - a.score);
  saveRanking(ranking);
  return ranking;
}

// Los nombres son texto libre del usuario: se insertan como texto (textContent),
// nunca como innerHTML, para no abrir la puerta a HTML/script injection.
function renderRanking(ranking) {
  rankingList.innerHTML = '';
  const top = ranking.slice(0, RANKING_MAX);
  if (!top.length) return;

  const title = document.createElement('p');
  title.className = 'ranking-title';
  title.textContent = '🏆 Ranking';
  rankingList.appendChild(title);

  const ol = document.createElement('ol');
  ol.className = 'ranking';
  top.forEach((entry, i) => {
    const li = document.createElement('li');
    if (entry.key === playerKey) li.classList.add('current-player');

    const pos = document.createElement('span');
    pos.className = 'rank-pos';
    pos.textContent = `${i + 1}.`;

    const name = document.createElement('span');
    name.className = 'rank-name';
    name.textContent = entry.name;

    const sc = document.createElement('span');
    sc.className = 'rank-score';
    sc.textContent = entry.score.toLocaleString();

    li.append(pos, name, sc);
    ol.appendChild(li);
  });
  rankingList.appendChild(ol);
}

// Toast breve ("COMBO x3!", "T-SPIN!", ...) sobre el tablero. Reinicia su propia
// animación CSS si se dispara de nuevo antes de que termine la anterior.
function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  toastEl.style.animation = 'none';
  void toastEl.offsetWidth; // fuerza reflow para poder reiniciar la animación
  toastEl.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 1200);
}

// Efectos de sonido sintetizados con Web Audio (no hay pipeline de assets en
// este proyecto — ver CLAUDE.md). `getAudioCtx` es un singleton perezoso.
function getAudioCtx() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

function playTone(freq, duration, delay = 0, type = 'sine') {
  const ctxA = getAudioCtx();
  if (!ctxA) return;
  const osc = ctxA.createOscillator();
  const gain = ctxA.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.15, ctxA.currentTime + delay);
  gain.gain.exponentialRampToValueAtTime(0.001, ctxA.currentTime + delay + duration);
  osc.connect(gain);
  gain.connect(ctxA.destination);
  osc.start(ctxA.currentTime + delay);
  osc.stop(ctxA.currentTime + delay + duration);
}

function playComboSound(comboLevel, tSpin, perfectClear) {
  if (perfectClear) {
    [523, 659, 784, 1047].forEach((f, i) => playTone(f, 0.25, i * 0.09, 'triangle'));
    return;
  }
  if (tSpin) {
    playTone(392, 0.12, 0, 'square');
    playTone(587, 0.18, 0.1, 'square');
    return;
  }
  playTone(440 + Math.min(comboLevel, 6) * 60, 0.15, 0, 'sine');
}

function drawBlock(context, x, y, colorIndex, size, alpha) {
  if (!colorIndex) return;
  const color = COLORS[colorIndex];
  context.globalAlpha = alpha ?? 1;
  context.fillStyle = color;
  context.fillRect(x * size + 1, y * size + 1, size - 2, size - 2);
  // highlight
  context.fillStyle = blockHighlight;
  context.fillRect(x * size + 1, y * size + 1, size - 2, 4);
  context.globalAlpha = 1;
}

function drawGrid() {
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 0.5;
  for (let c = 1; c < COLS; c++) {
    ctx.beginPath();
    ctx.moveTo(c * BLOCK, 0);
    ctx.lineTo(c * BLOCK, ROWS * BLOCK);
    ctx.stroke();
  }
  for (let r = 1; r < ROWS; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * BLOCK);
    ctx.lineTo(COLS * BLOCK, r * BLOCK);
    ctx.stroke();
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();

  // board
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      drawBlock(ctx, c, r, board[r][c], BLOCK);

  // ghost
  const gy = ghostY();
  for (let r = 0; r < current.shape.length; r++)
    for (let c = 0; c < current.shape[r].length; c++)
      if (current.shape[r][c])
        drawBlock(ctx, current.x + c, gy + r, current.shape[r][c], BLOCK, 0.2);

  // current piece
  for (let r = 0; r < current.shape.length; r++)
    for (let c = 0; c < current.shape[r].length; c++)
      drawBlock(ctx, current.x + c, current.y + r, current.shape[r][c], BLOCK);
}

// Centra `shape` en una caja fija de 4x4 a `size` px — usado para NEXT y HOLD.
function drawPiecePreview(context, canvas, shape) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!shape) return;
  const NB = 30;
  const offX = Math.floor((4 - shape[0].length) / 2);
  const offY = Math.floor((4 - shape.length) / 2);
  for (let r = 0; r < shape.length; r++)
    for (let c = 0; c < shape[r].length; c++)
      drawBlock(context, offX + c, offY + r, shape[r][c], NB);
}

function drawNext() {
  drawPiecePreview(nextCtx, nextCanvas, next.shape);
}

function drawHold() {
  drawPiecePreview(holdCtx, holdCanvas, heldType === null ? null : PIECES[heldType]);
}

function updateThemeColors() {
  const styles = getComputedStyle(document.body);
  gridColor = styles.getPropertyValue('--grid-line').trim();
  blockHighlight = styles.getPropertyValue('--block-highlight').trim();
}

function applyTheme(theme) {
  document.body.classList.toggle('light-theme', theme === 'light');
  themeToggleBtn.textContent = theme === 'light' ? '☀️' : '🌙';
  themeToggleBtn.setAttribute('aria-label', theme === 'light' ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro');
  updateThemeColors();
}

function toggleTheme() {
  const theme = document.body.classList.contains('light-theme') ? 'dark' : 'light';
  localStorage.setItem('theme', theme);
  applyTheme(theme);
}

// Estado único del overlay: muestra/oculta cada bloque (form de nombre, ranking,
// botón reiniciar) según para qué se está usando (nombre / pausa / game over).
function showOverlay({ title, scoreText, showNameForm, showRanking, showRestart, showPauseMenu }) {
  overlayTitle.textContent = title;
  overlayScore.textContent = scoreText || '';
  nameForm.classList.toggle('hidden', !showNameForm);
  rankingList.classList.toggle('hidden', !showRanking);
  restartBtn.classList.toggle('hidden', !showRestart);
  pauseMenuEl.classList.toggle('hidden', !showPauseMenu);
  overlay.classList.remove('hidden');
}

function endGame() {
  gameOver = true;
  cancelAnimationFrame(animId);
  const ranking = recordScore(playerKey, playerName, score);
  renderRanking(ranking);
  showOverlay({
    title: 'GAME OVER',
    scoreText: `Puntuación: ${score.toLocaleString()}`,
    showNameForm: false,
    showRanking: true,
    showRestart: true,
  });
}

function togglePause() {
  if (gameOver) return;
  paused = !paused;
  if (!paused) {
    overlay.classList.add('hidden');
    lastTime = performance.now();
    loop(lastTime);
  } else {
    cancelAnimationFrame(animId);
    pauseControlsList.classList.add('hidden');
    startLevelSelect.value = String(startLevel);
    showOverlay({ title: 'PAUSA', scoreText: '', showNameForm: false, showRanking: false, showRestart: true, showPauseMenu: true });
  }
}

function promptForName() {
  awaitingName = true;
  nameInput.value = localStorage.getItem(LAST_PLAYER_KEY) || '';
  showOverlay({ title: 'TETRIS', scoreText: '', showNameForm: true, showRanking: false, showRestart: false });
  nameInput.focus();
  nameInput.select();
  // El navegador auto-scrollea para mostrar el input enfocado, y ese
  // desplazamiento se queda pegado incluso después de empezar a jugar
  // (dejando la parte de arriba del tablero fuera de pantalla). Se vuelve a
  // dejar la página arriba del todo.
  window.scrollTo(0, 0);
}

function confirmName(e) {
  e.preventDefault();
  const displayName = toDisplayName(nameInput.value) || 'Jugador';
  playerName = displayName;
  playerKey = displayName.toLowerCase();
  localStorage.setItem(LAST_PLAYER_KEY, displayName);
  awaitingName = false;
  nameForm.classList.add('hidden');
  overlay.classList.add('hidden');
  // Gesto real del usuario: aprovechamos para desbloquear el audio (los
  // navegadores suspenden AudioContext hasta la primera interacción).
  const ctxA = getAudioCtx();
  if (ctxA && ctxA.state === 'suspended') ctxA.resume();
  init();
}

function loop(ts) {
  const dt = ts - lastTime;
  lastTime = ts;
  dropAccum += dt;
  if (dropAccum >= dropInterval) {
    dropAccum = 0;
    if (!collide(current.shape, current.x, current.y + 1)) {
      current.y++;
    } else {
      lockPiece();
    }
  }
  draw();
  if (!gameOver) {
    animId = requestAnimationFrame(loop);
  }
}

function init() {
  board = createBoard();
  score = 0;
  lines = 0;
  level = startLevel;
  paused = false;
  gameOver = false;
  dropInterval = dropIntervalForLevel(startLevel);
  dropAccum = 0;
  lastTime = performance.now();
  heldType = null;
  holdLocked = false;
  holdSection.classList.remove('locked');
  combo = 0;
  lastClearWasTetris = false;
  pendingRewardPiece = false;
  lastActionWasRotate = false;
  drawHold();
  next = randomPiece();
  spawn();
  updateHUD();
  overlay.classList.add('hidden');
  window.scrollTo(0, 0);
  cancelAnimationFrame(animId);
  animId = requestAnimationFrame(loop);
}

// Estas teclas hacen scroll de la página por defecto (flechas y espacio) —
// se bloquea ese comportamiento del navegador sin importar el estado del
// juego (también en pausa/game over), para que el tablero nunca se corra de
// la pantalla mientras se juega.
const SCROLL_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'];

document.addEventListener('keydown', e => {
  if (awaitingName) return;
  if (!paused && SCROLL_KEYS.includes(e.code)) e.preventDefault();
  if (e.code === 'KeyP' || e.code === 'Escape') { togglePause(); return; }
  if (paused || gameOver) return;
  switch (e.code) {
    case 'ArrowLeft':
      if (!collide(current.shape, current.x - 1, current.y)) current.x--;
      lastActionWasRotate = false; // mover lateralmente invalida el T-spin
      break;
    case 'ArrowRight':
      if (!collide(current.shape, current.x + 1, current.y)) current.x++;
      lastActionWasRotate = false;
      break;
    case 'ArrowDown':
      softDrop();
      break;
    case 'ArrowUp':
    case 'KeyX':
      tryRotate();
      break;
    case 'Space':
      hardDrop();
      break;
    case 'KeyC':
    case 'ShiftLeft':
    case 'ShiftRight':
      holdPiece();
      break;
  }
  updateHUD();
});

restartBtn.addEventListener('click', promptForName);
nameForm.addEventListener('submit', confirmName);
themeToggleBtn.addEventListener('click', toggleTheme);
resumeBtn.addEventListener('click', togglePause);
pauseControlsToggle.addEventListener('click', () => pauseControlsList.classList.toggle('hidden'));
startLevelSelect.addEventListener('change', () => {
  startLevel = parseInt(startLevelSelect.value, 10) || 1;
  try { localStorage.setItem(START_LEVEL_KEY, String(startLevel)); } catch {}
});

applyTheme(localStorage.getItem('theme') === 'light' ? 'light' : 'dark');
(function initStartLevel() {
  const parsed = parseInt(localStorage.getItem(START_LEVEL_KEY), 10);
  startLevel = Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : 1;
  startLevelSelect.value = String(startLevel);
})();
promptForName();
