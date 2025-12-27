# Comprehensive Caption System Fix - Prompt for Claude Code

## Current State
**Preview:** Captions work perfectly - shows word-by-word karaoke-style highlighting (see VideoPreviewEngine._renderCaption)
**Export:** Captions do NOT appear in the final exported video

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CAPTION SYSTEM FLOW                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  PREVIEW (WORKING)                      EXPORT (BROKEN)                      │
│  ─────────────────                      ──────────────                       │
│                                                                              │
│  VideoPreviewEngine                     Cloud Function                       │
│        │                                      │                              │
│        ▼                                      ▼                              │
│  _generateWordTimings()                 Creates job manifest                 │
│  (from scene.narration)                 (manifest.captions.style)            │
│        │                                      │                              │
│        ▼                                      ▼                              │
│  _renderCaption()                       creation-processor.js                │
│  (canvas rendering)                           │                              │
│        │                                      ▼                              │
│        ▼                                generateCaptions()                   │
│  Style-specific render                  (caption-renderer.js)                │
│  (karaoke, beasty, etc.)                      │                              │
│                                               ▼                              │
│                                         transcribeWithWhisper()              │
│                                         (REQUIRES OPENAI_API_KEY)            │
│                                               │                              │
│                                               ▼                              │
│                                         generateASSFile()                    │
│                                               │                              │
│                                               ▼                              │
│                                         FFmpeg -vf "ass=..."                 │
│                                               │                              │
│                                               ▼                              │
│                                         final_with_captions.mp4             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Files

### 1. Frontend - Preview Rendering (WORKS)
**File:** `frontend/video-creation-wizard.html`
**Location:** Lines 653-985 (VideoPreviewEngine._renderCaption)

```javascript
// Style-aware canvas rendering - generates word timing from narration
_renderCaption(scene) {
    const sceneLocalTime = this.currentTime - scene.startTime;
    const sceneDuration = scene.visualDuration || scene.duration || 5;
    const wordTimings = this._generateWordTimings(caption, sceneDuration);
    // Renders karaoke, beasty, hormozi, etc. styles on canvas
}
```

### 2. Cloud Function - Job Creation
**File:** `functions/index.js`
**Location:** Lines 24820-24826

```javascript
// Captions settings for subtitle generation
captions: {
    enabled: timelineState?.captions?.enabled ?? assembly.captions?.enabled ?? true,
    style: timelineState?.captions?.style || assembly.captions?.style || 'karaoke',
    position: timelineState?.captions?.position || assembly.captions?.position || 'bottom',
    size: parseFloat(timelineState?.captions?.size || assembly.captions?.size) || 1
}
```

### 3. Backend Processor - Caption Generation
**File:** `services/video-processor/src/creation-processor.js`
**Location:** Lines 255-318

```javascript
// Step 5.5: Generate and burn captions if enabled
const captionsConfig = manifest.captions || {};
const captionsEnabled = captionsConfig.enabled !== false;
const captionStyle = captionsConfig.style || 'karaoke';

if (captionsEnabled && captionStyle && captionStyle !== 'none') {
    const captionFile = await generateCaptions({
        jobId,
        videoFile: finalVideoFile,
        workDir,
        captionStyle: captionStyle,
        captionPosition: captionsConfig.position || 'bottom',
        captionSize: captionsConfig.size || 1
    });

    if (captionFile && fs.existsSync(captionFile)) {
        // Burn captions into video with FFmpeg
        const captionArgs = [
            '-i', finalVideoFile,
            '-vf', `ass='${escapedCaptionPath}'`,
            '-c:v', 'libx264',
            ...
        ];
    }
}
```

### 4. Caption Renderer - Whisper Transcription
**File:** `services/video-processor/src/caption-renderer.js`
**Location:** Lines 44-104 (generateCaptions), Lines 140-179 (transcribeWithWhisper)

```javascript
export async function generateCaptions({ jobId, videoFile, workDir, captionStyle, ... }) {
    // Step 1: Extract audio from video
    const audioFile = path.join(workDir, 'audio.wav');
    await extractAudio(jobId, videoFile, audioFile);

    // Step 2: Transcribe with Whisper (word-level timestamps)
    const transcription = await transcribeWithWhisper(jobId, audioFile);

    // Step 3: Generate ASS subtitle file
    const assFile = path.join(workDir, 'captions.ass');
    await generateASSFile(jobId, transcription.words, normalizedStyle, ...);

    return assFile;
}

async function transcribeWithWhisper(jobId, audioFile) {
    const client = getOpenAIClient();
    if (!client) {
        console.error(`[${jobId}] CRITICAL: OPENAI_API_KEY environment variable not set`);
        return null;  // <-- CAPTIONS DISABLED IF NO API KEY
    }
    // Uses OpenAI Whisper API for transcription
}
```

## Potential Causes of Caption Export Failure

### 1. OPENAI_API_KEY Not Set (MOST LIKELY)
**Location:** `services/video-processor/cloudbuild.yaml` line 65-67
```yaml
# Note: API keys (OPENAI_API_KEY, RAPIDAPI_KEY, etc.) should be set directly
# on Cloud Run via console or gcloud, NOT in this file.
```
**Impact:** If OPENAI_API_KEY is not set in Cloud Run environment, `generateCaptions()` returns null silently.

### 2. Whisper Transcription Fails
**Location:** `caption-renderer.js` lines 140-179
**Impact:** If audio extraction or Whisper API call fails, no captions generated.

### 3. ASS File Generation Fails
**Location:** `caption-renderer.js` lines 192+
**Impact:** If ASS file isn't created, FFmpeg won't burn captions.

### 4. FFmpeg ASS Filter Fails
**Location:** `creation-processor.js` lines 288-301
**Impact:** FFmpeg command might fail silently, falling back to video without captions.

## Style ID Mappings

Frontend ID → Backend ID (via STYLE_ALIASES in caption-renderer.js):
- `karaoke` → `karaoke`
- `beasty` → `bold`
- `deepdiver` → `minimal`
- `podp` → `podcast`
- `hormozi` → `hormozi`
- `ali` → `ali`
- `custom` → `custom`
- `none` → (skipped)

## Task: Fix Caption Export

### Option A: Verify Environment Variables
1. Check if OPENAI_API_KEY is set in Cloud Run
2. If not, set it via Google Cloud Console or gcloud CLI
3. Redeploy the service

### Option B: Add Fallback Caption System
If Whisper API isn't available, use the scripted narration text with calculated timing (same as preview):

```javascript
// In creation-processor.js or caption-renderer.js
async function generateCaptionsFromNarration(scenes, workDir, captionStyle, ...) {
    // Generate word timings from scene narration (like preview does)
    const words = [];
    let currentTime = 0;

    for (const scene of scenes) {
        const narration = scene.narration || '';
        const sceneWords = narration.split(/\s+/).filter(w => w.length > 0);
        const avgWordDuration = scene.duration / sceneWords.length;

        sceneWords.forEach((word, i) => {
            words.push({
                word: word,
                start: currentTime + (i * avgWordDuration),
                end: currentTime + ((i + 1) * avgWordDuration)
            });
        });
        currentTime += scene.duration;
    }

    // Generate ASS file from these timings
    return generateASSFile(jobId, words, captionStyle, ...);
}
```

### Option C: Add Detailed Logging/Diagnostics
Add more logging to pinpoint exactly where captions fail:

```javascript
// In creation-processor.js
console.log(`[${jobId}] Caption generation starting...`);
console.log(`[${jobId}] - manifest.captions:`, JSON.stringify(manifest.captions));
console.log(`[${jobId}] - OPENAI_API_KEY set: ${!!process.env.OPENAI_API_KEY}`);

const captionFile = await generateCaptions({...});

console.log(`[${jobId}] Caption generation result: ${captionFile ? 'SUCCESS' : 'NULL'}`);
if (captionFile) {
    console.log(`[${jobId}] Caption file exists: ${fs.existsSync(captionFile)}`);
    console.log(`[${jobId}] Caption file size: ${fs.statSync(captionFile).size} bytes`);
}
```

## Expected Behavior After Fix

1. User selects caption style (e.g., "karaoke") in Creation Wizard
2. Preview shows word-by-word highlighting on canvas
3. Export process:
   - Extracts audio from video
   - Transcribes with Whisper (or uses narration fallback)
   - Generates ASS file with selected style
   - FFmpeg burns ASS into video
4. Final exported video has visible captions matching preview style

## Files to Modify

1. `services/video-processor/src/creation-processor.js` - Add diagnostics/fallback
2. `services/video-processor/src/caption-renderer.js` - Add narration-based fallback
3. `services/video-processor/cloudbuild.yaml` - Document required env vars better
4. Possibly `functions/index.js` - Pass scene narrations to processor for fallback

## Testing Checklist

- [ ] Check Cloud Run logs for caption-related errors
- [ ] Verify OPENAI_API_KEY is set in Cloud Run environment
- [ ] Test export with captions enabled
- [ ] Verify ASS file is created in work directory
- [ ] Verify FFmpeg command runs successfully
- [ ] Verify final video contains burned-in captions
