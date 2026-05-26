# AI Interaction Tracker — Chrome Extension Documentation

**Version:** 1.1.0  
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
├── background.js                   # Service worker — storage, dedup, export, stats
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

Exported files are named `ai-interactions-all-YYYY-MM-DD.csv` (all sessions) or `ai-interactions-<session-prefix>-YYYY-MM-DD.csv` (single session).

| Column | Format | Description |
|--------|--------|-------------|
| `session_id` | UUID v4 or platform-prefixed ID | Unique identifier per conversation (derived from URL — see Session Management) |
| `timestamp` | `YYYY-MM-DD HH:MM:SS` | Local time when the message was captured |
| `role` | `human` or `assistant` | Who sent the message |
| `message` | Raw text | Full message content, verbatim, no truncation |
| `platform` | `chatgpt`, `claude`, or `gemini` | Source platform |
| `url` | URL string | Conversation URL locked at capture time |

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

### Adapter Interface

Each platform implements a common interface in its adapter file:

| Property / Method | Type | Purpose |
|---|---|---|
| `platform` | string | Platform name (`chatgpt`, `claude`, `gemini`) |
| `getConversationRoot()` | method | Returns the DOM element to observe for new turns |
| `messageSelector` | string | CSS selector that matches individual turn nodes |
| `isMessageNode(node)` | method | Returns `true` if a given node is a conversation turn |
| `parseMessage(node)` | method | Returns `{ role, text }` or `null` |
| `isStreaming(node)` | method | Returns `true` while the AI is still generating |
| `getInputEl()` | method | Returns the text input element (for send interception) |
| `getSendButtonEls()` | method | Returns all send button elements |
| `normalizeTurnNode(node)` | method *(optional)* | Maps a detected inner node to its stable turn container |
| `waitForConversationUrl` | boolean *(optional)* | When `true`, delays human-message capture until URL has a conversation ID |

`main.js` is fully platform-agnostic — it only calls adapter methods. Adding a new platform requires only a new adapter file.

---

## Session Management

### Session ID Derivation

Session IDs are derived directly from the conversation URL path on every call — they are never cached for pages that have a recognizable conversation URL:

| Platform | URL pattern | Session ID format |
|---|---|---|
| ChatGPT | `/c/<uuid>` | `<uuid>` (e.g. `abc12345-...`) |
| Claude | `/chat/<uuid>` | `<uuid>` (e.g. `def67890-...`) |
| Gemini | `/app/<id>` | `g_<id>` (e.g. `g_abc123`) |
| Any (home/new-chat) | No conversation ID | Random UUID v4 stored in `sessionStorage` |

Deriving from the URL on every call means the session ID is always authoritative even if a navigation event is missed. The `sessionStorage` fallback is only used for home pages and new-chat pages before the platform assigns a URL.

### Session ID in `T.capture`

When `T.capture` is called with a locked `url` parameter (passed by `waitForComplete` at stream-start time), the session ID is derived from **that locked URL** rather than from the current page URL. This ensures that an assistant response which finishes after the user has navigated to a different conversation is stored under the correct original session, not the current one.

### SPA Navigation

ChatGPT, Claude, and Gemini are single-page apps. `main.js` patches `history.pushState` and `history.replaceState` and listens to `popstate` to detect navigation without a page reload. On each navigation:

1. `T.resetSession()` clears the `sessionStorage` cache and the `T.seen` deduplication Set.
2. After 800 ms, `tryObserve()` re-attaches the conversation observer to the new container.
3. `captureExistingMessages()` captures any messages already rendered in the new conversation.

---

## Message Capture Flow

### Human Messages

```
User presses Enter or clicks Send
         │
         ▼
Send interceptor records pendingTimestamp
(keydown / click listener in main.js)
         │
         ▼
MutationObserver fires: new node added to conversation root
         │
         ▼
handleAddedNode → normalizeTurnNode → deduplicate (seen Set)
         │
         ▼
scheduleCapture — role = human
         │
         ├── adapter.waitForConversationUrl = true AND no conversation URL yet?
         │         │
         │         ▼
         │   Retry every 1,200 ms up to 10 times (~12 s)
         │   until T.hasConversationUrl() returns true
         │         │
         └─────────┘
                   │
                   ▼ (after 800 ms minimum delay)
         T.capture(role='human', text, platform, pendingTimestamp)
         → session_id derived from current URL (which now has conversation ID)
```

### Assistant Messages

```
MutationObserver fires: new assistant node added
         │
         ▼
handleAddedNode → normalizeTurnNode → deduplicate (seen Set)
         │
         ▼
scheduleCapture — role = assistant → waitForComplete(node)
         │
         ▼
startUrl = window.location.href   ← URL locked NOW at stream-start
         │
         ▼
MutationObserver on the node (childList + subtree + characterData + attributes)
         │
         ├── isStreaming() → true:   set QUIET_MS timer (8,000 ms)
         ├── isStreaming() → false   set SETTLE_MS timer (1,200 ms)
         │   (after was true):
         ├── No mutations at all:    noMutationTimer fires after 3,000 ms
         │                          → check content, capture if ready
         └── Safety limit:          capture after 120,000 ms unconditionally
                   │
                   ▼
         finish() called
         captureUrl = startUrl has conversation ID?
                       yes → use startUrl
                       no  → use window.location.href (Gemini new-chat upgrade)
                   │
                   ▼
         captureNode → T.capture(role='assistant', text, platform, null, captureUrl)
         → session_id derived from captureUrl
```

---

## Streaming Wait Strategy

Streaming AI responses require waiting for generation to finish before capturing. A two-tier strategy handles different platform behaviors:

**Tier 1 — Clean signal** (`isStreaming()` works reliably):  
When `isStreaming()` transitions from `true` → `false`, capture after **1,200 ms** settle time. If streaming resumes, any new mutations cancel the settle timer and restart it.

**Tier 2 — Unreliable signal** (`isStreaming()` never returns `true`):  
Wait for **8,000 ms** of complete silence (no DOM mutations). This handles platforms or builds where streaming indicators are not present.

**Fallback — No mutations** (cached or instant response):  
If zero mutations arrive within **3,000 ms** of the observer starting, check if the node already has content and is not streaming. If so, capture immediately. This prevents a long wait for responses that arrive pre-rendered.

**Safety limit:** All nodes are captured after **120,000 ms** maximum, regardless of streaming state.

**URL upgrade in `finish()`:** If `startUrl` was a home/new-chat page (no conversation ID in path), `finish()` uses `window.location.href` as `captureUrl`. By the time streaming ends, the platform has navigated to the real conversation URL, so the stored URL is correct.

---

## Deduplication (Four-Layer System)

Multiple dedup layers work together to prevent both phantom duplicates and suppress legitimate repeat sends:

### Layer 1 — `streamWatchers` WeakMap (main.js)
Prevents two `waitForComplete` observers from being attached to the same node. If a node is already being watched, the second call is a no-op.

### Layer 2 — `capturedNodes` WeakSet (main.js)
DOM node identity tracking. Once a node has been scheduled for capture (human) or captured (assistant), it is added to this set. `captureExistingMessages` skips nodes already in the set. Prevents the re-observation path from double-processing nodes the live observer already handled.

### Layer 3 — `T.isDuplicate` in-memory Set (shared.js)
Whitespace-normalized duplicate check for **assistant messages only**. A response stored during streaming (compact spacing) and re-encountered on page reload (paragraph spacing) normalizes to the same key and is blocked. The Set is cleared on session reset (`T.resetSession()`).

### Layer 4 — Background `storeMessage` dedup (background.js)
Final dedup gate applied before writing to `chrome.storage.local`. Behavior depends on the `recapture` flag:

| `recapture` | Strategy | Use case |
|---|---|---|
| `true` | Exact whitespace-normalized match within session | `captureExistingMessages` path — navigating back to a previous chat |
| `false` (human) | Whitespace-normalized match within **120-second** window | Blocks React DOM re-render duplicates (same text, arrives seconds later) |
| `false` (assistant) | Whitespace-normalized match within **5-second** window | Blocks two content-script instances racing on the same live stream |

The 120-second window for human messages is long enough to catch re-render duplicates but short enough that a user deliberately sending the same message twice (after 2 minutes) is allowed through.

---

## Storage Write Serialization

All writes to `chrome.storage.local` are chained through a single Promise (`_writeQueue`). This prevents a race condition where multiple concurrent `storeMessage()` calls each read stale data and overwrite each other's writes — which happens when capturing an existing multi-message conversation all at once.

```javascript
let _writeQueue = Promise.resolve();
function serialise(fn) {
  _writeQueue = _writeQueue.then(fn).catch(console.error);
}
```

---

## Platform-Specific Notes

### ChatGPT

- **Turn detection:** `[data-message-author-role]` attribute on each message container. Role `user` maps to `human`; everything else maps to `assistant`.
- **Streaming detection:** `data-is-streaming="true"` attribute on the turn container (or `.result-streaming` class fallback).
- **Content extraction:** Targets `.markdown` or `[class*="prose"]` to exclude action buttons (Copy, Regenerate, etc.) from captured text. Falls back to the whole turn node.
- **Thinking block filtering:** o-series models show a reasoning block inside `<details>` before the real answer. These are filtered by `node.closest('details')` check. Additional guards: `[data-testid*="thinking"]`, `[data-testid*="reasoning"]`, `[class*="thinking-indicator"]` elements. Bare loading-state text (`"Thinking"`, `"Generating"`) is also discarded.
- **No `normalizeTurnNode`:** Each turn is a single stable element — no lifting needed.

### Claude

Claude's DOM has no turn-level `data-testid` on AI responses. Individual response paragraphs carry a `font-claude-response-*` class with no single shared wrapper element.

- **Turn detection:** `[data-testid="user-message"]` for human turns. `[class*="font-claude-response"]` for AI response paragraphs (matched per-paragraph, then lifted by `normalizeTurnNode`).

- **`normalizeTurnNode` — topmost walk:**  
  Walks the entire ancestor chain from the detected paragraph upward, tracking the topmost element that still carries a `font-claude-response-*` class. Returns `topmost.parentElement` — the stable per-turn root.  
  *Why topmost, not first no-class ancestor from the bottom:* When a Claude response includes an artifact widget, the response has multiple `font-claude-response` wrapper sections separated by non-class elements. Walking to the topmost ensures all sections normalize to the same parent container, preventing separate `waitForComplete` calls and duplicate captures.

- **`parseMessage` — LCA approach:**  
  All elements matching `[class*="font-claude-response"]` are found within the turn container, then filtered to **leaf nodes only** (no further matching descendants) to prevent text doubling. The LCA (Lowest Common Ancestor) of all leaf nodes is then found by walking up from the first leaf until the ancestor contains all leaves. That LCA is the prose wrapper block — it naturally contains `<table>`, `<code>`, and other non-class elements that would be missed by collecting only the response-class leaves. If the LCA would be the turn root itself (leaves are direct children), leaf texts are joined with `\n\n` instead, which excludes action buttons living in sibling containers.

- **Streaming detection:** `[data-testid="streaming-cursor"]`, `[class*="cursor-blink"]`, `[class*="typing-indicator"]`, `[class*="StreamingIndicator"]`, `[aria-label*="loading"]`. For `[role="status"]`, the `[aria-live]` attribute is additionally required to avoid false positives from static UI elements (copy buttons, badges) that use `role="status"` without being active announcements.

### Gemini

Gemini uses Angular custom elements for conversation turns.

- **Turn detection:** `user-query` and `model-response` custom element tags.
- **Content extraction:** Targets `message-content` sub-component first (Angular's content container), then falls back through progressively broader selectors (`[class*="query-text"]`, `markdown-renderer`, etc.). If the full element is used as fallback, Angular still renders speaker labels inside — handled by unconditional prefix stripping.
- **Speaker-label stripping:** `"You said"` and `"Gemini said"` prefixes are stripped **unconditionally** (not only in the fallback path). This is because confirmed live output shows the labels appearing inside `message-content` elements as well as in the full-element fallback.
- **`waitForConversationUrl: true`:** Gemini assigns the conversation URL several seconds after the first message is sent (unlike ChatGPT/Claude which navigate before or during send). Setting this flag tells `main.js` to use the retry-loop path for human messages: poll `T.hasConversationUrl()` every 1,200 ms for up to 10 retries (~12 seconds total) before capturing. This prevents the human message being stored under a phantom random-UUID session before the real `/app/<id>` URL is assigned.
- **Streaming detection:** `pending` and `is-loading` attributes on `model-response`, plus `loading-indicator` element and `[class*="loading"]` class and `[aria-label*="enerating"]`.

---

## Popup UI

The extension popup provides:

- **Enable/Disable toggle** — pauses all capture when OFF; resumes when toggled back ON. Toggle state is persisted in `chrome.storage.local`.
- **Per-platform stats** — session and message count for ChatGPT, Claude, and Gemini.
- **Total count** — aggregate messages and sessions across all platforms.
- **Export all as CSV** — triggers a `chrome.downloads.download` of all captured data as a UTF-8 BOM CSV.
- **Clear all data** — deletes all stored sessions after a browser `confirm()` dialog.
- **Toast notifications** — brief status messages (2,400 ms auto-dismiss) for export success/failure, toggle state, and clear confirmation.

When no data has been captured, the stats section is hidden and export/clear buttons are disabled.

---

## Background Service Worker

The service worker (`background.js`) handles four message types sent from content scripts and the popup:

| Message type | Sender | Action |
|---|---|---|
| `CAPTURE_MESSAGE` | Content scripts | Stores a single message to `chrome.storage.local` via the write queue |
| `GET_STATS` | Popup | Returns per-platform and total session/message counts |
| `EXPORT_CSV` | Popup | Builds and downloads the CSV file; optionally scoped to one session |
| `CLEAR_DATA` | Popup | Deletes all stored session data |

### Storage Schema

Data is stored under a single `sessions` key as a JSON object keyed by `session_id`:

```json
{
  "sessions": {
    "<session_id>": {
      "id": "<session_id>",
      "platform": "chatgpt | claude | gemini",
      "url": "<conversation URL>",
      "startedAt": "<ISO timestamp>",
      "messages": [
        {
          "session_id": "<session_id>",
          "timestamp": "<ISO timestamp>",
          "role": "human | assistant",
          "message": "<verbatim text>",
          "platform": "chatgpt | claude | gemini",
          "url": "<conversation URL>"
        }
      ]
    }
  }
}
```

Messages within a session are stored in insertion order: the human message is stored ~800 ms after send; the assistant message is stored only after the streaming quiet timer fires (1,200 ms+ after generation ends). Human messages therefore always precede the corresponding assistant reply in the array.

---

## Known Behaviors and Limitations

- **Streaming delay:** AI responses are captured only after generation completes. For long responses, there may be a 1–8 second delay between the response appearing on screen and it being stored.
- **Gemini new-conversation delay:** On a new Gemini conversation, the human message capture is delayed by up to ~12 seconds while the extension polls for the conversation URL. The message is stored correctly once the URL is available; no data is lost.
- **Existing messages on page load:** When loading a page with an existing conversation, messages already on screen are captured after a 1,200 ms stabilization delay. If generation is still in progress, those nodes are routed through the streaming wait instead of being captured immediately.
- **SPA navigation timing:** After detecting a URL change, the extension waits 800 ms before re-attaching the observer and capturing existing messages, to allow the new conversation's DOM to render.
- **Navigate away mid-stream:** If the user navigates to a different conversation while an AI response is still generating, the response is stored under the correct original session (URL was locked at stream-start) rather than the current session.
- **DOM selector stability:** The extension targets semantic attributes (`data-testid`, `data-message-author-role`, Angular element tags) where possible to reduce sensitivity to CSS class renames. Claude's AI response detection is class-based (`font-claude-response-*`) because no semantic alternative exists in the current DOM.
- **Storage limit:** `chrome.storage.local` has an effective limit of approximately 10 MB by default. The `unlimitedStorage` permission is requested to remove this cap for heavy usage.
- **Multiple tabs:** Each tab runs its own content script instance. The write queue in `background.js` serializes concurrent writes from multiple tabs, and background dedup prevents the same live message from being stored twice if two instances happen to capture it simultaneously.

---

## Debugging

To inspect captured data or diagnose issues:

1. Open the target platform tab (ChatGPT, Claude, or Gemini)
2. Open Chrome DevTools (F12) → Console
3. Run in the background service worker console (accessible via `chrome://extensions` → "Inspect views: service worker"):

```javascript
chrome.storage.local.get('sessions', data => console.log(JSON.stringify(data, null, 2)));
```

To test adapter selectors on any page open the tab's DevTools console:

```javascript
// Check conversation root:
document.querySelector('[data-testid="conversation-turns"]')   // ChatGPT
document.querySelector('[data-testid="conversation"]')          // Claude
document.querySelector('infinite-scroller')                     // Gemini

// Check message detection:
document.querySelectorAll('[data-message-author-role]')          // ChatGPT
document.querySelectorAll('[data-testid="user-message"], [class*="font-claude-response"]') // Claude
document.querySelectorAll('user-query, model-response')          // Gemini

// Check streaming state (run while AI is generating):
document.querySelector('[data-is-streaming="true"]')            // ChatGPT
document.querySelector('[data-testid="streaming-cursor"]')      // Claude
document.querySelector('model-response[pending]')               // Gemini
```

To check if the session ID is being derived correctly:

```javascript
// Run in the content script tab console:
window.AITracker.getSessionId();   // should return conversation UUID, not a random UUID
window.AITracker.hasConversationUrl(); // should return true on a chat page
```

---

## Changelog

### v1.1.0

- **Fix:** Claude table and code block content was missing from CSV. Root cause: `parseMessage` only collected `font-claude-response` leaf elements; `<table>` has no such class. Fix: LCA (Lowest Common Ancestor) approach — the lowest ancestor containing all leaf paragraphs also contains tables and code blocks.
- **Fix:** Duplicate Claude assistant rows with whitespace variants. Root cause: streaming render (compact) vs final render (spaced) produce different text. Fix: whitespace-normalize before dedup in both `T.isDuplicate` and background `storeMessage`.
- **Fix:** Triple-duplicate Claude responses with artifact widgets. Root cause: multiple `font-claude-response` sections (separated by artifact containers) normalized to different containers → separate `waitForComplete` calls. Fix: `normalizeTurnNode` now walks to the **topmost** `font-claude-response` ancestor, ensuring all sections normalize to the same parent.
- **Fix:** Wrong session ID (message stored under wrong conversation). Root cause: `T.getSessionId()` returned a cached `sessionStorage` value after navigation. Fix: session IDs are now always derived from the current URL path; `sessionStorage` is only a fallback for home/new-chat pages.
- **Fix:** Gemini `"You said"` / `"Gemini said"` prefix leaking into captured human messages. Root cause: prefix-strip guard only ran when `contentEl === node` (full-element fallback). Labels appear inside `message-content` too. Fix: prefix stripping is now unconditional.
- **Fix:** Gemini human message stored under phantom random-UUID session. Root cause: fixed 5,200 ms delay was insufficient; Gemini can take 6+ seconds to assign the conversation URL. Fix: retry loop polling `T.hasConversationUrl()` every 1,200 ms up to 10 times (~12 s total).
- **Fix:** Gemini human message captured 3× (React re-renders replace DOM nodes, bypassing `capturedNodes`). Fix: background dedup uses a **120-second** time-window for human messages (vs 5 seconds for assistant messages), absorbing re-render duplicates that arrive within seconds.
- **Fix:** Wrong session when user navigates away mid-stream. Root cause: `T.capture` called `T.getSessionId()` at finish time (current URL). Fix: `T.capture` now derives `session_id` from the locked `url` parameter when it contains a conversation ID.
- **Fix:** Gemini assistant response stored with home-page URL. Root cause: `startUrl` locked to `gemini.google.com/app` (new-chat page). Fix: `finish()` in `waitForComplete` upgrades `startUrl` to `window.location.href` when `startUrl` has no conversation ID; by stream-end the real `/app/<id>` URL is available.
- **Fix:** Wrong URL for first ChatGPT/Claude assistant message. Root cause: URL read at capture time (stream-end), after user may have navigated. Fix: `startUrl = window.location.href` locked at the start of `waitForComplete`.
- **Fix:** ChatGPT thinking/reasoning blocks captured as spurious rows. Fix: `node.closest('details')` guard, `data-testid*="thinking/reasoning"` filter, and bare `"Thinking"` / `"Generating"` text rejection.
- **Fix:** Claude `[role="status"]` false positive in `isStreaming`. Fix: requires `[aria-live]` attribute to distinguish active status announcements from static UI elements.
- **Fix:** Storage write race condition when capturing many messages simultaneously. Fix: all `chrome.storage.local` writes serialized through a `_writeQueue` Promise chain.
- Added `recapture` flag to distinguish live-observer captures (time-window dedup) from re-captures on page reload (exact-match dedup).

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
