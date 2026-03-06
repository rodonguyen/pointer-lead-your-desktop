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
let steps = [];
let currentStepIndex = -1;
let lastScreenshot = null; // retained for OCR during step activation
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

  lastScreenshot = capture.base64;
  lastImgSize    = { imgWidth: capture.imgWidth, imgHeight: capture.imgHeight };
  console.log(`[Pointer] Screenshot captured — ${capture.imgWidth}×${capture.imgHeight}px (${Math.round(capture.base64.length / 1024)} KB), calling Claude…`);

  let result;
  try {
    result = await askClaude(question, capture.base64);
  } catch (err) {
    console.error('[Pointer] Claude error:', err.message);
    chatWindow.webContents.send('loading', false);
    chatWindow.webContents.send('error', `Sorry, I couldn't get instructions: ${err.message}`);
    return { ok: false };
  }

  steps = result.steps;
  currentStepIndex = -1;

  chatWindow.webContents.send('loading', false);
  chatWindow.webContents.send('steps-ready', {
    steps,
    friendly_summary: result.friendly_summary,
  });

  await activateStep(0);
  return { ok: true };
});

ipcMain.handle('next-step', async () => {
  if (currentStepIndex < steps.length - 1) {
    await activateStep(currentStepIndex + 1);
  }
});

ipcMain.handle('prev-step', async () => {
  stopDetection();
  if (currentStepIndex > 0) {
    await activateStep(currentStepIndex - 1);
  }
});

ipcMain.handle('mark-stuck', async () => {
  chatWindow.webContents.send('error', 'No worries! Try reading the instruction again slowly, or ask me a new question.');
});

ipcMain.handle('reset-session', async () => {
  stopDetection();
  steps = [];
  currentStepIndex = -1;
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

// ── Step Activation ───────────────────────────────────────────────────────────

async function activateStep(index) {
  stopDetection(); // cancel any detection from the previous step
  currentStepIndex = index;
  const step = steps[index];

  // Phase 5: OCR snap — try to find the exact UI element text on screen
  let ocrRect = null;
  if (step.search_text && lastScreenshot) {
    try {
      ocrRect = await findTextOnScreen(lastScreenshot, step.region, step.search_text, lastImgSize);
      if (ocrRect) console.log(`[Pointer] OCR snapped to "${step.search_text}" at`, ocrRect);
      else console.log(`[Pointer] OCR found no match for "${step.search_text}", using AI coords`);
    } catch (err) {
      console.warn('[Pointer] OCR error:', err.message);
    }
  }

  // Phase 4: resolve final pixel coords (OCR takes priority over AI coords)
  const { x: px, y: py } = resolvePointerCoords(step.region, ocrRect, lastImgSize);

  overlayWindow.webContents.send('show-pointer', {
    x: px,
    y: py,
    pointer_type: step.pointer_type,
  });

  chatWindow.webContents.send('step-changed', {
    index,
    total: steps.length,
    instruction: step.instruction,
    pointer_type: step.pointer_type,
  });

  // Auto-advance: start detection for non-last steps
  const isLast = index === steps.length - 1;
  if (!isLast) {
    startDetection(step, px, py, () => {
      if (currentStepIndex === index) { // guard: user may have manually advanced already
        activateStep(currentStepIndex + 1);
      }
    });
  }
}
