const { desktopCapturer, screen } = require('electron');

/**
 * Captures the primary display and returns a base64 PNG string (no data-URI prefix).
 */
async function captureScreen() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.bounds;           // logical pixels
  const scale  = display.scaleFactor || 1;

  // Request at physical resolution so the thumbnail matches what's on screen.
  // Electron may ignore the hint and return native-res anyway — we measure
  // the actual image size afterwards and return it so callers can normalise correctly.
  const physW = Math.round(width  * scale);
  const physH = Math.round(height * scale);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: physW, height: physH },
  });

  if (!sources.length) throw new Error('No screen sources found');

  const primary = sources.find(s => s.name === 'Entire Screen' || s.name === 'Screen 1') || sources[0];

  // Use the ACTUAL returned image dimensions for coordinate normalisation.
  const { width: imgW, height: imgH } = primary.thumbnail.getSize();

  const dataURL = primary.thumbnail.toDataURL();
  return {
    base64: dataURL.replace(/^data:image\/png;base64,/, ''),
    imgWidth:  imgW,
    imgHeight: imgH,
  };
}

/**
 * Captures a lightweight screenshot at 400×225 for pixel diff comparisons.
 * Does NOT hide any windows. Returns { bitmap: Buffer, width, height }.
 * bitmap is raw RGBA bytes from NativeImage.toBitmap().
 */
async function captureScreenLite() {
  const LITE_WIDTH  = 400;
  const LITE_HEIGHT = 225;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: LITE_WIDTH, height: LITE_HEIGHT },
  });

  if (!sources.length) throw new Error('No screen sources found');

  const primary = sources.find(s => s.name === 'Entire Screen' || s.name === 'Screen 1') || sources[0];
  const { width, height } = primary.thumbnail.getSize();
  const bitmap = primary.thumbnail.toBitmap();

  return { bitmap, width, height };
}

module.exports = { captureScreen, captureScreenLite };
