# GPU Setup Guide for Cloud Run

Before deploying with GPU acceleration, you need to complete these steps in Google Cloud Console.

## Prerequisites Checklist

### 1. Enable Required APIs

Go to [APIs & Services](https://console.cloud.google.com/apis/library) and enable:

- **Cloud Run API** (should already be enabled)
- **Compute Engine API** (required for GPU quota)
- **Container Registry API** (for pushing images)

Or run this command:
```powershell
gcloud services enable compute.googleapis.com run.googleapis.com containerregistry.googleapis.com --project=YOUR_PROJECT_ID
```

### 2. Request GPU Quota (IMPORTANT!)

Cloud Run GPU is available but requires quota approval:

1. Go to [IAM & Admin > Quotas](https://console.cloud.google.com/iam-admin/quotas)
2. Filter by:
   - **Service**: "Cloud Run Admin API"
   - **Quota**: "NVIDIA L4 GPU allocation"
   - **Location**: Your region (e.g., `us-central1`)

3. Select the quota and click **"EDIT QUOTAS"**
4. Request a limit of at least `20` (for parallel processing)
5. Provide a justification like:
   > "Video processing SaaS application requiring GPU acceleration for real-time video encoding.
   > Need parallel processing capability for multiple simultaneous user exports."

6. Submit and wait for approval (usually 1-2 business days, sometimes faster)

### 3. Check GPU Availability by Region

Not all regions support Cloud Run with GPU. Currently supported regions for NVIDIA L4:

| Region | Location | Status |
|--------|----------|--------|
| `us-central1` | Iowa | ✅ Recommended |
| `us-east1` | South Carolina | ✅ Available |
| `us-west1` | Oregon | ✅ Available |
| `europe-west1` | Belgium | ✅ Available |
| `europe-west4` | Netherlands | ✅ Available |
| `asia-east1` | Taiwan | ✅ Available |

Check current availability: https://cloud.google.com/run/docs/configuring/services/gpu

### 4. Billing Alert (Recommended)

GPU instances cost more than CPU. Set up billing alerts:

1. Go to [Billing > Budgets & Alerts](https://console.cloud.google.com/billing/budgets)
2. Create a budget alert for your project
3. Set thresholds at 50%, 75%, 90%, 100%

**Estimated GPU Costs:**
- NVIDIA L4 on Cloud Run: ~$0.90/hour when running
- With `min-instances=0`, you only pay when processing
- A 30-second clip costs approximately $0.01-0.02 in GPU time

### 5. Verify Setup

After quota approval, verify everything works:

```powershell
# Check your quota
gcloud compute regions describe us-central1 --project=YOUR_PROJECT_ID | Select-String -Pattern "GPU"

# Test deployment with a simple container first
gcloud run deploy test-gpu `
    --image=nvidia/cuda:12.2.0-runtime-ubuntu22.04 `
    --region=us-central1 `
    --gpu=1 `
    --gpu-type=nvidia-l4 `
    --command="nvidia-smi" `
    --project=YOUR_PROJECT_ID
```

## Deployment Commands (Windows PowerShell)

### GPU Mode (Recommended for Production)
```powershell
cd services\video-processor
.\deploy.ps1 -ProjectId "your-project-id" -Region "us-central1" -Mode "gpu"
```

### CPU Mode (Fallback/Development)
```powershell
cd services\video-processor
.\deploy.ps1 -ProjectId "your-project-id" -Region "us-central1" -Mode "cpu"
```

### With API Keys
```powershell
$env:VIDEO_DOWNLOAD_API_KEY = "your-api-key"
.\deploy.ps1 -ProjectId "your-project-id" -Mode "gpu"
```

## Troubleshooting

### "Quota exceeded" Error
- Your GPU quota request hasn't been approved yet
- Use `-Mode "cpu"` to deploy without GPU while waiting

### "GPU not available in region" Error
- Try a different region from the supported list above
- `us-central1` usually has the best availability

### Deployment Succeeds but GPU Not Working
- Check health endpoint: `curl https://YOUR-SERVICE-URL/health`
- Look for `"gpu": { "available": true }` in the response
- If `available: false`, check container logs in Cloud Console

### High Costs
- Ensure `min-instances=0` is set (default)
- Reduce `max-instances` if needed
- Consider using CPU mode during off-peak hours

## Cost Comparison

| Mode | Per-Clip Time | Per-Clip Cost | Monthly (1000 clips) |
|------|---------------|---------------|----------------------|
| CPU (2 vCPU) | 3 min | ~$0.003 | ~$3 |
| GPU (L4) | 25 sec | ~$0.01 | ~$10 |

GPU mode costs ~3x more but is ~6x faster. For user experience, GPU is worth it.

## Fallback Strategy

The code automatically falls back to CPU encoding if:
1. GPU quota not available
2. GPU not detected at runtime
3. NVENC encoder not found

You can force CPU mode via environment variable:
```
GPU_ENABLED=false
```
