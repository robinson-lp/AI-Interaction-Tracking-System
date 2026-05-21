'use strict';

// Claude adapter — targets claude.ai
//
// Claude.ai updates its data-testid values across builds. This adapter covers
// every known variant and falls back to structural heuristics so it stays
// resilient without being tied to a single set of attribute values.

window.AITracker.adapter = {

  platform: 'claude',

  // ─── Conversation Root ────────────────────────────────────────────────────

  getConversationRoot() {
    return (
      document.querySelector('[data-testid="conversation"]') ||
      document.querySelector('[data-testid="chat-messages-container"]') ||
      document.querySelector('[data-testid="virtuoso-scroller"]') ||
      document.querySelector('main [class*="ConversationContainer"]') ||
      document.querySelector('main [class*="conversation"]') ||
      document.querySelector('main [class*="Thread"]') ||
      document.querySelector('main [class*="Messages"]') ||
      document.querySelector('main')
    );
  },

  // ─── Message Detection ────────────────────────────────────────────────────

  // Covers all known data-testid patterns Claude has shipped across builds.
  messageSelector: [
    '[data-testid="human-turn"]',
    '[data-testid="ai-turn"]',
    '[data-testid="user-turn"]',
    '[data-testid="assistant-turn"]',
    '[data-testid="user-message"]',
    '[data-testid="assistant-message"]',
    '[data-testid="user-human-turn"]',
    '[data-testid="assistant-turn-content"]',
  ].join(', '),

  // Returns 'human' | 'assistant' | null from a data-testid value.
  _roleFromTestId(testId) {
    if (!testId) return null;
    const t = testId.toLowerCase();
    if (t === 'human-turn' || t === 'user-turn' ||
        t === 'user-message' || t === 'user-human-turn') return 'human';
    if (t === 'ai-turn' || t === 'assistant-turn' ||
        t === 'assistant-message' || t === 'assistant-turn-content') return 'assistant';
    // Catch any future variations that contain these words
    if (t.includes('human') || (t.includes('user') && !t.includes('assistant'))) return 'human';
    if (t.includes('ai') || t.includes('assistant')) return 'assistant';
    return null;
  },

  isMessageNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    return this._roleFromTestId(node.getAttribute('data-testid')) !== null;
  },

  parseMessage(node) {
    const role = this._roleFromTestId(node.getAttribute('data-testid'));
    if (!role) return null;

    // Target the prose container to exclude action buttons (Copy, Retry…)
    // that live outside the response text. Fall back to the whole node.
    const contentEl =
      node.querySelector('[class*="prose"]')           ||
      node.querySelector('[class*="ProseMirror"]')     ||
      node.querySelector('[class*="message-content"]') ||
      node.querySelector('[class*="MessageContent"]')  ||
      node.querySelector('[class*="content"]')         ||
      node;

    const text = (contentEl.innerText || contentEl.textContent || '').trim();
    return text ? { role, text } : null;
  },

  // ─── Streaming Detection ──────────────────────────────────────────────────

  isStreaming(node) {
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
