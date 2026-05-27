'use strict';

// Namespace shared by all content scripts in this tab
window.AITracker = window.AITracker || {};

(function (T) {

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  // Extracts a session ID from a URL pathname string.
  // Returns the ID if the path matches a known conversation pattern, else null.
  function extractFromPath(path) {
    let m;
    m = path.match(/\/c\/([0-9a-f-]{8,})/i);    if (m) return m[1];          // ChatGPT
    m = path.match(/\/chat\/([0-9a-f-]{8,})/i); if (m) return m[1];          // Claude
    m = path.match(/\/app\/([0-9a-zA-Z]+)/);    if (m) return 'g_' + m[1];  // Gemini
    return null;
  }

  // ─── Session ID ──────────────────────────────────────────────────────────────
  // For pages with a recognised conversation URL the ID is derived directly
  // from the path on every call — no caching. This stays correct even if
  // T.resetSession() misses a navigation event.
  // Home / new-chat pages fall back to a random UUID cached in sessionStorage
  // so all messages before a URL is assigned share the same session.

  T.getSessionId = function () {
    const fromPath = extractFromPath(window.location.pathname);
    if (fromPath) return fromPath;

    const KEY = 'ai_tracker_session_id';
    let id = sessionStorage.getItem(KEY);
    if (!id) { id = uuidv4(); sessionStorage.setItem(KEY, id); }
    return id;
  };

  // ─── Deduplication ───────────────────────────────────────────────────────────
  // Guards against the same assistant response being stored twice (e.g. two
  // capture paths racing past each other). Human messages are excluded — a
  // user may legitimately send the same prompt twice, and capturedNodes in
  // main.js handles their DOM-level dedup instead.

  T.seen = new Set();

  T.isDuplicate = function (role, text) {
    if (role !== 'assistant') return false;
    // Normalise whitespace so streaming (compact) and final (spaced) renders
    // of the same response are treated as identical.
    const key = text.trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
    if (T.seen.has(key)) return true;
    T.seen.add(key);
    return false;
  };

  // ─── Send to Background ──────────────────────────────────────────────────────

  // url is optional. Pass it when the correct URL must be locked at an earlier
  // point (stream-start) rather than resolved at capture time.
  // recapture = true  → captureExistingMessages path; use exact-match dedup.
  // recapture = false → live observer path; use time-window dedup.
  T.capture = function (role, text, platform, timestamp, url, recapture) {
    const cleaned = (text || '').trim();
    if (!cleaned) return;
    if (T.isDuplicate(role, cleaned)) return;

    // Prefer the caller-supplied url (locked at stream-start by waitForComplete).
    // If that url has no conversation ID (e.g. Gemini home page at stream-start),
    // use the current URL which by now should contain the real conversation ID.
    const effectiveUrl = (url && T.hasConversationUrl(url))
      ? url
      : window.location.href;

    // Derive session from the effective URL when it has a conversation ID.
    // This ensures a response that finishes after the user navigates away is
    // attributed to the correct original session, not the current one.
    const session_id = extractFromPath(new URL(effectiveUrl, location.href).pathname)
      || T.getSessionId();

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

  // ─── Conversation URL Check ───────────────────────────────────────────────────
  // Returns true when the given URL (current URL if omitted) contains a
  // recognisable conversation ID. Used by main.js to gate the Gemini retry loop
  // and by T.capture to decide which URL to use for session derivation.

  T.hasConversationUrl = function (href) {
    const path = href ? new URL(href, location.href).pathname : window.location.pathname;
    return extractFromPath(path) !== null;
  };

  // ─── Session Reset ───────────────────────────────────────────────────────────
  // Called on SPA navigation so each conversation gets a fresh session ID
  // and a clean deduplication scope.

  T.resetSession = function () {
    sessionStorage.removeItem('ai_tracker_session_id');
    T.seen.clear();
  };

  // ─── Utilities ───────────────────────────────────────────────────────────────

  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

}(window.AITracker));
