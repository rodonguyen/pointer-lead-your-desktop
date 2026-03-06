const Anthropic = require('@anthropic-ai/sdk');

let client = null;

function getClient() {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Add it to your .env file.');
    client = new Anthropic({ apiKey });
  }
  return client;
}

const SYSTEM_PROMPT = `You are a desktop guide assistant helping non-technical users complete tasks on their computer.
You will receive a screenshot of the user's current screen, their original task, and a summary of steps already completed.

CRITICAL: You MUST visually locate every UI element in the provided screenshot before setting region coordinates.
Do NOT use general knowledge about where things "usually" are (e.g. do not assume the Start button is bottom-left — on Windows 11 it is centered). Look at the actual screenshot pixels and find the element's real position.

Determine the SINGLE next action the user needs to take. If the task is already complete based on the screenshot, say so.

Respond ONLY with valid JSON in one of these two schemas — no markdown, no explanation:

When there is a next action:
{
  "is_complete": false,
  "instruction": "Plain English instruction (short, friendly, 16px readable)",
  "search_text": "Exact visible text on the button/field for OCR (null if no text label)",
  "target_description": "Short label for the UI element",
  "region": { "x": 0.0, "y": 0.0, "w": 0.1, "h": 0.05 },
  "pointer_type": "click",
  "friendly_message": "Encouraging 1-sentence shown to the user"
}

When the task is complete:
{
  "is_complete": true,
  "friendly_message": "Warm congratulations message"
}

Rules:
- region x/y are the CENTER of the target element, normalized 0.0–1.0 (x=left→right, y=top→bottom)
- region w/h are the element's width/height normalized 0.0–1.0
- BEFORE setting x/y: scan the screenshot to find exactly where the element appears. Set x/y to its actual visual center in the image, not where it "typically" would be
- pointer_type must be one of: "click", "type", "look", "highlight"
- search_text: exact text visible on the button/field; null if the element has no readable label
- Keep instructions simple — the user may be in their 50s with limited tech experience`;

/**
 * Sends a question + screenshot to Claude and returns a single next step.
 * @param {string} question - User's original task
 * @param {string} screenshotBase64 - Base64 PNG (no data-URI prefix)
 * @param {string[]} taskHistory - Array of completed step descriptions for context
 * @returns {{ is_complete: boolean, instruction?: string, search_text?: string, target_description?: string, region?: object, pointer_type?: string, friendly_message: string }}
 */
async function askClaude(question, screenshotBase64, taskHistory = []) {
  const claude = getClient();

  const historyText = taskHistory.length > 0
    ? `\n\nSteps already completed:\n${taskHistory.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : '';

  const response = await claude.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: screenshotBase64,
            },
          },
          {
            type: 'text',
            text: `Task: ${question}${historyText}`,
          },
        ],
      },
    ],
  });

  const raw = response.content[0].text.trim();
  const jsonText = extractJson(raw);

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Claude returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  if (typeof parsed.is_complete !== 'boolean') {
    throw new Error('Claude returned invalid response: missing is_complete field.');
  }

  return parsed;
}

/**
 * Extracts the first complete {...} JSON object from a string that may contain
 * prose, markdown fences, or other text before/after the JSON.
 */
function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return text; // no object found — let JSON.parse fail with original

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return text.slice(start); // unclosed — let JSON.parse surface the error
}

module.exports = { askClaude };
