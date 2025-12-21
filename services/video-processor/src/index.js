/**
 * Video Processor Service
 * Cloud Run service for processing YouTube clips into vertical shorts
 */

import express from 'express';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { processVideo } from './processor.js';
import { extractYouTubeFrames } from './youtube-downloader.js';
import { getGpuStatus } from './gpu-encoder.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import multer from 'multer';

const app = express();
app.use(express.json());

// CORS middleware - must be before all routes
// Allow requests from any origin (browser extension, web app, etc.)
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '86400'); // 24 hours

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }
  next();
});

// Configure multer for handling file uploads (video streams from browser extension)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max (video files can be large)
  },
});

// Initialize clients
const firestore = new Firestore();
const storage = new Storage();

const PORT = process.env.PORT || 8080;
// IMPORTANT: Use .firebasestorage.app format (not .appspot.com)
const BUCKET_NAME = process.env.BUCKET_NAME || 'ytseo-6d1b0.firebasestorage.app';
const TEMP_DIR = process.env.TEMP_DIR || '/tmp/video-processing';

// Track active processing jobs for health reporting
let activeJobs = 0;
let totalJobsProcessed = 0;
let lastJobCompletedAt = null;

/**
 * Health check endpoint
 * Returns detailed status including memory usage and active job count
 */
app.get('/health', (req, res) => {
  // FAST health check - no slow GPU queries
  // GPU status is only queried on explicit /gpu-status endpoint
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime() / 60)} minutes`,
    jobs: {
      active: activeJobs,
      totalProcessed: totalJobsProcessed
    }
  });
});

// Separate endpoint for detailed GPU status (not called during health checks)
app.get('/gpu-status', (req, res) => {
  const memUsage = process.memoryUsage();

  let gpuStatus;
  try {
    gpuStatus = getGpuStatus();
  } catch (e) {
    gpuStatus = { available: false, error: e.message };
  }

  res.status(200).json({
    timestamp: new Date().toISOString(),
    memory: {
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
      rss: `${Math.round(memUsage.rss / 1024 / 1024)} MB`
    },
    gpu: gpuStatus,
    environment: process.env.NODE_ENV || 'development'
  });
});

/**
 * Upload video stream from browser extension
 * This endpoint receives video data downloaded by the browser extension
 * (which has access to IP-restricted YouTube stream URLs) and stores it
 * in Firebase Storage for processing.
 *
 * This bypasses YouTube's IP-restriction on stream URLs by having the
 * extension download in the user's browser and upload to our server.
 */
app.post('/upload-stream', upload.single('video'), async (req, res) => {
  const uploadId = uuidv4().slice(0, 8);
  console.log(`[UploadStream:${uploadId}] Received upload request`);

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const { videoId, type = 'video' } = req.body;
    if (!videoId) {
      return res.status(400).json({ error: 'videoId is required' });
    }

    const fileSize = req.file.size;
    const mimeType = req.file.mimetype || 'video/mp4';
    console.log(`[UploadStream:${uploadId}] Video: ${videoId}, Type: ${type}, Size: ${(fileSize / 1024 / 1024).toFixed(2)}MB, MIME: ${mimeType}`);

    // Generate unique filename for storage based on actual mimeType
    const timestamp = Date.now();
    // Determine file extension from mimeType (MediaRecorder produces webm, direct downloads produce mp4)
    let extension = 'mp4'; // default fallback
    if (mimeType.includes('webm')) {
      extension = 'webm';
    } else if (mimeType.includes('mp4') || mimeType.includes('mpeg')) {
      extension = 'mp4';
    } else if (type === 'audio') {
      extension = mimeType.includes('webm') ? 'webm' : 'm4a';
    }
    const fileName = `extension-uploads/${videoId}/${type}_${timestamp}.${extension}`;

    // Upload to Firebase Storage
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(fileName);

    await file.save(req.file.buffer, {
      metadata: {
        contentType: mimeType,
        metadata: {
          videoId: videoId,
          type: type,
          uploadedAt: new Date().toISOString(),
          source: 'browser-extension'
        }
      }
    });

    // Make the file publicly accessible
    await file.makePublic();

    // Get the public URL
    const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${fileName}`;

    console.log(`[UploadStream:${uploadId}] Upload successful: ${publicUrl}`);

    res.json({
      success: true,
      url: publicUrl,
      videoId: videoId,
      type: type,
      size: fileSize,
      uploadId: uploadId
    });

  } catch (error) {
    console.error(`[UploadStream:${uploadId}] Upload failed:`, error);
    res.status(500).json({ error: error.message || 'Upload failed' });
  }
});

// CORS preflight is now handled by global middleware above

/**
 * Extract frames from a YouTube video at specific timestamps
 * Used for thumbnail generation with actual video frames as reference
 */
app.post('/extract-frames', async (req, res) => {
  const { videoId, timestamps, clipId } = req.body;

  if (!videoId || !timestamps || !Array.isArray(timestamps)) {
    return res.status(400).json({ error: 'videoId and timestamps array are required' });
  }

  console.log(`[FrameExtract] Extracting ${timestamps.length} frames from video ${videoId}`);

  try {
    // Create temp directory for this extraction
    const workDir = path.join(TEMP_DIR, `frames_${clipId || Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });

    // Extract frames
    const frames = await extractYouTubeFrames({
      videoId,
      timestamps,
      workDir
    });

    // Clean up work directory
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (e) {
      console.log('[FrameExtract] Cleanup warning:', e.message);
    }

    if (frames.length === 0) {
      return res.status(500).json({ error: 'Failed to extract any frames' });
    }

    console.log(`[FrameExtract] Successfully extracted ${frames.length} frames`);

    res.status(200).json({
      success: true,
      videoId,
      frames: frames.map(f => ({
        timestamp: f.timestamp,
        base64: f.base64,
        mimeType: f.mimeType || 'image/jpeg'
      }))
    });

  } catch (error) {
    console.error('[FrameExtract] Error:', error);
    res.status(500).json({ error: error.message || 'Frame extraction failed' });
  }
});

/**
 * Process a video clip
 * Called by Cloud Tasks or Pub/Sub when a new job is created
 */
app.post('/process', async (req, res) => {
  const startTime = Date.now();
  const { jobId, youtubeAuth } = req.body;

  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  console.log(`[${jobId}] ========================================`);
  console.log(`[${jobId}] Starting video processing job`);
  console.log(`[${jobId}] Timestamp: ${new Date().toISOString()}`);
  console.log(`[${jobId}] Active jobs before: ${activeJobs}`);

  // Increment active job counter
  activeJobs++;

  // Log if we have YouTube authentication
  if (youtubeAuth?.accessToken) {
    console.log(`[${jobId}] Received YouTube OAuth credentials`);
  }

  try {
    // Get job details from Firestore
    const jobRef = firestore.collection('wizardProcessingJobs').doc(jobId);
    const jobDoc = await jobRef.get();

    if (!jobDoc.exists) {
      console.error(`[${jobId}] Job not found`);
      activeJobs--;
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = jobDoc.data();
    console.log(`[${jobId}] Job details: videoId=${job.videoId}, segment=${job.startTime}s-${job.endTime}s`);
    console.log(`[${jobId}] Job flags: isUpload=${job.isUpload}, hasExtensionStream=${job.hasExtensionStream}`);

    // Check if already processed
    if (job.status === 'completed' || job.status === 'failed') {
      console.log(`[${jobId}] Job already ${job.status}`);
      activeJobs--;
      return res.status(200).json({ status: job.status, message: 'Job already processed' });
    }

    // Update status to processing
    await jobRef.update({
      status: 'processing',
      progress: 5,
      startedAt: Firestore.FieldValue.serverTimestamp(),
      updatedAt: Firestore.FieldValue.serverTimestamp()
    });

    // Process the video with optional YouTube auth
    const result = await processVideo({
      jobId,
      jobRef,
      job,
      storage,
      bucketName: BUCKET_NAME,
      tempDir: TEMP_DIR,
      youtubeAuth // Pass YouTube OAuth credentials if available
    });

    // Update job with result
    await jobRef.update({
      status: 'completed',
      progress: 100,
      outputUrl: result.outputUrl,
      outputPath: result.outputPath,
      outputSize: result.outputSize,
      processingTime: Date.now() - startTime,
      completedAt: Firestore.FieldValue.serverTimestamp(),
      updatedAt: Firestore.FieldValue.serverTimestamp()
    });

    // Also update the project with the processed clip URL
    await firestore.collection('wizardProjects').doc(job.projectId).update({
      [`clipProcessing.${job.clipId}`]: {
        status: 'completed',
        outputUrl: result.outputUrl,
        quality: job.quality,
        completedAt: Firestore.FieldValue.serverTimestamp()
      },
      updatedAt: Firestore.FieldValue.serverTimestamp()
    });

    // Update tracking stats
    activeJobs--;
    totalJobsProcessed++;
    lastJobCompletedAt = new Date().toISOString();

    const processingTime = Date.now() - startTime;
    console.log(`[${jobId}] ========================================`);
    console.log(`[${jobId}] Processing COMPLETED successfully`);
    console.log(`[${jobId}] Processing time: ${(processingTime / 1000).toFixed(1)}s`);
    console.log(`[${jobId}] Output size: ${(result.outputSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`[${jobId}] Active jobs after: ${activeJobs}`);
    console.log(`[${jobId}] Total jobs processed: ${totalJobsProcessed}`);
    console.log(`[${jobId}] ========================================`);

    res.status(200).json({
      success: true,
      jobId,
      outputUrl: result.outputUrl,
      processingTime
    });

  } catch (error) {
    // Decrement active job counter on error
    activeJobs--;

    console.error(`[${jobId}] ========================================`);
    console.error(`[${jobId}] Processing FAILED`);
    console.error(`[${jobId}] Error: ${error.message}`);
    console.error(`[${jobId}] Stack: ${error.stack?.split('\n').slice(0, 3).join('\n')}`);
    console.error(`[${jobId}] Active jobs after error: ${activeJobs}`);
    console.error(`[${jobId}] ========================================`);

    // Update job with error
    try {
      await firestore.collection('wizardProcessingJobs').doc(jobId).update({
        status: 'failed',
        error: error.message || 'Unknown error',
        updatedAt: Firestore.FieldValue.serverTimestamp()
      });
    } catch (updateError) {
      console.error(`[${jobId}] Failed to update job status:`, updateError);
    }

    res.status(500).json({
      error: error.message || 'Processing failed',
      jobId
    });
  }
});

/**
 * Get job status
 */
app.get('/status/:jobId', async (req, res) => {
  const { jobId } = req.params;

  try {
    const jobDoc = await firestore.collection('wizardProcessingJobs').doc(jobId).get();

    if (!jobDoc.exists) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = jobDoc.data();
    res.status(200).json({
      jobId,
      status: job.status,
      progress: job.progress || 0,
      outputUrl: job.outputUrl || null,
      error: job.error || null
    });

  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * Trigger processing for pending jobs (can be called by Cloud Scheduler)
 */
app.post('/process-pending', async (req, res) => {
  try {
    // Find pending jobs
    const pendingJobs = await firestore
      .collection('wizardProcessingJobs')
      .where('status', '==', 'queued')
      .orderBy('createdAt', 'asc')
      .limit(5)
      .get();

    if (pendingJobs.empty) {
      return res.status(200).json({ message: 'No pending jobs', processed: 0 });
    }

    const jobIds = [];
    pendingJobs.forEach(doc => jobIds.push(doc.id));

    console.log(`Found ${jobIds.length} pending jobs to process`);

    // Process each job (in production, you might want to use Cloud Tasks for this)
    for (const jobId of jobIds) {
      // Trigger processing asynchronously
      processJobAsync(jobId);
    }

    res.status(200).json({
      message: `Processing ${jobIds.length} jobs`,
      jobIds
    });

  } catch (error) {
    console.error('Process pending error:', error);
    res.status(500).json({ error: 'Failed to process pending jobs' });
  }
});

/**
 * Process a job asynchronously (fire and forget)
 */
async function processJobAsync(jobId) {
  const startTime = Date.now();

  try {
    const jobRef = firestore.collection('wizardProcessingJobs').doc(jobId);
    const jobDoc = await jobRef.get();
    const job = jobDoc.data();

    await jobRef.update({
      status: 'processing',
      progress: 5,
      startedAt: Firestore.FieldValue.serverTimestamp(),
      updatedAt: Firestore.FieldValue.serverTimestamp()
    });

    // Try to fetch YouTube credentials from user if job indicates they have auth
    let youtubeAuth = null;
    if (job.hasYouTubeAuth && job.userId) {
      try {
        const userDoc = await firestore.collection('users').doc(job.userId).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          const ytConn = userData.youtubeConnection;
          if (ytConn?.status === 'connected' && ytConn?.accessToken) {
            youtubeAuth = { accessToken: ytConn.accessToken };
            console.log(`[${jobId}] Fetched YouTube credentials for async processing`);
          }
        }
      } catch (authError) {
        console.log(`[${jobId}] Could not fetch YouTube auth:`, authError.message);
      }
    }

    const result = await processVideo({
      jobId,
      jobRef,
      job,
      storage,
      bucketName: BUCKET_NAME,
      tempDir: TEMP_DIR,
      youtubeAuth
    });

    await jobRef.update({
      status: 'completed',
      progress: 100,
      outputUrl: result.outputUrl,
      outputPath: result.outputPath,
      outputSize: result.outputSize,
      processingTime: Date.now() - startTime,
      completedAt: Firestore.FieldValue.serverTimestamp(),
      updatedAt: Firestore.FieldValue.serverTimestamp()
    });

    await firestore.collection('wizardProjects').doc(job.projectId).update({
      [`clipProcessing.${job.clipId}`]: {
        status: 'completed',
        outputUrl: result.outputUrl,
        quality: job.quality,
        completedAt: Firestore.FieldValue.serverTimestamp()
      },
      updatedAt: Firestore.FieldValue.serverTimestamp()
    });

    console.log(`[${jobId}] Async processing completed in ${Date.now() - startTime}ms`);

  } catch (error) {
    console.error(`[${jobId}] Async processing failed:`, error);

    await firestore.collection('wizardProcessingJobs').doc(jobId).update({
      status: 'failed',
      error: error.message || 'Unknown error',
      updatedAt: Firestore.FieldValue.serverTimestamp()
    });
  }
}

/**
 * Analyze an uploaded video file
 * Extracts duration, generates thumbnails, and creates clip segments
 */
app.post('/analyze-upload', async (req, res) => {
  const { projectId, videoUrl, storagePath, userId } = req.body;

  if (!projectId || !videoUrl) {
    return res.status(400).json({ error: 'projectId and videoUrl are required' });
  }

  console.log(`[AnalyzeUpload] Processing uploaded video for project ${projectId}`);

  try {
    // Create work directory
    const workDir = path.join(TEMP_DIR, `upload_${projectId}`);
    fs.mkdirSync(workDir, { recursive: true });

    // Download the video from Firebase Storage URL
    const localVideoPath = path.join(workDir, 'source.mp4');

    console.log(`[AnalyzeUpload] Downloading video from ${videoUrl}`);

    // Fetch the video
    const response = await fetch(videoUrl);
    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(localVideoPath, Buffer.from(buffer));

    console.log(`[AnalyzeUpload] Video downloaded, size: ${fs.statSync(localVideoPath).size} bytes`);

    // Get video duration using ffprobe
    const { spawn } = await import('child_process');

    const getDuration = () => new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'json',
        localVideoPath
      ]);

      let output = '';
      ffprobe.stdout.on('data', data => output += data.toString());
      ffprobe.stderr.on('data', data => console.log('[ffprobe]', data.toString()));

      ffprobe.on('close', code => {
        if (code !== 0) {
          reject(new Error(`ffprobe exited with code ${code}`));
          return;
        }
        try {
          const result = JSON.parse(output);
          const duration = parseFloat(result.format?.duration || 0);
          resolve(Math.round(duration));
        } catch (e) {
          reject(new Error('Failed to parse duration'));
        }
      });
    });

    const durationSeconds = await getDuration();
    console.log(`[AnalyzeUpload] Video duration: ${durationSeconds} seconds`);

    // Generate suggested clips based on duration
    const numClips = Math.min(8, Math.max(3, Math.floor(durationSeconds / 60)));
    const segmentSize = Math.floor(durationSeconds / numClips);

    // Generate thumbnails for each clip
    const generateThumbnail = (timestamp, outputPath) => new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-ss', String(timestamp),
        '-i', localVideoPath,
        '-vframes', '1',
        '-vf', 'scale=320:180',
        '-y',
        outputPath
      ]);

      ffmpeg.stderr.on('data', data => console.log('[ffmpeg thumbnail]', data.toString().substring(0, 100)));
      ffmpeg.on('close', code => {
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          reject(new Error(`Failed to generate thumbnail at ${timestamp}s`));
        }
      });
    });

    const clips = [];
    for (let i = 0; i < numClips; i++) {
      const clipDuration = Math.min(45, Math.max(20, segmentSize - 10));
      const startTime = Math.floor(segmentSize * i + Math.random() * 10);
      const endTime = Math.min(startTime + clipDuration, durationSeconds);
      const clipId = `clip_upload_${i}_${Date.now()}`;

      // Generate thumbnail for this clip
      let thumbnailUrl = '';
      try {
        const thumbnailPath = path.join(workDir, `thumb_${i}.jpg`);
        await generateThumbnail(startTime + 2, thumbnailPath); // 2 seconds into the clip

        // Upload thumbnail to Firebase Storage
        const thumbnailStoragePath = `thumbnails/${userId}/${projectId}_clip_${i}.jpg`;
        await storage.bucket(BUCKET_NAME).upload(thumbnailPath, {
          destination: thumbnailStoragePath,
          metadata: { contentType: 'image/jpeg' }
        });

        // Get public URL
        const [url] = await storage.bucket(BUCKET_NAME)
          .file(thumbnailStoragePath)
          .getSignedUrl({
            action: 'read',
            expires: Date.now() + 365 * 24 * 60 * 60 * 1000 // 1 year
          });
        thumbnailUrl = url;
        console.log(`[AnalyzeUpload] Generated thumbnail for clip ${i}`);
      } catch (thumbError) {
        console.log(`[AnalyzeUpload] Thumbnail generation failed for clip ${i}:`, thumbError.message);
        // Use a placeholder or leave empty
      }

      clips.push({
        id: clipId,
        startTime,
        endTime,
        duration: endTime - startTime,
        transcript: `Video segment ${i + 1} (${Math.floor(startTime / 60)}:${String(startTime % 60).padStart(2, '0')} - ${Math.floor(endTime / 60)}:${String(endTime % 60).padStart(2, '0')})`,
        aiSummary: `Clip ${i + 1} from uploaded video`,
        thumbnail: thumbnailUrl,
        score: 75 + Math.floor(Math.random() * 20),
        platforms: ['youtube', 'tiktok', 'instagram'],
        reason: 'Auto-generated segment for uploaded video'
      });
    }

    // Clean up work directory
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (e) {
      console.log('[AnalyzeUpload] Cleanup warning:', e.message);
    }

    console.log(`[AnalyzeUpload] Generated ${clips.length} clips with thumbnails`);

    res.status(200).json({
      success: true,
      projectId,
      duration: durationSeconds,
      clips,
      videoUrl // Return the video URL for preview
    });

  } catch (error) {
    console.error('[AnalyzeUpload] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to analyze uploaded video' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`Video Processor Service STARTED`);
  console.log(`========================================`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Port: ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`Temp Dir: ${TEMP_DIR}`);
  console.log(`----------------------------------------`);

  // Log memory settings
  console.log(`Node.js Memory Settings:`);
  const memUsage = process.memoryUsage();
  console.log(`  Heap Used: ${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`);
  console.log(`  Heap Total: ${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`);
  console.log(`  RSS: ${Math.round(memUsage.rss / 1024 / 1024)} MB`);
  console.log(`----------------------------------------`);

  // Log API key configurations
  console.log(`API Configuration:`);

  // Video Download API (PRIMARY - 99%+ reliable)
  const videoDownloadApiKey = process.env.VIDEO_DOWNLOAD_API_KEY;
  if (videoDownloadApiKey) {
    console.log(`  Video Download API: CONFIGURED (${videoDownloadApiKey.substring(0, 4)}...${videoDownloadApiKey.slice(-4)}) [PRIMARY]`);
  } else {
    console.log(`  Video Download API: NOT CONFIGURED`);
    console.log(`    ! Set VIDEO_DOWNLOAD_API_KEY for 99%+ reliable downloads`);
    console.log(`    ! Get API key at: https://video-download-api.com/`);
  }

  // RapidAPI (legacy)
  const rapidApiKey = process.env.RAPIDAPI_KEY;
  if (rapidApiKey) {
    console.log(`  RapidAPI: CONFIGURED (${rapidApiKey.substring(0, 4)}...${rapidApiKey.slice(-4)}) [legacy]`);
  } else {
    console.log(`  RapidAPI: NOT CONFIGURED (optional, legacy)`);
  }

  console.log(`----------------------------------------`);
  console.log(`Cloud Run Environment:`);
  console.log(`  K_SERVICE: ${process.env.K_SERVICE || 'not set'}`);
  console.log(`  K_REVISION: ${process.env.K_REVISION || 'not set'}`);
  console.log(`  GOOGLE_CLOUD_PROJECT: ${process.env.GOOGLE_CLOUD_PROJECT || 'not set'}`);
  console.log(`========================================`);
  console.log(`Ready to process video jobs!`);
  console.log(`========================================`);
});
