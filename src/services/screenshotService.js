const { desktopCapturer, screen } = require('electron');

/**
 * Captures the primary display and returns a base64 PNG string (no data-URI prefix).
 */
async function captureScreen() {
  const { width, height } = screen.getPrimaryDisplay().bounds;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
  });

  if (!sources.length) throw new Error('No screen sources found');

  // Pick the primary display source (largest area or first)
  const primary = sources.find(s => s.name === 'Entire Screen' || s.name === 'Screen 1') || sources[0];

  const dataURL = primary.thumbnail.toDataURL(); // 'data:image/png;base64,...'
  return dataURL.replace(/^data:image\/png;base64,/, '');
}

module.exports = { captureScreen };
