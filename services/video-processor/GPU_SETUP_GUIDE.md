# GPU Setup Guide for Cloud Run

**Project ID:** `ytseo-6d1b0`

Before deploying with GPU acceleration, complete these steps in Google Cloud Console.

---

## Step 1: Enable Required APIs

Run this command in PowerShell:

```powershell
gcloud services enable compute.googleapis.com run.googleapis.com containerregistry.googleapis.com --project=ytseo-6d1b0
```

Or enable manually at: https://console.cloud.google.com/apis/library?project=ytseo-6d1b0

---

## Step 2: Request GPU Quota (REQUIRED - Takes 1-2 Days)

GPU instances require quota approval from Google.

### How to Request:

1. **Go to Quotas page:**
   https://console.cloud.google.com/iam-admin/quotas?project=ytseo-6d1b0

2. **Filter the quotas:**
   - Click "Filter"
   - Add filter: `Service: Cloud Run Admin API`
   - Add filter: `Quota: NVIDIA L4 GPU allocation`
   - Select region: `us-central1`

3. **Edit the quota:**
   - Check the box next to the quota
   - Click "EDIT QUOTAS" at the top
   - Set new limit to: `20`
   - Add justification:
     ```
     Video processing SaaS application requiring GPU acceleration for real-time
     video encoding. Need parallel processing capability for multiple simultaneous
     user exports. Expected usage: 10-20 concurrent GPU instances during peak hours.
     ```

4. **Submit and wait** (usually 1-2 business days)

### While Waiting:
Deploy in CPU mode:
```powershell
cd services\video-processor
.\deploy.ps1 -Mode "cpu"
```

---

## Step 3: Set Up Billing Alerts (Recommended)

GPU costs ~$0.90/hour when running. Set up alerts:

1. Go to: https://console.cloud.google.com/billing/budgets?project=ytseo-6d1b0
2. Click "CREATE BUDGET"
3. Set monthly budget (e.g., $50)
4. Add alerts at 50%, 75%, 90%, 100%

---

## Step 4: Get Video Download API Key (Optional but Recommended)

The `VIDEO_DOWNLOAD_API_KEY` enables reliable YouTube video downloads when the browser extension method fails. This uses a third-party API service.

### Option A: RapidAPI (Recommended)

1. **Create RapidAPI account:**
   https://rapidapi.com/auth/sign-up

2. **Subscribe to a YouTube download API:**
   - Search for "YouTube Video Download" APIs
   - Recommended: "YouTube Video Download" by ytjar
   - https://rapidapi.com/ytjar/api/youtube-video-download-info
   - Subscribe to the free tier (usually 100-500 requests/month)

3. **Get your API key:**
   - After subscribing, go to the API page
   - Look for "X-RapidAPI-Key" in the code examples
   - Copy this key

4. **Set the environment variable:**
   ```powershell
   $env:RAPIDAPI_KEY = "your-rapidapi-key-here"
   ```

### Option B: Alternative APIs

Other YouTube download APIs you can use:
- **ytdl-core** (self-hosted, free but less reliable)
- **cobalt.tools** (free, rate-limited)
- **SaveFrom.net API** (paid)

### How the API Key is Used:

The video processor tries these methods in order:
1. Browser extension capture (primary method)
2. yt-dlp with POT token (built-in, free)
3. RapidAPI download (if `RAPIDAPI_KEY` set)
4. Direct stream download (fallback)

---

## Step 5: Deploy the Service

### Quick Deploy (CPU mode - works immediately):

```powershell
cd services\video-processor
.\deploy.ps1 -Mode "cpu"
```

### Full Deploy with GPU (after quota approved):

```powershell
cd services\video-processor
.\deploy.ps1 -Mode "gpu"
```

### Deploy with API Key:

```powershell
cd services\video-processor
$env:RAPIDAPI_KEY = "your-rapidapi-key"
.\deploy.ps1 -Mode "gpu"
```

---

## Step 6: Verify Deployment

After deployment, check the health endpoint:

```powershell
# Get the service URL
$serviceUrl = gcloud run services describe video-processor --region=us-central1 --project=ytseo-6d1b0 --format="value(status.url)"

# Check health (includes GPU status)
Invoke-RestMethod -Uri "$serviceUrl/health"
```

Expected response with GPU:
```json
{
  "status": "healthy",
  "gpu": {
    "available": true,
    "encoder": "h264_nvenc",
    "expectedSpeed": "15-30 seconds per clip"
  }
}
```

---

## Troubleshooting

### "Quota exceeded" or "GPU not available"
- Your quota request hasn't been approved yet
- Use `-Mode "cpu"` while waiting

### Deployment fails with permission error
```powershell
gcloud auth login
gcloud config set project ytseo-6d1b0
```

### Docker build fails
Make sure Docker Desktop is running on Windows.

### GPU shows as unavailable after deployment
Check Cloud Run logs:
```powershell
gcloud run services logs read video-processor --region=us-central1 --project=ytseo-6d1b0 --limit=50
```

---

## Cost Estimates

| Mode | Per-Clip Time | Per-Clip Cost | 1000 clips/month |
|------|---------------|---------------|------------------|
| CPU  | 3-5 min       | ~$0.005       | ~$5              |
| GPU  | 15-30 sec     | ~$0.015       | ~$15             |

GPU is 3x more expensive but 10x faster - worth it for user experience.

---

## Quick Reference Commands

```powershell
# Deploy with GPU
.\deploy.ps1

# Deploy with CPU (fallback)
.\deploy.ps1 -Mode "cpu"

# Deploy with API key
$env:RAPIDAPI_KEY = "your-key"
.\deploy.ps1

# Check service status
gcloud run services describe video-processor --region=us-central1 --project=ytseo-6d1b0

# View logs
gcloud run services logs read video-processor --region=us-central1 --project=ytseo-6d1b0 --limit=100

# Check health
curl https://video-processor-XXXX-uc.a.run.app/health
```
