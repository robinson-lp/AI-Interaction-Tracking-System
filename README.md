# AI Interaction Tracker

A Chrome Extension that automatically captures every prompt you send and every response you receive across ChatGPT, Claude, and Gemini — and exports the full history as a structured CSV file.

No data ever leaves your computer. Everything is stored locally in Chrome's built-in storage.

---

## What it does

- **Captures in real time** — records human messages at the moment you send them and AI responses the moment generation finishes
- **Handles streaming** — waits for the complete response before storing; never captures partial text
- **Three platforms** — ChatGPT (chat.openai.com / chatgpt.com), Claude (claude.ai), Gemini (gemini.google.com)
- **Exports to CSV** — one click downloads all captured interactions, ready for Excel, Google Sheets, or any data tool
- **Session-aware** — each conversation gets its own session ID derived from the conversation URL
- **Fully local** — no account, no server, no cloud sync; all data lives in `chrome.storage.local`

---

## Quick Install

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `chrome-extension/` folder
5. The tracker icon appears in your Chrome toolbar — you're ready

> To update after code changes: click the refresh icon on the extension card at `chrome://extensions`.

---

## How to use

1. Open any supported platform (ChatGPT, Claude, or Gemini)
2. Chat normally — the extension captures everything automatically
3. Click the toolbar icon to see stats, export data, or pause tracking

---

## Documentation

| Document | Audience | Description |
|---|---|---|
| [User Guide](docs/USER_GUIDE.md) | End users | Installing, using the popup, exporting CSV |
| [Developer Guide](docs/DEVELOPER_GUIDE.md) | Contributors | Architecture, adapter pattern, adding platforms |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Everyone | Common issues and how to fix them |
| [Privacy Policy](docs/PRIVACY.md) | Everyone | What is and isn't collected |
| [Technical Reference](CHROME_EXTENSION_DOCUMENTATION.md) | Developers | Deep-dive: session management, dedup, timing |

---

## Privacy

All captured data is stored exclusively in your browser using `chrome.storage.local`. Nothing is transmitted to any external server. You can view, export, or permanently delete all data at any time from the extension popup.

See [Privacy Policy](docs/PRIVACY.md) for full details.

---

## Version

**1.1.0** — see [Technical Reference → Changelog](CHROME_EXTENSION_DOCUMENTATION.md#changelog) for details.
