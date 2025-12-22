# Backup: v2.7.9 Working Video Capture

**Date**: 2025-12-22
**Version**: v2.7.9
**Commit**: 6956286
**Branch**: claude/fix-nvenc-frozen-video-v9bA2

## What This Fixes

This backup contains the working browser extension code that fixes the **FROZEN VIDEO** capture issue.

## The Problem

Videos captured by the browser extension were frozen (showing only the first frame) while audio played normally.

## Root Cause

Chrome's autoplay policy blocks unmuted video autoplay. The code was setting `muted=false` BEFORE calling `play()`, which caused Chrome to block autoplay silently. The video stayed paused, and `captureStream()` captured frozen frames.

## The Solution

Start with `muted=true` for autoplay to work, then unmute AFTER playback begins:

```javascript
// CORRECT (v2.7.9):
videoElement.muted = true;   // Start muted for autoplay
videoElement.play();         // Works!
recorder.start(500);
setTimeout(() => {
  videoElement.muted = false; // Unmute for audio capture
}, 100);
```

## Files in This Backup

- `background.js` - Main extension background script with video capture logic
- `manifest.json` - Extension manifest (version 2.7.9)

## How to Restore

If future changes break video capture again:

```bash
# Compare current code with this backup
diff browser-extension/src/background.js backups/v2.7.9-working-capture/background.js

# Restore from backup
cp backups/v2.7.9-working-capture/background.js browser-extension/src/background.js
cp backups/v2.7.9-working-capture/manifest.json browser-extension/manifest.json

# Or restore from git
git checkout 6956286 -- browser-extension/src/background.js browser-extension/manifest.json
```

## Key Code Location

The critical fix is in `background.js` around lines 1994-2028 in the `captureVideoWithMessage` function:

```javascript
// CRITICAL FIX: Start MUTED for autoplay to work (Chrome policy)
videoElement.muted = true;
videoElement.volume = 1;

const startRecording = () => {
  recorder.start(500);
  // NOW unmute to capture audio
  setTimeout(() => {
    videoElement.muted = false;
  }, 100);
};
```

## Warning

**NEVER** set `muted=false` before `play()` - this will break video capture!
