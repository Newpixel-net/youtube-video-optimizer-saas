# Video Creation Wizard Export Implementation Plan

## Overview

Implement server-side video rendering for `video-creation-wizard.html` using the same Cloud Run video processor infrastructure as `video-wizard.html`.

## Current Architecture (video-wizard.html)

```
[Browser Extension] → captures video → [Firebase Storage]
                                            ↓
[Frontend] → calls → [wizardProcessClip Cloud Function]
                                            ↓
[Firestore] ← creates job ← [Cloud Function]
                                            ↓
[Cloud Run video-processor] ← triggered ← [HTTP POST /process]
                                            ↓
[FFmpeg processing] → outputs → [Firebase Storage]
                                            ↓
[Frontend] ← polls status ← [Firestore job document]
                                            ↓
[Download/Preview] ← video URL ← [Storage URL]
```

## New Architecture (video-creation-wizard.html)

```
[Frontend] → uploads images/voiceovers → [Firebase Storage]
                                            ↓
[Frontend] → calls → [creationWizardProcessExport Cloud Function]
                                            ↓
[Firestore] ← creates job ← [Cloud Function]
                                            ↓
[Cloud Run video-processor] ← triggered ← [HTTP POST /creation-export]
                                            ↓
[FFmpeg Ken Burns processing] → outputs → [Firebase Storage]
                                            ↓
[Frontend] ← polls status ← [Firestore job document]
                                            ↓
[Download/Preview] ← video URL ← [Storage URL]
```

## Implementation Steps

### Phase 1: Video Processor Service Updates

**File: `services/video-processor/src/index.js`**

Add new endpoint `/creation-export`:

```javascript
app.post('/creation-export', async (req, res) => {
  const { jobId } = req.body;
  // Similar to /process but calls processCreationExport instead
});
```

**File: `services/video-processor/src/creation-processor.js`** (NEW)

Create new processor for creation wizard exports:

```javascript
export async function processCreationExport({ jobId, jobRef, job, storage, bucketName, tempDir }) {
  // 1. Download all images from storage
  // 2. Download all voiceover audio files
  // 3. Generate FFmpeg command for Ken Burns slideshow
  // 4. Add voiceovers synced to scenes
  // 5. Add background music (if selected)
  // 6. Render final video
  // 7. Upload to storage
  // 8. Return output URL
}
```

### Phase 2: FFmpeg Ken Burns Command

The Ken Burns effect FFmpeg filter:

```bash
ffmpeg -loop 1 -t 8 -i scene1.jpg -loop 1 -t 8 -i scene2.jpg \
  -filter_complex "
    [0:v]scale=8000:-1,zoompan=z='min(zoom+0.0015,1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=240:s=1920x1080[v0];
    [1:v]scale=8000:-1,zoompan=z='1.5':x='iw/2-(iw/zoom/2)+sin(on/120)*100':y='ih/2-(ih/zoom/2)':d=240:s=1920x1080[v1];
    [v0][v1]concat=n=2:v=1:a=0[outv]
  " \
  -map "[outv]" -c:v libx264 -pix_fmt yuv420p output.mp4
```

Key FFmpeg filters:
- `zoompan` - Ken Burns zoom/pan effect
- `fade` - Transitions between scenes
- `concat` - Join multiple scenes
- `amix` - Mix voiceover + background music

### Phase 3: Cloud Function Updates

**File: `functions/index.js`**

Add new Cloud Function:

```javascript
exports.creationWizardProcessExport = functions
  .runWith({ timeoutSeconds: 540, memory: '2GB' })
  .https.onCall(async (data, context) => {
    // 1. Validate user and project
    // 2. Build export manifest (scenes, images, voiceovers, settings)
    // 3. Create job in 'creationExportJobs' collection
    // 4. Trigger video processor service
    // 5. Return jobId for polling
  });
```

### Phase 4: Frontend Updates

**File: `frontend/video-creation-wizard.html`**

Update `startExport()`:

```javascript
async function startExport() {
  // 1. Validate content (images/voiceovers exist)
  // 2. Show progress UI
  // 3. Call creationWizardProcessExport Cloud Function
  // 4. Store jobId and start polling
  // 5. Update progress bar from job status
  // 6. Show download UI when complete
}
```

## Export Job Document Schema

```javascript
{
  id: 'job_id',
  userId: 'user_id',
  projectId: 'project_id',
  type: 'creation_export',
  status: 'queued' | 'processing' | 'completed' | 'failed',
  progress: 0-100,
  currentStage: 'Downloading images...',

  // Input data
  manifest: {
    scenes: [
      {
        id: 'scene_1',
        imageUrl: 'gs://bucket/image.jpg',
        voiceoverUrl: 'gs://bucket/voice.mp3',
        duration: 8,
        kenBurns: { startScale, endScale, startX, startY, endX, endY }
      }
    ],
    music: { url: '...', volume: 0.3 },
    aspectRatio: '16:9' | '9:16' | '1:1'
  },

  // Output settings
  output: {
    quality: '720p' | '1080p',
    format: 'mp4',
    fps: 30
  },

  // Results
  outputUrl: 'https://storage.../video.mp4',
  outputSize: 12345678,
  processingTime: 45000,

  // Timestamps
  createdAt: Timestamp,
  startedAt: Timestamp,
  completedAt: Timestamp
}
```

## Ken Burns FFmpeg Implementation Details

### Per-Scene Processing

```javascript
function generateKenBurnsFilter(scene, index, fps = 30) {
  const frames = scene.duration * fps;
  const kb = scene.kenBurns;

  // Calculate zoom interpolation
  const zoomExpr = `'${kb.startScale}+(${kb.endScale}-${kb.startScale})*on/${frames}'`;

  // Calculate pan interpolation
  const xExpr = `'iw*${kb.startX}+(iw*${kb.endX}-iw*${kb.startX})*on/${frames}'`;
  const yExpr = `'ih*${kb.startY}+(ih*${kb.endY}-ih*${kb.startY})*on/${frames}'`;

  return `[${index}:v]scale=8000:-1,zoompan=z=${zoomExpr}:x=${xExpr}:y=${yExpr}:d=${frames}:s=1920x1080:fps=${fps}[v${index}]`;
}
```

### Audio Mixing

```javascript
// Concatenate voiceovers with proper timing
const audioFilter = scenes.map((s, i) =>
  `[${i}:a]adelay=${s.startTime * 1000}|${s.startTime * 1000}[a${i}]`
).join(';');

// Mix with background music
const mixFilter = `${audioFilter};[a0][a1]...[music]amix=inputs=${scenes.length + 1}:duration=longest[aout]`;
```

## File Changes Summary

| File | Changes |
|------|---------|
| `services/video-processor/src/index.js` | Add `/creation-export` endpoint |
| `services/video-processor/src/creation-processor.js` | NEW - Ken Burns video processor |
| `functions/index.js` | Add `creationWizardProcessExport` function |
| `frontend/video-creation-wizard.html` | Update `startExport()` to use server-side rendering |

## Benefits Over Client-Side Rendering

1. **Quality**: Professional FFmpeg encoding (H.264 MP4) vs browser WebM
2. **Speed**: Server has more resources than browser
3. **Reliability**: No browser tab timeout issues
4. **Format**: MP4 output (universal compatibility) vs WebM
5. **Consistent**: Same output regardless of user's device

## Deployment

### Step 1: Deploy Video Processor to Cloud Run

```bash
cd services/video-processor
gcloud run deploy video-processor --source . --region us-central1 --allow-unauthenticated --memory 2Gi --timeout 600
```

Note the URL from the deployment output (e.g., `https://video-processor-xxxxx.run.app`)

### Step 2: Configure Cloud Functions with Processor URL

```bash
firebase functions:config:set videoprocessor.url="https://video-processor-xxxxx.run.app"
```

### Step 3: Deploy Cloud Functions

```bash
firebase deploy --only functions
```

### Step 4: Test End-to-End

1. Open video-creation-wizard.html
2. Create a project with images and voiceovers
3. Go to Export step and click Export
4. Verify progress updates appear
5. Verify MP4 video downloads correctly

## Implementation Status

✅ **Phase 1**: Video Processor Service (`services/video-processor/src/creation-processor.js`)
✅ **Phase 2**: Cloud Function (`creationWizardStartExport` in `functions/index.js`)
✅ **Phase 3**: Frontend (`startExport()` in `frontend/video-creation-wizard.html`)
✅ **Phase 4**: Ready for deployment
