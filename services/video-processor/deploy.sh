#!/bin/bash

# Video Processor Service Deployment Script with GPU Support
# Usage: ./deploy.sh [project-id] [region] [--gpu|--cpu] [--parallel]
#
# GPU Mode (default):
#   Uses NVIDIA L4 GPU for 10-20x faster encoding via NVENC
#   Higher cost but much faster processing (15-30 sec vs 2-5 min per clip)
#
# CPU Mode:
#   Standard CPU-based encoding with libx264
#   Lower cost but slower processing
#
# Parallel Mode (--parallel):
#   Enables parallel scene processing for Ken Burns video creation
#   Each scene is processed by a separate Cloud Run instance
#   15 scenes in ~3-5 min vs 45+ min sequential
#
# Environment variables:
#   VIDEO_DOWNLOAD_API_KEY - API key for reliable YouTube downloads
#   RAPIDAPI_KEY - RapidAPI key for premium downloads (optional)
#
# Examples:
#   ./deploy.sh my-project us-central1                    # GPU mode (default)
#   ./deploy.sh my-project us-central1 --gpu              # GPU mode (explicit)
#   ./deploy.sh my-project us-central1 --cpu              # CPU mode (fallback)
#   ./deploy.sh my-project us-central1 --gpu --parallel   # GPU + parallel scenes

set -e

PROJECT_ID="${1:-ytseo-6d1b0}"
REGION="${2:-us-central1}"
SERVICE_NAME="video-processor"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
RAPIDAPI_KEY="${RAPIDAPI_KEY:-}"
VIDEO_DOWNLOAD_API_KEY="${VIDEO_DOWNLOAD_API_KEY:-}"

# Parse additional arguments
GPU_ENABLED=true  # Default to GPU mode
PARALLEL_ENABLED=false

for arg in "${@:3}"; do
    case $arg in
        --gpu|-g)
            GPU_ENABLED=true
            ;;
        --cpu|-c)
            GPU_ENABLED=false
            ;;
        --parallel|-p)
            PARALLEL_ENABLED=true
            ;;
    esac
done

echo "============================================"
echo "Video Processor Service Deployment"
echo "============================================"
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service: ${SERVICE_NAME}"
echo ""

# Show GPU mode
if [ "$GPU_ENABLED" = true ]; then
    echo "🚀 GPU Mode: NVIDIA L4 with NVENC encoding"
    echo "   - Expected processing time: 15-30 seconds per clip"
    echo "   - Memory: 16Gi, CPU: 4, GPU: 1x nvidia-l4"
else
    echo "💻 CPU Mode: Standard libx264 encoding"
    echo "   - Expected processing time: 2-5 minutes per clip"
    echo "   - Memory: 4Gi, CPU: 2"
fi

# Show parallel mode
if [ "$PARALLEL_ENABLED" = true ]; then
    echo ""
    echo "⚡ Parallel Scene Processing: ENABLED"
    echo "   - Each scene processed by separate instance"
    echo "   - 15 scenes in ~3-5 min vs 45+ min sequential"
fi
echo ""

if [ -n "$VIDEO_DOWNLOAD_API_KEY" ]; then
    echo "Video Download API Key: Configured"
else
    echo "Video Download API Key: NOT SET (downloads may fail due to YouTube bot detection)"
fi

if [ -n "$RAPIDAPI_KEY" ]; then
    echo "RapidAPI Key: Configured (${RAPIDAPI_KEY:0:8}...)"
else
    echo "RapidAPI Key: NOT SET (using fallback methods)"
fi
echo "============================================"

# Check if gcloud is configured
if [ -z "$PROJECT_ID" ]; then
    echo "Error: No project ID specified and none configured in gcloud"
    echo "Usage: ./deploy.sh <project-id> [region] [--gpu|--cpu]"
    exit 1
fi

# Enable required APIs
echo ""
echo "Enabling required APIs..."
gcloud services enable \
    cloudbuild.googleapis.com \
    run.googleapis.com \
    containerregistry.googleapis.com \
    --project="${PROJECT_ID}"

# Build the Docker image
echo ""
echo "Building Docker image..."
docker build -t "${IMAGE_NAME}:latest" .

# Push to Container Registry
echo ""
echo "Pushing to Container Registry..."
docker push "${IMAGE_NAME}:latest"

# Build environment variables string
# IMPORTANT: Firebase Storage uses .firebasestorage.app (not .appspot.com)
ENV_VARS="BUCKET_NAME=${PROJECT_ID}.firebasestorage.app,NODE_ENV=production"

# Add GPU_ENABLED flag
if [ "$GPU_ENABLED" = true ]; then
    ENV_VARS="${ENV_VARS},GPU_ENABLED=true"
else
    ENV_VARS="${ENV_VARS},GPU_ENABLED=false"
fi

# Add parallel processing flags
if [ "$PARALLEL_ENABLED" = true ]; then
    ENV_VARS="${ENV_VARS},PARALLEL_SCENES=true"
    # VIDEO_PROCESSOR_URL will be set after deployment (see below)
fi

# Add video download API key if provided
if [ -n "$VIDEO_DOWNLOAD_API_KEY" ]; then
    ENV_VARS="${ENV_VARS},VIDEO_DOWNLOAD_API_KEY=${VIDEO_DOWNLOAD_API_KEY}"
fi

if [ -n "$RAPIDAPI_KEY" ]; then
    ENV_VARS="${ENV_VARS},RAPIDAPI_KEY=${RAPIDAPI_KEY}"
fi

# Deploy to Cloud Run with appropriate configuration
echo ""
echo "Deploying to Cloud Run..."

if [ "$GPU_ENABLED" = true ]; then
    # GPU-enabled deployment with NVIDIA L4
    # - 16GB RAM for GPU video processing
    # - 4 CPUs to feed the GPU
    # - 1x NVIDIA L4 GPU for NVENC encoding
    # - max-instances=10 (matches GPU quota)
    # - concurrency=1 (one job per instance for GPU workloads)
    gcloud run deploy "${SERVICE_NAME}" \
        --image="${IMAGE_NAME}:latest" \
        --region="${REGION}" \
        --platform=managed \
        --memory=16Gi \
        --cpu=4 \
        --gpu=1 \
        --gpu-type=nvidia-l4 \
        --timeout=900 \
        --concurrency=1 \
        --min-instances=0 \
        --max-instances=10 \
        --set-env-vars="${ENV_VARS}" \
        --allow-unauthenticated \
        --project="${PROJECT_ID}"
else
    # CPU-only deployment (fallback/cost-saving mode)
    # - 4GB RAM for standard processing
    # - 2 CPUs for libx264 encoding
    # - max-instances=20 for parallel processing
    gcloud run deploy "${SERVICE_NAME}" \
        --image="${IMAGE_NAME}:latest" \
        --region="${REGION}" \
        --platform=managed \
        --memory=4Gi \
        --cpu=2 \
        --timeout=900 \
        --concurrency=1 \
        --min-instances=0 \
        --max-instances=20 \
        --set-env-vars="${ENV_VARS}" \
        --allow-unauthenticated \
        --project="${PROJECT_ID}"
fi

# Get the service URL
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
    --region="${REGION}" \
    --project="${PROJECT_ID}" \
    --format="value(status.url)")

# If parallel mode is enabled, update service with VIDEO_PROCESSOR_URL
if [ "$PARALLEL_ENABLED" = true ]; then
    echo ""
    echo "Setting VIDEO_PROCESSOR_URL for parallel scene processing..."
    gcloud run services update "${SERVICE_NAME}" \
        --region="${REGION}" \
        --project="${PROJECT_ID}" \
        --update-env-vars="VIDEO_PROCESSOR_URL=${SERVICE_URL}"
fi

echo ""
echo "============================================"
echo "Deployment Complete!"
echo "============================================"
echo "Service URL: ${SERVICE_URL}"
echo ""
echo "Mode: $([ "$GPU_ENABLED" = true ] && echo "GPU (NVENC)" || echo "CPU (libx264)")"
if [ "$PARALLEL_ENABLED" = true ]; then
    echo "Parallel Scenes: ENABLED"
fi
echo "Max Instances: $([ "$GPU_ENABLED" = true ] && echo "10 (GPU quota)" || echo "20")"
echo ""
echo "Endpoints:"
echo "  Health:        ${SERVICE_URL}/health"
echo "  Process Clip:  POST ${SERVICE_URL}/process"
echo "  Creation Export: POST ${SERVICE_URL}/creation-export"
echo "  Process Scene: POST ${SERVICE_URL}/process-scene"
echo "  Status:        GET ${SERVICE_URL}/status/:jobId"
echo ""
echo "Performance:"
if [ "$GPU_ENABLED" = true ]; then
    echo "  Per-clip processing: ~15-30 seconds"
    echo "  3 clips in parallel: ~15-30 seconds total"
else
    echo "  Per-clip processing: ~2-5 minutes"
    echo "  3 clips in parallel: ~2-5 minutes total"
fi
if [ "$PARALLEL_ENABLED" = true ]; then
    echo ""
    echo "  Ken Burns Video Creation (Parallel):"
    echo "    15 scenes: ~3-5 minutes (vs 45+ min sequential)"
    echo "    Each scene processed by separate instance"
fi
echo ""
echo "To trigger processing for pending jobs:"
echo "  curl -X POST ${SERVICE_URL}/process-pending"
echo ""
echo "Environment Variables Set:"
echo "  BUCKET_NAME=${PROJECT_ID}.firebasestorage.app"
echo "  GPU_ENABLED=${GPU_ENABLED}"
if [ "$PARALLEL_ENABLED" = true ]; then
    echo "  PARALLEL_SCENES=true"
    echo "  VIDEO_PROCESSOR_URL=${SERVICE_URL}"
fi
echo "============================================"
