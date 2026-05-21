'use strict';

// ─── DOM References ────────────────────────────────────────────────────────────

const toggleEl       = document.getElementById('enabledToggle');
const toggleLabelEl  = document.getElementById('toggleLabel');
const disabledBanner = document.getElementById('disabledBanner');
const statsSection   = document.getElementById('statsSection');
const emptyState     = document.getElementById('emptyState');
const exportBtn      = document.getElementById('exportBtn');
const clearBtn       = document.getElementById('clearBtn');
const toastEl        = document.getElementById('toast');

const statEls = {
  chatgpt:        document.getElementById('statsChatgpt'),
  claude:         document.getElementById('statsClaude'),
  gemini:         document.getElementById('statsGemini'),
  totalNum:       document.getElementById('statsTotalNum'),
  totalSessions:  document.getElementById('statsTotalSessions'),
};

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const { enabled } = await chrome.storage.local.get('enabled');
  setToggle(enabled !== false);
  await refreshStats();
}

// ─── Toggle ───────────────────────────────────────────────────────────────────

toggleEl.addEventListener('change', async () => {
  const on = toggleEl.checked;
  await chrome.storage.local.set({ enabled: on });
  setToggle(on);
  toast(on ? 'Tracking enabled' : 'Tracking paused', on ? 'success' : '');
});

function setToggle(on) {
  toggleEl.checked = on;
  toggleLabelEl.textContent = on ? 'ON' : 'OFF';
  disabledBanner.hidden = on;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

async function refreshStats() {
  const stats = await sendToBackground({ type: 'GET_STATS' });
  if (!stats) return;

  const hasData = stats.totalMessages > 0;

  statsSection.hidden = !hasData;
  emptyState.hidden   = hasData;
  exportBtn.disabled  = !hasData;
  clearBtn.disabled   = !hasData;

  if (!hasData) return;

  for (const platform of ['chatgpt', 'claude', 'gemini']) {
    const p = stats.byPlatform[platform] || { sessions: 0, messages: 0 };
    statEls[platform].textContent =
      `${p.sessions} ${p.sessions === 1 ? 'session' : 'sessions'} · ${p.messages} ${p.messages === 1 ? 'message' : 'messages'}`;
  }

  statEls.totalNum.textContent      = stats.totalMessages;
  statEls.totalSessions.textContent = stats.totalSessions;
}

// ─── Export ───────────────────────────────────────────────────────────────────

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  exportBtn.textContent = 'Exporting…';

  const result = await sendToBackground({ type: 'EXPORT_CSV' });

  exportBtn.disabled = false;
  exportBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3v13M7 11l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M4 20h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
    Export all as CSV`;

  if (result?.ok) {
    toast(`Exported ${result.count} row${result.count === 1 ? '' : 's'}`, 'success');
  } else {
    toast(result?.error || 'Export failed', 'error');
  }
});

// ─── Clear ────────────────────────────────────────────────────────────────────

clearBtn.addEventListener('click', async () => {
  const confirmed = window.confirm(
    'Delete all captured interactions?\nThis cannot be undone.'
  );
  if (!confirmed) return;

  const result = await sendToBackground({ type: 'CLEAR_DATA' });

  if (result?.ok) {
    await refreshStats();
    toast('All data cleared', 'success');
  } else {
    toast('Failed to clear data', 'error');
  }
});

// ─── Background Messaging ─────────────────────────────────────────────────────

function sendToBackground(message) {
  return chrome.runtime.sendMessage(message).catch(() => null);
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;

function toast(message, type = '') {
  toastEl.textContent = message;
  toastEl.className   = 'toast toast--visible' + (type ? ` toast--${type}` : '');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = 'toast';
  }, 2400);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
