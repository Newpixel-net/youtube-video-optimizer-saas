# Video Optimizer - Capture & Export Optimization Plan

## Executive Summary

This document outlines a phased approach to fix three critical issues:
1. **Slow capture/export process** - Capture time increased 4x due to audio fix
2. **Subtitles not displaying after export** - Caption pipeline issues
3. **Reframe split showing wrong video** - Secondary source not implemented in processor

---

## Phase 0: Critical - Capture & Export Speed Optimization

### Problem Analysis

**Root Cause Identified:**
- Capture speed was changed from **4x playback** to **1x playback** (commit `1ccf82d`)
- This was done to fix audio issues (audio distortion, wrong speed, no audio)
- Result: A 30-second clip now takes **30 seconds** to capture instead of **~8 seconds**

**Current Flow:**
```
browser-extension/src/background.js:1339
const PLAYBACK_SPEED = 1;  // Was 4, changed to 1 for audio fix
```

**Impact:**
- 4x slower capture time
- Poor user experience during analysis
- Longer wait times for export

### Optimization Strategy (Safe Approaches)

**DO NOT CHANGE:**
- The `PLAYBACK_SPEED = 1` setting (this fixed critical audio issues)
- The PTS rescaling logic (handles legacy 4x captures)
- The video bitrate settings (8 Mbps)

**OPTIMIZE:**

#### 0.1 Parallel Processing in Video Processor
**File:** `services/video-processor/src/processor.js`

Current FFmpeg settings use `preset=fast` which is a good balance. Options:
- Change to `preset=veryfast` for encoding (line 1229)
- Use hardware acceleration if available (NVENC/VAAPI)

```javascript
// Current (line 1228-1232):
'-c:v', 'libx264',
'-preset', 'fast',
'-crf', '23',

// Proposed optimization:
'-c:v', 'libx264',
'-preset', 'veryfast',  // Faster encoding, slightly larger file
'-crf', '23',
'-threads', '0',  // Auto-detect optimal threads
```

#### 0.2 Caption Generation Optimization
**File:** `services/video-processor/src/caption-renderer.js`

Caption generation happens synchronously before video processing. Optimize:
- Use smaller audio sample for Whisper (currently 16kHz, could use 8kHz for faster transcription)
- Consider caching transcriptions by video hash

#### 0.3 Segment Extraction Optimization
**File:** `services/video-processor/src/processor.js` (lines 580-625)

When extracting segments from captured video:
- Current: Uses `ultrafast` preset for extraction, then `fast` for processing
- This is already optimized

#### 0.4 Browser Extension - Optimized Capture Window

Instead of capturing the full video, implement smarter segment capture:
- Only open YouTube tab when user clicks "Export" (not during analysis)
- Capture only the specific clip segment needed (not the full 5 minutes)
- This is already partially implemented but can be improved

**Key Files to Modify:**
1. `services/video-processor/src/processor.js` - Lines 1228-1232 (preset change)
2. `services/video-processor/src/caption-renderer.js` - Consider parallel processing

### Risk Assessment
- **Low Risk:** Changing encoder preset (veryfast vs fast)
- **Medium Risk:** Changing audio sample rate for Whisper
- **No Change Needed:** Playback speed (must stay at 1x)

---

## Phase 1: Subtitles Not Displayed After Export

### Problem Analysis

**Potential Causes:**
1. **Caption generation failing silently** - Whisper API errors not reported
2. **ASS file not being created** - Path issues or file system errors
3. **FFmpeg filter not including captions** - Filter chain construction issue
4. **Path escaping issues** - Special characters in file paths

### Investigation Points

#### 1.1 Caption Generation
**File:** `services/video-processor/src/caption-renderer.js`

Check if OpenAI API key is configured:
```javascript
// Line 14-21
function getOpenAIClient() {
  if (!openai && process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }
  return openai;  // Returns null if no API key!
}
```

**Issue:** If `OPENAI_API_KEY` is not set, captions silently fail.

#### 1.2 ASS Filter Integration
**File:** `services/video-processor/src/processor.js` (lines 1206-1212)

```javascript
// Current implementation:
if (captionFile && fs.existsSync(captionFile)) {
  const escapedPath = captionFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
  filters = `${filters},ass='${escapedPath}'`;
  console.log(`[${jobId}] Adding captions from: ${captionFile}`);
}
```

**Potential Issues:**
1. The filter is appended AFTER `buildFilterChain()` - but for complex filters (split_screen, three_person), the filter chain uses complex filter graph syntax that may not support simple appending
2. Path escaping may be incomplete for certain special characters

#### 1.3 Complex Filter Modes Incompatibility
**File:** `services/video-processor/src/processor.js` (lines 1283-1306)

For `split_screen` and `three_person` modes, the filter chain uses complex filter graphs:
```javascript
case 'split_screen':
  filters.push(`split[left][right]`);
  filters.push(`[left]crop=...`);
  filters.push(`[right]crop=...`);
  filters.push(`[l][r]vstack`);
  break;
```

**Problem:** Simple appending `,ass='...'` to a complex filter graph doesn't work. The ASS filter needs to be applied to the final output stream.

### Fix Strategy

#### Fix 1.1: Add Better Error Logging
Add explicit logging when captions fail:
```javascript
// In caption-renderer.js
if (!client) {
  console.error(`[${jobId}] CRITICAL: OPENAI_API_KEY not set - captions disabled`);
  return null;
}
```

#### Fix 1.2: Fix Complex Filter Caption Integration
For complex filter modes, captions need to be added differently:

```javascript
// Current (broken for complex filters):
filters = `${filters},ass='${escapedPath}'`;

// Fixed approach:
const isComplexFilter = ['split_screen', 'three_person'].includes(normalizedMode);
if (isComplexFilter) {
  // For complex filters, add ass filter to the final vstack output
  // The filter chain ends with a labeled output, add ass after it
  const lastFilter = filters[filters.length - 1];
  if (lastFilter.includes('vstack')) {
    filters[filters.length - 1] = `${lastFilter}[out];[out]ass='${escapedPath}'`;
  }
} else {
  filters = `${filters},ass='${escapedPath}'`;
}
```

#### Fix 1.3: Verify Caption File Exists
Add verification before FFmpeg command:
```javascript
if (captionFile) {
  if (fs.existsSync(captionFile)) {
    const fileSize = fs.statSync(captionFile).size;
    console.log(`[${jobId}] Caption file exists: ${captionFile} (${fileSize} bytes)`);
  } else {
    console.error(`[${jobId}] Caption file NOT FOUND: ${captionFile}`);
  }
}
```

### Files to Modify
1. `services/video-processor/src/processor.js` - Lines 1193-1212 (filter chain)
2. `services/video-processor/src/caption-renderer.js` - Add error logging

---

## Phase 2: Reframe Split - Second Video Issue

### Problem Analysis

**Critical Finding: Secondary source processing is NOT implemented!**

The frontend correctly:
- Tracks `secondarySource` settings (youtubeVideoId, uploadedUrl, position)
- Passes settings to `wizardProcessClip`
- Stores in processing job (lines 18313-18321 in functions/index.js)

But the processor:
- Receives `settings.secondarySource`
- **NEVER uses it!**
- `processVideoFile()` only processes single input file
- `buildFilterChain()` for split_screen just splits the PRIMARY video

**Current `split_screen` behavior:**
```javascript
case 'split_screen':
  // Takes left 1/3 and right 1/3 of the SAME video
  const splitCropW = Math.floor(inputWidth / 3);
  filters.push(`split[left][right]`);
  filters.push(`[left]crop=${splitCropW}:...`);
  filters.push(`[right]crop=${splitCropW}:...`);
  filters.push(`[l][r]vstack`);
```

This is designed for podcast layouts where one video has multiple speakers - NOT for two different videos.

### Implementation Plan

#### 2.1 Download Secondary Video Source
Add function to download secondary video:

```javascript
// In processor.js

async function downloadSecondarySource({ jobId, secondarySource, workDir }) {
  if (!secondarySource || !secondarySource.enabled) {
    return null;
  }

  const secondaryFile = path.join(workDir, 'secondary.mp4');

  if (secondarySource.uploadedUrl) {
    // Download from Firebase Storage
    const response = await fetch(secondarySource.uploadedUrl);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(secondaryFile, Buffer.from(buffer));
  } else if (secondarySource.youtubeVideoId) {
    // Download YouTube video segment
    // Need to implement or reuse existing download logic
    await downloadVideoSegment({
      jobId,
      videoId: secondarySource.youtubeVideoId,
      startTime: 0,
      endTime: 300, // Or based on primary clip duration
      workDir,
      outputFile: secondaryFile
    });
  }

  return secondaryFile;
}
```

#### 2.2 Multi-Input FFmpeg Filter
Create new filter chain for multi-source:

```javascript
async function processMultiSourceVideo({
  jobId,
  primaryFile,
  secondaryFile,
  settings,
  output,
  workDir
}) {
  const outputFile = path.join(workDir, 'processed.mp4');
  const targetWidth = output?.resolution?.width || 1080;
  const targetHeight = output?.resolution?.height || 1920;
  const halfHeight = Math.floor(targetHeight / 2);

  const position = settings.secondarySource?.position || 'bottom';
  const audioMix = settings.audioMix || { primaryVolume: 100, secondaryVolume: 0 };

  // Build filter complex for two inputs
  let filterComplex = '';

  if (position === 'top') {
    filterComplex = `
      [0:v]scale=${targetWidth}:${halfHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${halfHeight}[primary];
      [1:v]scale=${targetWidth}:${halfHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${halfHeight}[secondary];
      [secondary][primary]vstack[outv]
    `;
  } else {
    // Default: secondary on bottom
    filterComplex = `
      [0:v]scale=${targetWidth}:${halfHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${halfHeight}[primary];
      [1:v]scale=${targetWidth}:${halfHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${halfHeight}[secondary];
      [primary][secondary]vstack[outv]
    `;
  }

  // Audio mixing
  const primaryVol = audioMix.primaryVolume / 100;
  const secondaryVol = audioMix.secondaryVolume / 100;
  filterComplex += `;
    [0:a]volume=${primaryVol}[a0];
    [1:a]volume=${secondaryVol}[a1];
    [a0][a1]amix=inputs=2:duration=first[outa]
  `;

  const args = [
    '-i', primaryFile,
    '-i', secondaryFile,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-y',
    outputFile
  ];

  // Execute FFmpeg...
}
```

#### 2.3 Integrate into Main Processing Flow
Modify `processVideo()` to handle secondary sources:

```javascript
// After downloading primary video, check for secondary
let secondaryFile = null;
if (job.settings?.secondarySource?.enabled) {
  secondaryFile = await downloadSecondarySource({
    jobId,
    secondarySource: job.settings.secondarySource,
    workDir
  });
}

// Use multi-source processing if secondary exists
if (secondaryFile && ['split_screen', 'broll_split'].includes(job.settings?.reframeMode)) {
  processedFile = await processMultiSourceVideo({
    jobId,
    primaryFile: downloadedFile,
    secondaryFile,
    settings: job.settings,
    output: job.output,
    workDir
  });
} else {
  // Existing single-source processing
  processedFile = await processVideoFile({...});
}
```

### Files to Modify
1. `services/video-processor/src/processor.js` - Add multi-source support
2. `functions/index.js` - Ensure secondarySource is properly passed (already done)

---

## Implementation Priority

| Phase | Issue | Complexity | Impact | Priority |
|-------|-------|------------|--------|----------|
| 0 | Capture Speed | Medium | High | 1 |
| 1 | Subtitles | Low | High | 2 |
| 2 | Split Video | High | Medium | 3 |

### Recommended Order:
1. **Phase 1 first** - Quick fix, high impact, low risk
2. **Phase 0 next** - Medium effort, addresses core complaint
3. **Phase 2 last** - Most complex, requires new functionality

---

## Testing Checklist

### Phase 0 Tests
- [ ] Export a 30-second clip and measure total time
- [ ] Compare with previous export times
- [ ] Verify audio quality is preserved
- [ ] Check video quality at different presets

### Phase 1 Tests
- [ ] Export with karaoke captions - verify text appears
- [ ] Export with bold captions - verify styling
- [ ] Export with split_screen mode + captions
- [ ] Check Cloud Run logs for caption generation errors

### Phase 2 Tests
- [ ] Create split_screen with YouTube secondary video
- [ ] Create split_screen with uploaded secondary video
- [ ] Verify correct video appears in top/bottom positions
- [ ] Test audio mixing between primary/secondary

---

## Rollback Plan

If any phase causes issues:
1. **Phase 0:** Revert preset change (fast vs veryfast)
2. **Phase 1:** Caption errors are already non-blocking
3. **Phase 2:** Feature flag for multi-source processing

---

## Environment Variables Required

Ensure these are set in Cloud Run:
```
OPENAI_API_KEY=sk-...  # Required for captions
PTS_RESCALE_ENABLED=true  # For legacy 4x captures
```
