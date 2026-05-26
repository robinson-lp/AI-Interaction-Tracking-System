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

    // Strip Gemini's speaker-label prefixes unconditionally. These labels
    // ("You said" / "Gemini said") appear both inside message-content elements
    // and in the full custom-element fallback, so the old contentEl === node
    // guard was insufficient. Confirmed from live output:
    //   "You said\n\nHi how are you gemini"
    //   "Gemini said\n\n<response text>"
    text = text
      .replace(/^You said[\s\n]*/i,    '')
      .replace(/^Gemini said[\s\n]*/i, '')
      .trim();

    return text ? { role, text } : null;
  },

  // Gemini assigns the conversation URL several seconds after the first send
  // (unlike ChatGPT/Claude which navigate before or during send). Setting this
  // flag tells main.js to retry the human-message capture every 1200 ms until
  // the URL contains a conversation ID, preventing phantom random-UUID sessions.
  waitForConversationUrl: true,

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
