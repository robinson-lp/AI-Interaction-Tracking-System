# Developer Guide — AI Interaction Tracker

This guide covers the extension's architecture, how to add a new platform, and all the design decisions behind the timing, deduplication, and session management systems.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [File Structure](#file-structure)
3. [Script Loading Order](#script-loading-order)
4. [The Adapter Pattern](#the-adapter-pattern)
5. [Session Management](#session-management)
6. [Message Capture Pipeline](#message-capture-pipeline)
7. [Streaming Wait Strategy](#streaming-wait-strategy)
8. [Deduplication — Four Layers](#deduplication)
9. [Storage and the Write Queue](#storage-and-the-write-queue)
10. [SPA Navigation Handling](#spa-navigation-handling)
11. [Timing Constants](#timing-constants)
12. [How to Add a New Platform](#how-to-add-a-new-platform)
13. [Testing Checklist](#testing-checklist)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Browser Tab (ChatGPT / Claude / Gemini)                    │
│                                                             │
│  ┌──────────────┐  ┌────────────────┐  ┌────────────────┐  │
│  │  shared.js   │  │  [adapter].js  │  │   main.js      │  │
│  │  T namespace │→ │  T.adapter     │→ │  orchestrator  │  │
│  └──────────────┘  └────────────────┘  └───────┬────────┘  │
│                                                 │           │
│                          chrome.runtime.sendMessage         │
└─────────────────────────────────────────────────┼───────────┘
                                                  ▼
┌─────────────────────────────────────────────────────────────┐
│  background.js (Service Worker)                             │
│  Receives CAPTURE_MESSAGE, GET_STATS, EXPORT_CSV, CLEAR     │
│  Writes to chrome.storage.local via serialised queue        │
└─────────────────────────────────────────────────────────────┘
                                                  ▲
                           chrome.runtime.sendMessage
┌─────────────────────────────────────────────────────────────┐
│  popup.js / popup.html                                      │
│  Toggle, stats, export, clear                               │
└─────────────────────────────────────────────────────────────┘
```

The extension has three layers:

1. **Content scripts** — injected into platform tabs; read the DOM, detect messages, send captures to the service worker
2. **Service worker** (`background.js`) — receives all messages, deduplicates, stores, and exports
3. **Popup** — reads stats from the service worker, triggers export/clear

Content scripts never write to storage directly; all persistence goes through the service worker.

---

## File Structure

```
chrome-extension/
├── manifest.json               Extension config (Manifest V3)
├── background.js               Service worker
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
└── content/
    ├── shared.js               window.AITracker namespace + utilities
    ├── main.js                 Platform-agnostic orchestrator
    └── adapters/
        ├── chatgpt.js
        ├── claude.js
        └── gemini.js
```

---

## Script Loading Order

For each platform, `manifest.json` injects three scripts in order:

```
shared.js  →  [platform].js  →  main.js
```

1. `shared.js` creates `window.AITracker` with session, dedup, and capture utilities
2. The adapter file sets `window.AITracker.adapter` to a platform-specific object
3. `main.js` reads `window.AITracker.adapter` and starts the observation loop

`main.js` is fully platform-agnostic — it only calls adapter methods and never queries the DOM itself.

---

## The Adapter Pattern

Each adapter is a plain object assigned to `window.AITracker.adapter`. It must implement:

```javascript
window.AITracker.adapter = {

  // String identifier stored in every captured message row.
  platform: 'myplatform',

  // Returns the DOM element whose subtree contains conversation turns.
  // main.js attaches its MutationObserver here.
  getConversationRoot() { ... },

  // CSS selector matching individual turn elements.
  // Used by captureExistingMessages and handleAddedNode.
  messageSelector: 'my-turn-element',

  // Returns true if `node` is a conversation turn element.
  isMessageNode(node) { ... },

  // Returns { role: 'human'|'assistant', text: string } or null.
  // Called both when a node first appears and when streaming ends.
  parseMessage(node) { ... },

  // Returns true while the AI is still generating this node's response.
  isStreaming(node) { ... },

  // Returns the text input element (for Enter-key interception).
  getInputEl() { ... },

  // Returns an array of send button elements.
  getSendButtonEls() { ... },

  // OPTIONAL: Maps a detected node to the stable turn container.
  // Required when individual detected nodes are sub-elements of a turn
  // (e.g. Claude's per-paragraph detection).
  normalizeTurnNode(node) { ... },

  // OPTIONAL: Set to true when the platform assigns a conversation URL
  // several seconds after the first send (currently only Gemini).
  // Triggers a retry loop in scheduleCapture.
  waitForConversationUrl: false,
};
```

### Adapter design rules

- **`parseMessage` must be safe to call on an empty or mid-stream node** — it is called multiple times during streaming and must return `null` when the node has no real content yet.
- **`isStreaming` must be fast** — it is called inside a MutationObserver callback on every DOM mutation.
- **`getConversationRoot` may fail on first call** — `main.js` retries every 600 ms until a root is found.
- **`normalizeTurnNode` must be idempotent** — calling it on an already-normalized node must return the same result.

---

## Session Management

### Derivation priority

Session IDs are derived using this priority order:

1. **URL-derived (no cache):** If the current URL path matches a known conversation pattern, the ID comes from the path:
   - ChatGPT: `/c/<uuid>` → session ID = `<uuid>`
   - Claude: `/chat/<uuid>` → session ID = `<uuid>`
   - Gemini: `/app/<id>` → session ID = `g_<id>`

2. **sessionStorage fallback:** If no conversation pattern is found (home page, new-chat page), a random UUID is generated and cached in `sessionStorage`. All messages from that tab before a URL is assigned share this UUID.

### Locked URL in `T.capture`

`waitForComplete` in `main.js` locks `startUrl = window.location.href` at the moment a streaming watcher starts. This URL is passed to `T.capture` as the `url` argument. `T.capture` derives `session_id` from this locked URL, not from `window.location.href` at call time. This prevents navigate-away session mismatch (the user leaves mid-stream → response still filed under the original conversation).

### Home-page upgrade in `finish()`

When `startUrl` has no conversation ID (Gemini new-chat scenario), `finish()` upgrades it to `window.location.href`, which by stream-end contains the real `/app/<id>` URL. `T.capture` then uses the upgraded URL for both the stored `url` field and `session_id` derivation.

---

## Message Capture Pipeline

### Human messages

```
User sends message
  ↓
hookSendEvents records pendingTimestamp
  ↓
MutationObserver: new node added to conversation root
  ↓
handleAddedNode → isMessageNode? → normalizeTurnNode → deduplicate (seen Set)
  ↓
scheduleCapture — role = human
  ↓
needsWait? (adapter.waitForConversationUrl && no conversation URL yet)
  ├── yes: retry every 1200ms until URL has conversation ID (max 10 retries)
  └── no: proceed
  ↓ (after 800ms initial delay)
parseMessage → T.capture(role, text, platform, pendingTimestamp)
```

### Assistant messages

```
MutationObserver: new assistant node added
  ↓
handleAddedNode → normalizeTurnNode → deduplicate → scheduleCapture
  ↓
waitForComplete(node)
  startUrl = window.location.href   ← locked NOW
  ↓
Inner MutationObserver + streaming detection (two-tier)
  ↓
finish():
  captureUrl = hasConversationUrl(startUrl) ? startUrl : location.href
  captureNode → T.capture(role, text, platform, null, captureUrl)
```

### Existing messages (page load / SPA nav)

`captureExistingMessages` runs 1200 ms after each navigation. It queries `adapter.messageSelector`, normalizes each node, skips nodes already in `capturedNodes` or `streamWatchers`, and routes:
- Streaming nodes → `waitForComplete`
- Non-streaming nodes → `captureNode` with `recapture=true`

---

## Streaming Wait Strategy

Two tiers handle different platform streaming signal reliability:

| Scenario | Mechanism | Timer |
|---|---|---|
| `isStreaming()` goes `true → false` | Clean signal detected | SETTLE_MS = 1200ms after last `false` |
| `isStreaming()` never returns `true` | Signal unreliable | QUIET_MS = 8000ms of silence |
| No mutations arrive at all | Cached/instant response | NO_MUTATION_MS = 3000ms check |
| Anything else | Safety net | TIMEOUT_MS = 120000ms |

The MutationObserver watches: `childList`, `subtree`, `characterData`, and `attributes` (filtered to `data-is-streaming`, `pending`, `is-loading`) so attribute-removal streaming-done signals are caught even when no text changes.

---

## Deduplication

Four layers work in sequence, each catching a different failure mode:

### Layer 1 — `streamWatchers` WeakMap
**What:** Prevents two `waitForComplete` observers on the same node.  
**Why:** `handleAddedNode` may fire multiple times for the same node (subtree mutations). The WeakMap check is O(1).

### Layer 2 — `capturedNodes` WeakSet
**What:** DOM node identity tracking. A node added to this set is never scheduled or captured again.  
**Why:** `captureExistingMessages` runs after `tryObserve`. Without this set, it would re-process nodes the live observer already handled.

### Layer 3 — `T.isDuplicate` in-memory Set (shared.js)
**What:** Whitespace-normalised text comparison for assistant messages.  
**Why:** Streaming capture (compact whitespace) and re-capture on reload (spaced paragraphs) produce the same logical content but different literal strings. Normalisation makes them equal.  
**Scope:** Per-tab, cleared on session reset.

### Layer 4 — Background `storeMessage` dedup (background.js)
**What:** Final gate before `chrome.storage.local.set`.  
**Mode 1 — recapture=true:** Exact (normalised) text match within session. Used by `captureExistingMessages` to block nav-back re-stores.  
**Mode 2 — recapture=false, human:** 120-second time window. Long enough to absorb React DOM re-render duplicates (which arrive within seconds) but short enough that a repeat send after 2 minutes is allowed through.  
**Mode 3 — recapture=false, assistant:** 5-second time window. Two content-script instances racing on the same live stream diverge by at most a few seconds.

---

## Storage and the Write Queue

All `chrome.storage.local` writes are serialised through a Promise chain:

```javascript
let _writeQueue = Promise.resolve();
function serialise(fn) {
  _writeQueue = _writeQueue.then(fn).catch(console.error);
}
```

Without this, concurrent `storeMessage()` calls each read stale data (`get → modify → set`) and overwrite each other — a real problem when `captureExistingMessages` fires many captures at once.

### Storage schema

```
chrome.storage.local → { sessions: { [session_id]: Session } }

Session {
  id:        string       // session_id
  platform:  string       // chatgpt | claude | gemini
  url:        string       // first conversation URL
  startedAt: ISO string   // timestamp of first message
  messages:  Message[]
}

Message {
  session_id: string
  timestamp:  ISO string
  role:       'human' | 'assistant'
  message:    string      // verbatim, no truncation
  platform:   string
  url:        string
}
```

---

## SPA Navigation Handling

All three platforms are single-page apps — navigating to a new conversation calls `history.pushState` without a page reload.

`main.js` patches `history.pushState` and `history.replaceState` and listens to `popstate`. On each URL change:

1. `T.resetSession()` — clears `sessionStorage` cache and `T.seen`
2. 800ms delay (DOM render)
3. `tryObserve()` — re-attaches MutationObserver to the new conversation root
4. `captureExistingMessages()` — captures messages already in the new DOM

The `onUrlChange` guard (`location.href === lastUrl`) prevents double-firing when both `pushState` and `popstate` fire for the same navigation.

---

## Timing Constants

| Constant | Value | Purpose |
|---|---|---|
| `SETTLE_MS` | 1200ms | Wait after `isStreaming → false` before capturing. Allows final renders to stabilize. |
| `QUIET_MS` | 8000ms | Wait when streaming signal is unreliable. Long enough for slow responses. |
| `NO_MUTATION_MS` | 3000ms | Fallback for instant/cached responses that never mutate after appearing. |
| `TIMEOUT_MS` | 120000ms | Absolute safety cap. No response takes longer than 2 minutes. |
| SPA re-attach delay | 800ms | Wait after URL change before re-observing. Lets the new DOM render. |
| Existing messages delay | 1200ms | Wait after SPA nav before scanning for existing messages. Same as SETTLE_MS. |
| Gemini URL retry interval | 1200ms | How often to poll for conversation URL on new Gemini chats. |
| Gemini URL retry max | 10 | Maximum retries (~12 seconds total). Covers observed 6-second assignment delays. |
| Human message base delay | 800ms | Minimum wait before capturing human message, giving SPA time to navigate. |
| Human dedup window | 120000ms | Time window for human message dedup. Covers React re-render duplicates. |
| Assistant dedup window | 5000ms | Time window for assistant dedup. Covers two CS instances racing on a stream. |

---

## How to Add a New Platform

### Step 1 — Create the adapter file

Create `chrome-extension/content/adapters/myplatform.js`:

```javascript
'use strict';

window.AITracker.adapter = {
  platform: 'myplatform',

  getConversationRoot() {
    return document.querySelector('YOUR_CONVERSATION_CONTAINER');
  },

  messageSelector: 'YOUR_TURN_SELECTOR',

  isMessageNode(node) {
    return node.nodeType === Node.ELEMENT_NODE &&
      node.matches('YOUR_TURN_SELECTOR');
  },

  parseMessage(node) {
    // Determine role from some attribute or element
    const role = node.classList.contains('user') ? 'human' : 'assistant';

    // Extract text, excluding UI chrome (buttons, labels)
    const contentEl = node.querySelector('.message-body') || node;
    const text = (contentEl.innerText || '').trim();

    return text ? { role, text } : null;
  },

  isStreaming(node) {
    // Return true while generating. Check for:
    // - a "generating" attribute on the node
    // - a loading spinner inside the node
    // - an aria-label containing "generating"
    return node.hasAttribute('loading') ||
      !!node.querySelector('.spinner');
  },

  getInputEl() {
    return document.querySelector('YOUR_INPUT_SELECTOR');
  },

  getSendButtonEls() {
    return [...document.querySelectorAll('YOUR_SEND_BUTTON_SELECTOR')];
  },
};
```

### Step 2 — Register in manifest.json

Add an entry to the `content_scripts` array:

```json
{
  "matches": ["https://myplatform.com/*"],
  "js": [
    "content/shared.js",
    "content/adapters/myplatform.js",
    "content/main.js"
  ],
  "run_at": "document_idle"
}
```

Also add the host to `host_permissions`:

```json
"host_permissions": [
  "https://myplatform.com/*"
]
```

### Step 3 — Update background.js stats

Add the new platform to `byPlatform` in `getStats()`:

```javascript
byPlatform: {
  chatgpt:    { sessions: 0, messages: 0 },
  claude:     { sessions: 0, messages: 0 },
  gemini:     { sessions: 0, messages: 0 },
  myplatform: { sessions: 0, messages: 0 },  // ← add
},
```

### Step 4 — Update the popup

Add a row in `popup.html`:

```html
<div class="platform-row">
  <span class="platform-row__dot" style="background:#YOUR_COLOR"></span>
  <span class="platform-row__name">My Platform</span>
  <span class="platform-row__counts" id="statsMyplatform">— sessions · — messages</span>
</div>
```

And add it to the loop in `popup.js`:

```javascript
for (const platform of ['chatgpt', 'claude', 'gemini', 'myplatform']) {
```

And add the DOM reference:

```javascript
const statEls = {
  // ...existing...
  myplatform: document.getElementById('statsMyplatform'),
};
```

### Step 5 — Update session ID derivation

If the platform uses a URL pattern to identify conversations, add it to `extractFromPath()` in `shared.js`:

```javascript
function extractFromPath(path) {
  let m;
  m = path.match(/\/c\/([0-9a-f-]{8,})/i);       if (m) return m[1];
  m = path.match(/\/chat\/([0-9a-f-]{8,})/i);    if (m) return m[1];
  m = path.match(/\/app\/([0-9a-zA-Z]+)/);        if (m) return 'g_' + m[1];
  m = path.match(/\/conv\/([0-9a-zA-Z-]+)/);      if (m) return 'mp_' + m[1]; // ← add
  return null;
}
```

### Step 6 — Handle optional edge cases

- **If the platform assigns URLs late** (like Gemini): set `waitForConversationUrl: true` on the adapter. This triggers the retry loop in `scheduleCapture`.
- **If turn elements are sub-components of a larger container** (like Claude): implement `normalizeTurnNode(node)` to map the detected node to the stable container.
- **If the platform prefixes speaker labels** into message text: strip them in `parseMessage`.

---

## Testing Checklist

Use this checklist when testing a new adapter or after a platform DOM change:

**Basic capture**
- [ ] Human message captured with correct text (no UI label leakage)
- [ ] Assistant message captured after streaming ends (not mid-stream)
- [ ] Both have the correct `session_id` (matching the conversation URL)
- [ ] Both have the correct `url` (conversation URL, not home page)

**Streaming**
- [ ] Short response (instant): captured within 3 seconds of appearing
- [ ] Long response: captured only after generation completes
- [ ] `isStreaming()` returns `false` after generation; `true` during
- [ ] Navigating away mid-stream: response stored under original session, not new one

**Session management**
- [ ] New conversation: new `session_id`
- [ ] Navigate back to old conversation: same `session_id` as before
- [ ] Multiple conversations in same tab: separate `session_id` per conversation

**Deduplication**
- [ ] Reload page mid-conversation: no duplicate rows
- [ ] Navigate back to old conversation: no duplicate rows
- [ ] Send same message twice (>2 min apart): two rows in CSV

**Special content**
- [ ] Response with a table: table content present in CSV
- [ ] Response with code blocks: code present in CSV
- [ ] Response with multi-part sections: captured as a single row

**Popup**
- [ ] Stats update after capture
- [ ] Export produces valid CSV with all messages
- [ ] Clear deletes all data

**Toggle**
- [ ] Toggle OFF: no new captures during a live conversation
- [ ] Toggle ON after pause: captures existing messages correctly (no duplicates)
