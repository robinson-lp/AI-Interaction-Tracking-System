'use strict';

// Main orchestrator — runs after shared.js + the platform adapter are loaded.
// Responsibilities:
//   1. Respect the enabled/disabled toggle from the popup.
//   2. Intercept the send event to record the precise human-message timestamp.
//   3. Use a MutationObserver to detect new conversation turns.
//   4. Wait for streaming to finish before capturing AI responses.
//   5. Capture messages already present on the page (existing chats).
//   6. Handle SPA navigation (new chat = new session, re-attach observer).

(function () {

  const T       = window.AITracker;
  const adapter = T.adapter;

  if (!adapter) return;

  // ─── State ────────────────────────────────────────────────────────────────

  let enabled                = true;
  let conversationObsv       = null;
  let pendingTimestamp       = null;
  const streamWatchers       = new WeakMap();

  // One-time guards so hookSendEvents / watchForNavigation don't stack up
  // when start() is called again after a toggle.
  let sendListenersAttached  = false;
  let navWatcherAttached     = false;

  // ─── Boot ─────────────────────────────────────────────────────────────────

  chrome.storage.local.get('enabled', ({ enabled: stored }) => {
    enabled = stored !== false;
    if (enabled) start();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !('enabled' in changes)) return;
    enabled = changes.enabled.newValue !== false;
    enabled ? start() : stop();
  });

  // ─── Start / Stop ─────────────────────────────────────────────────────────

  function start() {
    hookSendEvents();       // idempotent — guarded by sendListenersAttached
    watchForNavigation();   // idempotent — guarded by navWatcherAttached
    tryObserve();
    captureExistingMessages();
  }

  function stop() {
    if (conversationObsv) {
      conversationObsv.disconnect();
      conversationObsv = null;
    }
  }

  // ─── SPA Navigation ───────────────────────────────────────────────────────
  // ChatGPT / Claude / Gemini are single-page apps: navigating to a new chat
  // calls history.pushState without a page reload.  We intercept that to:
  //   • reset the session ID and dedup set (new chat = new session)
  //   • re-attach the conversation observer to the new container

  function watchForNavigation() {
    if (navWatcherAttached) return;
    navWatcherAttached = true;

    let lastUrl = location.href;

    function onUrlChange() {
      if (location.href === lastUrl) return;
      lastUrl = location.href;

      // New conversation: start a fresh session and reconnect the observer.
      T.resetSession();
      setTimeout(() => {
        tryObserve();
        captureExistingMessages();
      }, 800);
    }

    window.addEventListener('popstate', onUrlChange);

    // Intercept programmatic navigation (React router, etc.)
    const origPush = history.pushState.bind(history);
    history.pushState = function (...args) {
      origPush(...args);
      onUrlChange();
    };

    const origReplace = history.replaceState.bind(history);
    history.replaceState = function (...args) {
      origReplace(...args);
      onUrlChange();
    };
  }

  // ─── Send Interceptor ─────────────────────────────────────────────────────

  function hookSendEvents() {
    if (sendListenersAttached) return;
    sendListenersAttached = true;

    document.addEventListener('keydown', (e) => {
      if (!enabled || e.key !== 'Enter' || e.shiftKey) return;
      const input = adapter.getInputEl();
      if (input && (document.activeElement === input || input.contains(document.activeElement))) {
        pendingTimestamp = new Date().toISOString();
      }
    }, true);

    document.addEventListener('click', (e) => {
      if (!enabled) return;
      const btns = adapter.getSendButtonEls();
      for (const btn of btns) {
        if (btn && (e.target === btn || btn.contains(e.target))) {
          pendingTimestamp = new Date().toISOString();
          break;
        }
      }
    }, true);
  }

  // ─── Conversation Observer ────────────────────────────────────────────────

  function tryObserve() {
    const root = adapter.getConversationRoot();

    if (!root) {
      setTimeout(tryObserve, 600);
      return;
    }

    if (conversationObsv) conversationObsv.disconnect();

    conversationObsv = new MutationObserver((mutations) => {
      if (!enabled) return;
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          handleAddedNode(node);
        }
      }
    });

    conversationObsv.observe(root, { childList: true, subtree: true });
  }

  // ─── Node Handler ─────────────────────────────────────────────────────────

  function handleAddedNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const candidates = [];
    if (adapter.isMessageNode(node)) candidates.push(node);
    candidates.push(...node.querySelectorAll(adapter.messageSelector));

    for (const msgNode of candidates) {
      scheduleCapture(msgNode);
    }
  }

  function scheduleCapture(msgNode) {
    const parsed = adapter.parseMessage(msgNode);

    if (parsed && parsed.role === 'human') {
      setTimeout(() => {
        const p = adapter.parseMessage(msgNode);
        if (!p) return;
        const ts = pendingTimestamp || new Date().toISOString();
        pendingTimestamp = null;
        T.capture(p.role, p.text, adapter.platform, ts);
      }, 150);
      return;
    }

    // Assistant turns: always hand to waitForComplete.
    // The node may be empty when first added — streaming starts moments later.
    waitForComplete(msgNode);
  }

  // ─── Streaming Wait ───────────────────────────────────────────────────────
  // Two-tier timing strategy:
  //   • isStreaming() transitions true → false  →  capture after SETTLE_MS.
  //     Any resumed streaming fires new mutations that cancel the settle timer.
  //   • isStreaming() never goes true (unreliable signal) or still true
  //     →  only capture after QUIET_MS of complete silence.

  const SETTLE_MS  = 1200;
  const QUIET_MS   = 8000;
  const TIMEOUT_MS = 120000;

  function waitForComplete(node) {
    if (streamWatchers.has(node)) return;

    const probe = adapter.parseMessage(node);
    if (probe && probe.text && !adapter.isStreaming(node)) {
      captureNode(node);
      return;
    }

    let quietTimer        = null;
    let streamingDetected = false;

    const obsv = new MutationObserver(() => {
      if (quietTimer) clearTimeout(quietTimer);

      const streaming = adapter.isStreaming(node);

      if (streaming) {
        streamingDetected = true;
        quietTimer = setTimeout(finish, QUIET_MS);
      } else if (streamingDetected) {
        // Clean done signal — short settle then capture.
        // If streaming resumes, the next mutations will cancel this timer.
        quietTimer = setTimeout(finish, SETTLE_MS);
      } else {
        // isStreaming() never returned true — use safe long fallback.
        quietTimer = setTimeout(finish, QUIET_MS);
      }
    });

    const safetyTimer = setTimeout(finish, TIMEOUT_MS);

    function finish() {
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(safetyTimer);
      obsv.disconnect();
      streamWatchers.delete(node);
      captureNode(node);
    }

    // attributes: true lets us detect when platforms signal completion by
    // changing/removing a streaming attribute (e.g. data-is-streaming on ChatGPT,
    // 'pending' on Gemini) even when no further text mutations occur.
    obsv.observe(node, {
      childList:       true,
      subtree:         true,
      characterData:   true,
      attributes:      true,
      attributeFilter: ['data-is-streaming', 'pending', 'is-loading'],
    });
    streamWatchers.set(node, { obsv, safetyTimer });
  }

  function captureNode(node) {
    const p = adapter.parseMessage(node);
    if (!p) return;
    T.capture(p.role, p.text, adapter.platform);
  }

  // ─── Existing Messages ────────────────────────────────────────────────────
  // Captures messages already rendered when the script loads or after SPA nav.
  // BUG FIX: previously called captureNode() on ALL nodes including streaming
  // ones, storing partial text. Now we route streaming nodes to waitForComplete
  // so the full response is captured when generation finishes.

  function captureExistingMessages() {
    setTimeout(() => {
      if (!enabled) return;
      const nodes = document.querySelectorAll(adapter.messageSelector);
      for (const node of nodes) {
        if (streamWatchers.has(node)) continue;  // already being watched

        if (adapter.isStreaming(node)) {
          waitForComplete(node);                  // stream in progress — watch it
          continue;
        }

        captureNode(node);                        // complete — capture immediately
      }
    }, 1200);
  }

}());
