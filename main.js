require('dotenv').config();
const { app, BrowserWindow, ipcMain, Tray, nativeImage, screen } = require('electron');
const path = require('path');
const { captureScreen } = require('./src/services/screenshotService');
const { askClaude } = require('./src/services/aiService');
const { initOcr, destroyOcr, findTextOnScreen } = require('./src/services/ocrService');
const { resolvePointerCoords } = require('./src/services/pointerService');
const { startDetection, stopDetection, startUiohook, stopUiohook } = require('./src/services/detectionService');

let chatWindow = null;
let overlayWindow = null;
let tray = null;

// Session state
let currentTask    = null; // user's original question
let currentStep    = null; // single step object from latest Claude response
let stepCount      = 0;    // how many steps completed so far
let stepSummary    = [];   // brief log of completed steps for Claude context
let lastImgSize    = null; // actual screenshot pixel dimensions for coord mapping

function createChatWindow() {
  chatWindow = new BrowserWindow({
    width: 380,
    height: 620,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  chatWindow.setAlwaysOnTop(true, 'screen-saver');
  chatWindow.on('show', () => chatWindow.setAlwaysOnTop(true, 'screen-saver'));
  chatWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));
}

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;

  overlayWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(__dirname, 'src/overlay/overlay.html'));
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets/tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Pointer — Desktop Guide');
  tray.on('click', () => {
    chatWindow && chatWindow.show();
  });
}

app.whenReady().then(() => {
  createChatWindow();
  createOverlayWindow();
  createTray();
  initOcr(); // warm up Tesseract worker in background
  startUiohook();
});

app.on('quit', () => {
  destroyOcr();
  stopUiohook();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('ask-question', async (e, question) => {
  chatWindow.webContents.send('loading', true);

  // Move chat window off-screen so it doesn't appear in the screenshot
  overlayWindow.webContents.send('hide-pointer');
  const prevBounds = chatWindow.getBounds();
  chatWindow.setPosition(-prevBounds.width - 100, -prevBounds.height - 100);
  await sleep(200); // wait for compositor to flush both windows off screen

  let capture;
  try {
    capture = await captureScreen();
  } finally {
    chatWindow.setPosition(prevBounds.x, prevBounds.y);
  }

  lastImgSize = { imgWidth: capture.imgWidth, imgHeight: capture.imgHeight };
  console.log(`[Pointer] Screenshot captured — ${capture.imgWidth}×${capture.imgHeight}px (${Math.round(capture.base64.length / 1024)} KB), calling Claude…`);

  // Reset session state for new task
  currentTask = question;
  stepCount   = 0;
  stepSummary = [];
  currentStep = null;

  let result;
  try {
    result = await askClaude(question, capture.base64, stepSummary);
  } catch (err) {
    console.error('[Pointer] Claude error:', err.message);
    chatWindow.webContents.send('loading', false);
    chatWindow.webContents.send('error', `Sorry, I couldn't get instructions: ${err.message}`);
    return { ok: false };
  }

  chatWindow.webContents.send('loading', false);
  chatWindow.webContents.send('steps-ready', {
    friendly_summary: result.friendly_message || 'Let me guide you through this!',
  });

  await applyStep(result, capture.base64);
  return { ok: true };
});

ipcMain.handle('next-step', async () => {
  await analyzeNextStep();
});

ipcMain.handle('mark-stuck', async () => {
  chatWindow.webContents.send('error', 'No worries! Try reading the instruction again slowly, or ask me a new question.');
});

ipcMain.handle('reset-session', async () => {
  stopDetection();
  currentTask  = null;
  currentStep  = null;
  stepCount    = 0;
  stepSummary  = [];
  overlayWindow.webContents.send('hide-pointer');
});

ipcMain.handle('hide-window', () => {
  chatWindow && chatWindow.minimize();
});

ipcMain.handle('close-window', () => {
  app.quit();
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step Analysis ─────────────────────────────────────────────────────────────

/**
 * Takes a fresh screenshot, asks Claude for the next single step, then applies it.
 */
async function analyzeNextStep() {
  stopDetection();

  if (!currentTask) return;

  // Record the completed step in history before fetching the next one
  if (currentStep && !currentStep.is_complete) {
    stepSummary.push(currentStep.instruction || currentStep.target_description || 'Step completed');
  }

  chatWindow.webContents.send('loading', true);

  // Hide chat window for clean screenshot
  const prevBounds = chatWindow.getBounds();
  chatWindow.setPosition(-prevBounds.width - 100, -prevBounds.height - 100);
  overlayWindow.webContents.send('hide-pointer');
  await sleep(200);

  let capture;
  try {
    capture = await captureScreen();
  } finally {
    chatWindow.setPosition(prevBounds.x, prevBounds.y);
  }

  lastImgSize = { imgWidth: capture.imgWidth, imgHeight: capture.imgHeight };
  console.log(`[Pointer] Fresh screenshot for step ${stepCount + 1} — ${capture.imgWidth}×${capture.imgHeight}px, calling Claude…`);

  let result;
  try {
    result = await askClaude(currentTask, capture.base64, stepSummary);
  } catch (err) {
    console.error('[Pointer] Claude error:', err.message);
    chatWindow.webContents.send('loading', false);
    chatWindow.webContents.send('error', `Sorry, something went wrong: ${err.message}`);
    return;
  }

  chatWindow.webContents.send('loading', false);
  await applyStep(result, capture.base64);
}

/**
 * Applies a step response from Claude — either shows completion or activates the step.
 * @param {object} result - Claude response object
 * @param {string} screenshotBase64 - The screenshot used for this step (for OCR)
 */
async function applyStep(result, screenshotBase64) {
  currentStep = result;

  if (result.is_complete) {
    overlayWindow.webContents.send('hide-pointer');
    chatWindow.webContents.send('step-changed', {
      is_complete: true,
      friendly_message: result.friendly_message,
    });
    return;
  }

  stepCount++;

  // OCR snap — try to find the exact UI element text on screen
  let ocrRect = null;
  if (result.search_text && screenshotBase64) {
    try {
      ocrRect = await findTextOnScreen(screenshotBase64, result.region, result.search_text, lastImgSize);
      if (ocrRect) console.log(`[Pointer] OCR snapped to "${result.search_text}" at`, ocrRect);
      else console.log(`[Pointer] OCR found no match for "${result.search_text}", using AI coords`);
    } catch (err) {
      console.warn('[Pointer] OCR error:', err.message);
    }
  }

  const { x: px, y: py } = resolvePointerCoords(result.region, ocrRect, lastImgSize);

  overlayWindow.webContents.send('show-pointer', {
    x: px,
    y: py,
    pointer_type: result.pointer_type,
  });

  chatWindow.webContents.send('step-changed', {
    is_complete: false,
    stepNum: stepCount,
    instruction: result.instruction,
    pointer_type: result.pointer_type,
  });

  // Auto-advance: detect action completion then fetch next step
  startDetection(result, px, py, () => {
    analyzeNextStep();
  });
}
