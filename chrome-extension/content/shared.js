'use strict';

// Namespace shared by all content scripts in this tab
window.AITracker = window.AITracker || {};

(function (T) {

  // ─── Session ID ──────────────────────────────────────────────────────────────
  // Per-tab, survives soft navigation but resets on full page reload.
  // Stored in sessionStorage so each tab has its own independent session.

  T.getSessionId = function () {
    const path = window.location.pathname;
    let m;
    // For pages with a recognisable conversation URL, derive the ID directly from
    // the path — no caching. This stays correct even if T.resetSession() misses a
    // navigation event, because the URL itself is always authoritative.
    m = path.match(/\/c\/([0-9a-f-]{8,})/i);    if (m) return m[1];   // ChatGPT /c/<uuid>
    m = path.match(/\/chat\/([0-9a-f-]{8,})/i); if (m) return m[1];   // Claude  /chat/<uuid>
    m = path.match(/\/app\/([0-9a-zA-Z]+)/);    if (m) return 'g_' + m[1]; // Gemini /app/<id>
    // Home / new-chat pages: use a cached random UUID so all messages before
    // the conversation gets its own URL share the same session.
    const KEY = 'ai_tracker_session_id';
    let id = sessionStorage.getItem(KEY);
    if (!id) { id = uuidv4(); sessionStorage.setItem(KEY, id); }
    return id;
  };

  // ─── Deduplication ───────────────────────────────────────────────────────────
  // Guards against the same assistant response being stored twice (e.g. two
  // capture paths racing past each other). Human messages are intentionally
  // excluded — a user legitimately may send the same prompt twice, and DOM-node
  // identity tracking in main.js (capturedNodes) handles their dedup instead.

  T.seen = new Set();

  T.isDuplicate = function (role, text) {
    if (role !== 'assistant') return false;
    // Normalise whitespace before comparing: streaming renders (compact spacing)
    // and final renders (spaced paragraphs) of the same response differ only in
    // runs of whitespace — treat them as identical to avoid double-storing.
    const key = text.trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
    if (T.seen.has(key)) return true;
    T.seen.add(key);
    return false;
  };

  // ─── Send to Background ──────────────────────────────────────────────────────

  // url is optional. Pass it when the correct URL must be locked at an earlier
  // point (e.g. stream-start) rather than resolved at capture time. Omit it
  // for human messages — the 800 ms delay in main.js already gives SPA
  // platforms time to navigate before window.location.href is read.
  // recapture = true  → message came from captureExistingMessages (page already had
  //                     this content; use exact-match dedup to block navigation-back
  //                     re-captures).
  // recapture = false → message came from a live observer (new DOM node, live send
  //                     or fresh stream); use a 5-second time-window so two content-
  //                     script instances can't double-store but a deliberate repeat
  //                     send by the user (>5 s later) is allowed through.
  T.capture = function (role, text, platform, timestamp, url, recapture) {
    const cleaned = (text || '').trim();
    if (!cleaned) return;
    if (T.isDuplicate(role, cleaned)) return;

    // Derive the effective URL: prefer the caller-supplied url (locked at
    // stream-start by waitForComplete) but fall back to current href for
    // human messages (which don't pass url). If startUrl was a home/new-chat
    // page (no conversation ID), use the current URL instead so the correct
    // final conversation URL is stored.
    const effectiveUrl = (url && T.hasConversationUrl(url))
      ? url
      : window.location.href;

    // Derive session from the effective URL when it has a conversation ID.
    // This ensures an assistant response that finishes after the user has
    // navigated away is still stored under the session where it was started,
    // not the session the user navigated to.
    let session_id;
    if (T.hasConversationUrl(effectiveUrl)) {
      const path = new URL(effectiveUrl, location.href).pathname;
      let m;
      m = path.match(/\/c\/([0-9a-f-]{8,})/i);    if (m) { session_id = m[1]; }
      else {
        m = path.match(/\/chat\/([0-9a-f-]{8,})/i); if (m) { session_id = m[1]; }
        else {
          m = path.match(/\/app\/([0-9a-zA-Z]+)/);  if (m) { session_id = 'g_' + m[1]; }
        }
      }
    }
    if (!session_id) session_id = T.getSessionId();

    const payload = {
      session_id,
      timestamp:  timestamp || new Date().toISOString(),
      role,
      message:    cleaned,
      platform,
      url:        effectiveUrl,
      recapture:  !!recapture,
    };

    chrome.runtime.sendMessage({ type: 'CAPTURE_MESSAGE', payload })
      .catch(() => { /* extension context invalidated on reload — safe to ignore */ });
  };

  // Returns true when the given URL (or current URL if omitted) contains a
  // recognisable conversation ID.
  // Used by main.js to decide whether to add an extra capture delay so that
  // platforms like Gemini (which assign URLs after the first send) have time
  // to navigate before we read the session ID.
  T.hasConversationUrl = function (href) {
    const path = href ? new URL(href, location.href).pathname : window.location.pathname;
    return /\/c\/[0-9a-f-]{8,}/i.test(path)    ||  // ChatGPT
           /\/chat\/[0-9a-f-]{8,}/i.test(path)  ||  // Claude
           /\/app\/[0-9a-zA-Z]+/.test(path);         // Gemini
  };

  // ─── Session Reset ───────────────────────────────────────────────────────────
  // Called on SPA navigation so each conversation gets its own session ID
  // and its own deduplication scope.

  T.resetSession = function () {
    sessionStorage.removeItem('ai_tracker_session_id');
    T.seen.clear();
  };

  // ─── Enabled State ───────────────────────────────────────────────────────────

  T.isEnabled = async function () {
    const { enabled } = await chrome.storage.local.get('enabled');
    return enabled !== false; // default ON
  };

  // ─── Utilities ───────────────────────────────────────────────────────────────

  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

}(window.AITracker));
