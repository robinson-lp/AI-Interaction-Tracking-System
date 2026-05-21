'use strict';

// ChatGPT adapter — targets chat.openai.com and chatgpt.com
// Selectors use data-testid / aria-label / role attributes per the proposal's
// guidance on robust, semantic selectors.

window.AITracker.adapter = {

  platform: 'chatgpt',

  // ─── Conversation Root ────────────────────────────────────────────────────

  // Returns the scrollable container that holds all conversation turns.
  getConversationRoot() {
    return (
      document.querySelector('[data-testid="conversation-turns"]') ||
      // The turns live inside an <article> → its parent is the scrollable div
      document.querySelector('article[data-scroll-anchor]')?.closest('[role="presentation"]') ||
      document.querySelector('main .flex.flex-col.items-center') ||
      document.querySelector('main')
    );
  },

  // ─── Message Detection ────────────────────────────────────────────────────

  // CSS selector that matches individual conversation turn roots.
  messageSelector: '[data-message-author-role]',

  isMessageNode(node) {
    return node.nodeType === Node.ELEMENT_NODE &&
      node.hasAttribute('data-message-author-role');
  },

  // Returns {role, text} or null if the node is not a recognisable message.
  parseMessage(node) {
    const rawRole = node.getAttribute('data-message-author-role');
    if (!rawRole) return null;

    const role = rawRole === 'user' ? 'human' : 'assistant';

    // Assistant: target the .markdown / prose block (excludes action buttons).
    // User:      target .whitespace-pre-wrap (ChatGPT's user-message text wrapper).
    // Fallback:  the whole turn node.
    const contentEl =
      node.querySelector('.markdown') ||
      node.querySelector('[class*="prose"]') ||
      node.querySelector('[data-message-content]') ||
      node.querySelector('.whitespace-pre-wrap') ||
      node;

    const text = (contentEl.innerText || contentEl.textContent || '').trim();
    return text ? { role, text } : null;
  },

  // ─── Streaming Detection ──────────────────────────────────────────────────

  // Returns true while ChatGPT is still generating a response.
  isStreaming(node) {
    // The turn container carries data-is-streaming="true" during generation.
    const turn = node.closest('[data-is-streaming]') || node;
    if (turn.getAttribute('data-is-streaming') === 'true') return true;

    // Fallback: a spinning cursor class inside the node.
    if (node.querySelector('.result-streaming')) return true;

    return false;
  },

  // ─── Send Interception ────────────────────────────────────────────────────

  // The <textarea> or contenteditable used for composing messages.
  getInputEl() {
    return (
      document.querySelector('#prompt-textarea') ||
      document.querySelector('textarea[data-id]') ||
      document.querySelector('[contenteditable="true"][data-virtualkeyboard-visible]') ||
      document.querySelector('div[contenteditable="true"]')
    );
  },

  // Elements whose click triggers a message send.
  getSendButtonEls() {
    return [
      ...document.querySelectorAll('[data-testid="send-button"]'),
      ...document.querySelectorAll('button[aria-label="Send message"]'),
      ...document.querySelectorAll('button[aria-label="Send Message"]'),
    ];
  },
};
