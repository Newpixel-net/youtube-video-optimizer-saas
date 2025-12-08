# YouTube Video Optimizer - Chrome Extension

A secure Chrome extension for capturing and downloading YouTube video clips directly from your browser.

## Features

- Capture clips from any YouTube video
- Select custom start and end times
- Choose between 720p and 1080p quality
- Direct download to your computer
- Works with your existing YouTube session (no authentication issues)
- High security with Manifest V3

## Security Features

- **Manifest V3**: Uses the latest, most secure Chrome extension architecture
- **Strict Content Security Policy**: Prevents XSS and injection attacks
- **Minimal Permissions**: Only requests necessary permissions (activeTab, storage, downloads)
- **Input Validation**: All user inputs are validated and sanitized
- **Secure Communication**: All extension components use secure message passing
- **No External Servers**: Video capture happens entirely in your browser

## Installation

### Developer Mode Installation

1. **Download the Extension**
   - Download or clone this folder to your computer

2. **Open Chrome Extensions**
   - Open Chrome browser
   - Navigate to `chrome://extensions/`
   - Or: Menu > More tools > Extensions

3. **Enable Developer Mode**
   - Toggle the "Developer mode" switch in the top-right corner

4. **Load the Extension**
   - Click "Load unpacked"
   - Select the `browser-extension` folder
   - The extension icon should appear in your toolbar

5. **Pin the Extension (Recommended)**
   - Click the puzzle piece icon in Chrome toolbar
   - Find "YouTube Video Optimizer"
   - Click the pin icon to keep it visible

## Usage

1. **Navigate to a YouTube Video**
   - Go to any YouTube video page (youtube.com/watch?v=...)

2. **Open the Extension**
   - Click the extension icon in your toolbar

3. **Select Clip Range**
   - Set the start time and end time for your clip
   - Maximum duration is 5 minutes

4. **Choose Quality**
   - Select 720p HD or 1080p Full HD

5. **Capture & Download**
   - Click "Capture & Download"
   - Choose where to save the file
   - Wait for the download to complete

## Permissions Explained

| Permission | Why It's Needed |
|------------|-----------------|
| `activeTab` | Access the current YouTube tab to extract video info |
| `storage` | Save your preferences (quality, etc.) |
| `downloads` | Save captured videos to your computer |
| `host_permissions: youtube.com` | Read video information from YouTube pages |
| `host_permissions: googlevideo.com` | Download video streams from YouTube's servers |

## Troubleshooting

### Extension doesn't show video info
- Make sure you're on a YouTube video page (URL contains `/watch?v=`)
- Try refreshing the YouTube page
- Check if the video is available in your region

### Download fails
- Some videos may be protected and cannot be downloaded
- Live streams cannot be captured (wait until they finish)
- Try selecting a lower quality

### "Please refresh the page" message
- The extension needs to inject a script into the page
- Refresh the YouTube page and try again

## Development

### File Structure

```
browser-extension/
  manifest.json          # Extension configuration
  src/
    popup.html           # Extension popup UI
    popup.css            # Popup styles
    popup.js             # Popup logic
    background.js        # Service worker
    content.js           # YouTube page script
    content.css          # Content script styles
    injected.js          # Page context script
  icons/
    icon16.png           # Toolbar icon
    icon32.png           # Extension menu icon
    icon48.png           # Extensions page icon
    icon128.png          # Chrome Web Store icon
  scripts/
    create-png-icons.mjs # Icon generation script
```

### Building from Source

```bash
# Generate icons (if needed)
node scripts/create-png-icons.mjs

# Load the extension in Chrome as described above
```

## Privacy

This extension:
- Does NOT collect any personal data
- Does NOT track your browsing activity
- Does NOT send data to external servers
- Only accesses YouTube pages you visit
- Stores preferences locally in your browser

## License

MIT License - See LICENSE file for details.
