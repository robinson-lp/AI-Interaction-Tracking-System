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
