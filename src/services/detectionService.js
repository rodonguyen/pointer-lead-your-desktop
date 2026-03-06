/**
 * detectionService.js
 * Owns all auto-advance detection logic for guided steps.
 * Detects when the user has completed a step and fires onAdvance callback.
 */

const { screen } = require('electron');
const { captureScreenLite } = require('./screenshotService');

// ── uiohook singleton ─────────────────────────────────────────────────────────

let uIOhook = null;

function startUiohook() {
  try {
    const { uIOhook: hook } = require('uiohook-napi');
    uIOhook = hook;
    uIOhook.start();
    console.log('[Detection] uIOhook started');
  } catch (err) {
    console.warn('[Detection] uiohook-napi not available, keyboard detection disabled:', err.message);
    uIOhook = null;
  }
}

function stopUiohook() {
  if (uIOhook) {
    try {
      uIOhook.stop();
      console.log('[Detection] uIOhook stopped');
    } catch (err) {
      console.warn('[Detection] Error stopping uIOhook:', err.message);
    }
    uIOhook = null;
  }
}

// ── Active detection state ────────────────────────────────────────────────────

let detecting = false;
let activeIntervals = [];
let activeTimeouts = [];
let activeKeydownListener = null;

function clearAll() {
  detecting = false;
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
  activeTimeouts.forEach(id => clearTimeout(id));
  activeTimeouts = [];
  if (activeKeydownListener && uIOhook) {
    uIOhook.off('keydown', activeKeydownListener);
  }
  activeKeydownListener = null;
}

function stopDetection() {
  clearAll();
}

// ── Guard wrapper ─────────────────────────────────────────────────────────────

function makeGuarded(onAdvance) {
  let fired = false;
  return () => {
    if (!detecting || fired) return;
    fired = true;
    clearAll();
    onAdvance();
  };
}

// ── Cursor zone detection (for 'click' steps) ────────────────────────────────

function startCursorDetection(px, py, onAdvance) {
  const ZONE_RADIUS = 80;
  let wasInZone = false;

  const id = setInterval(() => {
    if (!detecting) return;
    const { x, y } = screen.getCursorScreenPoint();
    const dist = Math.hypot(x - px, y - py);
    const inZone = dist <= ZONE_RADIUS;

    if (wasInZone && !inZone) {
      console.log('[Detection] Cursor left target zone — advancing');
      onAdvance();
    }
    wasInZone = inZone;
  }, 500);

  activeIntervals.push(id);
}

// ── Keyboard idle detection (for 'type' steps) ───────────────────────────────

function startKeyboardIdleDetection(onAdvance) {
  if (!uIOhook) {
    console.log('[Detection] uIOhook unavailable, skipping keyboard detection');
    return;
  }

  let idleTimer = null;
  let started = false;

  const listener = () => {
    if (!detecting) return;
    if (!started) {
      started = true;
      console.log('[Detection] First keydown detected, starting 1s idle timer');
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!detecting) return;
      console.log('[Detection] Keyboard idle for 1s — advancing');
      onAdvance();
    }, 1000);
  };

  activeKeydownListener = listener;
  uIOhook.on('keydown', listener);
}

// ── Pixel diff fallback ───────────────────────────────────────────────────────

async function startPixelDiffFallback(pointerX, pointerY, onAdvance) {
  let baseline = null;
  try {
    baseline = await captureScreenLite();
  } catch (err) {
    console.warn('[Detection] Could not capture baseline for pixel diff:', err.message);
    return;
  }

  if (!detecting) return;

  const SAMPLE_STEP = 8;        // sample every 8th pixel
  const DIFF_THRESHOLD = 20;    // channel difference to count as changed
  const CHANGED_RATIO = 0.03;   // 3% of sampled pixels must change
  const EXCLUSION_RADIUS = 120; // logical pixels around pointer to ignore

  // Scale exclusion radius to lite image coords
  const display = screen.getPrimaryDisplay();
  const logicalW = display.bounds.width;
  const exclusionRadiusInLite = EXCLUSION_RADIUS / (logicalW / baseline.width);

  // Scale pointer coords to lite image coords
  const logicalH = display.bounds.height;
  const scaleX = baseline.width / logicalW;
  const scaleY = baseline.height / logicalH;
  const litePointerX = pointerX * scaleX;
  const litePointerY = pointerY * scaleY;

  const id = setInterval(async () => {
    if (!detecting) return;

    let current;
    try {
      current = await captureScreenLite();
    } catch (err) {
      return;
    }

    if (!detecting) return;

    const { bitmap: baseBuf, width, height } = baseline;
    const { bitmap: curBuf } = current;

    let sampledCount = 0;
    let changedCount = 0;

    for (let y = 0; y < height; y += SAMPLE_STEP) {
      for (let x = 0; x < width; x += SAMPLE_STEP) {
        // Skip pixels within exclusion radius of pointer
        const dist = Math.hypot(x - litePointerX, y - litePointerY);
        if (dist <= exclusionRadiusInLite) continue;

        const i = (y * width + x) * 4; // RGBA
        const rDiff = Math.abs(baseBuf[i]     - curBuf[i]);
        const gDiff = Math.abs(baseBuf[i + 1] - curBuf[i + 1]);
        const bDiff = Math.abs(baseBuf[i + 2] - curBuf[i + 2]);

        sampledCount++;
        if (rDiff > DIFF_THRESHOLD || gDiff > DIFF_THRESHOLD || bDiff > DIFF_THRESHOLD) {
          changedCount++;
        }
      }
    }

    if (sampledCount > 0 && changedCount / sampledCount > CHANGED_RATIO) {
      console.log(`[Detection] Pixel diff triggered — ${changedCount}/${sampledCount} pixels changed`);
      onAdvance();
    }
  }, 500);

  activeIntervals.push(id);
}

// ── Auto timer (for 'look' / 'highlight' steps) ──────────────────────────────

function startAutoTimer(ms, onAdvance) {
  console.log(`[Detection] Auto-timer: advancing in ${ms}ms`);
  const id = setTimeout(() => {
    if (!detecting) return;
    console.log('[Detection] Auto-timer fired — advancing');
    onAdvance();
  }, ms);
  activeTimeouts.push(id);
}

// ── Main entry point ──────────────────────────────────────────────────────────

function startDetection(step, pointerX, pointerY, onAdvance) {
  clearAll();
  detecting = true;

  const guarded = makeGuarded(onAdvance);
  const pointerType = step.pointer_type || 'click';

  console.log(`[Detection] Starting detection for pointer_type="${pointerType}" at (${pointerX}, ${pointerY})`);

  if (pointerType === 'look' || pointerType === 'highlight') {
    startAutoTimer(3000, guarded);
  } else if (pointerType === 'type') {
    startKeyboardIdleDetection(guarded);
    // Pixel diff fallback after 15s
    const fallbackId = setTimeout(() => {
      if (!detecting) return;
      console.log('[Detection] Starting pixel diff fallback for type step');
      startPixelDiffFallback(pointerX, pointerY, guarded);
    }, 15000);
    activeTimeouts.push(fallbackId);
  } else {
    // 'click' (default)
    startCursorDetection(pointerX, pointerY, guarded);
    // Pixel diff fallback after 15s
    const fallbackId = setTimeout(() => {
      if (!detecting) return;
      console.log('[Detection] Starting pixel diff fallback for click step');
      startPixelDiffFallback(pointerX, pointerY, guarded);
    }, 15000);
    activeTimeouts.push(fallbackId);
  }
}

module.exports = { startDetection, stopDetection, startUiohook, stopUiohook };
