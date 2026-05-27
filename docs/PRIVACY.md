# Privacy Policy — AI Interaction Tracker

**Last updated:** 2026-05-27

---

## Summary

- All data is stored **only on your computer**, inside Chrome's local storage
- Nothing is ever sent to any server, cloud service, or third party
- You can export or permanently delete all data at any time

---

## What is captured

When tracking is enabled, the extension records the following for each message you send or receive on ChatGPT, Claude, and Gemini:

| Field | Description |
|---|---|
| Message text | The full text of your prompt or the AI's response |
| Timestamp | The local date and time the message was captured |
| Role | Whether the message is from you (`human`) or the AI (`assistant`) |
| Platform | Which platform the message came from (chatgpt, claude, gemini) |
| URL | The conversation URL at the time of capture |
| Session ID | A unique identifier derived from the conversation URL |

---

## What is NOT captured

The extension does not capture, transmit, or store:

- File attachments, images, or audio you upload to a platform
- Your login credentials or account information on any platform
- Payment information or any financial data
- Pages outside of ChatGPT, Claude, and Gemini
- System prompts or hidden context injected by the platforms
- Any data while tracking is set to **OFF** in the popup

---

## Where data is stored

All captured data is stored exclusively in **`chrome.storage.local`** on your computer. This storage:

- Is local to your Chrome browser profile
- Does not sync to Google's servers (unlike `chrome.storage.sync`)
- Is not accessible by websites, other extensions, or any external service
- Persists until you clear it using the extension popup or clear Chrome's browsing data

No data is transmitted to Anthropic, to the AI platforms you use, or to any other server. The extension has no network permissions beyond the host permissions needed to inject content scripts into the three supported platforms.

---

## How to delete your data

**To delete all captured data:**
1. Open the extension popup (click the AI Tracker icon in the toolbar)
2. Click **Clear all data**
3. Confirm the dialog

This immediately and permanently removes all stored sessions and messages from `chrome.storage.local`. The action cannot be undone.

**To stop capturing new data without deleting existing data:**
1. Open the popup and toggle tracking to **OFF**

**To uninstall the extension:**
1. Go to `chrome://extensions`
2. Find AI Tracker and click **Remove**
3. Note: uninstalling may not clear `chrome.storage.local` data in all Chrome versions. Use the Clear button before uninstalling if you want to ensure all data is removed.

---

## Third-party platforms

This extension operates on third-party platforms (ChatGPT, Claude, Gemini). The privacy policies of those platforms govern your interactions with their services. This extension does not modify how those platforms handle your data — it only reads what is already rendered in the browser.

---

## Changes to this policy

If this policy changes materially, the change will be noted in the project changelog and the "Last updated" date above will be updated.
