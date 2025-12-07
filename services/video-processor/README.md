# Video Processor Service

Cloud Run service for processing YouTube videos into vertical shorts (9:16 format).

## Features

- **Video Download**: Uses yt-dlp to download specific segments from YouTube
- **Smart Cropping**: Automatically crops horizontal videos to 9:16 vertical format
- **Reframe Modes**:
  - Auto-center (default)
  - Split screen
  - Gameplay mode
- **Visual Effects**:
  - Auto zoom on key moments
  - Cinematic vignette
  - Color grading for social media
- **Transitions**:
  - Fade in/out
  - Zoom in/out
  - Slide in/out
  - Glitch effect
- **Audio Enhancement**:
  - Loudness normalization
  - Noise reduction
  - Dynamic compression

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Firebase      │────▶│   Cloud Run      │────▶│  Cloud Storage  │
│   Functions     │     │  Video Processor │     │  (Output Files) │
└─────────────────┘     └──────────────────┘     └─────────────────┘
        │                       │                        │
        ▼                       ▼                        ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Firestore     │     │    YouTube       │     │   User Gets     │
│ (Job Tracking)  │     │   (Source)       │     │  Download Link  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## API Endpoints

### Health Check
```
GET /health
Response: { "status": "healthy", "timestamp": "..." }
```

### Process Video
```
POST /process
Body: { "jobId": "abc123" }
Response: { "success": true, "outputUrl": "https://..." }
```

### Get Status
```
GET /status/:jobId
Response: { "status": "processing", "progress": 45, ... }
```

### Process Pending Jobs
```
POST /process-pending
Response: { "message": "Processing 3 jobs", "jobIds": [...] }
```

## Deployment

### Prerequisites

1. Google Cloud SDK installed and configured
2. Docker installed
3. Firebase project with Firestore enabled
4. Cloud Storage bucket created

### Deploy

```bash
# Make deploy script executable
chmod +x deploy.sh

# Deploy to your project
./deploy.sh your-project-id us-central1
```

### Manual Deployment

```bash
# Build Docker image
docker build -t gcr.io/YOUR_PROJECT/video-processor .

# Push to Container Registry
docker push gcr.io/YOUR_PROJECT/video-processor

# Deploy to Cloud Run
gcloud run deploy video-processor \
  --image gcr.io/YOUR_PROJECT/video-processor \
  --region us-central1 \
  --memory 4Gi \
  --cpu 2 \
  --timeout 900
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 8080 |
| `BUCKET_NAME` | Cloud Storage bucket | project.appspot.com |
| `TEMP_DIR` | Temporary file directory | /tmp/video-processing |
| `NODE_ENV` | Environment | production |

## Job Data Structure

Jobs are stored in Firestore collection `wizardProcessingJobs`:

```javascript
{
  userId: "user123",
  projectId: "project456",
  clipId: "clip_abc",
  videoId: "dQw4w9WgXcQ",
  startTime: 30,
  endTime: 75,
  duration: 45,
  quality: "720p",
  settings: {
    captionStyle: "karaoke",
    reframeMode: "auto_center",
    introTransition: "fade",
    outroTransition: "fade",
    autoZoom: false,
    vignette: true,
    colorGrade: true,
    enhanceAudio: true
  },
  output: {
    format: "mp4",
    aspectRatio: "9:16",
    resolution: { width: 720, height: 1280 },
    fps: 30
  },
  status: "queued",  // queued | processing | completed | failed
  progress: 0,
  outputUrl: null,
  createdAt: Timestamp,
  updatedAt: Timestamp
}
```

## Cost Estimation

Per video clip (45 seconds @ 720p):
- Cloud Run: ~$0.026
- Cloud Storage: ~$0.002
- Network: ~$0.015
- **Total: ~$0.04/clip**

## Troubleshooting

### Common Issues

1. **yt-dlp fails to download**
   - Check if video is available in your region
   - Verify video is not age-restricted
   - Try updating yt-dlp: `yt-dlp -U`

2. **FFmpeg processing fails**
   - Check input video format
   - Verify sufficient memory (4GB recommended)
   - Check disk space in temp directory

3. **Upload fails**
   - Verify Cloud Storage permissions
   - Check bucket exists and is accessible
   - Verify service account has Storage Admin role

## Development

### Local Testing

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Test health endpoint
curl http://localhost:8080/health
```

### Build Docker Image Locally

```bash
docker build -t video-processor .
docker run -p 8080:8080 video-processor
```
