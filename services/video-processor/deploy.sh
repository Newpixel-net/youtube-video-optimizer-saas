#!/bin/bash

# Video Processor Service Deployment Script with GPU Support
# Usage: ./deploy.sh [project-id] [region] [--gpu|--cpu]
#
# GPU Mode (default):
#   Uses NVIDIA L4 GPU for 10-20x faster encoding via NVENC
#   Higher cost but much faster processing (15-30 sec vs 2-5 min per clip)
#
# CPU Mode:
#   Standard CPU-based encoding with libx264
#   Lower cost but slower processing
#
# Environment variables:
#   VIDEO_DOWNLOAD_API_KEY - API key for reliable YouTube downloads
#   RAPIDAPI_KEY - RapidAPI key for premium downloads (optional)
#
# Examples:
#   ./deploy.sh my-project us-central1           # GPU mode (default)
#   ./deploy.sh my-project us-central1 --gpu     # GPU mode (explicit)
#   ./deploy.sh my-project us-central1 --cpu     # CPU mode (fallback)

set -e

PROJECT_ID="${1:-ytseo-6d1b0}"
REGION="${2:-us-central1}"
MODE="${3:---gpu}"  # Default to GPU mode
SERVICE_NAME="video-processor"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
RAPIDAPI_KEY="${RAPIDAPI_KEY:-}"
VIDEO_DOWNLOAD_API_KEY="${VIDEO_DOWNLOAD_API_KEY:-}"

echo "============================================"
echo "Video Processor Service Deployment"
echo "============================================"
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service: ${SERVICE_NAME}"
echo "Mode: ${MODE}"
echo ""

# Determine if GPU mode
if [ "$MODE" == "--gpu" ] || [ "$MODE" == "-g" ]; then
    GPU_ENABLED=true
    echo "🚀 GPU Mode: NVIDIA L4 with NVENC encoding"
    echo "   - Expected processing time: 15-30 seconds per clip"
    echo "   - Memory: 16Gi, CPU: 4, GPU: 1x nvidia-l4"
else
    GPU_ENABLED=false
    echo "💻 CPU Mode: Standard libx264 encoding"
    echo "   - Expected processing time: 2-5 minutes per clip"
    echo "   - Memory: 4Gi, CPU: 2"
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

echo ""
echo "============================================"
echo "Deployment Complete!"
echo "============================================"
echo "Service URL: ${SERVICE_URL}"
echo ""
echo "Mode: $([ "$GPU_ENABLED" = true ] && echo "GPU (NVENC)" || echo "CPU (libx264)")"
echo "Max Instances: 20 (parallel processing enabled)"
echo ""
echo "Endpoints:"
echo "  Health:  ${SERVICE_URL}/health"
echo "  Process: POST ${SERVICE_URL}/process"
echo "  Status:  GET ${SERVICE_URL}/status/:jobId"
echo ""
echo "Performance:"
if [ "$GPU_ENABLED" = true ]; then
    echo "  Per-clip processing: ~15-30 seconds"
    echo "  3 clips in parallel: ~15-30 seconds total"
else
    echo "  Per-clip processing: ~2-5 minutes"
    echo "  3 clips in parallel: ~2-5 minutes total"
fi
echo ""
echo "To trigger processing for pending jobs:"
echo "  curl -X POST ${SERVICE_URL}/process-pending"
echo "============================================"
