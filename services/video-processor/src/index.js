/**
 * Video Processor Service
 * Cloud Run service for processing YouTube clips into vertical shorts
 */

import express from 'express';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { processVideo } from './processor.js';
import { extractYouTubeFrames } from './youtube-downloader.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());

// Initialize clients
const firestore = new Firestore();
const storage = new Storage();

const PORT = process.env.PORT || 8080;
const BUCKET_NAME = process.env.BUCKET_NAME || 'your-project-id.appspot.com';
const TEMP_DIR = process.env.TEMP_DIR || '/tmp/video-processing';

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

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

  console.log(`[${jobId}] Starting video processing job`);

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
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = jobDoc.data();

    // Check if already processed
    if (job.status === 'completed' || job.status === 'failed') {
      console.log(`[${jobId}] Job already ${job.status}`);
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

    console.log(`[${jobId}] Processing completed in ${Date.now() - startTime}ms`);

    res.status(200).json({
      success: true,
      jobId,
      outputUrl: result.outputUrl,
      processingTime: Date.now() - startTime
    });

  } catch (error) {
    console.error(`[${jobId}] Processing failed:`, error);

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
  console.log(`Video Processor Service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`Temp Dir: ${TEMP_DIR}`);
});
