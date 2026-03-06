const { createWorker } = require('tesseract.js');
const { screen, nativeImage } = require('electron');

let worker = null;

/**
 * Initialise the Tesseract worker once and cache it.
 * Call this early (e.g. after app.whenReady) to absorb the 300–800 ms init cost.
 */
async function initOcr() {
  if (worker) return;
  worker = await createWorker('eng');
}

/**
 * Destroy the worker on app quit to free memory.
 */
async function destroyOcr() {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
}

/**
 * Crops a 3× hint region from a full-screen base64 PNG and runs OCR on it.
 * Returns the bounding box (in full-screen PHYSICAL pixel coords) of the best text match,
 * or null if no confident match is found.
 *
 * @param {string} screenshotBase64 - Full-screen PNG, no data-URI prefix
 * @param {{ x: number, y: number, w: number, h: number }} region - AI normalized region (x/y = center)
 * @param {string|null} searchText - Exact text to find, or null to skip OCR
 * @param {{ imgWidth: number, imgHeight: number }|null} imgSize - actual screenshot dimensions
 * @returns {Promise<{ x: number, y: number, width: number, height: number }|null>}
 */
async function findTextOnScreen(screenshotBase64, region, searchText, imgSize = null) {
  if (!searchText || !worker) return null;

  // Use the actual screenshot physical dimensions for crop math.
  // Falling back to physical bounds (logical × scale) if imgSize is unavailable.
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const { width: logW, height: logH } = display.bounds;
  const refW = imgSize ? imgSize.imgWidth  : Math.round(logW * scale);
  const refH = imgSize ? imgSize.imgHeight : Math.round(logH * scale);

  // Build a 3× crop region around the AI hint (clamped to screenshot dimensions)
  const cropW = Math.round(region.w * refW * 3);
  const cropH = Math.round(region.h * refH * 3);
  const cropX = Math.max(0, Math.round(region.x * refW - cropW / 2));
  const cropY = Math.max(0, Math.round(region.y * refH - cropH / 2));
  const clampedW = Math.min(cropW, refW - cropX);
  const clampedH = Math.min(cropH, refH - cropY);

  // Crop from the full screenshot
  const fullImage = nativeImage.createFromBuffer(Buffer.from(screenshotBase64, 'base64'));
  const cropped = fullImage.crop({ x: cropX, y: cropY, width: clampedW, height: clampedH });
  const croppedBuffer = cropped.toPNG();

  let result;
  try {
    result = await worker.recognize(croppedBuffer);
  } catch {
    return null;
  }

  const needle = searchText.toLowerCase().trim();

  // 1. Exact phrase match across words
  const words = result.data.words;
  const rect = findPhrase(words, needle);
  if (rect) {
    return offsetRect(rect, cropX, cropY);
  }

  // 2. Fuzzy single-word match (longest word overlap)
  const fuzzy = findFuzzyWord(words, needle);
  if (fuzzy) {
    return offsetRect(fuzzy, cropX, cropY);
  }

  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Finds an exact phrase by sliding a word-window across the OCR word list.
 * Returns the bounding box spanning all matching words, or null.
 */
function findPhrase(words, needle) {
  const needleWords = needle.split(/\s+/);
  for (let i = 0; i <= words.length - needleWords.length; i++) {
    const slice = words.slice(i, i + needleWords.length);
    const match = slice.every((w, j) => w.text.toLowerCase().includes(needleWords[j]));
    if (match) return mergeBboxes(slice.map(w => w.bbox));
  }
  return null;
}

/**
 * Returns the bounding box of the word whose text most overlaps with needle.
 */
function findFuzzyWord(words, needle) {
  let best = null;
  let bestScore = 0;
  for (const w of words) {
    const wl = w.text.toLowerCase();
    if (wl.includes(needle) || needle.includes(wl)) {
      const score = Math.min(wl.length, needle.length) / Math.max(wl.length, needle.length);
      if (score > bestScore) { bestScore = score; best = w.bbox; }
    }
  }
  return bestScore > 0.5 ? best : null;
}

/** Merges an array of {x0,y0,x1,y1} bboxes into one spanning rect. */
function mergeBboxes(bboxes) {
  const x0 = Math.min(...bboxes.map(b => b.x0));
  const y0 = Math.min(...bboxes.map(b => b.y0));
  const x1 = Math.max(...bboxes.map(b => b.x1));
  const y1 = Math.max(...bboxes.map(b => b.y1));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Translates a crop-relative rect back to full-screen coords. */
function offsetRect(rect, dx, dy) {
  return { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
}

module.exports = { initOcr, destroyOcr, findTextOnScreen };
