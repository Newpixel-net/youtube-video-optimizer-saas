# YouTube Video Optimizer - Chrome Extension

A Chrome extension that integrates with Video Wizard to capture YouTube videos directly from your browser, bypassing server-side download restrictions.

## Why This Extension?

YouTube frequently changes their APIs and encryption, which breaks server-side video downloaders. This extension solves that problem by:

- Using your browser's existing YouTube session
- Capturing video data directly from the page
- Sending video info to Video Wizard for processing
- No server-side YouTube downloading needed

## Features

- **Video Wizard Integration**: Seamlessly works with the Video Wizard web app
- **Direct Capture**: Uses your browser's YouTube session (no auth issues)
- **One-Click Send**: Send YouTube videos directly to Video Wizard
- **Secure**: Manifest V3 with strict security policies
- **Lightweight**: Minimal permissions, no external servers

## Installation

### Step 1: Download the Extension

Download the `browser-extension` folder to your computer.

### Step 2: Open Chrome Extensions

1. Open Chrome browser
2. Navigate to `chrome://extensions/`
3. Or: Click Menu (three dots) > More tools > Extensions

### Step 3: Enable Developer Mode

Toggle the "Developer mode" switch in the top-right corner.

### Step 4: Load the Extension

1. Click "Load unpacked"
2. Select the `browser-extension` folder
3. The extension icon should appear in your toolbar

### Step 5: Pin the Extension (Recommended)

1. Click the puzzle piece icon in Chrome toolbar
2. Find "YouTube Video Optimizer"
3. Click the pin icon to keep it visible

## How to Use

### Method 1: From YouTube

1. Go to any YouTube video
2. Click the extension icon
3. Click "Send to Video Wizard"
4. Video Wizard opens with your video ready to process

### Method 2: From Video Wizard

1. Open Video Wizard (ytseo.siteuo.com/video-wizard.html)
2. The extension shows "Connected" status
3. Paste any YouTube URL in Video Wizard
4. The extension automatically captures the video

## How It Works

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   YouTube    │ --> │  Extension   │ --> │ Video Wizard │
│   Browser    │     │  (captures)  │     │  (processes) │
└──────────────┘     └──────────────┘     └──────────────┘

1. You browse YouTube normally
2. Extension captures video info from the page
3. Video Wizard receives the data and processes clips
4. No server-side YouTube downloading needed!
```

## Security

- **Manifest V3**: Latest, most secure extension architecture
- **Minimal Permissions**: Only `activeTab` and `storage`
- **Strict CSP**: `script-src 'self'; object-src 'none'`
- **Input Validation**: All inputs are sanitized
- **No External Servers**: Data stays in your browser

## File Structure

```
browser-extension/
├── manifest.json          # Extension configuration
├── src/
│   ├── popup.html         # Extension popup UI
│   ├── popup.css          # Popup styles
│   ├── popup.js           # Popup logic
│   ├── background.js      # Service worker
│   ├── content.js         # YouTube page script
│   ├── content.css        # Content script styles
│   ├── injected.js        # Page context script
│   └── wizard-bridge.js   # Video Wizard integration
├── icons/
│   ├── icon16.png         # Toolbar icon
│   ├── icon32.png         # Extension menu icon
│   ├── icon48.png         # Extensions page icon
│   └── icon128.png        # Chrome Web Store icon
└── scripts/
    └── create-png-icons.mjs  # Icon generation
```

## Troubleshooting

### Extension shows "Inactive"
- Make sure you're on YouTube or Video Wizard
- Check that the extension is enabled in `chrome://extensions/`

### "Please refresh the page" message
- The extension needs to inject scripts into the page
- Refresh the YouTube page and try again

### Video Wizard doesn't detect extension
- Check that wizard-bridge.js is loaded (check browser console)
- Refresh the Video Wizard page
- Make sure you're using the correct domain

## Privacy

This extension:
- Does NOT collect any personal data
- Does NOT track your browsing activity
- Does NOT send data to external servers (only to Video Wizard)
- Only accesses YouTube and Video Wizard pages
- Stores preferences locally in your browser

## Development

```bash
# Generate icons (if needed)
node scripts/create-png-icons.mjs

# Load the extension in Chrome as described above
```

## License

MIT License
