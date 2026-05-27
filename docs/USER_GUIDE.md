# User Guide — AI Interaction Tracker

This guide covers everything you need to install the extension, understand the popup, export your data, and get the most out of the tracker.

---

## Table of Contents

1. [Installation](#installation)
2. [Supported Platforms](#supported-platforms)
3. [The Popup — at a glance](#the-popup)
4. [What gets captured](#what-gets-captured)
5. [Enabling and Disabling Tracking](#enabling-and-disabling)
6. [Exporting Your Data](#exporting-your-data)
7. [Understanding the CSV](#understanding-the-csv)
8. [Clearing Your Data](#clearing-your-data)
9. [Frequently Asked Questions](#faq)

---

## Installation

### Step 1 — Download the extension

Clone or download the project repository to your computer. The extension code is inside the `chrome-extension/` folder.

### Step 2 — Enable Developer Mode in Chrome

1. Open Chrome and navigate to `chrome://extensions` in the address bar
2. In the top-right corner, flip the **Developer mode** toggle to ON

### Step 3 — Load the extension

1. Click **Load unpacked** (appears after enabling Developer mode)
2. In the file picker, navigate to this project and select the `chrome-extension/` folder
3. Click **Select Folder**

The extension is now installed. You will see **AI Tracker** appear in your extensions list and its icon in the Chrome toolbar.

> **After updating the code:** Go back to `chrome://extensions` and click the refresh (↺) icon on the AI Tracker card. You do not need to re-load the folder.

---

## Supported Platforms

| Platform | URLs tracked |
|---|---|
| ChatGPT | chat.openai.com, chatgpt.com |
| Claude | claude.ai |
| Gemini | gemini.google.com |

The extension activates automatically when you open any of these URLs. No setup is required on the platform side — just chat normally.

---

## The Popup

Click the AI Tracker icon in the Chrome toolbar to open the popup.

```
┌──────────────────────────────────────┐
│  ◉ AI Tracker                    ON  │  ← Header + toggle
├──────────────────────────────────────┤
│  CAPTURED INTERACTIONS               │
│  ● ChatGPT   3 sessions · 14 msgs   │
│  ● Claude    1 session  · 6 msgs    │
│  ● Gemini    2 sessions · 9 msgs    │
│                                      │
│  Total: 29 messages across 6 sessions│
├──────────────────────────────────────┤
│  [↓ Export all as CSV]               │
│  [🗑 Clear all data]                 │
└──────────────────────────────────────┘
```

**Header toggle (ON / OFF):** Controls whether the extension is actively capturing. Toggling to OFF pauses all capture; a red banner appears. Toggling back to ON resumes immediately.

**Stats section:** Shows a live count of sessions and messages captured for each platform since the last clear. Only appears when data exists.

**Export button:** Downloads all captured data as a CSV file. The button is disabled when no data has been captured.

**Clear button:** Permanently deletes all stored data after a confirmation prompt.

---

## What Gets Captured

For every message in a conversation, the extension records:

- **The full text** of your prompt (human) exactly as you sent it
- **The full text** of the AI response (assistant) after generation completes — never partial, never truncated
- **When** the message was captured (local timestamp)
- **Which platform** it came from
- **The conversation URL** at the time of capture

### What is NOT captured

- File attachments or images you upload
- Voice/audio input
- UI elements like buttons, menus, or suggestions
- System prompts or hidden context
- Any text from pages other than the three supported platforms

---

## Enabling and Disabling

Use the toggle in the popup header to pause and resume tracking.

- **ON (default):** All conversations on supported platforms are captured in real time
- **OFF:** No new messages are captured. Any conversation already in storage is preserved. Existing stored data is not deleted when you pause.

The toggle state persists across browser restarts — if you leave it OFF and restart Chrome, it stays OFF.

---

## Exporting Your Data

1. Open the popup and click **Export all as CSV**
2. Chrome will automatically download the file to your default Downloads folder
3. The file is named `ai-interactions-all-YYYY-MM-DD.csv`

The export includes all captured data across all platforms and all sessions. The file opens correctly in:

- **Microsoft Excel** (UTF-8 BOM is included — no encoding issues)
- **Google Sheets** (import as CSV, encoding UTF-8)
- **Any text editor** or data analysis tool

---

## Understanding the CSV

Each row in the CSV is one message — either a human prompt or an AI response.

| Column | Example | Description |
|---|---|---|
| `session_id` | `abc12345-...` | Unique ID per conversation, derived from the conversation URL |
| `timestamp` | `2026-05-27 14:32:01` | Local time when the message was captured |
| `role` | `human` or `assistant` | Who sent the message |
| `message` | `Hello, how are you?` | Full message text, exactly as typed or generated |
| `platform` | `chatgpt` | Source platform |
| `url` | `https://chatgpt.com/c/...` | Conversation URL at capture time |

**Row ordering:** Human messages always appear immediately before the corresponding AI response, matching the natural back-and-forth of the conversation.

**Sessions:** All messages from the same conversation share the same `session_id`. When you start a new conversation (new URL), a new `session_id` is generated. Navigating back to an old conversation reuses the original session ID.

**Multi-session CSV:** When you export "all as CSV", conversations are ordered by when they started (oldest first), then all messages within each conversation appear in order.

---

## Clearing Your Data

1. Open the popup and click **Clear all data**
2. A confirmation dialog appears: "Delete all captured interactions? This cannot be undone."
3. Click OK to permanently delete all stored data

After clearing, the stats section disappears and both buttons are disabled until new data is captured.

> There is no partial clear — the button deletes everything. If you want to keep data from specific platforms, export to CSV first, then clear, and keep what you need from the file.

---

## FAQ

**Q: Will it capture messages from conversations that started before I installed the extension?**  
A: When you navigate to an existing conversation, the extension captures messages that are already visible on screen (within 1–2 seconds of the page loading). Messages from conversations you never open after installing the extension are not captured.

**Q: Why is there sometimes a delay before the AI response appears in storage?**  
A: The extension deliberately waits for the AI to finish generating before storing the response — it never captures partial text. There is an additional 1.2-second settle period after generation ends to make sure the final text is stable.

**Q: I sent the same message twice. Will it appear twice?**  
A: Yes, if you send the same message more than 2 minutes after the first send. Sends within a 2-minute window are deduplicated (to filter out browser re-renders, not intentional repeats).

**Q: Gemini seems to take longer to capture than ChatGPT and Claude. Is that normal?**  
A: Yes. Gemini assigns a conversation URL several seconds after your first message is sent. The extension waits for that URL before recording the human message, to ensure it's filed under the correct session. This adds up to ~12 seconds of polling for new conversations.

**Q: Does the extension slow down the AI platforms?**  
A: No. The extension only reads the DOM — it never modifies AI platform content, never intercepts network requests, and never injects content into the conversation. The only overhead is a MutationObserver watching for new DOM nodes, which is negligible.

**Q: Is my data backed up anywhere?**  
A: No. Data is stored only in `chrome.storage.local` on your computer. Uninstalling Chrome or clearing browser data will permanently delete it. Export to CSV regularly if you want to keep a backup.

**Q: Can I use this on multiple computers?**  
A: Data does not sync across computers. Each Chrome profile has its own independent storage. If you want to consolidate data, export CSV from each computer and merge the files.

**Q: The extension stopped working after a platform update. What do I do?**  
A: AI platforms update their DOM structure regularly. See the [Troubleshooting Guide](TROUBLESHOOTING.md) for how to diagnose and report the issue.
