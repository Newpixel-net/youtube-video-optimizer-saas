# Video Optimizer - Capture & Export Optimization Plan

## Status: ✅ ALL ISSUES RESOLVED

This document contains critical information about fixes implemented for:
1. **Slow capture/export process** - Optimized with `veryfast` preset
2. **Subtitles not displaying after export** - Fixed filter chain + OPENAI_API_KEY required
3. **Reframe split showing wrong video** - Implemented browser extension capture for secondary videos

---

# CRITICAL INFORMATION

## Required Environment Variables (Cloud Run)

These MUST be set in Cloud Run for full functionality:

```bash
OPENAI_API_KEY=sk-...        # REQUIRED for captions/subtitles
PTS_RESCALE_ENABLED=true     # For legacy 4x capture compatibility
```

### How to Set Environment Variables

**Option 1: Command Line (PowerShell recommended for special characters)**
```powershell
gcloud run services update video-processor --region=us-central1 --update-env-vars="OPENAI_API_KEY=sk-your-key-here"
```

**Option 2: Using env-vars-file (Best for keys with special characters)**
1. Create `env.yaml`:
```yaml
OPENAI_API_KEY: "sk-your-full-api-key-here"
PTS_RESCALE_ENABLED: "true"
```

2. Run:
```cmd
gcloud run services update video-processor --region=us-central1 --env-vars-file=env.yaml
```

**Option 3: Google Cloud Console**
1. Go to: https://console.cloud.google.com/run
2. Click on `video-processor` service
3. Click "Edit & Deploy New Revision"
4. Go to "Variables & Secrets" section
5. Add the variables
6. Click "Deploy"

### How to Check Current Environment Variables
```cmd
gcloud run services describe video-processor --region=us-central1 --format="yaml(spec.template.spec.containers[0].env)"
```

---

# ISSUE 1: Subtitles Not Displaying After Export

## Root Causes Found

1. **OPENAI_API_KEY not set in Cloud Run** - Captions silently failed
2. **Complex filter graph incompatibility** - For `split_screen` and `three_person` modes, the ASS subtitle filter was incorrectly appended

## Solution Implemented

### Fix 1: Better Error Logging
**File:** `services/video-processor/src/caption-renderer.js`

Added explicit logging when API key is missing:
```javascript
if (!client) {
  console.error(`[${jobId}] CRITICAL: OPENAI_API_KEY environment variable not set - captions will be disabled`);
  console.error(`[${jobId}] To enable captions, set OPENAI_API_KEY in Cloud Run environment variables`);
  return null;
}
```

### Fix 2: Complex Filter Graph Handling
**File:** `services/video-processor/src/processor.js`

For complex modes (`split_screen`, `three_person`):
- Now uses `-filter_complex` instead of `-vf`
- Properly labels output streams for caption overlay

```javascript
// Determine filter type
const isComplexFilter = ['split_screen', 'three_person'].includes(normalizedMode);
const filterFlag = isComplexFilter ? '-filter_complex' : '-vf';

// For complex filters, label output and add captions
if (isComplexFilter && captionFile) {
  filters = `${filters}[vout];[vout]ass='${escapedCaptionPath}'`;
}
```

## Verification

Check Cloud Run logs for:
```
[jobId] ========== CAPTION GENERATION ==========
[jobId] Caption style requested: "karaoke"
[jobId] Generating captions with style: karaoke
[jobId] Transcribing with Whisper...
[jobId] Caption file created: /tmp/.../captions.ass (1234 bytes)
[jobId] Caption generation SUCCESS
```

If you see `CRITICAL: OPENAI_API_KEY environment variable not set`, the API key is missing.

---

# ISSUE 2: Reframe Split Showing Wrong Video

## Root Cause Found

**CRITICAL BUG:** Server-side YouTube download fails due to bot detection!

The logs showed:
```
yt-dlp failed (bot_detection)
Video Download API key: NOT CONFIGURED
```

YouTube blocks all server-side download attempts (yt-dlp, youtubei.js, etc.) even with POT server.

## Solution Implemented

**Capture secondary YouTube videos via browser extension** - same method as primary video.

### Implementation Details

**File:** `frontend/video-wizard.html` (lines 11410-11511)

When exporting with a YouTube secondary source:
1. Detect if secondary source is a YouTube URL
2. Capture via browser extension (uses user's authenticated session)
3. Upload to Firebase Storage
4. Use the storage URL for processing

```javascript
// ===== SECONDARY VIDEO CAPTURE (if YouTube URL) =====
if (clipSettings.secondarySource &&
    clipSettings.secondarySource.enabled &&
    clipSettings.secondarySource.type === 'youtube' &&
    clipSettings.secondarySource.youtubeVideoId &&
    !clipSettings.secondarySource.uploadedUrl) {

    // Capture via extension
    var secCaptureResult = await sendExtensionRequest('captureVideoForWizard', {
        videoId: secVideoId,
        youtubeUrl: clipSettings.secondarySource.youtubeUrl,
        clipStart: secTimeOffset,
        clipEnd: secTimeOffset + clipDuration,
        quality: quality,
        autoCapture: true,
        autoOpenTab: true  // Auto-open YouTube tab
    });

    // Upload to storage and update settings
    if (secCaptureResult.success) {
        clipSettings.secondarySource.uploadedUrl = secStorageUrl;
    }
}
```

### Why This Works

- Primary video works because it's captured via browser extension
- Browser extension uses user's authenticated YouTube session
- Bypasses all bot detection (user is a real human with real cookies)
- Secondary video now uses the same proven method

### Backend Changes

**File:** `services/video-processor/src/processor.js`

1. Added `downloadSecondarySource()` function
2. Added `processMultiSourceVideo()` for two-input FFmpeg processing
3. Uses separate temp directory to avoid overwriting primary video
4. Supports audio mixing between primary/secondary

```javascript
// Create subdirectory for secondary download to avoid file conflicts
const secondaryWorkDir = path.join(workDir, 'secondary_temp');
fs.mkdirSync(secondaryWorkDir, { recursive: true });
```

---

# ISSUE 3: Slow Capture/Export Process

## Root Cause

Capture speed was changed from 4x to 1x playback to fix audio issues.

**DO NOT CHANGE `PLAYBACK_SPEED = 1`** - This fixed critical audio problems.

## Optimizations Implemented

**File:** `services/video-processor/src/processor.js`

1. Changed FFmpeg preset from `fast` to `veryfast`
2. Added multi-threading with `-threads 0`

```javascript
const args = [
  '-i', inputFile,
  filterFlag, filters,
  '-c:v', 'libx264',
  '-preset', 'veryfast',     // Optimized: faster encoding
  '-crf', '23',
  '-threads', '0',           // Auto-detect optimal thread count
  // ...
];
```

Applied to:
- Main video processing
- Transition encoding
- Multi-source processing

---

# Files Modified

| File | Changes |
|------|---------|
| `services/video-processor/src/processor.js` | Multi-source support, optimized encoding, fixed filter chains |
| `services/video-processor/src/caption-renderer.js` | Better error logging for missing API key |
| `frontend/video-wizard.html` | Secondary video capture via browser extension |

---

# Debugging

## Check Multi-Source Detection
Look for in Cloud Run logs:
```
========== MULTI-SOURCE MODE CHECK ==========
Reframe mode: split_screen
Secondary source exists: true
Secondary enabled: true
Secondary uploadedUrl: YES  <-- This should be YES after extension capture
Is multi-source mode: true
========================================
```

## Check Secondary Download
```
========== SECONDARY SOURCE DOWNLOAD ==========
Downloading secondary from storage URL...
Secondary video downloaded: X.XX MB
Secondary source download SUCCESS
========================================
```

## Check Caption Generation
```
========== CAPTION GENERATION ==========
Caption style requested: "karaoke"
Caption file created: /tmp/.../captions.ass (1234 bytes)
Caption generation SUCCESS
========================================
```

---

# Common Issues & Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| Subtitles missing | `OPENAI_API_KEY` not set | Add to Cloud Run env vars |
| Split shows same video twice | Secondary YouTube download failed | Extension now captures secondary video |
| Secondary download fails with "bot_detection" | YouTube blocks server-side downloads | Use uploaded file or extension capture |
| Captions missing on split_screen | Wrong FFmpeg filter flag | Fixed: uses `-filter_complex` for complex modes |

---

# Testing Checklist

- [x] Export with captions - verify subtitles appear
- [x] Export split_screen with YouTube secondary - verify two different videos
- [x] Export split_screen with uploaded secondary - verify correct positioning
- [x] Check Cloud Run logs show caption generation success
- [x] Verify encoding uses `veryfast` preset

---

# Commits

```
dc135f9 feat: Capture secondary YouTube videos via browser extension
fa05ac2 fix: Critical fixes for secondary source and improved debugging
f0e71be fix: Implement capture/export optimization and fix subtitle/split issues
e5bfd19 docs: Add comprehensive optimization plan for capture/export issues
```
