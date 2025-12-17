# Critical Information - Video Capture Issues and Solutions

This document contains critical solutions for video/audio capture issues encountered in the YouTube Video Optimizer extension.

---

## Problem 1: Video Plays at Wrong Speed (4x Too Fast)

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

## Problem 2: Audio Issues (Distorted, Wrong Speed, or Missing)

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
**Capture at 1x playback speed with audio unmuted.**

**In `browser-extension/src/background.js`:**

```javascript
// Use 1x playback for reliable audio capture
const PLAYBACK_SPEED = 1;

// CRITICAL: Do NOT mute the video element
videoElement.playbackRate = PLAYBACK_SPEED;
videoElement.muted = false;  // MUST be false to capture audio
videoElement.volume = 1;     // Full volume ensures audio is captured
```

### Why This Works
1. At 1x playback, no timestamp rescaling issues
2. `muted = false` ensures audio track is active and captured by `captureStream()`
3. Audio and video are synchronized naturally
4. No FFmpeg audio filters needed

### Trade-off
Capture takes the full duration of the clip (30s video = 30s capture time) instead of 4x faster.

### Key Files
- `browser-extension/src/background.js` - PLAYBACK_SPEED constant (multiple locations: ~lines 1337, 2072, 2762)
- `browser-extension/src/background.js` - muted/volume settings (~line 1964-1968)

---

## Quick Reference: What NOT to Do

### Video Element Settings That Break Audio Capture
```javascript
// BAD - prevents audio capture
videoElement.muted = true;

// BAD - can cause distorted audio at non-1x speeds
videoElement.volume = 0;

// BAD - unreliable audio routing
audioContext.createMediaElementSource(videoElement);
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

---

## Summary

| Issue | Root Cause | Solution |
|-------|------------|----------|
| Video 4x too fast | MediaRecorder timestamps based on real time | `setpts=PTS*scaleFactor` in FFmpeg |
| No audio | `muted = true` on video element | Set `muted = false`, `volume = 1` |
| Audio distorted | Capturing at non-1x playback | Use `PLAYBACK_SPEED = 1` |
| Audio wrong speed | Incorrect FFmpeg filter | Don't apply audio filters at 1x capture |

---

*Last updated: December 2024*
*Related commits: fix-video-ad-issues branch*
