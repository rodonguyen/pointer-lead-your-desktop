# Pointer — Desktop AI Guide App

## Context
Build a Windows-first Electron app that helps non-technical users (e.g. a parent in their 50s) complete desktop tasks. The user asks a question in a chat panel, the AI takes a screenshot, generates step-by-step instructions, and shows an animated visual pointer on screen pointing to the exact UI element to interact with. Similar to Interview Helper / Cluely but for desktop navigation guidance.

## Architecture: Two Electron Windows

| Window | Purpose |
|---|---|
| **Chat window** (380x620, frameless, always-on-top) | Chat UI — user input, step instructions, Next/Prev/Stuck buttons |
| **Overlay window** (fullscreen, transparent, click-through, always-on-top) | Renders animated pointer ring / highlight box on top of the desktop |

## Pointer Accuracy Strategy (multi-layer)
1. **AI returns normalized coords (0-1)** — avoids resolution mismatch from AI image downscaling
2. **OCR refinement via tesseract.js** — if AI provides `search_text`, OCR finds the exact text on screen and snaps to its bounding box (much more accurate)
3. **Large visual indicator** — 80-100px pulsing ring is forgiving of ±20px errors
4. **Region crop for OCR** — only OCR the 3x hint region, not full screen (200-500ms vs 3-7s)

## Tech Stack
- Electron 31+ (Node.js, no framework)
- Plain HTML/CSS/JS for both renderers (no React)
- `@anthropic-ai/sdk` — Claude claude-3-5-sonnet-20241022 with vision
- `tesseract.js` v5 — OCR for element finding
- `electron-store` — persist API key and settings
- `dotenv` — dev API key via `.env`

## Project Structure
```
pointer-lead-your-desktop/
├── main.js                          # Main process: windows, IPC hub, tray, hotkeys
├── preload.js                       # Shared IPC bridge (contextBridge) for both windows
├── package.json
├── .env                             # ANTHROPIC_API_KEY (not committed)
├── src/
│   ├── renderer/
│   │   ├── index.html               # Chat window UI
│   │   ├── renderer.js              # Chat logic, step navigation
│   │   └── styles.css               # Large fonts, warm colors, bubble chat
│   ├── overlay/
│   │   ├── overlay.html             # Transparent fullscreen shell
│   │   ├── overlay.js               # Canvas animation: pulsing ring, highlight box
│   │   └── overlay.css              # background: transparent
│   └── services/
│       ├── screenshotService.js     # desktopCapturer → base64 PNG
│       ├── aiService.js             # Claude API call + JSON response parsing
│       ├── ocrService.js            # tesseract.js worker (cached) + text search
│       └── pointerService.js        # Coord math: normalized→pixels, OCR merge
└── assets/
    └── tray-icon.png
```

## Data Flow

```
User types question
  → renderer.js: window.pointer.askQuestion(q)
  → IPC: 'ask-question'
  → main.js: hide chatWindow (150ms wait for compositor)
  → screenshotService: desktopCapturer → base64 PNG
  → aiService: Claude vision API → structured JSON steps
  → chatWindow shown again, 'steps-ready' sent to renderer
  → activateStep(0):
      → ocrService: if step.search_text, OCR crop region → refine coords
      → pointerService: build final pixel coords
      → 'show-pointer' → overlayWindow canvas animation
      → 'step-changed' → chatWindow updates instruction + progress
User clicks "NEXT STEP →" → activateStep(index + 1)
```

## AI Prompt Schema (JSON response)
```json
{
  "steps": [{
    "instruction": "Click the address bar at the top",
    "search_text": "Search or enter web address",
    "target_description": "address bar",
    "region": { "x": 0.5, "y": 0.04, "w": 0.6, "h": 0.05 },
    "pointer_type": "click"
  }],
  "friendly_summary": "I'll help you download Audacity! Just follow these 5 easy steps."
}
```

- `region` values are normalized 0.0–1.0 (x/y = center of target)
- `search_text` = exact visible text on the button/field for OCR to find; null if no text label
- `pointer_type`: `"click"` | `"highlight"` | `"type"` | `"look"`

## Key Implementation Notes

### Overlay Window (Windows-specific)
```javascript
overlayWindow.setIgnoreMouseEvents(true, { forward: true })  // { forward: true } is critical on Windows
overlayWindow.setAlwaysOnTop(true, 'screen-saver')           // Above chat window
// backgroundColor: '#00000000' and transparent: true both required
// focusable: false prevents keyboard focus trap
```

### IPC Channels
- `ask-question` → main (invoke)
- `next-step`, `prev-step`, `mark-stuck`, `reset-session` → main (invoke)
- `steps-ready`, `step-changed`, `loading`, `error` → chatRenderer (send)
- `show-pointer`, `hide-pointer` → overlayWindow (send)

### OCR Service
- Create Tesseract worker **once**, cache it (300-800ms init cost)
- OCR only the 3x hint region, not full screen
- Match: exact phrase → fuzzy single-word → null (fall back to AI coords)
- Destroy worker on `app.quit()`

### UX Design (for non-techy parent)
- Font: 16px+, warm cream background (#FFF8F0), orange primary (#FF6B35)
- Chat bubbles like WhatsApp
- Big "NEXT STEP →" (green), "Back" (gray), "I'm stuck 🆘" (yellow) buttons
- Progress: "Step 2 of 5" shown prominently
- Pointer labels: "Click here!", "Type here", "Look here"

## Development Phases

| Phase | Goal | Key Deliverable |
|---|---|---|
| 1 | Shell | Two windows communicate, test pulsing ring visible |
| 2 | Screenshot | Screen captured, overlay positions on hard-coded data |
| 3 | AI integration | Real Claude response drives step list |
| 4 | Overlay accuracy | Normalized coords → correct pixel positions |
| 5 | OCR refinement | OCR snaps pointer to exact element |
| 6 | UX polish | Hotkey, tray, stuck button, loading states, API key setup |
| 7 | Auto-click | AI clicks on behalf of the user (opt-in toggle) |
| 8 | Packaging | `.exe` installer via electron-builder |

## Phase 7: Auto-Click Feature

Allow the AI to perform the actual mouse click after showing the pointer, so the user doesn't have to click themselves.

### Implementation
- Add `@nut-tree/nut-js` (preferred) or `robotjs` for mouse automation
- Add "Click for me" toggle in the chat window UI
- New IPC handler in `main.js`:
  ```js
  ipcMain.handle('auto-click', async (e, { x, y, pointer_type }) => {
    if (pointer_type !== 'click') return; // only auto-click on click steps
    await sleep(800); // pause so user sees pointer first
    robot.moveMouse(x, y);
    robot.mouseClick();
  });
  ```
- Call after `show-pointer` in the existing `activateStep()` flow when toggle is on

### Notes
- `pointer_type: "highlight"`, `"look"`, `"type"` steps are skipped (no auto-click)
- For `"type"` steps, optionally auto-focus the field and type the suggested text
- May require accessibility permissions on Windows for some apps (UAC-elevated windows)
- Native binaries must be rebuilt for Electron during packaging (`electron-rebuild`)

## Files to Create (all new — empty repo)
- `package.json`
- `main.js`
- `preload.js`
- `src/renderer/index.html`, `renderer.js`, `styles.css`
- `src/overlay/overlay.html`, `overlay.js`, `overlay.css`
- `src/services/screenshotService.js`, `aiService.js`, `ocrService.js`, `pointerService.js`
- `.env.example`
- `assets/tray-icon.png` (placeholder)

## Verification
1. `npm start` — both windows appear, no errors in DevTools
2. Type "How do I open Notepad?" → chat shows steps, overlay shows pulsing ring near Start button
3. Click "NEXT STEP →" → pointer moves to next element, instruction updates
4. Test on 1080p and 4K screens — normalized coords handle both correctly
5. Test with multi-word button text — OCR snaps accurately vs AI-only coords
