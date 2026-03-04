/**
 * Unit tests for pointerService and ocrService (no Electron window needed).
 * Run with: npx playwright test tests/services.spec.js
 */
const { test, expect } = require('@playwright/test');

// ── extractJson (tested via aiService internals via a small harness) ──────────

// Re-implement extractJson here to unit-test it independently
function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return text;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start);
}

const VALID_JSON = '{"steps":[{"instruction":"Click Start"}],"friendly_summary":"Let\'s go!"}';

test('extractJson: plain JSON passthrough', () => {
  expect(extractJson(VALID_JSON)).toBe(VALID_JSON);
});

test('extractJson: strips markdown code fence', () => {
  const input = '```json\n' + VALID_JSON + '\n```';
  expect(JSON.parse(extractJson(input))).toMatchObject({ steps: expect.any(Array) });
});

test('extractJson: strips prose before JSON', () => {
  const input = 'Sure! Here is the plan:\n' + VALID_JSON;
  expect(JSON.parse(extractJson(input))).toMatchObject({ steps: expect.any(Array) });
});

test('extractJson: strips prose before a fenced block', () => {
  const input = 'Looking at your screen...\n```json\n' + VALID_JSON + '\n```';
  expect(JSON.parse(extractJson(input))).toMatchObject({ steps: expect.any(Array) });
});

test('extractJson: handles escaped quotes inside strings', () => {
  const json = '{"steps":[{"instruction":"Click \\"OK\\""}],"friendly_summary":"Done"}';
  expect(JSON.parse(extractJson(json))).toMatchObject({ steps: [{ instruction: 'Click "OK"' }] });
});

test('extractJson: returns original when no { found', () => {
  expect(extractJson('no json here')).toBe('no json here');
});

// ── pointerService ────────────────────────────────────────────────────────────
// We test the pure coord math by requiring the module directly.
// electron's `screen` isn't available outside an Electron process, so we mock it.

let resolvePointerCoords;

// Mock display: 1920×1080 logical, scaleFactor 1.5 → 2880×1620 physical
const MOCK_DISPLAY = { bounds: { width: 1920, height: 1080 }, scaleFactor: 1.5 };

test.beforeAll(() => {
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (request, ...args) {
    if (request === 'electron') {
      return {
        screen: { getPrimaryDisplay: () => MOCK_DISPLAY },
        nativeImage: { createFromBuffer: () => {} },
      };
    }
    return originalLoad.call(this, request, ...args);
  };
  resolvePointerCoords = require('../src/services/pointerService').resolvePointerCoords;
  Module._load = originalLoad;
});

// ── AI coords (no OCR, with imgSize from screenshot) ─────────────────────────

test('resolvePointerCoords: normalised centre — imgSize matches logical (scale=1)', () => {
  // Screenshot captured at logical size: 1920×1080
  const coords = resolvePointerCoords(
    { x: 0.5, y: 0.5, w: 0.1, h: 0.05 },
    null,
    { imgWidth: 1920, imgHeight: 1080 }
  );
  expect(coords.x).toBe(960);
  expect(coords.y).toBe(540);
});

test('resolvePointerCoords: normalised centre — imgSize at physical (2×)', () => {
  // Screenshot at 2880×1620 physical, logical display 1920×1080
  // AI sees image, returns normalized y=0.5 → overlay must draw at logical 540
  const coords = resolvePointerCoords(
    { x: 0.5, y: 0.5, w: 0.1, h: 0.05 },
    null,
    { imgWidth: 2880, imgHeight: 1620 }
  );
  expect(coords.x).toBe(960);
  expect(coords.y).toBe(540);
});

test('resolvePointerCoords: top-left corner', () => {
  const coords = resolvePointerCoords({ x: 0, y: 0, w: 0.05, h: 0.05 }, null, { imgWidth: 1920, imgHeight: 1080 });
  expect(coords.x).toBe(0);
  expect(coords.y).toBe(0);
});

test('resolvePointerCoords: bottom-right corner clamps to logical display', () => {
  const coords = resolvePointerCoords({ x: 1.0, y: 1.0, w: 0.1, h: 0.1 }, null, { imgWidth: 1920, imgHeight: 1080 });
  expect(coords.x).toBe(1919);
  expect(coords.y).toBe(1079);
});

test('resolvePointerCoords: out-of-range values clamp', () => {
  const coords = resolvePointerCoords({ x: 1.5, y: -0.5, w: 0.1, h: 0.1 }, null, { imgWidth: 1920, imgHeight: 1080 });
  expect(coords.x).toBe(1919);
  expect(coords.y).toBe(0);
});

// ── OCR override ─────────────────────────────────────────────────────────────

test('resolvePointerCoords: ocrRect overrides AI coords (no scaling)', () => {
  // Screenshot at 1920×1080 (same as logical) — OCR rect is in screenshot pixels = logical
  const ocrRect = { x: 100, y: 200, width: 80, height: 24 };
  const coords = resolvePointerCoords(
    { x: 0.5, y: 0.5, w: 0.1, h: 0.05 },
    ocrRect,
    { imgWidth: 1920, imgHeight: 1080 }
  );
  // center: (100+40, 200+12) = (140, 212) — same in logical since imgSize == display
  expect(coords.x).toBe(140);
  expect(coords.y).toBe(212);
});

test('resolvePointerCoords: ocrRect scales to logical when imgSize is physical', () => {
  // Screenshot at 2880×1620, display logical 1920×1080 (scale 1.5)
  // OCR found element at physical (2160, 810) size (120, 36)
  // center physical = (2160+60, 810+18) = (2220, 828)
  // logical = (2220 * 1920/2880, 828 * 1080/1620) = (1480, 552)
  const ocrRect = { x: 2160, y: 810, width: 120, height: 36 };
  const coords = resolvePointerCoords(
    { x: 0.5, y: 0.5, w: 0.1, h: 0.05 },
    ocrRect,
    { imgWidth: 2880, imgHeight: 1620 }
  );
  expect(coords.x).toBe(1480);
  expect(coords.y).toBe(552);
});

test('resolvePointerCoords: ocrRect center is clamped to logical display', () => {
  const ocrRect = { x: 2800, y: 1580, width: 200, height: 200 };
  const coords = resolvePointerCoords(
    { x: 0.5, y: 0.5, w: 0.1, h: 0.05 },
    ocrRect,
    { imgWidth: 2880, imgHeight: 1620 }
  );
  expect(coords.x).toBe(1919);
  expect(coords.y).toBe(1079);
});
