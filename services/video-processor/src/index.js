/**
 * Video Processor Service
 * Cloud Run service for processing YouTube clips into vertical shorts
 */

const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const { Storage } = require('@google-cloud/storage');
const { processVideo } = require('./processor');
const { v4: uuidv4 } = require('uuid');

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
 * Process a video clip
 * Called by Cloud Tasks or Pub/Sub when a new job is created
 */
app.post('/process', async (req, res) => {
  const startTime = Date.now();
  const { jobId } = req.body;

  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  console.log(`[${jobId}] Starting video processing job`);

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

    // Process the video
    const result = await processVideo({
      jobId,
      jobRef,
      job,
      storage,
      bucketName: BUCKET_NAME,
      tempDir: TEMP_DIR
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

    const result = await processVideo({
      jobId,
      jobRef,
      job,
      storage,
      bucketName: BUCKET_NAME,
      tempDir: TEMP_DIR
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

// Start server
app.listen(PORT, () => {
  console.log(`Video Processor Service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`Temp Dir: ${TEMP_DIR}`);
});
