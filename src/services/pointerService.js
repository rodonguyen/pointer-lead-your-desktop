const { screen } = require('electron');

/**
 * Converts a normalized region {x, y, w, h} (0.0–1.0, x/y = center)
 * into LOGICAL pixel coordinates for the overlay canvas.
 *
 * imgWidth/imgHeight are the ACTUAL pixel dimensions of the screenshot Claude saw.
 * Using those (instead of display bounds) removes any DPI thumbnail-size mismatch.
 *
 * If ocrRect is provided (from OCR snap, already in logical pixels), it overrides AI coords.
 *
 * @param {{ x: number, y: number, w: number, h: number }} region
 * @param {{ x: number, y: number, width: number, height: number }|null} ocrRect
 * @param {{ imgWidth: number, imgHeight: number }} imgSize - actual screenshot dimensions
 * @returns {{ x: number, y: number, displayWidth: number, displayHeight: number }}
 */
function resolvePointerCoords(region, ocrRect = null, imgSize = null) {
  const display = screen.getPrimaryDisplay();
  const { width: logW, height: logH } = display.bounds;  // logical (overlay canvas space)
  const scale = display.scaleFactor || 1;

  // Use actual screenshot dimensions if available, else fall back to physical bounds.
  const refW = imgSize ? imgSize.imgWidth  : Math.round(logW * scale);
  const refH = imgSize ? imgSize.imgHeight : Math.round(logH * scale);

  let px, py;

  if (ocrRect) {
    // OCR rect is in screenshot-pixel space — convert to logical overlay space
    px = Math.round((ocrRect.x + ocrRect.width  / 2) * logW / refW);
    py = Math.round((ocrRect.y + ocrRect.height / 2) * logH / refH);
  } else {
    // AI gives normalized coords (0–1) relative to the screenshot image.
    // Multiply by logical display size to get overlay canvas coordinates.
    px = Math.round(region.x * logW);
    py = Math.round(region.y * logH);
  }

  // Clamp to logical display bounds
  px = Math.max(0, Math.min(px, logW - 1));
  py = Math.max(0, Math.min(py, logH - 1));

  return { x: px, y: py, displayWidth: logW, displayHeight: logH };
}

module.exports = { resolvePointerCoords };
