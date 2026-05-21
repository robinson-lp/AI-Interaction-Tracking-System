'use strict';

// Gemini adapter — targets gemini.google.com
// Gemini's UI is built with Angular custom elements (user-query, model-response).
// Selectors target those element tags and their aria / data attributes.

window.AITracker.adapter = {

  platform: 'gemini',

  // ─── Conversation Root ────────────────────────────────────────────────────

  getConversationRoot() {
    return (
      document.querySelector('infinite-scroller') ||
      document.querySelector('chat-history') ||
      document.querySelector('[class*="conversation-container"]') ||
      document.querySelector('main')
    );
  },

  // ─── Message Detection ────────────────────────────────────────────────────

  // Gemini uses Angular custom elements for each turn.
  messageSelector: 'user-query, model-response',

  isMessageNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = node.tagName.toLowerCase();
    return tag === 'user-query' || tag === 'model-response';
  },

  parseMessage(node) {
    const tag  = node.tagName.toLowerCase();
    const role = tag === 'user-query' ? 'human' : 'assistant';

    // Speaker labels ("You said" / "Gemini said") live in a sibling element
    // outside the actual content container. Try increasingly broad selectors
    // until we find the element that holds only the message text.
    const contentEl =
      node.querySelector('message-content')              || // Angular sub-component
      node.querySelector('.query-text')                  ||
      node.querySelector('[class*="query-text"]')        ||
      node.querySelector('markdown-renderer')            ||
      node.querySelector('[class*="response-content"]')  ||
      node.querySelector('[class*="message-text"]')      ||
      node.querySelector('[class*="content-container"]') ||
      node;

    let text = (contentEl.innerText || contentEl.textContent || '').trim();

    // Last-resort cleanup: if we fell all the way back to the full custom
    // element, strip the known Gemini speaker-label lines that precede the
    // actual message. Confirmed from live output: "You said\n\n<message>"
    // and "Gemini said\n\n<response>".
    if (contentEl === node) {
      text = text
        .replace(/^You said[\s\n]*/i,    '')
        .replace(/^Gemini said[\s\n]*/i, '')
        .trim();
    }

    return text ? { role, text } : null;
  },

  // ─── Streaming Detection ──────────────────────────────────────────────────

  isStreaming(node) {
    // model-response carries a pending or loading attribute while generating.
    if (node.hasAttribute('pending'))               return true;
    if (node.hasAttribute('is-loading'))            return true;

    // Some builds add a loading indicator inside the response.
    if (node.querySelector('loading-indicator'))    return true;
    if (node.querySelector('[class*="loading"]'))   return true;
    if (node.querySelector('[aria-label*="enerating"]')) return true;

    return false;
  },

  // ─── Send Interception ────────────────────────────────────────────────────

  getInputEl() {
    return (
      document.querySelector('rich-textarea div[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"][aria-label*="message"]') ||
      document.querySelector('div[contenteditable="true"][aria-label*="prompt"]') ||
      document.querySelector('div[contenteditable="true"]')
    );
  },

  getSendButtonEls() {
    return [
      ...document.querySelectorAll('button[aria-label="Send message"]'),
      ...document.querySelectorAll('button[aria-label="Send"]'),
      ...document.querySelectorAll('button.send-button'),
      // Material icon button used in some builds
      ...document.querySelectorAll('button mat-icon[fonticon="send"]'),
    ].map(el => el.closest('button') || el);
  },
};
