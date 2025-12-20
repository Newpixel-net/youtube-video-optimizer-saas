# Video Processor Service Deployment Script for Windows (PowerShell)
# Usage: .\deploy.ps1 -ProjectId "my-project" -Region "us-central1" -Mode "gpu"
#
# GPU Mode (default):
#   Uses NVIDIA L4 GPU for 10-20x faster encoding via NVENC
#
# CPU Mode:
#   Standard CPU-based encoding (fallback/cost-saving)
#
# Examples:
#   .\deploy.ps1 -ProjectId "my-project"                    # GPU mode (default)
#   .\deploy.ps1 -ProjectId "my-project" -Mode "gpu"        # GPU mode (explicit)
#   .\deploy.ps1 -ProjectId "my-project" -Mode "cpu"        # CPU mode

param(
    [Parameter(Mandatory=$false)]
    [string]$ProjectId = "ytseo-6d1b0",

    [Parameter(Mandatory=$false)]
    [string]$Region = "us-central1",

    [Parameter(Mandatory=$false)]
    [ValidateSet("gpu", "cpu")]
    [string]$Mode = "gpu",

    [Parameter(Mandatory=$false)]
    [string]$VideoDownloadApiKey = $env:VIDEO_DOWNLOAD_API_KEY,

    [Parameter(Mandatory=$false)]
    [string]$RapidApiKey = $env:RAPIDAPI_KEY
)

$ErrorActionPreference = "Stop"

# Get project ID from gcloud if not provided
if (-not $ProjectId) {
    $ProjectId = gcloud config get-value project 2>$null
    if (-not $ProjectId) {
        Write-Error "No project ID specified. Use: .\deploy.ps1 -ProjectId 'your-project-id'"
        exit 1
    }
}

$ServiceName = "video-processor"
$ImageName = "gcr.io/$ProjectId/$ServiceName"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Video Processor Service Deployment" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Project: $ProjectId"
Write-Host "Region: $Region"
Write-Host "Service: $ServiceName"
Write-Host "Mode: $Mode"
Write-Host ""

if ($Mode -eq "gpu") {
    Write-Host "GPU Mode: NVIDIA L4 with NVENC encoding" -ForegroundColor Green
    Write-Host "  - Expected processing time: 15-30 seconds per clip"
    Write-Host "  - Memory: 16Gi, CPU: 4, GPU: 1x nvidia-l4"
} else {
    Write-Host "CPU Mode: Standard libx264 encoding" -ForegroundColor Yellow
    Write-Host "  - Expected processing time: 2-5 minutes per clip"
    Write-Host "  - Memory: 4Gi, CPU: 2"
}
Write-Host ""

if ($VideoDownloadApiKey) {
    Write-Host "Video Download API Key: Configured" -ForegroundColor Green
} else {
    Write-Host "Video Download API Key: NOT SET" -ForegroundColor Yellow
}
Write-Host "============================================" -ForegroundColor Cyan

# Enable required APIs
Write-Host "`nEnabling required APIs..." -ForegroundColor Cyan
gcloud services enable `
    cloudbuild.googleapis.com `
    run.googleapis.com `
    containerregistry.googleapis.com `
    --project="$ProjectId"

# Build the Docker image
Write-Host "`nBuilding Docker image..." -ForegroundColor Cyan
docker build -t "${ImageName}:latest" .

if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker build failed"
    exit 1
}

# Push to Container Registry
Write-Host "`nPushing to Container Registry..." -ForegroundColor Cyan
docker push "${ImageName}:latest"

if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker push failed"
    exit 1
}

# Build environment variables
$EnvVars = "BUCKET_NAME=$ProjectId.firebasestorage.app,NODE_ENV=production"

if ($Mode -eq "gpu") {
    $EnvVars += ",GPU_ENABLED=true"
} else {
    $EnvVars += ",GPU_ENABLED=false"
}

if ($VideoDownloadApiKey) {
    $EnvVars += ",VIDEO_DOWNLOAD_API_KEY=$VideoDownloadApiKey"
}

if ($RapidApiKey) {
    $EnvVars += ",RAPIDAPI_KEY=$RapidApiKey"
}

# Deploy to Cloud Run
Write-Host "`nDeploying to Cloud Run..." -ForegroundColor Cyan

if ($Mode -eq "gpu") {
    # GPU-enabled deployment
    gcloud run deploy $ServiceName `
        --image="${ImageName}:latest" `
        --region="$Region" `
        --platform=managed `
        --memory=16Gi `
        --cpu=4 `
        --gpu=1 `
        --gpu-type=nvidia-l4 `
        --timeout=900 `
        --concurrency=1 `
        --min-instances=0 `
        --max-instances=20 `
        --set-env-vars="$EnvVars" `
        --allow-unauthenticated `
        --project="$ProjectId"
} else {
    # CPU-only deployment
    gcloud run deploy $ServiceName `
        --image="${ImageName}:latest" `
        --region="$Region" `
        --platform=managed `
        --memory=4Gi `
        --cpu=2 `
        --timeout=900 `
        --concurrency=1 `
        --min-instances=0 `
        --max-instances=20 `
        --set-env-vars="$EnvVars" `
        --allow-unauthenticated `
        --project="$ProjectId"
}

if ($LASTEXITCODE -ne 0) {
    Write-Error "Deployment failed"
    exit 1
}

# Get service URL
$ServiceUrl = gcloud run services describe $ServiceName `
    --region="$Region" `
    --project="$ProjectId" `
    --format="value(status.url)"

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "Deployment Complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host "Service URL: $ServiceUrl"
Write-Host ""
Write-Host "Mode: $( if ($Mode -eq 'gpu') { 'GPU (NVENC)' } else { 'CPU (libx264)' } )"
Write-Host "Max Instances: 20 (parallel processing enabled)"
Write-Host ""
Write-Host "Endpoints:"
Write-Host "  Health:  $ServiceUrl/health"
Write-Host "  Process: POST $ServiceUrl/process"
Write-Host ""
if ($Mode -eq "gpu") {
    Write-Host "Performance: ~15-30 seconds per clip" -ForegroundColor Green
} else {
    Write-Host "Performance: ~2-5 minutes per clip" -ForegroundColor Yellow
}
Write-Host "============================================" -ForegroundColor Green
