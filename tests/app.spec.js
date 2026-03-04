const { _electron: electron } = require('@playwright/test');
const { test, expect } = require('@playwright/test');
const path = require('path');
const dotenv = require('dotenv');

let electronApp;
let chatPage;

test.beforeAll(async () => {
  // Load .env so ANTHROPIC_API_KEY is available to the Electron process
  const envVars = dotenv.config({ path: path.join(__dirname, '../.env') }).parsed || {};

  electronApp = await electron.launch({
    args: [path.join(__dirname, '../main.js')],
    env: { ...process.env, ...envVars },
  });

  // Wait for both windows (chat + overlay) to open, then find the chat window
  // by checking which one has #question-input in its DOM.
  await electronApp.waitForEvent('window');

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    for (const win of electronApp.windows()) {
      try {
        await win.waitForSelector('#question-input', { timeout: 1000 });
        chatPage = win;
        break;
      } catch {
        // not the chat window
      }
    }
    if (chatPage) break;
    await new Promise(r => setTimeout(r, 200));
  }

  if (!chatPage) throw new Error('Could not find chat window with #question-input');
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
});

test('app launches and shows chat window', async () => {
  expect(chatPage).toBeTruthy();
});

test('chat input is visible and enabled', async () => {
  const input = chatPage.locator('#question-input');
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
});

test('Ask button is visible', async () => {
  const btn = chatPage.locator('#btn-ask');
  await expect(btn).toBeVisible();
});

test('initial greeting bubble is shown', async () => {
  const bubble = chatPage.locator('.bubble.ai').first();
  await expect(bubble).toBeVisible();
  expect(await bubble.textContent()).toContain('Pointer');
});

test('step card is hidden initially', async () => {
  const stepCard = chatPage.locator('#step-card');
  await expect(stepCard).not.toHaveClass(/visible/);
});

test('reset button clears chat and re-shows greeting', async () => {
  await chatPage.locator('#btn-reset').click();
  const text = await chatPage.locator('#chat-area').textContent();
  expect(text).toContain('Pointer');
  await expect(chatPage.locator('#question-input')).toBeEnabled();
});

test('typing in input field works', async () => {
  const input = chatPage.locator('#question-input');
  await input.fill('How do I open Notepad?');
  expect(await input.inputValue()).toBe('How do I open Notepad?');
  await input.fill('');
});

test('multiple windows are created (chat + overlay)', async () => {
  expect(electronApp.windows().length).toBeGreaterThanOrEqual(2);
});

test('send a question and Claude responds with steps', async () => {
  test.setTimeout(90000);

  const input = chatPage.locator('#question-input');
  await input.fill('How do I open Notepad?');
  await chatPage.locator('#btn-ask').click();

  // User bubble appears
  await expect(chatPage.locator('.bubble.user').last()).toBeVisible();
  expect(await chatPage.locator('.bubble.user').last().textContent()).toContain('Notepad');

  // Input disabled while loading
  await expect(input).toBeDisabled();

  // Wait for input to re-enable — means Claude finished (success or error)
  await expect(input).toBeEnabled({ timeout: 80000 });

  // ── Assert AI success ──────────────────────────────────────────────────────

  // Check for any error bubble first — if present, fail with its message
  const errorBubbles = chatPage.locator('.bubble.ai');
  const count = await errorBubbles.count();
  const lastBubbleText = count > 0 ? await errorBubbles.last().textContent() : '';
  const hadError = lastBubbleText.includes("couldn't") || lastBubbleText.includes('wrong');
  if (hadError) {
    throw new Error(`Claude returned an error: "${lastBubbleText}"`);
  }

  // Friendly summary bubble should appear
  const summaryBubble = chatPage.locator('.bubble.ai.summary');
  await expect(summaryBubble).toBeVisible();
  const summary = await summaryBubble.textContent();
  expect(summary.trim().length).toBeGreaterThan(10);

  // Step card must be visible with a real instruction
  const stepCard = chatPage.locator('#step-card');
  await expect(stepCard).toHaveClass(/visible/);

  const progress = await chatPage.locator('#step-progress').textContent();
  expect(progress).toMatch(/Step 1 of [1-7]/);

  const instruction = await chatPage.locator('#step-instruction').textContent();
  expect(instruction.trim().length).toBeGreaterThan(5);

  // Badge must be one of the 4 valid pointer types
  const badge = await chatPage.locator('#step-type-badge').textContent();
  expect(['Click', 'Type here', 'Look here', 'Highlight']).toContain(badge);

  // Next step button is visible
  await expect(chatPage.locator('#btn-next')).toBeVisible();
});
