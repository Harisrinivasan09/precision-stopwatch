/* ═══════════════════════════════════════════════════════════════════
   PRECISION STOPWATCH — stopwatch.js
   Architecture:
     - State machine: idle → running → paused → (reset → idle)
     - High-precision timing via performance.now()
     - rAF render loop; timer math never depends on rAF cadence
     - Lap list DOM manipulation with best-lap highlighting
═══════════════════════════════════════════════════════════════════ */

// ── DOM references ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const timerCard     = $('timerCard');
const statusDot     = $('statusDot');
const timeMain      = $('timeMain');
const timeMs        = $('timeMs');
const dialProgress  = $('dialProgress');
const btnStart      = $('btnStart');
const btnLap        = $('btnLap');
const btnReset      = $('btnReset');
const lapList       = $('lapList');
const lapEmpty      = $('lapEmpty');
const lapCountBadge = $('lapCountBadge');
const statLaps      = $('statLaps');
const statBest      = $('statBest');
const statAvg       = $('statAvg');

// ── Timer state ────────────────────────────────────────────────────
const state = {
  phase: 'idle',    // 'idle' | 'running' | 'paused'
  startTs: 0,       // performance.now() when last started
  accumulated: 0,   // ms banked before the most recent start
  laps: [],         // array of lap durations in ms
  lapStart: 0,      // accumulated + elapsed at last lap mark
  rafId: null,
};

// Circumference of the progress arc (r=104)
const ARC_C = 2 * Math.PI * 104; // ≈ 653.45

// ── Build SVG tick marks ───────────────────────────────────────────
(function buildTicks() {
  const g  = document.getElementById('tickMarks');
  const cx = 120, cy = 120, r = 104;
  for (let i = 0; i < 60; i++) {
    const ang   = (i / 60) * 2 * Math.PI - Math.PI / 2;
    const isMaj = i % 5 === 0;
    const len   = isMaj ? 10 : 5;
    const r1    = r + 3;
    const r2    = r1 + len;
    const x1    = cx + r1 * Math.cos(ang);
    const y1    = cy + r1 * Math.sin(ang);
    const x2    = cx + r2 * Math.cos(ang);
    const y2    = cy + r2 * Math.sin(ang);
    const line  = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1.toFixed(2));
    line.setAttribute('y1', y1.toFixed(2));
    line.setAttribute('x2', x2.toFixed(2));
    line.setAttribute('y2', y2.toFixed(2));
    line.style.strokeWidth = isMaj ? '2' : '1';
    line.style.opacity     = isMaj ? '0.5' : '0.2';
    g.appendChild(line);
  }
})();

// ── Time formatting ────────────────────────────────────────────────

/** Format centiseconds portion (2 digits) */
function fmtCs(ms) {
  return String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
}

/** Format mm:ss from milliseconds */
function fmtMmSs(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Full mm:ss.cc string */
function fmtFull(ms) {
  return `${fmtMmSs(ms)}.${fmtCs(ms)}`;
}

// ── Arc progress ───────────────────────────────────────────────────
function updateArc(ms) {
  // One full revolution per 60 seconds
  const secondsFraction = (ms % 60000) / 60000;
  const offset = ARC_C * (1 - secondsFraction);
  dialProgress.style.strokeDasharray  = ARC_C;
  dialProgress.style.strokeDashoffset = offset;
}

// ── Render loop ────────────────────────────────────────────────────
function getElapsed() {
  if (state.phase === 'running') {
    return state.accumulated + (performance.now() - state.startTs);
  }
  return state.accumulated;
}

function render() {
  const elapsed = getElapsed();
  timeMain.textContent = fmtMmSs(elapsed);
  timeMs.textContent   = '.' + fmtCs(elapsed);
  updateArc(elapsed);
  if (state.phase === 'running') {
    state.rafId = requestAnimationFrame(render);
  }
}

function startLoop() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = requestAnimationFrame(render);
}

function stopLoop() {
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
}

// ── Button state machine ───────────────────────────────────────────
function applyUIState() {
  const { phase } = state;
  const isRunning = phase === 'running';
  const isPaused  = phase === 'paused';
  const isIdle    = phase === 'idle';

  statusDot.classList.toggle('running', isRunning);
  timerCard.classList.toggle('running', isRunning);

  // Dial arc dims when not running
  dialProgress.style.stroke = isRunning ? 'var(--accent)' : 'var(--text-dim)';

  // Start button morphs into Pause and back
  if (isRunning) {
    btnStart.className = 'btn btn-pause';
    btnStart.setAttribute('aria-label', 'Pause stopwatch');
    btnStart.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
        <rect x="2" y="1" width="4" height="12" rx="1"/>
        <rect x="8" y="1" width="4" height="12" rx="1"/>
      </svg>
      Pause`;
  } else {
    btnStart.className = 'btn btn-start';
    btnStart.setAttribute('aria-label', isPaused ? 'Resume stopwatch' : 'Start stopwatch');
    btnStart.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
        <polygon points="2,1 13,7 2,13"/>
      </svg>
      ${isPaused ? 'Resume' : 'Start'}`;
  }

  btnStart.disabled = false;
  btnLap.disabled   = !isRunning;
  btnReset.disabled = isIdle;
}

// ── Stats panel ────────────────────────────────────────────────────
function updateStats() {
  const { laps } = state;
  const count = laps.length;
  statLaps.textContent = count;

  if (count === 0) {
    statBest.textContent = '—';
    statAvg.textContent  = '—';
    return;
  }

  const best = Math.min(...laps);
  const avg  = laps.reduce((a, b) => a + b, 0) / count;

  statBest.textContent      = fmtFull(best);
  statAvg.textContent       = fmtFull(avg);
  lapCountBadge.textContent = count;

  // Refresh best-lap highlight across all rows
  document.querySelectorAll('.lap-item').forEach(el => {
    el.classList.toggle('best-lap', parseInt(el.dataset.duration, 10) === best);
  });
}

// ── Lap list DOM ───────────────────────────────────────────────────
function addLapRow(lapNum, lapMs, splitMs) {
  if (lapEmpty.parentNode) lapEmpty.remove();

  const li = document.createElement('li');
  li.className = 'lap-item';
  li.dataset.duration = lapMs;
  li.setAttribute('aria-label', `Lap ${lapNum}: ${fmtFull(lapMs)}, split ${fmtFull(splitMs)}`);

  li.innerHTML = `
    <span class="lap-num">L${String(lapNum).padStart(2, '0')}</span>
    <div class="lap-time-col">
      <span class="lap-time-label">Lap</span>
      <span class="lap-time-val">${fmtFull(lapMs)}</span>
    </div>
    <div class="lap-time-col" style="text-align:right">
      <span class="lap-time-label">Split</span>
      <span class="lap-split-val">${fmtFull(splitMs)}</span>
    </div>`;

  // Newest lap at top
  lapList.insertBefore(li, lapList.firstChild);
  lapList.scrollTop = 0;
}

function clearLapList() {
  lapList.innerHTML = '';
  lapList.appendChild(lapEmpty);
  lapCountBadge.textContent = '0';
}

// ── Actions ────────────────────────────────────────────────────────
function actionStart() {
  state.startTs = performance.now();
  state.phase   = 'running';
  if (state.laps.length === 0) state.lapStart = 0;
  applyUIState();
  startLoop();
}

function actionPause() {
  state.accumulated += performance.now() - state.startTs;
  state.phase = 'paused';
  stopLoop();
  render(); // paint final frame
  applyUIState();
}

function actionReset() {
  stopLoop();
  state.phase       = 'idle';
  state.accumulated = 0;
  state.startTs     = 0;
  state.lapStart    = 0;
  state.laps        = [];

  timeMain.textContent = '00:00';
  timeMs.textContent   = '.00';
  dialProgress.style.strokeDashoffset = ARC_C;
  clearLapList();
  updateStats();
  applyUIState();
}

function actionLap() {
  if (state.phase !== 'running') return;

  const elapsed = getElapsed();
  const lapMs   = elapsed - state.lapStart;
  const lapNum  = state.laps.length + 1;

  state.laps.push(lapMs);
  state.lapStart = elapsed;

  addLapRow(lapNum, lapMs, elapsed);
  updateStats();

  // Brief glow pulse on the arc
  dialProgress.style.filter = 'drop-shadow(0 0 12px var(--accent))';
  setTimeout(() => {
    dialProgress.style.filter = 'drop-shadow(0 0 6px var(--accent))';
  }, 250);
}

// ── Event listeners ────────────────────────────────────────────────
btnStart.addEventListener('click', () => {
  if (state.phase === 'running') actionPause();
  else                           actionStart();
});

btnLap.addEventListener('click',   actionLap);
btnReset.addEventListener('click', actionReset);

// Keyboard shortcuts: Space = start/pause, L = lap, R = reset
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'BUTTON') return;
  if (e.code === 'Space') {
    e.preventDefault();
    btnStart.click();
  } else if (e.code === 'KeyL') {
    if (!btnLap.disabled) actionLap();
  } else if (e.code === 'KeyR') {
    if (!btnReset.disabled) actionReset();
  }
});

// ── Init ───────────────────────────────────────────────────────────
applyUIState();
dialProgress.style.strokeDasharray  = ARC_C;
dialProgress.style.strokeDashoffset = ARC_C;