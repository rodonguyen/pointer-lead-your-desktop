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
You will receive a screenshot of the user's current screen and their question.

Respond ONLY with valid JSON in this exact schema — no markdown, no explanation:
{
  "steps": [
    {
      "instruction": "Plain English instruction (short, friendly, 16px readable)",
      "search_text": "Exact visible text on the button/field for OCR (null if no text label)",
      "target_description": "Short label for the UI element",
      "region": { "x": 0.0, "y": 0.0, "w": 0.1, "h": 0.05 },
      "pointer_type": "click"
    }
  ],
  "friendly_summary": "Encouraging 1-sentence intro shown to the user before steps"
}

Rules:
- region x/y are the CENTER of the target element, normalized 0.0–1.0 (x=left→right, y=top→bottom)
- region w/h are the element's width/height normalized 0.0–1.0
- pointer_type must be one of: "click", "type", "look", "highlight"
- search_text: exact text visible on the button/field; null if the element has no readable label
- Keep instructions simple — the user may be in their 50s with limited tech experience
- Maximum 7 steps; combine steps where sensible
- friendly_summary must be warm and reassuring`;

/**
 * Sends a question + screenshot to Claude and returns parsed step data.
 * @param {string} question - User's question
 * @param {string} screenshotBase64 - Base64 PNG (no data-URI prefix)
 * @returns {{ steps: Array, friendly_summary: string }}
 */
async function askClaude(question, screenshotBase64) {
  const claude = getClient();

  const response = await claude.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 2048,
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
            text: question,
          },
        ],
      },
    ],
  });

  const raw = response.content[0].text.trim();

  // Strip markdown code fences if model wraps the JSON anyway
  const jsonText = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Claude returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error('Claude returned no steps.');
  }

  return parsed;
}

module.exports = { askClaude };
