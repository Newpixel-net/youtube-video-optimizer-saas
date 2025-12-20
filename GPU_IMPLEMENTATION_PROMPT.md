# GPU Acceleration Implementation - New Chat Prompt

Copy and paste everything below this line into a new Claude Code chat:

---

## Project Context

I have a YouTube video optimizer SaaS that processes videos into vertical shorts (9:16). The video processor currently runs on **Google Cloud Run** with CPU-only encoding, which takes **2-5 minutes per 45-second clip**.

I want to enable **GPU acceleration using NVIDIA L4 on Cloud Run** to reduce processing time to **15-30 seconds per clip**.

## Current Architecture

- **Frontend**: Firebase hosted (`frontend/video-wizard.html`)
- **Backend**: Firebase Cloud Functions (`functions/index.js`)
- **Video Processor**: Cloud Run service (`services/video-processor/`)
- **Storage**: Firebase Storage / Google Cloud Storage

## Current Video Processor Setup

**Location**: `services/video-processor/`

**Current Dockerfile** (`services/video-processor/Dockerfile`):
- Base image: `node:20-slim`
- FFmpeg installed via apt
- No GPU support

**Current deploy.sh settings**:
```bash
--memory=4Gi
--cpu=2
--timeout=900
--concurrency=1
--min-instances=0
--max-instances=10
```

**Current FFmpeg encoding** (`services/video-processor/src/processor.js`):
```javascript
'-c:v', 'libx264',
'-preset', 'veryfast',
'-crf', '23',
'-threads', '0'
```

## Goal: Enable GPU Acceleration

### 1. Update Dockerfile for GPU Support

Change from `node:20-slim` to NVIDIA CUDA base image:

```dockerfile
FROM nvidia/cuda:12.2.0-runtime-ubuntu22.04

# Install FFmpeg with NVENC support
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs

# ... rest of existing Dockerfile
```

### 2. Update deploy.sh for GPU

Add GPU flags:
```bash
--gpu 1
--gpu-type nvidia-l4
--memory 16Gi
--cpu 4
--no-cpu-throttling
```

### 3. Update processor.js for NVENC

Replace libx264 with h264_nvenc when GPU is available:

```javascript
const useGPU = process.env.GPU_ENABLED === 'true';

const videoCodec = useGPU
  ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23']
  : ['-c:v', 'libx264', '-preset', 'superfast', '-crf', '24'];

const hwaccel = useGPU
  ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']
  : [];
```

### 4. Update cloudbuild.yaml

Ensure the build uses the correct machine type and the new Dockerfile.

## Key Files to Modify

1. `services/video-processor/Dockerfile` - Change base image to CUDA
2. `services/video-processor/deploy.sh` - Add GPU flags
3. `services/video-processor/src/processor.js` - Add NVENC encoding logic
4. `services/video-processor/cloudbuild.yaml` - Update build config if needed

## Important Notes

1. **NVENC Filter Chain**: Some FFmpeg filters need adjustment for GPU:
   - `scale` → `scale_cuda` or `scale_npp`
   - Some filters may need to download from GPU, process, then upload back

2. **Fallback**: Keep CPU encoding as fallback if GPU is unavailable

3. **Environment Variable**: Use `GPU_ENABLED=true` to toggle GPU mode

4. **Testing**: The processor has health endpoints at `/health`

5. **Region**: Must deploy to a region that supports L4 GPUs (us-central1 works)

## Reference Documentation

Full implementation plan is in: `PROCESSING_SPEED_IMPROVEMENT_PLAN.md`

## Task

Please implement GPU acceleration for the video processor:

1. Update the Dockerfile to use NVIDIA CUDA base image with FFmpeg NVENC support
2. Update deploy.sh to include GPU flags
3. Modify processor.js to use h264_nvenc when GPU is available
4. Ensure the filter chain works with GPU acceleration
5. Add fallback to CPU encoding
6. Test the changes work correctly

Start by reading the current files to understand the existing implementation, then make the necessary changes.
