# AI Interaction Tracker — Chrome Extension Documentation

**Version:** 1.0.0  
**Manifest:** Chrome Extension Manifest V3  
**Platforms supported:** ChatGPT (chat.openai.com, chatgpt.com), Claude (claude.ai), Gemini (gemini.google.com)

---

## Overview

The AI Interaction Tracker is a Chrome Extension that silently captures the full text of every human prompt and AI response across three major AI chat platforms, then lets you export the complete conversation history as a structured CSV file. No data is trimmed, sanitized, or truncated — every character of every message is stored verbatim.

---

## File Structure

```
chrome-extension/
├── manifest.json                   # Extension configuration (MV3)
├── background.js                   # Service worker — storage, export, stats
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── popup/
│   ├── popup.html                  # Extension popup UI
│   ├── popup.css                   # Dark theme styling
│   └── popup.js                    # Popup logic — toggle, stats, export, clear
└── content/
    ├── shared.js                   # Shared utilities — session ID, dedup, capture
    ├── main.js                     # Core orchestrator — observer, streaming wait
    └── adapters/
        ├── chatgpt.js              # DOM adapter for ChatGPT
        ├── claude.js               # DOM adapter for Claude
        └── gemini.js               # DOM adapter for Gemini
```

---

## How to Install (Local Development)

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `chrome-extension/` folder from this project
5. The extension icon will appear in the Chrome toolbar

To reload after making code changes: click the refresh icon on the extension card at `chrome://extensions`.

---

## CSV Export Schema

Exported files are named `ai-interactions-all-YYYY-MM-DD.csv`.

| Column | Format | Description |
|--------|--------|-------------|
| `session_id` | UUID v4 | Unique identifier per browser tab per conversation |
| `timestamp` | `YYYY-MM-DD HH:MM:SS` | Local time when the message was captured |
| `role` | `human` or `assistant` | Who sent the message |
| `message` | Raw text | Full message content, verbatim, no truncation |
| `platform` | `chatgpt`, `claude`, or `gemini` | Source platform |
| `url` | URL string | Page URL at capture time |

**CSV encoding:** UTF-8 with BOM (so Excel auto-detects UTF-8 instead of Windows-1252).  
**Quoting:** RFC 4180 — cells containing commas, double-quotes, or newlines are wrapped in double-quotes with internal quotes escaped as `""`.  
**Row order:** Human message always appears before the corresponding assistant response, matching the natural conversation flow.

---

## Architecture

### Script Loading Order

For each platform, three content scripts are injected in order:

```
shared.js → [platform-adapter].js → main.js
```

`shared.js` creates the `window.AITracker` namespace. The adapter populates `window.AITracker.adapter`. `main.js` reads the adapter and starts the observer.

### Adapter Pattern

Each platform implements a common interface in its adapter file:

| Method | Purpose |
|--------|---------|
| `getConversationRoot()` | Returns the DOM element to observe for new turns |
| `messageSelector` | CSS selector that matches individual turn nodes |
| `isMessageNode(node)` | Returns true if a given node is a conversation turn |
| `parseMessage(node)` | Returns `{ role, text }` or `null` |
| `isStreaming(node)` | Returns true while the AI is still generating |
| `getInputEl()` | Returns the text input element (for send interception) |
| `getSendButtonEls()` | Returns all send button elements |
| `normalizeTurnNode(node)` | *(Optional)* Maps a detected node to its stable turn container |

`main.js` is fully platform-agnostic — it only calls adapter methods. Adding a new platform requires only a new adapter file.

### Session Management

Each browser tab has its own session ID, stored in `sessionStorage`. The session ID is a UUID v4 generated on first access and persists across soft navigations within the same tab.

When the user navigates to a new conversation (SPA navigation via `history.pushState` or `history.replaceState`), `T.resetSession()` is called to generate a fresh session ID and clear the deduplication set, so each conversation is tracked independently.

### Message Capture Flow

```
User sends message
       │
       ▼
Send interceptor records pendingTimestamp (keydown Enter / send button click)
       │
       ▼
MutationObserver detects new node in conversation root
       │
       ▼
handleAddedNode → normalizeTurnNode → deduplicate → scheduleCapture
       │
       ├─── role = human ──────► 150ms delay → T.capture(role, text, platform, timestamp)
       │
       └─── role = assistant ──► waitForComplete(node)
                                        │
                              MutationObserver on the node
                              + streaming detection (two-tier)
                                        │
                              streaming ends → captureNode → T.capture
```

### Streaming Wait Strategy

Streaming AI responses require waiting for generation to finish before capturing. A two-tier strategy handles different platform behaviors:

**Tier 1 — Clean signal** (`isStreaming()` works reliably):  
When `isStreaming()` transitions from `true` → `false`, capture after **1,200 ms** settle time. If streaming resumes, any new mutations cancel the settle timer.

**Tier 2 — Unreliable signal** (`isStreaming()` never returns true):  
Wait for **8,000 ms** of complete silence (no DOM mutations). This handles platforms or builds where streaming indicators are not present.

**Fallback — No mutations** (cached/instant response):  
If zero mutations arrive within **3,000 ms** of the observer starting, check if the node already has content. If yes, capture immediately. This prevents a long wait for responses that arrive pre-rendered.

**Safety limit:** All nodes are captured after **120,000 ms** maximum, regardless of streaming state.

### Deduplication

An in-memory `Set` tracks `role + '\x00' + text` pairs. If the same content is seen twice in a page session (e.g., from both `captureExistingMessages` and a live mutation), the second capture is silently dropped. The set is cleared on session reset.

### Storage Write Serialization

All writes to `chrome.storage.local` are chained through a single Promise (`_writeQueue`). This prevents a race condition where multiple concurrent `storeMessage()` calls each read stale data and overwrite each other's writes — which would happen when capturing an existing multi-message conversation all at once.

---

## Platform-Specific Notes

### ChatGPT

- **Turn detection:** `[data-message-author-role]` attribute on each message container.
- **Streaming detection:** `data-is-streaming="true"` attribute on the turn container (or `.result-streaming` class fallback).
- **Content extraction:** Targets `.markdown` or `[class*="prose"]` to exclude action buttons (Copy, Regenerate, etc.) from captured text.
- **No `normalizeTurnNode`:** Each turn is a single stable element — no lifting needed.

### Claude

Claude's DOM has no turn-level `data-testid` on AI responses. Individual response paragraphs carry a `font-claude-response-*` class, with no shared wrapper.

- **Turn detection:** `[data-testid="user-message"]` for human, `[class*="font-claude-response"]` for AI paragraphs.
- **`normalizeTurnNode`:** Walks up through all ancestors that also carry a `font-claude-response-*` class to find the first ancestor that does NOT. This produces a single stable container per AI turn, ensuring only one `MutationObserver` is attached per response.
- **Leaf-node filtering in `parseMessage`:** All elements matching `[class*="font-claude-response"]` are found, then filtered to only those with no further matching descendants (leaves). This prevents text doubling when both a wrapper `<div>` and its child `<p>` both match the selector.
- **Streaming detection:** `[data-testid="streaming-cursor"]`, `[class*="cursor-blink"]`, `[class*="typing-indicator"]`, `[aria-label*="loading"]`, `[role="status"]`.

### Gemini

Gemini uses Angular custom elements for conversation turns.

- **Turn detection:** `user-query` and `model-response` custom element tags.
- **Content extraction:** Targets `message-content` sub-component first (Angular's content container), then falls back through progressively broader selectors. If the full element is used as fallback, "You said" / "Gemini said" speaker-label prefixes are stripped with regex.
- **Streaming detection:** `pending` and `is-loading` attributes on `model-response`, plus `loading-indicator` element and `[class*="loading"]` class.

---

## Popup UI

The extension popup provides:

- **Enable/Disable toggle** — pauses all capture when OFF; resumes when toggled back ON.
- **Per-platform stats** — sessions and message count for ChatGPT, Claude, and Gemini.
- **Total count** — aggregate messages and sessions across all platforms.
- **Export all as CSV** — triggers a download of all captured data.
- **Clear all data** — deletes all stored sessions after a confirmation dialog.
- **Toast notifications** — brief status messages for export success/failure and toggle state.

---

## Background Service Worker

The service worker (`background.js`) handles four message types sent from content scripts and the popup:

| Message type | Action |
|-------------|--------|
| `CAPTURE_MESSAGE` | Stores a single message to `chrome.storage.local` |
| `GET_STATS` | Returns per-platform and total session/message counts |
| `EXPORT_CSV` | Builds and downloads the CSV file |
| `CLEAR_DATA` | Deletes all stored session data |

Data is stored under a single `sessions` key as a JSON object keyed by `session_id`. Each session contains metadata (`platform`, `url`, `startedAt`) and an ordered `messages` array.

---

## Known Behaviors and Limitations

- **Streaming delay:** AI responses are captured only after generation completes. For long responses, there may be a 1–8 second delay between the response appearing and it being stored.
- **Existing messages:** When loading a page with an existing conversation, messages already on screen are captured after a 1,200 ms delay (to let the page stabilize). If generation is still in progress, those nodes are routed through the streaming wait instead.
- **SPA navigation timing:** After detecting a URL change, the extension waits 800 ms before re-attaching the observer and capturing existing messages, to allow the new conversation's DOM to render.
- **DOM selector stability:** The extension targets semantic attributes (`data-testid`, `data-message-author-role`, Angular element tags) where possible to reduce sensitivity to CSS class renames. Claude's AI response detection is class-based because no semantic alternative exists in the current DOM.
- **Storage limit:** `chrome.storage.local` has an effective limit of approximately 10 MB by default. The `unlimitedStorage` permission is requested to remove this cap for heavy usage.

---

## Debugging

To inspect captured data or diagnose issues:

1. Open the target platform tab (ChatGPT, Claude, or Gemini)
2. Open Chrome DevTools (F12) → Console
3. Run: `chrome.storage.local.get('sessions', console.log)` in the background service worker console (accessible via `chrome://extensions` → "Inspect views: service worker")

To test adapter selectors on any page:
```javascript
// Check if the conversation root is found:
document.querySelector('[data-testid="conversation"]')   // Claude example

// Check if messages are found:
document.querySelectorAll('[data-message-author-role]')  // ChatGPT example
document.querySelectorAll('user-query, model-response')  // Gemini example
```

---

## Changelog

### v1.0.0

- Initial implementation covering ChatGPT, Claude, and Gemini
- Adapter pattern for clean platform isolation
- Two-tier streaming detection with configurable settle/quiet timers
- `normalizeTurnNode` hook for Claude's paragraph-based DOM
- Leaf-node filtering to prevent text doubling on nested selectors
- Write-queue serialization to prevent storage race conditions
- UTF-8 BOM and RFC 4180 CSV export
- Session-based data grouping with per-tab isolation
- SPA navigation detection via `history.pushState` interception
- ON/OFF toggle with per-platform stats in popup
