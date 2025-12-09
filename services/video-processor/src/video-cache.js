/**
 * Video Source Cache
 * Downloads full videos once and caches them for multiple clip extraction
 *
 * COST OPTIMIZATION:
 * - Without cache: 4 clips = 4 downloads = $2.00 (at $0.50/download)
 * - With cache: 4 clips = 1 download + local cuts = $0.50 + $0.01 storage = $0.51
 *
 * SAVINGS: ~75% reduction in download costs for multi-clip projects
 */

import fs from 'fs';
import path from 'path';
import { Firestore } from '@google-cloud/firestore';

const firestore = new Firestore();

// Cache expiry time (24 hours)
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Check if we have a cached full video for this videoId
 * @param {string} videoId - YouTube video ID
 * @returns {Promise<{exists: boolean, url?: string, path?: string, expiresAt?: number}>}
 */
async function checkVideoCache(videoId) {
  try {
    const cacheDoc = await firestore.collection('videoSourceCache').doc(videoId).get();

    if (!cacheDoc.exists) {
      return { exists: false };
    }

    const cache = cacheDoc.data();
    const now = Date.now();

    // Check if cache is expired
    if (cache.expiresAt && cache.expiresAt.toMillis() < now) {
      console.log(`[VideoCache] Cache expired for ${videoId}`);
      return { exists: false, expired: true };
    }

    // Check if the file still exists in storage
    if (!cache.storageUrl) {
      return { exists: false };
    }

    console.log(`[VideoCache] Cache HIT for ${videoId}`);
    return {
      exists: true,
      url: cache.storageUrl,
      path: cache.storagePath,
      expiresAt: cache.expiresAt?.toMillis(),
      duration: cache.duration,
      size: cache.size
    };

  } catch (error) {
    console.error(`[VideoCache] Error checking cache:`, error.message);
    return { exists: false };
  }
}

/**
 * Save full video to cache
 * @param {Object} params
 * @param {string} params.videoId - YouTube video ID
 * @param {string} params.localPath - Local file path
 * @param {Object} params.storage - Cloud Storage client
 * @param {string} params.bucketName - Bucket name
 * @param {number} [params.duration] - Video duration in seconds
 * @returns {Promise<{url: string, path: string}>}
 */
async function saveToVideoCache({ videoId, localPath, storage, bucketName, duration }) {
  const storagePath = `video-cache/${videoId}/source.mp4`;

  console.log(`[VideoCache] Uploading full video to cache: ${videoId}`);

  const bucket = storage.bucket(bucketName);
  const file = bucket.file(storagePath);

  // Get file size
  const stats = fs.statSync(localPath);
  const fileSize = stats.size;

  // Upload to Cloud Storage
  await bucket.upload(localPath, {
    destination: storagePath,
    metadata: {
      contentType: 'video/mp4',
      metadata: {
        videoId: videoId,
        cachedAt: new Date().toISOString(),
        duration: duration ? String(duration) : 'unknown'
      }
    }
  });

  // Make the file accessible (with signed URL)
  const [signedUrl] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + CACHE_EXPIRY_MS
  });

  // Also get public URL for internal use
  const publicUrl = `https://storage.googleapis.com/${bucketName}/${storagePath}`;

  // Save cache metadata to Firestore
  await firestore.collection('videoSourceCache').doc(videoId).set({
    videoId: videoId,
    storagePath: storagePath,
    storageUrl: publicUrl,
    signedUrl: signedUrl,
    size: fileSize,
    duration: duration || null,
    cachedAt: Firestore.FieldValue.serverTimestamp(),
    expiresAt: Firestore.Timestamp.fromMillis(Date.now() + CACHE_EXPIRY_MS),
    accessCount: 1
  });

  console.log(`[VideoCache] Cached video ${videoId}: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

  return {
    url: publicUrl,
    path: storagePath,
    signedUrl: signedUrl
  };
}

/**
 * Download cached video to local file
 * @param {Object} params
 * @param {string} params.videoId - YouTube video ID
 * @param {string} params.cacheUrl - Cached video URL
 * @param {string} params.outputPath - Local output path
 * @param {string} params.jobId - Job ID for logging
 * @returns {Promise<string>} - Local file path
 */
async function downloadFromCache({ videoId, cacheUrl, outputPath, jobId }) {
  console.log(`[${jobId}] Downloading from cache: ${videoId}`);

  const response = await fetch(cacheUrl);
  if (!response.ok) {
    throw new Error(`Failed to download from cache: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));

  const stats = fs.statSync(outputPath);
  console.log(`[${jobId}] Downloaded cached video: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

  // Update access count
  try {
    await firestore.collection('videoSourceCache').doc(videoId).update({
      accessCount: Firestore.FieldValue.increment(1),
      lastAccessedAt: Firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    // Non-critical error
  }

  return outputPath;
}

/**
 * Extract segment from cached full video using FFmpeg
 * This is much cheaper than downloading a segment from the API!
 * @param {Object} params
 * @param {string} params.inputPath - Full video path
 * @param {string} params.outputPath - Segment output path
 * @param {number} params.startTime - Start time in seconds
 * @param {number} params.endTime - End time in seconds
 * @param {string} params.jobId - Job ID for logging
 * @returns {Promise<string>} - Segment file path
 */
async function extractSegmentFromCache({ inputPath, outputPath, startTime, endTime, jobId }) {
  const { spawn } = await import('child_process');

  console.log(`[${jobId}] Extracting segment ${startTime}s-${endTime}s from cached video`);

  return new Promise((resolve, reject) => {
    // Use stream copy for speed (no re-encoding)
    const args = [
      '-ss', String(startTime),
      '-i', inputPath,
      '-t', String(endTime - startTime),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-y',
      outputPath
    ];

    const ffmpeg = spawn('ffmpeg', args);
    let stderr = '';

    ffmpeg.stderr.on('data', data => {
      stderr += data.toString();
    });

    ffmpeg.on('close', code => {
      if (code === 0 && fs.existsSync(outputPath)) {
        const stats = fs.statSync(outputPath);
        console.log(`[${jobId}] Extracted segment: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        resolve(outputPath);
      } else {
        console.error(`[${jobId}] Segment extraction failed: ${stderr.slice(-500)}`);
        reject(new Error(`FFmpeg segment extraction failed with code ${code}`));
      }
    });

    ffmpeg.on('error', error => {
      reject(new Error(`FFmpeg spawn error: ${error.message}`));
    });
  });
}

/**
 * Cleanup expired cache entries
 * Can be called periodically by Cloud Scheduler
 */
async function cleanupExpiredCache(storage, bucketName) {
  console.log('[VideoCache] Starting cache cleanup...');

  const now = Firestore.Timestamp.now();

  // Find expired entries
  const expiredDocs = await firestore.collection('videoSourceCache')
    .where('expiresAt', '<', now)
    .limit(100)
    .get();

  if (expiredDocs.empty) {
    console.log('[VideoCache] No expired entries found');
    return { cleaned: 0 };
  }

  let cleaned = 0;
  const bucket = storage.bucket(bucketName);

  for (const doc of expiredDocs.docs) {
    const cache = doc.data();

    try {
      // Delete from storage
      if (cache.storagePath) {
        await bucket.file(cache.storagePath).delete();
      }

      // Delete from Firestore
      await doc.ref.delete();

      cleaned++;
      console.log(`[VideoCache] Cleaned: ${cache.videoId}`);
    } catch (error) {
      console.error(`[VideoCache] Failed to clean ${cache.videoId}:`, error.message);
    }
  }

  console.log(`[VideoCache] Cleanup complete: ${cleaned} entries removed`);
  return { cleaned };
}

export {
  checkVideoCache,
  saveToVideoCache,
  downloadFromCache,
  extractSegmentFromCache,
  cleanupExpiredCache
};
