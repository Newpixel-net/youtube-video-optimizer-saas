#!/bin/bash

# Video Processor Service Deployment Script
# Usage: ./deploy.sh [project-id] [region]
#
# Environment variables:
#   RAPIDAPI_KEY - RapidAPI key for YouTube video downloads (required for premium downloads)
#
# Example:
#   RAPIDAPI_KEY=your-api-key ./deploy.sh my-project us-central1

set -e

PROJECT_ID="${1:-$(gcloud config get-value project)}"
REGION="${2:-us-central1}"
SERVICE_NAME="video-processor"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
RAPIDAPI_KEY="${RAPIDAPI_KEY:-}"

echo "============================================"
echo "Video Processor Service Deployment"
echo "============================================"
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Service: ${SERVICE_NAME}"
if [ -n "$RAPIDAPI_KEY" ]; then
    echo "RapidAPI Key: Configured (${RAPIDAPI_KEY:0:8}...)"
else
    echo "RapidAPI Key: NOT SET (video downloads will use fallback methods)"
    echo "  Set RAPIDAPI_KEY environment variable for premium YouTube downloads"
fi
echo "============================================"

# Check if gcloud is configured
if [ -z "$PROJECT_ID" ]; then
    echo "Error: No project ID specified and none configured in gcloud"
    echo "Usage: ./deploy.sh <project-id> [region]"
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
ENV_VARS="BUCKET_NAME=${PROJECT_ID}.appspot.com,NODE_ENV=production"
if [ -n "$RAPIDAPI_KEY" ]; then
    ENV_VARS="${ENV_VARS},RAPIDAPI_KEY=${RAPIDAPI_KEY}"
fi

# Deploy to Cloud Run
echo ""
echo "Deploying to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
    --image="${IMAGE_NAME}:latest" \
    --region="${REGION}" \
    --platform=managed \
    --memory=4Gi \
    --cpu=2 \
    --timeout=900 \
    --concurrency=1 \
    --min-instances=0 \
    --max-instances=10 \
    --set-env-vars="${ENV_VARS}" \
    --allow-unauthenticated \
    --project="${PROJECT_ID}"

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
echo "Endpoints:"
echo "  Health:  ${SERVICE_URL}/health"
echo "  Process: POST ${SERVICE_URL}/process"
echo "  Status:  GET ${SERVICE_URL}/status/:jobId"
echo ""
echo "To trigger processing for pending jobs:"
echo "  curl -X POST ${SERVICE_URL}/process-pending"
echo "============================================"
