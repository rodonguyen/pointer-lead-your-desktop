require('dotenv').config();
const { app, BrowserWindow, ipcMain, Tray, nativeImage, screen } = require('electron');
const path = require('path');
const { captureScreen } = require('./src/services/screenshotService');

let chatWindow = null;
let overlayWindow = null;
let tray = null;

// Session state
let steps = [];
let currentStepIndex = -1;

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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('ask-question', async (e, question) => {
  chatWindow.webContents.send('loading', true);

  // Hide chat window so it doesn't appear in screenshot
  chatWindow.hide();
  await sleep(150); // wait for compositor to remove window from screen

  let screenshotBase64;
  try {
    screenshotBase64 = await captureScreen();
  } finally {
    chatWindow.show();
  }

  // Phase 2: still hard-coded steps, but screenshot is captured and ready for AI (Phase 3)
  console.log(`[Phase 2] Screenshot captured — ${Math.round(screenshotBase64.length / 1024)} KB base64`);

  steps = [
    {
      instruction: 'Click the Start button in the bottom-left corner of your screen.',
      search_text: 'Start',
      target_description: 'Start button',
      region: { x: 0.02, y: 0.97, w: 0.05, h: 0.05 },
      pointer_type: 'click',
    },
    {
      instruction: 'Type "Notepad" in the search box that appears.',
      search_text: null,
      target_description: 'search box',
      region: { x: 0.3, y: 0.85, w: 0.4, h: 0.05 },
      pointer_type: 'type',
    },
    {
      instruction: 'Click on "Notepad" in the search results.',
      search_text: 'Notepad',
      target_description: 'Notepad result',
      region: { x: 0.3, y: 0.7, w: 0.3, h: 0.05 },
      pointer_type: 'click',
    },
  ];
  currentStepIndex = -1;

  chatWindow.webContents.send('loading', false);
  chatWindow.webContents.send('steps-ready', {
    steps,
    friendly_summary: `Sure! Here are ${steps.length} easy steps. (Screenshot captured ✓)`,
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
  if (currentStepIndex > 0) {
    await activateStep(currentStepIndex - 1);
  }
});

ipcMain.handle('mark-stuck', async () => {
  chatWindow.webContents.send('error', 'No worries! Try reading the instruction again slowly, or ask me a new question.');
});

ipcMain.handle('reset-session', async () => {
  steps = [];
  currentStepIndex = -1;
  overlayWindow.webContents.send('hide-pointer');
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step Activation ───────────────────────────────────────────────────────────

async function activateStep(index) {
  currentStepIndex = index;
  const step = steps[index];
  const { width, height } = screen.getPrimaryDisplay().bounds;

  // Convert normalized coords to pixels
  const px = Math.round(step.region.x * width);
  const py = Math.round(step.region.y * height);

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
}
