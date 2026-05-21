'use strict';

// Claude adapter — targets claude.ai
//
// DOM structure confirmed from live inspection:
//   Human: <div data-testid="user-message" class="font-large !font-user-message ...">
//   AI:    <p class="font-claude-response-body ..."> (one per paragraph, no turn-level testid)
//
// Because AI content has no wrapper data-testid, we detect individual response
// paragraphs via class name and use normalizeTurnNode() to lift detection up to
// their shared parent container — the element that holds all paragraphs of one
// response. main.js calls this hook before passing nodes to scheduleCapture/
// captureNode so the entire turn is watched and captured as one unit.

window.AITracker.adapter = {

  platform: 'claude',

  // ─── Conversation Root ────────────────────────────────────────────────────

  getConversationRoot() {
    return (
      document.querySelector('[data-testid="conversation"]')            ||
      document.querySelector('[data-testid="chat-messages-container"]') ||
      document.querySelector('[data-testid="virtuoso-scroller"]')       ||
      document.querySelector('main [class*="ConversationContainer"]')   ||
      document.querySelector('main [class*="conversation"]')            ||
      document.querySelector('main [class*="Thread"]')                  ||
      document.querySelector('main')
    );
  },

  // ─── Message Detection ────────────────────────────────────────────────────

  // Matches human-turn divs (data-testid) AND individual AI response paragraphs
  // (class-based). normalizeTurnNode lifts the paragraphs to their container.
  messageSelector: '[data-testid="user-message"], [class*="font-claude-response"]',

  isMessageNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.getAttribute('data-testid') === 'user-message') return true;
    return node.classList && [...node.classList].some(c => c.includes('font-claude-response'));
  },

  // Maps a detected node to the element that should be watched and captured:
  //   • user-message divs  → returned as-is
  //   • font-claude-response paragraphs → parent div (holds all response paragraphs)
  //
  // Called by main.js in handleAddedNode and captureExistingMessages before
  // passing nodes to scheduleCapture / captureNode. Returning the parent ensures
  // the MutationObserver sees all paragraph additions for one AI turn, and
  // streamWatchers deduplication prevents multiple watchers on the same container.
  normalizeTurnNode(node) {
    if (!node) return node;
    if (node.getAttribute && node.getAttribute('data-testid') === 'user-message') return node;

    const hasResponseClass = (el) =>
      el && el.classList && [...el.classList].some(c => c.includes('font-claude-response'));

    if (hasResponseClass(node)) {
      // Walk UP through every element that also carries a font-claude-response-*
      // class (wrapper divs, containers, etc.) until we reach the first ancestor
      // that does NOT have it. That ancestor is the stable per-turn root used as
      // the key for streamWatchers, so all inner elements normalise to the same
      // node and only one watcher is ever created per AI turn.
      let el = node.parentElement;
      while (el && hasResponseClass(el)) {
        el = el.parentElement;
      }
      return el || node.parentElement || node;
    }

    return node;
  },

  // ─── Parsing ──────────────────────────────────────────────────────────────

  parseMessage(node) {
    if (!node) return null;

    // Human turn: data-testid="user-message" div contains the prompt directly.
    if (node.getAttribute && node.getAttribute('data-testid') === 'user-message') {
      const text = (node.innerText || node.textContent || '').trim();
      return text ? { role: 'human', text } : null;
    }

    // AI turn container (the parentElement of font-claude-response paragraphs).
    // Collect text specifically from those paragraphs — not from the whole container —
    // so that sibling button text (Copy, Retry, Share…) is excluded.
    const hasResponse = (node.querySelector && node.querySelector('[class*="font-claude-response"]')) ||
      (node.classList && [...node.classList].some(c => c.includes('font-claude-response')));

    if (hasResponse) {
      if (node.querySelector) {
        const allMatching = [...node.querySelectorAll('[class*="font-claude-response"]')];
        // Keep only LEAF nodes — elements that contain no further matching
        // descendants. This prevents a wrapper div and its child <p> both
        // matching, which would double the text when their innerText is joined.
        const leaves = allMatching.filter(
          el => el.querySelectorAll('[class*="font-claude-response"]').length === 0
        );
        if (leaves.length > 0) {
          const text = leaves
            .map(el => (el.innerText || el.textContent || '').trim())
            .filter(Boolean)
            .join('\n\n');
          return text ? { role: 'assistant', text } : null;
        }
      }
      // Fallback: node itself is a leaf response element
      const text = (node.innerText || node.textContent || '').trim();
      return text ? { role: 'assistant', text } : null;
    }

    return null;
  },

  // ─── Streaming Detection ──────────────────────────────────────────────────

  isStreaming(node) {
    if (!node || !node.querySelector) return false;
    if (node.querySelector('[data-testid="streaming-cursor"]'))  return true;
    if (node.querySelector('[class*="cursor-blink"]'))           return true;
    if (node.querySelector('[class*="typing-indicator"]'))       return true;
    if (node.querySelector('[class*="StreamingIndicator"]'))     return true;
    if (node.querySelector('[aria-label*="loading"]'))           return true;
    if (node.querySelector('[role="status"]'))                   return true;
    return false;
  },

  // ─── Send Interception ────────────────────────────────────────────────────

  getInputEl() {
    return (
      document.querySelector('div[contenteditable="true"][aria-label]') ||
      document.querySelector('.ProseMirror[contenteditable="true"]')    ||
      document.querySelector('div[contenteditable="true"]')
    );
  },

  getSendButtonEls() {
    return [
      ...document.querySelectorAll('button[aria-label="Send Message"]'),
      ...document.querySelectorAll('button[aria-label="Send message"]'),
      ...document.querySelectorAll('button[data-testid="send-button"]'),
      ...document.querySelectorAll('button[type="submit"]'),
    ];
  },
};
