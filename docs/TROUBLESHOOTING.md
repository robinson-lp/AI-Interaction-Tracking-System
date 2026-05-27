# Troubleshooting Guide — AI Interaction Tracker

Use this guide to diagnose and fix common issues. For each problem there is a quick check, a likely cause, and a fix.

---

## Table of Contents

1. [Extension not loading / icon not appearing](#extension-not-loading)
2. [No messages being captured](#no-messages-captured)
3. [Human message missing from CSV](#human-message-missing)
4. [AI response missing from CSV](#ai-response-missing)
5. [Missing content — tables, code blocks (Claude)](#missing-content-claude)
6. [Duplicate rows in CSV](#duplicate-rows)
7. [Wrong session IDs — messages in wrong conversation](#wrong-session-ids)
8. [Gemini slow to capture / no conversation URL](#gemini-slow)
9. ["You said" prefix in Gemini messages](#gemini-prefix)
10. [CSV not downloading](#csv-not-downloading)
11. [CSV opens with garbled characters](#csv-encoding)
12. [Data disappeared after browser update](#data-disappeared)
13. [Live debugging with DevTools](#live-debugging)

---

## Extension not loading

**Symptom:** No AI Tracker icon in toolbar; `chrome://extensions` shows an error.

**Check:**
1. Go to `chrome://extensions`
2. Look for the AI Tracker card — if it shows an error, click **Details** to see the message

**Common causes and fixes:**

| Error message | Fix |
|---|---|
| "Manifest file is missing or unreadable" | You selected the wrong folder. Select the `chrome-extension/` folder (contains `manifest.json`), not the project root |
| "Could not load background script 'background.js'" | A syntax error in `background.js`. Open the service worker console to see the JS error |
| "Could not load content script 'content/main.js'" | A syntax error in one of the content scripts. Check the DevTools console on a supported platform tab |
| Extension card missing entirely | Click **Load unpacked** again — the extension was never loaded |

---

## No messages captured

**Symptom:** You chatted on a supported platform but the popup shows 0 messages.

**Check in order:**

1. **Is tracking ON?** Open the popup — the toggle must show **ON**. If it shows OFF, click it.

2. **Is the platform supported?** Check that you are on `chatgpt.com`, `chat.openai.com`, `claude.ai`, or `gemini.google.com` (not a self-hosted or API version).

3. **Is the extension active on this tab?** Reload the tab after loading the extension — content scripts do not inject into tabs that were already open when the extension was first installed.

4. **Is the conversation root found?** Open the tab's DevTools console and run:
   ```javascript
   window.AITracker?.adapter?.getConversationRoot()
   ```
   If it returns `null`, the platform has updated its DOM and the root selector needs updating.

5. **Is message detection working?** Run:
   ```javascript
   document.querySelectorAll(window.AITracker.adapter.messageSelector)
   ```
   If this returns empty or wrong elements, the `messageSelector` or `isMessageNode` needs updating.

---

## Human message missing

**Symptom:** Assistant responses appear in the CSV but your prompts do not.

**Causes:**

- **Send interception failed:** The Enter key or send button was not detected. Run this in the tab console to verify the input is found:
  ```javascript
  window.AITracker.adapter.getInputEl()        // should return the input element
  window.AITracker.adapter.getSendButtonEls()  // should return send buttons
  ```
  If either returns `null` or empty, the selectors are stale.

- **parseMessage returns null for the human node:** Test directly:
  ```javascript
  const nodes = document.querySelectorAll(window.AITracker.adapter.messageSelector);
  nodes.forEach(n => console.log(window.AITracker.adapter.parseMessage(n)));
  ```
  Human nodes should return `{ role: 'human', text: '...' }`.

- **Gemini new conversation — URL not yet assigned:** On a brand-new Gemini conversation, the human message waits up to 12 seconds for the conversation URL to appear. Wait a bit longer, then check the popup.

---

## AI response missing

**Symptom:** Human prompts appear in the CSV but assistant responses do not.

**Causes:**

- **Streaming never ended cleanly:** The safety timer (120 seconds) will eventually trigger. Check if the message appears after 2 minutes.

- **`parseMessage` returns null on the completed node:** After a response finishes, run in the tab console:
  ```javascript
  const node = /* find the assistant node */;
  window.AITracker.adapter.parseMessage(node);
  ```
  If `null`, the content selector is not matching the node's content.

- **`isStreaming` never returns false:** If `isStreaming(node)` is stuck returning `true`, the QUIET_MS (8-second) fallback applies. Check manually:
  ```javascript
  const node = /* find the completed assistant node */;
  window.AITracker.adapter.isStreaming(node); // should return false when done
  ```

---

## Missing content — tables, code blocks (Claude)

**Symptom:** Claude responses appear in the CSV but tables or large code blocks are absent or truncated.

**This was fixed in v1.1.0.** If you are on v1.0.0, reload the extension from the latest code.

**Verify fix is active:** Open the Claude tab console and run:
```javascript
// On a Claude turn node with a table:
const node = document.querySelector('[data-testid="user-message"]')
  ?.closest('[class*="ConversationTurn"]');
// Or find the actual assistant turn container
console.log(window.AITracker.adapter.parseMessage(node));
```
The returned `text` should contain the table content.

**If still missing:** Claude has changed their DOM class names. Open DevTools → Inspector, find a table inside a response, and check if its ancestor elements still carry `font-claude-response-*` classes. The LCA walk in `parseMessage` depends on those classes being present on the leaf paragraph elements.

---

## Duplicate rows

**Symptom:** The CSV has two (or more) identical or near-identical rows for the same message.

**Check which layer the duplicate slipped through:**

1. **Are the texts identical or whitespace-different?** If whitespace differs between rows, the whitespace normalisation in `T.isDuplicate` / `storeMessage` should catch it. Check your extension version — this was fixed in v1.1.0.

2. **Are the timestamps more than 2 minutes apart (human) or 5 seconds apart (assistant)?** If so, this is correct behaviour — the time-window dedup intentionally allows deliberate repeat sends after the window expires.

3. **Are you running two tabs on the same conversation?** Two content-script instances watching the same DOM can both fire. The background dedup window should catch this, but if the tabs have meaningfully different clocks, it may not.

4. **Did you reload the page mid-conversation?** The `recapture=true` exact-match dedup handles this case. If duplicates appear, check that `captureExistingMessages` is passing `recapture=true` (it always does — verify you are on the latest code).

---

## Wrong session IDs

**Symptom:** Messages from conversation A appear under the session ID of conversation B.

**Causes:**

- **v1.0.0 sessionStorage caching bug.** Fixed in v1.1.0. Update the extension.

- **Navigate-away mid-stream bug.** Fixed in v1.1.0. The `startUrl` is now locked at stream-start; `T.capture` derives `session_id` from it.

**To verify session IDs are correct:**
```javascript
// Run in any supported platform tab:
window.AITracker.getSessionId();
// Should match the UUID in the current URL:
// ChatGPT: /c/<uuid>   → returns <uuid>
// Claude:  /chat/<uuid> → returns <uuid>
// Gemini:  /app/<id>   → returns g_<id>
window.AITracker.hasConversationUrl(); // should return true on a chat page
```

---

## Gemini slow to capture

**Symptom:** On a new Gemini conversation, the human message takes 5–15 seconds to appear in storage.

**This is expected behaviour.** Gemini assigns the conversation URL several seconds after you send your first message. The extension polls for the URL every 1.2 seconds (up to 10 times, ~12 seconds total) before recording the human message. This ensures it is filed under the correct `/app/<id>` session rather than a phantom UUID.

If the message never appears (after 15+ seconds), run:
```javascript
window.AITracker.hasConversationUrl(); // run after the URL changes
```
If this still returns `false` after the URL bar shows `/app/<id>`, the Gemini URL pattern regex needs updating.

---

## "You said" prefix in Gemini messages

**Symptom:** Human messages in the CSV start with "You said" or "You said\n\n".

**This was fixed in v1.1.0.** The prefix is now stripped unconditionally from all Gemini message content.

**To verify:**
```javascript
// On a Gemini page, after sending a message:
const node = document.querySelector('user-query');
window.AITracker.adapter.parseMessage(node);
// text field should NOT start with "You said"
```

---

## CSV not downloading

**Symptom:** Clicking Export does nothing, or the toast shows an error.

**Check:**

1. **Is there data to export?** The Export button is disabled when no data exists. If it's clickable and still fails, continue.

2. **Is the `downloads` permission granted?** Check `chrome://extensions` → AI Tracker → Permissions. `downloads` should be listed.

3. **Check the service worker console** (`chrome://extensions` → Inspect views: service worker) for errors when you click Export.

4. **Chrome download blocked?** Chrome may prompt you to allow downloads from extensions. Check for a download notification in the address bar.

---

## CSV opens with garbled characters

**Symptom:** The CSV opens in Excel and shows `Ã©` or similar instead of accented/Unicode characters.

**Fix:** The CSV is UTF-8 encoded with a BOM (byte-order mark). In Excel:
1. Close the file if open
2. Open Excel → Data → Get External Data → From Text/CSV
3. Set encoding to **UTF-8** in the import wizard

Alternatively, open the file in Google Sheets or a text editor (VS Code, Notepad++) which auto-detect UTF-8 correctly.

---

## Data disappeared after browser update

**Symptom:** The popup shows 0 messages and sessions after a Chrome update or profile migration.

**`chrome.storage.local` does not sync** across Chrome profiles or computers. It is also cleared if you:
- Sign out and sign back into a different Chrome profile
- Wipe Chrome's local data (Settings → Privacy → Clear browsing data → Cookies and site data)
- Uninstall and reinstall Chrome

**Prevention:** Export to CSV regularly. Once deleted, data cannot be recovered from `chrome.storage.local`.

---

## Live debugging

### Monitor every capture in real time

Paste this into the tab's DevTools console to intercept every `T.capture` call:

```javascript
const _orig = window.AITracker.capture.bind(window.AITracker);
window.AITracker.capture = function(role, text, platform, ts, url, recapture) {
  console.log(
    `%c[CAPTURE] ${role} @ ${platform}`, 'color:lime;font-weight:bold',
    '\ntext (first 120):', text.slice(0, 120),
    '\nsession_id:', window.AITracker.getSessionId(),
    '\neffective url:', url || window.location.href,
    '\nrecapture:', !!recapture
  );
  return _orig(role, text, platform, ts, url, recapture);
};
console.log('[AI Tracker] Capture monitor active');
```

### Inspect stored data

Run in the **service worker** console (`chrome://extensions` → Inspect views: service worker):

```javascript
chrome.storage.local.get('sessions', data => {
  const sessions = Object.values(data.sessions || {});
  console.log(`${sessions.length} sessions`);
  sessions.forEach(s => {
    console.group(`Session: ${s.id} (${s.platform})`);
    s.messages.forEach(m => console.log(`[${m.role}]`, m.message.slice(0, 80)));
    console.groupEnd();
  });
});
```

### Check adapter selectors live

```javascript
// Conversation root
window.AITracker.adapter.getConversationRoot();

// All detected turns
document.querySelectorAll(window.AITracker.adapter.messageSelector);

// Parse each turn
document.querySelectorAll(window.AITracker.adapter.messageSelector)
  .forEach(n => console.log(window.AITracker.adapter.parseMessage(n)));

// Streaming state (run while AI is generating)
const node = /* current assistant node */;
window.AITracker.adapter.isStreaming(node);
```

### Test session ID derivation

```javascript
window.AITracker.getSessionId();      // should match URL
window.AITracker.hasConversationUrl(); // true on chat pages, false on home
```
