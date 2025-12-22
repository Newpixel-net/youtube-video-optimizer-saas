# Critical Information - Video Capture Issues and Solutions

This document contains critical solutions for video/audio capture issues encountered in the YouTube Video Optimizer extension.

---

## Problem 1: FROZEN VIDEO - Chrome Autoplay Policy (CRITICAL - Fixed 2025-12-22)

### Symptoms
- Captured video shows only the first frame (frozen)
- Audio plays normally
- MediaRecorder captures data successfully but video content is static
- WebM file is valid but contains repeated first frame

### Root Cause
**Chrome's autoplay policy blocks unmuted video autoplay.**

The change from `muted=true` to `muted=false` (to fix audio capture) broke video capture because:

```javascript
// BROKEN CODE (after v2.7.1):
videoElement.muted = false;  // Unmuted = Chrome blocks autoplay!
videoElement.play();         // FAILS silently - video stays PAUSED
// captureStream() then captures frozen frames
```

```javascript
// WORKING CODE (v2.7.1):
videoElement.muted = true;   // Muted = Chrome allows autoplay
videoElement.play();         // Works!
// captureStream() captures actual video frames
```

### Solution
**Start muted for autoplay, then unmute AFTER playback begins:**

**In `browser-extension/src/background.js` (~line 1994-2028):**

```javascript
// CRITICAL FIX: Start MUTED for autoplay to work (Chrome policy)
// Chrome blocks autoplay of unmuted videos. We must start muted,
// then unmute AFTER playback begins for audio capture.
videoElement.muted = true;
videoElement.volume = 1; // Pre-set volume for when we unmute

const startRecording = () => {
  recorder.start(500);
  console.log('[EXT][CAPTURE] Recording started');

  // NOW unmute to capture audio (after playback confirmed)
  setTimeout(() => {
    videoElement.muted = false;
    console.log('[EXT][CAPTURE] Video unmuted for audio capture');
  }, 100);
};

// Ensure video is playing before starting (muted autoplay should work)
if (videoElement.paused) {
  videoElement.play().then(startRecording).catch((e) => {
    console.warn('[EXT][CAPTURE] Play failed, trying anyway:', e.message);
    startRecording();
  });
} else {
  startRecording();
}
```

### Key Points
1. **NEVER set `muted=false` before `play()`** - Chrome will block autoplay
2. Start with `muted=true` so autoplay is allowed
3. Unmute AFTER playback has started (100ms delay)
4. The 100ms delay ensures playback is stable before unmuting

### Working Version Reference
- **v2.7.10** is the working version with the complete fix
- Commit: `2410782` (2025-12-22)
- Key file: `browser-extension/src/background.js`

**Important**: There are TWO places where `muted=true` must be set before `play()`:
1. **Pre-capture section** (~line 1766-1768) - before `captureStream()` is called
2. **Recording section** (~line 1994-2028) - when starting the MediaRecorder

The v2.7.9 fix only addressed the recording section. v2.7.10 adds the fix to the pre-capture section as well.

---

## Problem 2: Video Plays at Wrong Speed (4x Too Fast)

### Symptoms
- Exported video plays at 4x speed
- Video duration shows correctly but playback is fast
- Audio may be chipmunk-sounding or missing

### Root Cause
The browser extension was capturing video at `playbackRate = 4` to reduce capture time. However, **MediaRecorder writes timestamps based on real-world capture time, not video content time**.

Example:
- 30-second video clip
- Captured at 4x speed = 7.5 seconds real time
- MediaRecorder writes timestamps spanning 0-7.5s
- Result: 30s of video frames with 7.5s of timestamps = plays at 4x speed

### Solution
**In `services/video-processor/src/processor.js`:**

Use FFmpeg's `setpts` filter to rescale video timestamps:

```javascript
// Calculate scale factor
const ptsRatio = realWorldDuration / videoPtsInfo.ptsSpan;  // e.g., 30/7.5 = 4

// Apply video filter to stretch timestamps
videoFilter = `setpts=PTS*${scaleFactor.toFixed(6)}`;
```

The `setpts=PTS*4` filter multiplies all presentation timestamps by 4, stretching the video from 7.5s to 30s.

### Key Files
- `services/video-processor/src/processor.js` - PTS rescaling logic (lines 660-730)
- Feature flag: `PTS_RESCALE_ENABLED` environment variable

---

## Problem 3: Audio Issues (Distorted, Wrong Speed, or Missing)

### Symptoms
- Audio is distorted or robotic
- Audio plays too fast or too slow
- Audio ends before video finishes
- No audio at all

### Root Cause
When capturing video at non-1x playback speeds, `captureStream()` and `MediaRecorder` have **inconsistent audio behavior** across browsers:

| Approach | Result |
|----------|--------|
| `muted = true` | Audio NOT captured or captured incorrectly |
| `volume = 0` | Audio distorted |
| Web Audio API (`createMediaElementSource`) | No audio captured |
| `atempo` filter in FFmpeg | Made audio too slow (audio wasn't actually 4x) |
| `asetpts` filter in FFmpeg | Audio ended early |

The W3C spec says audio should be "time-stretched" at different playback rates, but browser implementations vary.

### Solution
**Capture at 1x playback speed with audio unmuted (after playback starts).**

**In `browser-extension/src/background.js`:**

```javascript
// Use 1x playback for reliable audio capture
const PLAYBACK_SPEED = 1;

// Start muted for autoplay, unmute after playback begins
videoElement.playbackRate = PLAYBACK_SPEED;
videoElement.muted = true;  // Start muted for autoplay
videoElement.volume = 1;

// After recorder.start():
setTimeout(() => {
  videoElement.muted = false;  // Unmute to capture audio
}, 100);
```

### Why This Works
1. At 1x playback, no timestamp rescaling issues
2. Starting `muted=true` allows autoplay (Chrome policy)
3. Unmuting after playback starts captures audio properly
4. Audio and video are synchronized naturally
5. No FFmpeg audio filters needed

### Trade-off
Capture takes the full duration of the clip (30s video = 30s capture time) instead of 4x faster.

### Key Files
- `browser-extension/src/background.js` - PLAYBACK_SPEED constant (multiple locations: ~lines 1337, 2101, 2948)
- `browser-extension/src/background.js` - muted/volume settings (~line 1994-2028)

---

## Quick Reference: What NOT to Do

### Video Element Settings That Break Video/Audio Capture
```javascript
// BAD - prevents autoplay, causes FROZEN VIDEO
videoElement.muted = false;
videoElement.play();  // Chrome blocks this!

// BAD - can cause distorted audio at non-1x speeds
videoElement.volume = 0;

// BAD - unreliable audio routing
audioContext.createMediaElementSource(videoElement);
```

### CORRECT Approach
```javascript
// GOOD - allows autoplay
videoElement.muted = true;
videoElement.volume = 1;
videoElement.play().then(() => {
  // Start recording
  recorder.start(500);
  // Then unmute for audio capture
  setTimeout(() => {
    videoElement.muted = false;
  }, 100);
});
```

### FFmpeg Audio Filters That Don't Work for This Use Case
```javascript
// BAD - if audio isn't actually at 4x speed, this makes it way too slow
audioFilter = 'atempo=0.5,atempo=0.5';

// BAD - doesn't stretch audio content, just timestamps
audioFilter = 'asetpts=PTS*4';

// BAD - same issue
audioFilter = 'asetpts=N/SR/TB';
```

---

## Diagnostic Tools

### Check PTS (Presentation Timestamps) of a Video File
```bash
# Get video packet timestamps
ffprobe -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 "video.webm"

# Get audio packet timestamps
ffprobe -v error -select_streams a:0 -show_entries packet=pts_time -of csv=p=0 "video.webm"

# Get stream info
ffprobe -v error -show_streams "video.webm"
```

### Key Diagnostic in Processor Logs
Look for these log lines:
```
PTS ANALYSIS: ptsSpan=7.5s, realWorld=30s, ratio=4.0
```
If ratio is significantly different from 1.0, timestamp rescaling is needed.

### Check if Video is Frozen
```bash
# Count unique frames (frozen video = very few unique frames)
ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "video.webm"
```

---

## Summary

| Issue | Root Cause | Solution |
|-------|------------|----------|
| **FROZEN VIDEO** | `muted=false` before `play()` blocks autoplay | Start `muted=true`, unmute after playback starts |
| Video 4x too fast | MediaRecorder timestamps based on real time | `setpts=PTS*scaleFactor` in FFmpeg |
| No audio | `muted=true` throughout capture | Unmute after playback starts |
| Audio distorted | Capturing at non-1x playback | Use `PLAYBACK_SPEED = 1` |

---

## Working Version Backup Reference (v2.7.10)

**Date**: 2025-12-22
**Commit**: `2410782`
**Branch**: `claude/fix-nvenc-frozen-video-v9bA2`

### Key Configuration (browser-extension/src/background.js)

**Location 1: Pre-capture section (~lines 1763-1781)**
```javascript
// CRITICAL: Ensure video is PLAYING before captureStream
if (videoElement.paused) {
  console.log('[EXT][CAPTURE] Video is paused after seek, resuming playback...');
  try {
    // CRITICAL FIX v2.7.10: Must set muted=true for Chrome autoplay policy!
    // Without this, play() fails silently and captureStream() gets frozen frames
    videoElement.muted = true;
    await videoElement.play();
    await sleep(300);
  } catch (playErr) {
    // Fallback to YouTube player API...
  }
}
```

**Location 2: Recording section (~lines 1994-2028)**
```javascript
// CRITICAL FIX: Start MUTED for autoplay to work (Chrome policy)
videoElement.muted = true;
videoElement.volume = 1;

const startRecording = () => {
  recorder.start(500);
  // NOW unmute to capture audio (after playback confirmed)
  setTimeout(() => {
    videoElement.muted = false;
  }, 100);
};
```

### To Restore if Problems Arise
```bash
# Compare current code with working version
git diff 2410782 -- browser-extension/src/background.js

# Reset to working version if needed
git checkout 2410782 -- browser-extension/src/background.js
```

---

*Last updated: 2025-12-22*
*Working version: v2.7.10 (commit 2410782)*
