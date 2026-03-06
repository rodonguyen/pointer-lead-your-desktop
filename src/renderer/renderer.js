const chatArea      = document.getElementById('chat-area');
const stepCard      = document.getElementById('step-card');
const stepProgress  = document.getElementById('step-progress');
const stepBadge     = document.getElementById('step-type-badge');
const stepNav       = document.getElementById('step-nav');
const questionInput = document.getElementById('question-input');
const btnAsk        = document.getElementById('btn-ask');
const btnNext       = document.getElementById('btn-next');
const btnStuck      = document.getElementById('btn-stuck');
const btnReset      = document.getElementById('btn-reset');
const btnHideWindow = document.getElementById('btn-hide-window');
const btnCloseWindow = document.getElementById('btn-close-window');

// ── Helpers ────────────────────────────────────────────────────────────────

function addBubble(text, type = 'ai', extraClass = '') {
  const div = document.createElement('div');
  div.className = `bubble ${type} ${extraClass}`.trim();
  div.textContent = text;
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
  return div;
}

function addLoadingBubble() {
  const div = document.createElement('div');
  div.className = 'bubble ai';
  div.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
  return div;
}

function setInputEnabled(enabled) {
  questionInput.disabled = !enabled;
  btnAsk.disabled = !enabled;
}

const BADGE_CLASSES = { click: 'badge-click', type: 'badge-type', look: 'badge-look', highlight: 'badge-highlight' };
const BADGE_LABELS  = { click: 'Click', type: 'Type here', look: 'Look here', highlight: 'Highlight' };

function updateStepCard(stepNum, instruction, pointer_type) {
  stepProgress.textContent = `Step ${stepNum}`;
  stepBadge.className = `step-type-badge ${BADGE_CLASSES[pointer_type] || 'badge-click'}`;
  stepBadge.textContent = BADGE_LABELS[pointer_type] || pointer_type;
  stepCard.classList.add('visible');
  stepNav.classList.add('visible');
  btnNext.textContent = 'Done ✓';

  addBubble(instruction, 'ai', 'step-instruction');
}

// ── Event Listeners ────────────────────────────────────────────────────────

async function handleAsk() {
  const q = questionInput.value.trim();
  if (!q) return;

  questionInput.value = '';
  setInputEnabled(false);
  stepCard.classList.remove('visible');
  stepNav.classList.remove('visible');

  addBubble(q, 'user');

  try {
    await window.pointer.askQuestion(q);
  } catch (err) {
    if (loadingBubble) { loadingBubble.remove(); loadingBubble = null; }
    addBubble('Something went wrong. Please try again.', 'ai');
    setInputEnabled(true);
  }
}

btnAsk.addEventListener('click', handleAsk);
questionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleAsk();
  }
});

btnNext.addEventListener('click', async () => {
  await window.pointer.resetSession();
  stepCard.classList.remove('visible');
  stepNav.classList.remove('visible');
  addBubble('Great job! Ask me anything else.', 'ai');
  setInputEnabled(true);
});

btnStuck.addEventListener('click', () => window.pointer.markStuck());
btnHideWindow.addEventListener('click', () => window.pointer.hideWindow());
btnCloseWindow.addEventListener('click', () => window.pointer.closeWindow());

btnReset.addEventListener('click', async () => {
  await window.pointer.resetSession();
  chatArea.innerHTML = '<div class="bubble ai">Hi! I\'m Pointer. Ask me anything like <em>"How do I open Notepad?"</em> and I\'ll guide you step by step!</div>';
  stepCard.classList.remove('visible');
  stepNav.classList.remove('visible');
  setInputEnabled(true);
});

// ── IPC from Main ──────────────────────────────────────────────────────────

let loadingBubble = null;

window.pointer.on('loading', (isLoading) => {
  if (isLoading) {
    loadingBubble = addLoadingBubble();
  } else if (loadingBubble) {
    loadingBubble.remove();
    loadingBubble = null;
  }
});

window.pointer.on('steps-ready', ({ friendly_summary }) => {
  // Remove any leftover loader
  if (loadingBubble) { loadingBubble.remove(); loadingBubble = null; }
  const loaders = chatArea.querySelectorAll('.bubble.ai');
  const last = loaders[loaders.length - 1];
  if (last && last.querySelector('.loading-dots')) last.remove();

  addBubble(friendly_summary, 'ai', 'summary');
  setInputEnabled(true);
});

window.pointer.on('step-changed', (data) => {
  // Remove any loading bubble
  if (loadingBubble) { loadingBubble.remove(); loadingBubble = null; }

  if (data.is_complete) {
    stepCard.classList.remove('visible');
    stepNav.classList.remove('visible');
    addBubble(data.friendly_message, 'ai', 'summary');
    setInputEnabled(true);
    return;
  }

  updateStepCard(data.stepNum, data.instruction, data.pointer_type);
});

window.pointer.on('error', (message) => {
  const loaders = chatArea.querySelectorAll('.bubble.ai');
  const last = loaders[loaders.length - 1];
  if (last && last.querySelector('.loading-dots')) last.remove();

  addBubble(message, 'ai');
  setInputEnabled(true);
});
