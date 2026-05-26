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
  // Tracks DOM nodes that have already been scheduled or captured so that
  // captureExistingMessages (called on toggle-on or SPA re-attach) never
  // re-stores a message from a node the live observer already processed.
  const capturedNodes        = new WeakSet();

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

  // If the adapter provides normalizeTurnNode(), use it to lift detected inner
  // elements (e.g. Claude's per-paragraph nodes) up to their turn container
  // before passing to scheduleCapture. Adapters that don't define it get the
  // identity function, so ChatGPT / Gemini behaviour is unchanged.
  const normalizeTurnNode = adapter.normalizeTurnNode
    ? adapter.normalizeTurnNode.bind(adapter)
    : n => n;

  function handleAddedNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const raw = [];
    if (adapter.isMessageNode(node)) raw.push(node);
    raw.push(...node.querySelectorAll(adapter.messageSelector));

    // Normalize then deduplicate — two paragraphs from the same AI turn
    // both normalize to the same parent container, so scheduleCapture
    // (and therefore waitForComplete) is called only once per container.
    const seen = new Set();
    for (const n of raw) {
      const normalized = normalizeTurnNode(n);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        scheduleCapture(normalized);
      }
    }
  }

  function scheduleCapture(msgNode) {
    const parsed = adapter.parseMessage(msgNode);

    if (parsed && parsed.role === 'human') {
      // Guard: captureExistingMessages must not re-process this node later.
      if (capturedNodes.has(msgNode)) return;
      capturedNodes.add(msgNode);

      // 800 ms gives SPA platforms time to navigate to the conversation URL.
      // For platforms that assign the URL *after* the first send (Gemini new
      // chats), the adapter sets waitForConversationUrl: true. In that case,
      // if we are currently at a root/home URL, we retry every 1200 ms until
      // the URL contains a conversation ID (max 10 retries ≈ 12 s). This
      // prevents capturing the human message under a phantom random-UUID session
      // before the platform has navigated to the real conversation URL.
      const ts = pendingTimestamp || new Date().toISOString();
      pendingTimestamp = null;
      const needsWait = adapter.waitForConversationUrl && !T.hasConversationUrl();
      let retries = 0;
      function doCapture() {
        if (!T.hasConversationUrl() && retries < 10) {
          retries++;
          setTimeout(doCapture, 1200);
          return;
        }
        const p = adapter.parseMessage(msgNode);
        if (!p) return;
        T.capture(p.role, p.text, adapter.platform, ts);
      }
      setTimeout(needsWait ? doCapture : () => {
        const p = adapter.parseMessage(msgNode);
        if (!p) return;
        T.capture(p.role, p.text, adapter.platform, ts);
      }, 800);
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

    // Lock the conversation URL now. T.capture reads window.location.href at
    // call time — if the user navigates away while the response is still
    // streaming the URL would be wrong. Passing startUrl avoids that.
    const startUrl = window.location.href;

    let quietTimer        = null;
    let streamingDetected = false;
    let hadMutations      = false;

    const obsv = new MutationObserver(() => {
      // First mutation cancels the no-mutation fallback timer.
      if (!hadMutations) {
        hadMutations = true;
        clearTimeout(noMutationTimer);
      }
      if (quietTimer) clearTimeout(quietTimer);

      const streaming = adapter.isStreaming(node);

      if (streaming) {
        // Platform confirms still generating.
        streamingDetected = true;
        quietTimer = setTimeout(finish, QUIET_MS);
      } else if (streamingDetected) {
        // Clean done signal: was streaming, now finished.
        // If streaming resumes the next mutations cancel this timer.
        quietTimer = setTimeout(finish, SETTLE_MS);
      } else {
        // isStreaming() never returned true — signal unreliable, use long fallback.
        quietTimer = setTimeout(finish, QUIET_MS);
      }
    });

    // Fallback for responses that arrive with content already present and produce
    // no further mutations (e.g. cached replies, instant single-paragraph answers).
    // Without this, the observer would never fire and we'd wait for TIMEOUT_MS.
    // NOT used for live-streaming nodes because the first incoming mutation clears it.
    const NO_MUTATION_MS  = 3000;
    const noMutationTimer = setTimeout(() => {
      if (hadMutations) return;
      const probe = adapter.parseMessage(node);
      if (probe && probe.text && !adapter.isStreaming(node)) finish();
    }, NO_MUTATION_MS);

    const safetyTimer = setTimeout(finish, TIMEOUT_MS);

    function finish() {
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(noMutationTimer);
      clearTimeout(safetyTimer);
      obsv.disconnect();
      streamWatchers.delete(node);
      // If startUrl was a home/new-chat page (no conversation ID), upgrade to
      // the current URL which by now should contain the real conversation ID.
      // T.capture further validates this and falls back to window.location.href
      // if needed, so passing an improved URL here is safe.
      const captureUrl = T.hasConversationUrl(startUrl) ? startUrl : window.location.href;
      captureNode(node, captureUrl);
    }

    // attributes: true detects streaming-done signals that are attribute removals
    // (data-is-streaming on ChatGPT, pending on Gemini) even when no text changes.
    obsv.observe(node, {
      childList:       true,
      subtree:         true,
      characterData:   true,
      attributes:      true,
      attributeFilter: ['data-is-streaming', 'pending', 'is-loading'],
    });
    streamWatchers.set(node, { obsv, safetyTimer });
  }

  // url       — locked at stream-start time by waitForComplete; undefined = use current URL.
  // recapture — true when called from captureExistingMessages (existing DOM content,
  //             not a fresh user send). Controls which dedup strategy the background uses.
  function captureNode(node, url, recapture) {
    if (!enabled) return;              // tracking was toggled off while streaming
    if (capturedNodes.has(node)) return;
    const p = adapter.parseMessage(node);
    if (!p) return;
    capturedNodes.add(node);
    T.capture(p.role, p.text, adapter.platform, null, url, recapture);
  }

  // ─── Existing Messages ────────────────────────────────────────────────────
  // Captures messages already rendered when the script loads or after SPA nav.
  // BUG FIX: previously called captureNode() on ALL nodes including streaming
  // ones, storing partial text. Now we route streaming nodes to waitForComplete
  // so the full response is captured when generation finishes.

  function captureExistingMessages() {
    setTimeout(() => {
      if (!enabled) return;
      const seen = new Set();
      const nodes = document.querySelectorAll(adapter.messageSelector);

      for (const node of nodes) {
        // Normalize (e.g. Claude paragraphs → parent container) then deduplicate.
        const normalized = normalizeTurnNode(node);
        if (seen.has(normalized)) continue;
        seen.add(normalized);

        if (streamWatchers.has(normalized)) continue;
        if (capturedNodes.has(normalized)) continue;  // already handled by live observer

        if (adapter.isStreaming(normalized)) {
          waitForComplete(normalized);
          continue;
        }

        captureNode(normalized, undefined, true);  // recapture=true → exact-match dedup
      }
    }, 1200);
  }

}());
