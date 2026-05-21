'use strict';

// Namespace shared by all content scripts in this tab
window.AITracker = window.AITracker || {};

(function (T) {

  // ─── Session ID ──────────────────────────────────────────────────────────────
  // Per-tab, survives soft navigation but resets on full page reload.
  // Stored in sessionStorage so each tab has its own independent session.

  T.getSessionId = function () {
    const KEY = 'ai_tracker_session_id';
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = uuidv4();
      sessionStorage.setItem(KEY, id);
    }
    return id;
  };

  // ─── Deduplication ───────────────────────────────────────────────────────────
  // Prevents re-capturing identical role+text pairs within the same page session.

  T.seen = new Set();

  T.isDuplicate = function (role, text) {
    const key = role + '\x00' + text.trim();
    if (T.seen.has(key)) return true;
    T.seen.add(key);
    return false;
  };

  // ─── Send to Background ──────────────────────────────────────────────────────

  T.capture = function (role, text, platform, timestamp) {
    const cleaned = (text || '').trim();
    if (!cleaned) return;
    if (T.isDuplicate(role, cleaned)) return;

    const payload = {
      session_id: T.getSessionId(),
      timestamp:  timestamp || new Date().toISOString(),
      role,
      message:    cleaned,
      platform,
      url:        window.location.href,
    };

    chrome.runtime.sendMessage({ type: 'CAPTURE_MESSAGE', payload })
      .catch(() => { /* extension context invalidated on reload — safe to ignore */ });
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
