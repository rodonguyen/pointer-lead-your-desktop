const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

// Match canvas to window size
function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
resize();
window.addEventListener('resize', resize);

// ── Pointer State ──────────────────────────────────────────────────────────

let active       = false;
let pointerX     = 0;
let pointerY     = 0;
let pointerType  = 'click'; // click | type | look | highlight
let animFrame    = null;
let startTime    = null;

const COLORS = {
  click:     '#FF6B35',
  type:      '#17A2B8',
  look:      '#FFC107',
  highlight: '#6F42C1',
};

const LABELS = {
  click:     'Click here!',
  type:      'Type here',
  look:      'Look here',
  highlight: 'Here!',
};

// ── Animation Loop ─────────────────────────────────────────────────────────

function draw(timestamp) {
  if (!startTime) startTime = timestamp;
  const elapsed = (timestamp - startTime) / 1000; // seconds

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!active) return;

  const color = COLORS[pointerType] || COLORS.click;
  const label = LABELS[pointerType] || 'Here!';
  const cx    = pointerX;
  const cy    = pointerY;

  // Pulsing ring — outer
  const pulse = 0.5 + 0.5 * Math.sin(elapsed * Math.PI * 2); // 0..1 at 1Hz
  const outerR = 40 + pulse * 20; // 40–60px
  const outerAlpha = 0.15 + pulse * 0.25;

  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.fillStyle = hexToRgba(color, outerAlpha);
  ctx.fill();

  // Middle ring
  ctx.beginPath();
  ctx.arc(cx, cy, 30 + pulse * 8, 0, Math.PI * 2);
  ctx.strokeStyle = hexToRgba(color, 0.5 + pulse * 0.3);
  ctx.lineWidth   = 3;
  ctx.stroke();

  // Inner solid dot
  ctx.beginPath();
  ctx.arc(cx, cy, 10, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // White border on inner dot
  ctx.beginPath();
  ctx.arc(cx, cy, 10, 0, Math.PI * 2);
  ctx.strokeStyle = 'white';
  ctx.lineWidth   = 2.5;
  ctx.stroke();

  // Label
  const labelY = cy - 55 - pulse * 6;
  ctx.font      = 'bold 16px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
  ctx.textAlign = 'center';

  // Label shadow/pill background
  const labelW = ctx.measureText(label).width + 24;
  const labelH = 28;
  const labelX = cx - labelW / 2;
  const lY     = labelY - labelH + 6;

  ctx.fillStyle = color;
  roundRect(ctx, labelX, lY, labelW, labelH, 14);
  ctx.fill();

  ctx.fillStyle = 'white';
  ctx.fillText(label, cx, labelY);

  animFrame = requestAnimationFrame(draw);
}

function show(x, y, type) {
  pointerX    = x;
  pointerY    = y;
  pointerType = type || 'click';
  active      = true;
  startTime   = null;
  if (!animFrame) animFrame = requestAnimationFrame(draw);
}

function hide() {
  active = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
}

// ── IPC ────────────────────────────────────────────────────────────────────

window.pointer.on('show-pointer', ({ x, y, pointer_type }) => show(x, y, pointer_type));
window.pointer.on('hide-pointer', () => hide());

// ── Utilities ──────────────────────────────────────────────────────────────

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
