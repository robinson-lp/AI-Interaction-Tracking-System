'use strict';

// ─── Write Queue ───────────────────────────────────────────────────────────────
// All chrome.storage.local writes are serialised through this promise chain.
// Without it, concurrent storeMessage calls (e.g. when capturing an existing
// chat) each do get→modify→set on stale data and overwrite each other.

let _writeQueue = Promise.resolve();

function serialise(fn) {
  _writeQueue = _writeQueue.then(fn).catch(console.error);
  return _writeQueue;
}

// ─── Message Router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'CAPTURE_MESSAGE':
      storeMessage(message.payload).then(() => sendResponse({ ok: true }));
      return true;

    case 'GET_STATS':
      getStats().then(sendResponse);
      return true;

    case 'EXPORT_CSV':
      exportCSV(message.sessionId).then(sendResponse);
      return true;

    case 'CLEAR_DATA':
      clearData().then(sendResponse);
      return true;
  }
});

// ─── Storage ───────────────────────────────────────────────────────────────────

function storeMessage(payload) {
  return serialise(async () => {
    const { sessions = {} } = await chrome.storage.local.get('sessions');

    const { session_id } = payload;

    if (!sessions[session_id]) {
      sessions[session_id] = {
        id:        session_id,
        platform:  payload.platform,
        url:       payload.url,
        startedAt: payload.timestamp,
        messages:  [],
      };
    }

    // Normalise text for dedup comparison.
    // Handles all the ways ChatGPT's React renderer produces different strings
    // for the same response across DOM re-renders:
    //   • \r\n / \r  → \n
    //   • Non-breaking spaces, tabs, Unicode spaces → regular space
    //   • Emoji variation selectors (U+FE0F) and combining enclosing keycap
    //     (U+20E3) stripped — these render invisibly but differ between captures
    //   • Zero-width / formatting chars stripped
    //   • Triple+ blank lines collapsed to double
    const normMsg = s => s
      .replace(/[︀-️⃣]/g, '')
      .replace(/[​-‍\u200E\u200F⁠﻿­]/g, '')
      .trim()
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      .replace(/[^\S\n]/g, ' ')
      .replace(/ +/g, ' ')
      .replace(/\n{3,}/g, '\n\n');
    const pNorm = normMsg(payload.message);

    // ── Primary dedup: same session, exact match ──────────────────────────────
    // If this exact text (same role) already exists anywhere in this session,
    // never store it again — regardless of timing, recapture flag, or how many
    // times the platform re-renders the DOM node.
    if (sessions[session_id].messages.some(
      m => m.role === payload.role && normMsg(m.message) === pNorm
    )) return;

    // ── Secondary dedup: cross-session home-page race (human only) ────────────
    // ChatGPT and Gemini navigate from the home page to the real conversation URL
    // ~1 s after the first send. Despite waitForConversationUrl, there is a narrow
    // window where the live observer may fire under a home-page random-UUID session.
    // If the same human text was stored in any other same-platform session within
    // 5 minutes, treat it as the same message and skip it.
    if (payload.role === 'human') {
      const CROSS_WINDOW_MS = 300000;
      if (Object.values(sessions).some(s => {
        if (s.id === session_id || s.platform !== payload.platform) return false;
        return s.messages.some(m => {
          if (m.role !== 'human' || normMsg(m.message) !== pNorm) return false;
          return Math.abs(
            new Date(payload.timestamp).getTime() - new Date(m.timestamp).getTime()
          ) < CROSS_WINDOW_MS;
        });
      })) return;
    }

    sessions[session_id].messages.push({
      session_id: session_id,
      timestamp:  payload.timestamp,
      role:       payload.role,
      message:    payload.message,  // stored verbatim — no trimming or truncation
      platform:   payload.platform,
      url:        payload.url,
    });

    await chrome.storage.local.set({ sessions });
  });
}

// ─── Stats ─────────────────────────────────────────────────────────────────────

async function getStats() {
  const { sessions = {} } = await chrome.storage.local.get('sessions');

  const stats = {
    totalSessions: 0,
    totalMessages: 0,
    byPlatform: {
      chatgpt: { sessions: 0, messages: 0 },
      claude:  { sessions: 0, messages: 0 },
      gemini:  { sessions: 0, messages: 0 },
    },
  };

  for (const session of Object.values(sessions)) {
    const p = session.platform;
    stats.totalSessions++;
    stats.totalMessages += session.messages.length;
    if (stats.byPlatform[p]) {
      stats.byPlatform[p].sessions++;
      stats.byPlatform[p].messages += session.messages.length;
    }
  }

  return stats;
}

// ─── Export ────────────────────────────────────────────────────────────────────

async function exportCSV(sessionId) {
  const { sessions = {} } = await chrome.storage.local.get('sessions');

  let rows = [];

  if (sessionId && sessions[sessionId]) {
    // Single session: use insertion order directly.
    rows = [...sessions[sessionId].messages];
  } else {
    // Multiple sessions: order sessions by when they started, then concat
    // each session's messages in insertion order.
    // Insertion order is always correct: the human message is stored ~150 ms
    // after send, the assistant message only after the quiet timer (2500 ms+),
    // so human is always pushed to the array before the assistant reply.
    const sortedSessions = Object.values(sessions)
      .sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''));
    for (const session of sortedSessions) {
      rows.push(...session.messages);
    }
  }

  if (rows.length === 0) {
    return { ok: false, error: 'No interactions to export.' };
  }

  // UTF-8 BOM ensures Excel auto-detects UTF-8 instead of Windows-1252.
  // data: URI is used instead of Blob+createObjectURL because service workers
  // (MV3) do not have access to URL.createObjectURL.
  const csv = '﻿' + buildCSV(rows);
  const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);

  const filename = sessionId
    ? `ai-interactions-${sessionId.slice(0, 8)}-${dateStr()}.csv`
    : `ai-interactions-all-${dateStr()}.csv`;

  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });

  return { ok: true, count: rows.length };
}

// ─── Clear ─────────────────────────────────────────────────────────────────────

async function clearData() {
  await chrome.storage.local.set({ sessions: {} });
  return { ok: true };
}

// ─── CSV Helpers ───────────────────────────────────────────────────────────────

const CSV_HEADERS = ['session_id', 'timestamp', 'role', 'message', 'platform', 'url'];

function buildCSV(rows) {
  // Rows are already sorted chronologically by exportCSV before arriving here.
  const lines = [CSV_HEADERS.join(',')];
  for (const row of rows) {
    lines.push([
      row.session_id,
      formatTimestamp(row.timestamp),
      row.role,
      row.message,
      row.platform,
      row.url,
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n');
}

// Converts stored ISO timestamp to local "YYYY-MM-DD HH:MM:SS" for readability.
function formatTimestamp(isoStr) {
  const d = new Date(isoStr);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function csvCell(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function dateStr() {
  return new Date().toISOString().slice(0, 10);
}
