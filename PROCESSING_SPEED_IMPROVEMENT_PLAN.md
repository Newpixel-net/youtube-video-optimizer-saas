# Video Processing Speed Improvement Plan

## Executive Summary

This document outlines a comprehensive strategy to improve video processing speed from the current **2-5 minutes per clip** down to **30-60 seconds per clip**. The plan is organized by implementation complexity and cost impact.

---

## Current State Analysis

### Infrastructure
| Component | Current Setting | Issue |
|-----------|-----------------|-------|
| Cloud Run Memory | 4GB | Adequate but could be higher |
| Cloud Run CPU | 2 cores | Bottleneck for FFmpeg |
| Concurrency | 1 | Sequential only |
| Min Instances | 0 | Cold start delays (15-30s) |
| Timeout | 900s (15 min) | Sufficient |

### FFmpeg Settings
| Setting | Current | Impact |
|---------|---------|--------|
| Preset | `veryfast` | Good balance |
| CRF | 23 | Quality vs speed tradeoff |
| Threads | Auto (2) | Limited by CPU cores |
| Hardware Accel | None | Major opportunity |

### Typical Processing Breakdown (45-second clip)
```
Video Download:         15-45 seconds (highly variable)
Segment Extraction:     5-10 seconds
FFmpeg Processing:      60-180 seconds (main bottleneck)
Caption Generation:     10-30 seconds (if enabled)
Output Upload:          10-20 seconds
─────────────────────────────────────────────
Total:                  100-285 seconds (1.5-5 minutes)
```

---

## Phase 1: Quick Wins (No/Low Cost)

### 1.1 FFmpeg Preset Optimization
**Impact: 20-30% faster encoding**
**Cost: Free**

```javascript
// Current
'-preset', 'veryfast', '-crf', '23'

// Recommended for speed (slight quality tradeoff)
'-preset', 'ultrafast', '-crf', '26'

// Or balanced approach
'-preset', 'superfast', '-crf', '24'
```

**Encoding Speed Comparison:**
| Preset | Speed | Quality | File Size |
|--------|-------|---------|-----------|
| ultrafast | 5x faster | Lower | Larger |
| superfast | 3x faster | Good | Moderate |
| veryfast | 2x faster | Better | Moderate |
| medium | 1x (baseline) | Best | Smallest |

### 1.2 Enable Warm Instances
**Impact: Eliminate 15-30s cold starts**
**Cost: ~$15-30/month**

```yaml
# deploy.sh - change min-instances
--min-instances=1  # Always keep 1 instance warm
```

### 1.3 Parallel Multi-Clip Processing
**Impact: N clips processed simultaneously**
**Cost: Free (uses existing infrastructure)**

Current flow: Sequential (clip 1 → clip 2 → clip 3)
Proposed: Parallel (all clips start simultaneously)

```javascript
// Frontend: Export all clips in parallel
async function exportAllClips(clipIds) {
  const promises = clipIds.map(id => exportClip(id));
  return Promise.all(promises);
}
```

### 1.4 Simplified Filter Chains
**Impact: 10-20% faster for effects**
**Cost: Free**

Reduce filter complexity for common operations:
- Combine multiple scale operations
- Pre-compute crop values
- Use simpler caption styling

---

## Phase 2: Infrastructure Upgrades (Moderate Cost)

### 2.1 Increase Cloud Run Resources
**Impact: 40-60% faster processing**
**Cost: ~$0.20-0.40/hour when processing**

```yaml
# deploy.sh - upgrade resources
--memory=8Gi          # Double memory
--cpu=4               # Double CPU cores
--concurrency=2       # Process 2 jobs per instance
```

**Estimated Processing Time:**
- Current (2 CPU, 4GB): 2-5 minutes
- Upgraded (4 CPU, 8GB): 1-2 minutes

### 2.2 Enable Max Instances Scaling
**Impact: Handle burst processing**
**Cost: Usage-based (only when scaling)**

```yaml
--max-instances=20    # Allow more parallel processing
--min-instances=1     # Keep 1 warm
```

### 2.3 Regional Optimization
**Impact: Reduce download/upload latency**
**Cost: Free**

Deploy to region closest to:
1. Your video source (YouTube CDN)
2. Your users
3. Your storage bucket

---

## Phase 3: Hardware Acceleration ($0.35-0.60/hour)

### Option A: Google Cloud GPU (Recommended - Native Integration)

Since you're already on GCP, this is the **most seamless option** with no additional vendor accounts needed.

#### A1. Cloud Run with GPU (NEW - GA 2024)
**Cost: ~$0.35-0.50/hour for L4 GPU**
**Impact: 5-10x faster, same deployment model**

Cloud Run now supports NVIDIA L4 GPUs - you can keep your existing architecture!

```yaml
# deploy.sh - Add GPU support
gcloud run deploy video-processor \
  --image gcr.io/$PROJECT_ID/video-processor:latest \
  --region us-central1 \
  --memory 16Gi \
  --cpu 4 \
  --gpu 1 \
  --gpu-type nvidia-l4 \
  --no-cpu-throttling \
  --timeout 900 \
  --min-instances 0 \
  --max-instances 5
```

**Requirements:**
- Update Dockerfile to include NVIDIA drivers and CUDA
- Use `nvidia/cuda` base image
- Install FFmpeg with NVENC support

```dockerfile
# Dockerfile for GPU-enabled Cloud Run
FROM nvidia/cuda:12.2.0-runtime-ubuntu22.04

# Install FFmpeg with NVENC support
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

CMD ["node", "src/index.js"]
```

**FFmpeg with NVENC (GPU encoding):**
```javascript
// processor.js - GPU-accelerated encoding
const ffmpegArgs = [
  '-hwaccel', 'cuda',           // Use CUDA for decoding
  '-hwaccel_output_format', 'cuda',
  '-i', inputFile,
  '-vf', `scale_cuda=${width}:${height}`,  // GPU scaling
  '-c:v', 'h264_nvenc',         // NVIDIA GPU encoder
  '-preset', 'p4',              // NVENC preset (p1=fastest, p7=best quality)
  '-rc', 'vbr',                 // Variable bitrate
  '-cq', '23',                  // Constant quality
  '-c:a', 'aac',
  '-b:a', '128k',
  '-movflags', '+faststart',
  outputFile
];
```

**GCP GPU Pricing (us-central1):**
| GPU | Cost/hour | VRAM | Best For |
|-----|-----------|------|----------|
| NVIDIA L4 | $0.35 | 24GB | Cloud Run (recommended) |
| NVIDIA T4 | $0.35 | 16GB | Compute Engine |
| NVIDIA A100 | $2.93 | 40GB | Batch processing |

#### A2. Compute Engine with GPU
**Cost: ~$0.40-0.60/hour (VM + GPU)**
**Impact: Full control, persistent instance**

For dedicated processing with more control:

```bash
# Create GPU-enabled VM
gcloud compute instances create video-processor-gpu \
  --machine-type n1-standard-4 \
  --accelerator type=nvidia-tesla-t4,count=1 \
  --image-family ubuntu-2204-lts \
  --image-project ubuntu-os-cloud \
  --boot-disk-size 100GB \
  --zone us-central1-a \
  --maintenance-policy TERMINATE \
  --metadata startup-script='#!/bin/bash
    # Install NVIDIA drivers
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    sudo apt-get update && sudo apt-get install -y nvidia-driver-535
    # Install FFmpeg with NVENC
    sudo apt-get install -y ffmpeg
  '
```

#### A3. Cloud Batch with GPU
**Cost: Pay only when jobs run**
**Impact: Best for batch processing multiple clips**

```javascript
// Submit batch job to Cloud Batch
const batchJob = {
  taskGroups: [{
    taskSpec: {
      runnables: [{
        container: {
          imageUri: 'gcr.io/PROJECT/video-processor-gpu:latest',
          commands: ['node', 'process.js'],
          volumes: ['/mnt/disks/work:/work']
        }
      }],
      computeResource: {
        cpuMilli: 4000,
        memoryMib: 16384
      },
      maxRunDuration: '900s'
    },
    taskCount: clipCount,
    parallelism: 5  // Process 5 clips simultaneously
  }],
  allocationPolicy: {
    instances: [{
      policy: {
        machineType: 'n1-standard-4',
        accelerators: [{
          type: 'nvidia-tesla-t4',
          count: 1
        }]
      }
    }]
  }
};
```

---

### Option B: Modal.com
**Cost: ~$0.45-0.60/hour for GPU instances**
**Impact: 5-10x faster encoding with GPU**

Modal.com offers:
- Serverless GPU compute
- Pay-per-second billing
- No cold starts with keep_warm
- NVIDIA T4/A10G GPUs
- Built-in FFmpeg with NVENC support

```python
# modal_processor.py
import modal

stub = modal.Stub("video-processor")

@stub.function(
    gpu="T4",  # $0.45/hour
    memory=8192,
    timeout=600,
    keep_warm=1
)
def process_video(job_data):
    # FFmpeg with NVENC (GPU encoding)
    cmd = [
        'ffmpeg', '-hwaccel', 'cuda',
        '-i', input_file,
        '-c:v', 'h264_nvenc',  # GPU encoder
        '-preset', 'p4',       # NVENC preset (p1-p7)
        '-rc', 'vbr',
        '-cq', '23',
        '-c:a', 'aac',
        output_file
    ]
```

**GPU Encoding Speed:**
| Method | 45s clip @ 1080p |
|--------|------------------|
| CPU (2 core) | 120-180 seconds |
| CPU (4 core) | 60-90 seconds |
| GPU (T4) | 15-30 seconds |
| GPU (A10G) | 10-20 seconds |

### Option B: RunPod (Already in your stack)
**Cost: ~$0.20-0.50/hour depending on GPU**
**Impact: Similar to Modal**

You're already using RunPod for image generation. Can extend to video:

```javascript
// RunPod API call for video processing
const response = await fetch('https://api.runpod.ai/v2/video-processor/run', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${RUNPOD_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    input: {
      video_url: videoUrl,
      start_time: startTime,
      end_time: endTime,
      crop_position: cropPosition,
      // ... other settings
    }
  })
});
```

**RunPod GPU Pricing:**
| GPU | Cost/hour | VRAM | Best For |
|-----|-----------|------|----------|
| RTX 3070 | $0.20 | 8GB | Short clips |
| RTX 3090 | $0.40 | 24GB | Long videos |
| A10G | $0.50 | 24GB | Production |

### Option C: Render.com
**Cost: ~$0.50/hour for Standard instance**
**Impact: 2-3x faster with better CPU**

Simple deployment, but CPU-only (no GPU):
- Persistent compute (no cold starts)
- Easy scaling
- Integrated CI/CD

### Option D: Dedicated GPU VM (GCP/AWS)
**Cost: ~$0.30-0.80/hour**
**Impact: Full control, fastest possible**

For highest throughput, run a dedicated GPU VM:

```bash
# GCP N1 + T4 GPU
gcloud compute instances create video-processor \
  --machine-type=n1-standard-4 \
  --accelerator=type=nvidia-tesla-t4,count=1 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --zone=us-central1-a
```

---

## Phase 4: Architecture Improvements

### 4.1 Pre-processing Pipeline
**Impact: Reduce per-clip time by 50%**

Instead of downloading video for each clip:
1. Download full video once during analysis
2. Store in Cloud Storage (already implemented as cache)
3. Process all clips from cached source

```
Current: Download → Process Clip 1 → Download → Process Clip 2
Better:  Download → Cache → Process All Clips from Cache
```

### 4.2 Queue-Based Processing with Workers
**Impact: Unlimited parallelism**

Replace synchronous processing with job queue:

```
Frontend → Cloud Function → Pub/Sub Queue → Worker Pool
                                              ↓
                              Worker 1: Clip 1 processing
                              Worker 2: Clip 2 processing
                              Worker 3: Clip 3 processing
```

### 4.3 Progressive Delivery
**Impact: Better UX, not faster processing**

Stream partial results as they complete:
- Generate thumbnail immediately
- Show preview after crop (before encoding)
- Deliver encoded video last

---

## Recommended Implementation Path

### Week 1: Quick Wins (Free)
1. [ ] Change FFmpeg preset to `superfast` with CRF 24
2. [ ] Enable `--min-instances=1` for warm starts
3. [ ] Implement parallel export for multiple clips
4. [ ] Add processing time logging for benchmarking

### Week 2: Infrastructure Upgrade (~$50/month)
1. [ ] Upgrade to 4 CPU, 8GB memory
2. [ ] Increase max-instances to 20
3. [ ] Enable concurrency=2 per instance
4. [ ] Monitor and optimize

### Week 3-4: GPU Integration (~$0.35/hour when processing)
1. [ ] Update Dockerfile to use `nvidia/cuda` base image
2. [ ] Install FFmpeg with NVENC support
3. [ ] Deploy Cloud Run with `--gpu 1 --gpu-type nvidia-l4`
4. [ ] Update processor.js to use NVENC encoding
5. [ ] A/B test processing times

### Ongoing: Optimization
1. [ ] Monitor processing times per clip
2. [ ] Identify bottlenecks in specific filter chains
3. [ ] Optimize caption generation (cache Whisper models)
4. [ ] Consider Cloud Batch for bulk exports

---

## Cost Comparison

| Configuration | Processing Time (45s clip) | Monthly Cost* |
|--------------|---------------------------|---------------|
| Current (2 CPU, 4GB, cold) | 2-5 min | ~$10 |
| Warm Instance (2 CPU, 4GB) | 1.5-4 min | ~$40 |
| Upgraded (4 CPU, 8GB) | 1-2 min | ~$60 |
| **GCP Cloud Run + L4 GPU** | **15-30 sec** | **~$25-75** |
| GCP Compute Engine + T4 | 15-30 sec | ~$50-150 |
| Modal.com / RunPod | 20-40 sec | ~$30-100 |
| GCP Cloud Batch + GPU | 15-30 sec | ~$20-60** |

*Assuming 500 clips/month
**Best for batch processing, pay only when running

---

## Quick Reference: GCP Cloud Run with GPU (Recommended)

### Deploy Command
```bash
gcloud run deploy video-processor \
  --image gcr.io/$PROJECT_ID/video-processor-gpu:latest \
  --region us-central1 \
  --memory 16Gi \
  --cpu 4 \
  --gpu 1 \
  --gpu-type nvidia-l4 \
  --no-cpu-throttling \
  --timeout 900 \
  --min-instances 0 \
  --max-instances 5 \
  --allow-unauthenticated
```

### Dockerfile Changes
```dockerfile
# Change FROM line
FROM nvidia/cuda:12.2.0-runtime-ubuntu22.04

# Add NVENC-capable FFmpeg
RUN apt-get update && apt-get install -y ffmpeg
```

### processor.js Changes
```javascript
// Replace libx264 with h264_nvenc
const useGPU = process.env.GPU_ENABLED === 'true';

const videoCodec = useGPU
  ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23']
  : ['-c:v', 'libx264', '-preset', 'superfast', '-crf', '24'];

const hwaccel = useGPU
  ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']
  : [];

const ffmpegArgs = [
  ...hwaccel,
  '-i', inputFile,
  '-vf', filterChain,
  ...videoCodec,
  '-c:a', 'aac', '-b:a', '128k',
  '-movflags', '+faststart',
  outputFile
];
```

---

## Alternative: Modal.com Integration

### Setup
```bash
pip install modal
modal token new
```

### Basic Implementation
```python
# video_processor.py
import modal
import subprocess

stub = modal.Stub("video-processor")

# Define container with FFmpeg + CUDA
image = modal.Image.debian_slim().apt_install(
    "ffmpeg"
).pip_install("google-cloud-storage")

@stub.function(
    image=image,
    gpu="T4",
    memory=8192,
    timeout=600,
    keep_warm=1,  # Always warm - no cold starts
)
def process_clip(video_url, settings):
    # Download video
    subprocess.run(['wget', '-O', 'input.mp4', video_url])

    # Process with GPU acceleration
    cmd = [
        'ffmpeg', '-hwaccel', 'cuda',
        '-i', 'input.mp4',
        '-vf', build_filter_chain(settings),
        '-c:v', 'h264_nvenc',
        '-preset', 'p4',
        '-cq', '23',
        '-c:a', 'aac', '-b:a', '128k',
        'output.mp4'
    ]
    subprocess.run(cmd)

    # Upload to GCS
    upload_to_storage('output.mp4', settings['output_path'])
    return {'status': 'complete'}
```

### Calling from Cloud Function
```javascript
// functions/index.js
const modalEndpoint = 'https://your-modal-app.modal.run/process_clip';

async function processWithGPU(jobData) {
  const response = await fetch(modalEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(jobData)
  });
  return response.json();
}
```

---

## Conclusion

The fastest path to improved processing is:

1. **Immediate** (today): Change FFmpeg preset to `superfast` - 20-30% faster
2. **This week**: Enable warm instances - eliminate cold starts
3. **Next week**: Upgrade Cloud Run to 4 CPU, 8GB - 50% faster
4. **Next month**: Enable GPU on Cloud Run (L4) - 5-10x faster

### Recommended: GCP Cloud Run with L4 GPU

Since you're already on Google Cloud, **Cloud Run with GPU** is the most seamless option:

- **No new vendor accounts** - uses your existing GCP project
- **Same deployment model** - just add `--gpu 1 --gpu-type nvidia-l4`
- **Cost: ~$0.35/hour** when processing (cheaper than Modal/RunPod)
- **Speed: 15-30 seconds** per clip (vs 2-5 minutes currently)
- **Scales to zero** - no cost when not processing

This provides the best ROI for your processing workload, with potential to process clips **10x faster** at a lower cost than third-party GPU services.
