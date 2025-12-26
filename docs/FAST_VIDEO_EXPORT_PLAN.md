# Fast Video Export Implementation Plan

## Executive Summary

**Current State:** 15 scenes × 8 seconds = 2+ hours processing time
**Target State:** 15 scenes × 8 seconds = 5-10 minutes processing time
**Expected Improvement:** 10-20x faster

---

## Option 1: Parallel Scene Processing

### Concept
Instead of processing scenes sequentially (Scene 1 → Scene 2 → ... → Scene 15), we process ALL scenes simultaneously using multiple Cloud Run instances.

```
CURRENT (Sequential):
Scene 1 [====] → Scene 2 [====] → ... → Scene 15 [====]
Total: 15 × 3 min = 45 min

PROPOSED (Parallel):
Scene 1  [====]
Scene 2  [====]
Scene 3  [====]
...
Scene 15 [====]
Total: 3 min + 30 sec concat = ~4 min
```

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    MAIN CREATION EXPORT JOB                      │
│                                                                  │
│  1. Download all images & voiceovers                            │
│  2. Upload images to temp storage (for workers to access)       │
│  3. Spawn N parallel scene workers                              │
│  4. Wait for all workers to complete                            │
│  5. Download scene videos from workers                          │
│  6. Concatenate + Add audio                                     │
│  7. Upload final video                                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ Scene Worker 1│   │ Scene Worker 2│   │ Scene Worker N│
│               │   │               │   │               │
│ - Download img│   │ - Download img│   │ - Download img│
│ - Ken Burns   │   │ - Ken Burns   │   │ - Ken Burns   │
│ - Upload video│   │ - Upload video│   │ - Upload video│
└───────────────┘   └───────────────┘   └───────────────┘
```

### Implementation Steps

#### Step 1.1: Create Scene Worker Endpoint
Add new endpoint `/process-scene` to video-processor:

```javascript
// POST /process-scene
{
  "sceneIndex": 0,
  "imageUrl": "https://storage.../scene_0.jpg",
  "duration": 8,
  "kenBurns": { startScale: 1.0, endScale: 1.2, ... },
  "output": { width: 1920, height: 1080, fps: 30 },
  "jobId": "parent-job-id",
  "outputBucket": "temp-scenes"
}

// Response
{
  "success": true,
  "sceneVideoUrl": "https://storage.../scene_0.mp4",
  "duration": 8.0,
  "processingTime": 45000 // ms
}
```

#### Step 1.2: Modify Main Export to Use Parallel Processing

```javascript
async function generateKenBurnsVideoParallel({ jobId, jobRef, scenes, imageFiles, workDir, output }) {
  // Upload images to accessible URLs
  const imageUrls = await uploadImagesToTempStorage(imageFiles);

  // Create all scene processing promises
  const scenePromises = scenes.map((scene, index) =>
    processSceneRemote({
      sceneIndex: index,
      imageUrl: imageUrls[index],
      duration: scene.duration || 8,
      kenBurns: scene.kenBurns,
      output,
      jobId
    })
  );

  // Process ALL scenes in parallel
  await updateProgress(jobRef, 30, 'Processing all scenes in parallel...');
  const sceneResults = await Promise.all(scenePromises);

  // Download scene videos
  await updateProgress(jobRef, 55, 'Downloading rendered scenes...');
  const sceneVideos = await downloadSceneVideos(sceneResults, workDir);

  // Concatenate
  await updateProgress(jobRef, 60, 'Assembling your video...');
  return await concatenateScenes(sceneVideos, workDir, output);
}
```

#### Step 1.3: Cloud Run Configuration

```yaml
# Increase max instances to handle parallel requests
max_instances: 100
min_instances: 0
concurrency: 1  # Each instance handles 1 scene at a time
cpu: 4
memory: 16Gi
timeout: 600s  # 10 min per scene max
```

### Estimated Performance

| Metric | Current | With Parallel |
|--------|---------|---------------|
| 15 scenes | 45-120 min | 4-8 min |
| Cost per export | $0.50-2.00 | $0.20-0.50 |
| Cloud Run instances | 1 | 15 (burst) |

---

## Option 2: Optimized Ken Burns Effect

### Concept
The current `zoompan` filter is slow because it calculates zoom/pan for EVERY frame. Instead, we can:

1. **Pre-scale images** to different zoom levels
2. **Use crossfade** between scaled images (GPU-friendly)
3. **Simpler motion** that's faster to compute

### Approach A: Pre-Scaled Image Crossfade

```
Instead of:
  Image → [zoompan filter: compute 240 frames] → Video

Do this:
  Image_100% ─┐
  Image_110% ─┼→ [xfade/crossfade] → Video (fast!)
  Image_120% ─┘
```

```javascript
async function generateKenBurnsOptimized({ imageFile, duration, startScale, endScale, output }) {
  const { width, height } = output;
  const fps = output.fps || 30;

  // Step 1: Pre-generate scaled versions of the image
  const scales = [startScale, (startScale + endScale) / 2, endScale];
  const scaledImages = [];

  for (const scale of scales) {
    const scaledPath = `${imageFile}_scale_${scale}.jpg`;
    const scaledWidth = Math.round(width * scale);
    const scaledHeight = Math.round(height * scale);

    // Use ImageMagick or sharp (much faster than FFmpeg for single images)
    await sharp(imageFile)
      .resize(scaledWidth, scaledHeight, { fit: 'cover' })
      .extract({
        left: (scaledWidth - width) / 2,
        top: (scaledHeight - height) / 2,
        width,
        height
      })
      .toFile(scaledPath);

    scaledImages.push(scaledPath);
  }

  // Step 2: Create video with crossfade between scaled images
  // This is MUCH faster because no per-frame calculations
  const segmentDuration = duration / (scales.length - 1);

  // FFmpeg crossfade (hardware accelerated on many systems)
  const args = [
    '-loop', '1', '-t', segmentDuration, '-i', scaledImages[0],
    '-loop', '1', '-t', segmentDuration, '-i', scaledImages[1],
    '-loop', '1', '-t', segmentDuration, '-i', scaledImages[2],
    '-filter_complex',
    `[0:v][1:v]xfade=transition=fade:duration=${segmentDuration}:offset=0[v01];` +
    `[v01][2:v]xfade=transition=fade:duration=${segmentDuration}:offset=${segmentDuration}[vout]`,
    '-map', '[vout]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-y', outputFile
  ];
}
```

### Approach B: Simplified Zoompan (Less Quality, Much Faster)

```javascript
// Current (slow): Scale to 2x, then zoompan
const filterComplex = `scale=2*${width}:-1,zoompan=z='${zoomExpr}':...`;

// Optimized (faster): Skip the 2x upscale, use native resolution
const filterComplex = `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${frames}:s=${width}x${height}:fps=${fps}`;

// Even faster: Lower FPS during zoom, interpolate later
const filterComplex = `zoompan=z='${zoomExpr}':...:fps=15,minterpolate=fps=${fps}`;
```

### Approach C: CSS-Style Transform (Fastest, Best Quality)

Use a headless browser to render frames with hardware-accelerated CSS:

```javascript
// Use Puppeteer to render frames
async function renderKenBurnsWithPuppeteer({ imageUrl, duration, startScale, endScale, output }) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  await page.setViewport({ width: output.width, height: output.height });

  // CSS animation is hardware-accelerated
  await page.setContent(`
    <style>
      @keyframes kenburns {
        from { transform: scale(${startScale}); }
        to { transform: scale(${endScale}); }
      }
      img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        animation: kenburns ${duration}s linear forwards;
      }
    </style>
    <img src="${imageUrl}" />
  `);

  // Capture frames (GPU-accelerated)
  const frames = [];
  const frameCount = duration * output.fps;
  for (let i = 0; i < frameCount; i++) {
    await page.evaluate(t => {
      document.querySelector('img').style.animationDelay = `-${t}s`;
    }, i / output.fps);
    frames.push(await page.screenshot({ type: 'jpeg', quality: 95 }));
  }

  // Encode frames with FFmpeg (fast, just encoding)
  // ...
}
```

### Performance Comparison

| Method | Time per 8s Scene | Quality | GPU Benefit |
|--------|-------------------|---------|-------------|
| Current zoompan (2x scale) | 3-5 min | Excellent | None |
| Zoompan (no upscale) | 1-2 min | Good | None |
| Pre-scaled crossfade | 10-20 sec | Good | Some |
| CSS/Puppeteer render | 15-30 sec | Excellent | Full |

---

## Combined Implementation Plan

### Phase 1: Quick Wins (Implement First)

#### 1.1 Remove 2x Upscale (5 min change)
```javascript
// Change this:
const filterComplex = `scale=2*${width}:-1,zoompan=...`;

// To this:
const filterComplex = `scale=${width * 1.3}:-1,zoompan=...`;
```
**Expected improvement: 30-50% faster**

#### 1.2 Use Faster Preset (5 min change)
```javascript
// Change this:
'-preset', 'fast',

// To this:
'-preset', 'ultrafast',
```
**Expected improvement: 20-30% faster**

#### 1.3 Lower Intermediate FPS (5 min change)
```javascript
// Render at 24fps instead of 30fps (20% fewer frames)
const fps = 24;
```
**Expected improvement: 20% faster**

### Phase 2: Parallel Processing (1-2 hours)

#### 2.1 Create /process-scene endpoint
#### 2.2 Modify main export to spawn parallel workers
#### 2.3 Add temp storage for intermediate files
#### 2.4 Implement progress tracking across workers

**Expected improvement: 10-15x faster (linear with scene count)**

### Phase 3: Optimized Ken Burns (2-3 hours)

#### 3.1 Implement pre-scaled image approach
#### 3.2 Use sharp for fast image scaling
#### 3.3 Use xfade for smooth transitions
#### 3.4 Optional: Puppeteer-based rendering for best quality

**Expected improvement: 5-10x faster per scene**

---

## Final Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                     CREATION EXPORT REQUEST                         │
└────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR (Main Job)                          │
│  1. Validate request                                                │
│  2. Download & prep images                                          │
│  3. Dispatch parallel scene workers                    [5%→25%]     │
└────────────────────────────────────────────────────────────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  SCENE WORKER 1  │ │  SCENE WORKER 2  │ │  SCENE WORKER N  │
│                  │ │                  │ │                  │
│ Pre-scale image  │ │ Pre-scale image  │ │ Pre-scale image  │
│ Apply Ken Burns  │ │ Apply Ken Burns  │ │ Apply Ken Burns  │
│ (optimized)      │ │ (optimized)      │ │ (optimized)      │
│ Upload result    │ │ Upload result    │ │ Upload result    │
│                  │ │                  │ │                  │
│ ~30 seconds      │ │ ~30 seconds      │ │ ~30 seconds      │
└──────────────────┘ └──────────────────┘ └──────────────────┘
            │                   │                   │
            └───────────────────┼───────────────────┘
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR (Finalize)                          │
│  4. Collect scene videos                               [25%→50%]    │
│  5. Concatenate scenes (fast, stream copy)             [50%→60%]    │
│  6. GPU re-encode (NVENC)                              [60%→65%]    │
│  7. Add voiceovers + music                             [65%→85%]    │
│  8. Upload final video                                 [85%→100%]   │
└────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                         FINAL VIDEO                                 │
│                    Total time: 5-10 minutes                         │
└────────────────────────────────────────────────────────────────────┘
```

---

## Cost Analysis

### Current (Sequential Processing)
- 1 Cloud Run instance × 60 min = $0.60-1.20
- Total: ~$1.00 per export

### Proposed (Parallel Processing)
- 15 Cloud Run instances × 2 min = $0.30-0.50
- 1 orchestrator × 5 min = $0.05-0.10
- Total: ~$0.40 per export

**Result: 60% cost reduction + 10x speed improvement**

---

## Implementation Checklist

### Phase 1: Quick Wins (Today)
- [ ] Reduce image upscale from 2x to 1.3x
- [ ] Change preset from 'fast' to 'ultrafast'
- [ ] Test and measure improvement

### Phase 2: Parallel Processing (Tomorrow)
- [ ] Create `/process-scene` endpoint in video-processor
- [ ] Create temp storage bucket for scene videos
- [ ] Modify `generateKenBurnsVideo` to dispatch parallel jobs
- [ ] Implement progress aggregation across workers
- [ ] Add timeout and retry logic
- [ ] Test with 15 scenes

### Phase 3: Optimized Ken Burns (Day 3)
- [ ] Install sharp library for fast image scaling
- [ ] Implement pre-scaled image generation
- [ ] Replace zoompan with xfade crossfade
- [ ] Test quality vs speed tradeoff
- [ ] Optional: Implement Puppeteer-based rendering

### Phase 4: Production Hardening (Day 4)
- [ ] Add comprehensive error handling
- [ ] Implement job cleanup on failure
- [ ] Add monitoring and alerting
- [ ] Load test with concurrent exports
- [ ] Document the new architecture

---

## Future Enhancements (If Needed)

### Option 3: Remotion Lambda
- React-based video rendering
- Automatic parallelization
- Pay per render (~$0.01-0.05 per video)
- Best for complex animations

### Option 4: RunPod GPU (H100/A100)
- For maximum processing speed
- 10-50x faster than CPU
- Cost: ~$2-4/hour
- Best for high-volume production

---

## Questions Before Implementation

1. **Quality vs Speed tradeoff**: Is "Good" quality acceptable, or must we maintain "Excellent"?
2. **Cost tolerance**: Is $0.40/export acceptable?
3. **Concurrency**: How many exports might run simultaneously?
4. **Error handling**: What should happen if 1 scene fails? Skip it? Retry? Fail all?
