/**
 * Video Processor
 * Core video processing logic using FFmpeg and youtubei.js
 *
 * COST OPTIMIZATION:
 * This processor now uses video caching to reduce download costs by ~75%
 * - First clip: Downloads full video, caches to Cloud Storage
 * - Subsequent clips: Uses cached video, extracts segment locally (FREE)
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Firestore } from '@google-cloud/firestore';
import { downloadVideoSegment, downloadFullVideo } from './youtube-downloader.js';
import {
  checkVideoCache,
  saveToVideoCache,
  downloadFromCache,
  extractSegmentFromCache
} from './video-cache.js';
import { generateCaptions } from './caption-renderer.js';

/**
 * Main video processing function
 * @param {Object} params
 * @param {string} params.jobId - The job ID
 * @param {Object} params.jobRef - Firestore job reference
 * @param {Object} params.job - Job data
 * @param {Object} params.storage - Cloud Storage client
 * @param {string} params.bucketName - Storage bucket name
 * @param {string} params.tempDir - Temp directory path
 * @param {Object} [params.youtubeAuth] - Optional YouTube OAuth credentials
 */
async function processVideo({ jobId, jobRef, job, storage, bucketName, tempDir, youtubeAuth }) {
  const workDir = path.join(tempDir, jobId);

  try {
    // Create working directory
    fs.mkdirSync(workDir, { recursive: true });
    console.log(`[${jobId}] Created work directory: ${workDir}`);

    let downloadedFile;

    // Detect if running on server (Cloud Run) - extension URLs won't work due to IP restriction
    const isRunningOnServer = process.env.NODE_ENV === 'production' ||
                               process.env.K_SERVICE || // Cloud Run sets this
                               process.env.GOOGLE_CLOUD_PROJECT;

    // Check if this is an uploaded video
    if (job.isUpload && job.uploadedVideoUrl) {
      console.log(`[${jobId}] Processing uploaded video - downloading from storage...`);
      await updateProgress(jobRef, 10, 'Downloading uploaded video...');

      // Download the uploaded video from Firebase Storage
      const response = await fetch(job.uploadedVideoUrl);
      if (!response.ok) {
        throw new Error(`Failed to download uploaded video: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      downloadedFile = path.join(workDir, 'source.mp4');
      fs.writeFileSync(downloadedFile, Buffer.from(buffer));
      console.log(`[${jobId}] Downloaded uploaded video: ${fs.statSync(downloadedFile).size} bytes`);

      // For uploaded videos, we need to extract the segment
      // Note: Always extract if duration is unknown (undefined) to be safe
      const needsExtraction = job.startTime > 0 ||
                              (job.duration && job.endTime < job.duration) ||
                              (!job.duration && job.endTime); // Extract if duration unknown but endTime specified
      if (needsExtraction) {
        const segmentFile = path.join(workDir, 'segment.mp4');
        await new Promise((resolve, reject) => {
          // spawn is already imported at top of file (ES module)
          const ffmpeg = spawn('ffmpeg', [
            '-i', downloadedFile,
            '-ss', String(job.startTime),
            '-to', String(job.endTime),
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            '-y',
            segmentFile
          ]);

          ffmpeg.stderr.on('data', data => console.log(`[${jobId}] ffmpeg: ${data.toString().substring(0, 100)}`));
          ffmpeg.on('close', code => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`ffmpeg segment extraction failed with code ${code}`));
            }
          });
        });
        downloadedFile = segmentFile;
        console.log(`[${jobId}] Extracted segment from ${job.startTime}s to ${job.endTime}s`);
      }
    } else if (job.hasExtensionStream && job.extensionStreamData?.videoUrl) {
      // Extension-captured video - check if we should try these URLs
      // IMPORTANT: Extension stream URLs are IP-restricted to user's browser IP
      // When running on server (Cloud Run), these ALWAYS fail with 403, so skip them

      const extensionStreamSource = job.extensionStreamData?.source || 'unknown';
      // These capture methods upload video to storage and bypass IP-restriction:
      // - mediarecorder_primary: Primary capture method (v2.1+)
      // - mediarecorder_capture: Legacy capture method
      // - mediarecorder_local: Captured but server unavailable (frontend uploaded)
      // - browser_download: Direct download method
      const uploadedCaptureSources = ['mediarecorder_primary', 'mediarecorder_capture', 'mediarecorder_local', 'browser_download'];
      const isUploadedCapture = uploadedCaptureSources.includes(extensionStreamSource) &&
                                 job.extensionStreamData?.uploadedToStorage;

      if (isUploadedCapture) {
        // Captured/downloaded video was uploaded to our storage - use it directly
        console.log(`[${jobId}] Using ${extensionStreamSource} video from storage (bypasses IP restriction)`);
        await updateProgress(jobRef, 10, 'Downloading captured video...');

        try {
          const response = await fetch(job.extensionStreamData.videoUrl);
          if (!response.ok) {
            throw new Error(`Failed to download captured video: ${response.status}`);
          }

          const buffer = await response.arrayBuffer();
          // MediaRecorder produces webm, browser_download produces mp4
          const fileExt = extensionStreamSource === 'browser_download' ? 'mp4' : 'webm';
          const capturedFile = path.join(workDir, `captured.${fileExt}`);
          fs.writeFileSync(capturedFile, Buffer.from(buffer));
          console.log(`[${jobId}] Downloaded ${extensionStreamSource}: ${fs.statSync(capturedFile).size} bytes`);

          // Check if we need to extract a specific segment from the captured video
          // The extension may have captured more than needed (e.g., full 5 minutes)
          // while the clip only needs a portion (e.g., 30 seconds at 2:00)
          const capturedStart = job.extensionStreamData?.captureStartTime || 0;
          const capturedEnd = job.extensionStreamData?.captureEndTime || 300;
          const clipStart = job.startTime || 0;
          const clipEnd = job.endTime || (clipStart + 60);

          // Calculate if segment extraction is needed
          const needsExtraction = (clipStart > capturedStart) || (clipEnd < capturedEnd);

          if (needsExtraction && clipStart >= capturedStart && clipEnd <= capturedEnd) {
            // Extract the specific segment from the captured video
            const relativeStart = clipStart - capturedStart;
            const relativeEnd = clipEnd - capturedStart;
            console.log(`[${jobId}] Extracting segment ${relativeStart}s-${relativeEnd}s from captured video`);
            await updateProgress(jobRef, 15, 'Extracting clip segment...');

            downloadedFile = path.join(workDir, `source.${fileExt}`);
            await new Promise((resolve, reject) => {
              const ffmpeg = spawn('ffmpeg', [
                '-i', capturedFile,
                '-ss', String(relativeStart),
                '-to', String(relativeEnd),
                '-c', 'copy',
                '-avoid_negative_ts', 'make_zero',
                '-y',
                downloadedFile
              ]);

              let stderr = '';
              ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });
              ffmpeg.on('close', (code) => {
                if (code === 0 && fs.existsSync(downloadedFile)) {
                  console.log(`[${jobId}] Segment extracted: ${fs.statSync(downloadedFile).size} bytes`);
                  resolve();
                } else {
                  reject(new Error(`FFmpeg segment extraction failed: ${stderr.slice(-200)}`));
                }
              });
              ffmpeg.on('error', reject);
            });

            // Cleanup captured file
            try { fs.unlinkSync(capturedFile); } catch (e) {}
          } else {
            // Use the captured file directly (segment already matches or no extraction needed)
            downloadedFile = capturedFile;
            console.log(`[${jobId}] Using captured video directly (segment matches or full capture)`);
          }
        } catch (captureError) {
          console.warn(`[${jobId}] Extension capture download failed: ${captureError.message}`);
          console.log(`[${jobId}] Falling back to Video Download API...`);
          await updateProgress(jobRef, 12, 'Capture failed, using download API...');

          downloadedFile = await downloadVideoSegment({
            jobId,
            videoId: job.videoId,
            startTime: job.startTime,
            endTime: job.endTime,
            workDir,
            youtubeAuth
          });
        }
      } else if (isRunningOnServer) {
        // Running on server - skip extension stream URLs (they're IP-restricted and will always fail)
        console.log(`[${jobId}] Running on server - skipping extension stream URLs (IP-restricted)`);
        console.log(`[${jobId}] Extension stream source: ${extensionStreamSource}`);
        console.log(`[${jobId}] Going directly to Video Download API for reliability`);
        await updateProgress(jobRef, 10, 'Downloading video...');

        downloadedFile = await downloadVideoSegment({
          jobId,
          videoId: job.videoId,
          startTime: job.startTime,
          endTime: job.endTime,
          workDir,
          youtubeAuth
        });
      } else {
        // Not on server (local dev) - can try extension streams
        console.log(`[${jobId}] Local environment - attempting extension stream URLs`);
        await updateProgress(jobRef, 10, 'Trying extension capture...');

        try {
          downloadedFile = await downloadFromExtensionStream({
            jobId,
            extensionStreamData: job.extensionStreamData,
            startTime: job.startTime,
            endTime: job.endTime,
            workDir
          });
          console.log(`[${jobId}] Extension stream download succeeded`);
        } catch (extStreamError) {
          console.warn(`[${jobId}] Extension stream failed (${extStreamError.message}), falling back to server download...`);
          await updateProgress(jobRef, 12, 'Extension failed, trying server download...');

          downloadedFile = await downloadVideoSegment({
            jobId,
            videoId: job.videoId,
            startTime: job.startTime,
            endTime: job.endTime,
            workDir,
            youtubeAuth
          });
        }
      }
    } else {
      // YouTube video - use CACHING for cost optimization
      // This reduces download costs by ~75% for multi-clip projects
      await updateProgress(jobRef, 10, 'Checking video cache...');

      // Check if we have a cached full video
      const cache = await checkVideoCache(job.videoId);

      if (cache.exists) {
        // CACHE HIT - Download from cache and extract segment locally (FREE!)
        console.log(`[${jobId}] CACHE HIT: Using cached video for ${job.videoId}`);
        await updateProgress(jobRef, 12, 'Using cached video (cost savings!)...');

        const cachedVideoPath = path.join(workDir, 'cached_source.mp4');
        await downloadFromCache({
          videoId: job.videoId,
          cacheUrl: cache.url,
          outputPath: cachedVideoPath,
          jobId
        });

        // Extract segment locally (FREE - no API cost!)
        downloadedFile = path.join(workDir, 'source.mp4');
        await extractSegmentFromCache({
          inputPath: cachedVideoPath,
          outputPath: downloadedFile,
          startTime: job.startTime,
          endTime: job.endTime,
          jobId
        });

        // Cleanup cached source to save disk space
        try { fs.unlinkSync(cachedVideoPath); } catch (e) {}

        console.log(`[${jobId}] CACHE: Segment extracted locally - ZERO download cost!`);

      } else {
        // CACHE MISS - Download full video and cache it for future clips
        console.log(`[${jobId}] CACHE MISS: Downloading and caching full video...`);
        await updateProgress(jobRef, 12, 'Downloading full video for caching...');

        try {
          // Download full video (cheaper than segment download!)
          const fullVideoPath = path.join(workDir, 'full_video.mp4');
          const downloadResult = await downloadFullVideo({
            jobId,
            videoId: job.videoId,
            workDir,
            outputFile: fullVideoPath
          });

          // Cache the full video for future clips
          await updateProgress(jobRef, 18, 'Caching video for future clips...');
          await saveToVideoCache({
            videoId: job.videoId,
            localPath: fullVideoPath,
            storage,
            bucketName
          });

          // Extract segment locally
          downloadedFile = path.join(workDir, 'source.mp4');
          await extractSegmentFromCache({
            inputPath: fullVideoPath,
            outputPath: downloadedFile,
            startTime: job.startTime,
            endTime: job.endTime,
            jobId
          });

          // Cleanup full video to save disk space
          try { fs.unlinkSync(fullVideoPath); } catch (e) {}

          console.log(`[${jobId}] CACHE: Full video cached - future clips will be FREE!`);

        } catch (cacheError) {
          // Fallback to segment download if caching fails
          console.warn(`[${jobId}] CACHE: Caching failed (${cacheError.message}), falling back to segment download...`);
          await updateProgress(jobRef, 15, 'Downloading video segment...');

          downloadedFile = await downloadVideoSegment({
            jobId,
            videoId: job.videoId,
            startTime: job.startTime,
            endTime: job.endTime,
            workDir,
            youtubeAuth
          });
        }
      }
    }

    await updateProgress(jobRef, 30, 'Processing video...');

    // Step 2: Process the video (crop to 9:16, apply effects)
    const processedFile = await processVideoFile({
      jobId,
      inputFile: downloadedFile,
      settings: job.settings,
      output: job.output,
      workDir
    });

    await updateProgress(jobRef, 70, 'Applying effects...');

    // Step 3: Apply transitions if specified
    let finalFile = processedFile;
    const introTransition = job.settings?.introTransition || 'none';
    const outroTransition = job.settings?.outroTransition || 'none';
    if (introTransition !== 'none' || outroTransition !== 'none') {
      finalFile = await applyTransitions({
        jobId,
        inputFile: processedFile,
        introTransition,
        outroTransition,
        workDir
      });
    }

    await updateProgress(jobRef, 85, 'Uploading...');

    // Step 4: Upload to Cloud Storage
    const result = await uploadToStorage({
      jobId,
      filePath: finalFile,
      storage,
      bucketName,
      userId: job.userId,
      clipId: job.clipId
    });

    await updateProgress(jobRef, 95, 'Finalizing...');

    // Cleanup
    cleanupWorkDir(workDir);

    return result;

  } catch (error) {
    // Cleanup on error
    cleanupWorkDir(workDir);
    throw error;
  }
}

// downloadVideoSegment is imported from youtube-downloader.js
// Uses youtubei.js with automatic PO token generation to bypass bot detection

/**
 * Download video from extension-captured stream URLs
 * Uses direct stream URLs provided by the browser extension
 */
async function downloadFromExtensionStream({ jobId, extensionStreamData, startTime, endTime, workDir }) {
  console.log(`[${jobId}] Downloading from extension stream URLs`);

  const { videoUrl, audioUrl, quality } = extensionStreamData;
  const outputFile = path.join(workDir, 'segment.mp4');

  // Check if stream URLs are still valid (they expire after some time)
  const capturedAt = extensionStreamData.capturedAt || 0;
  const now = Date.now();
  const ageMinutes = (now - capturedAt) / (1000 * 60);

  if (ageMinutes > 30) {
    console.log(`[${jobId}] Extension stream URLs are ${ageMinutes.toFixed(1)} minutes old, may have expired`);
  }

  try {
    if (audioUrl) {
      // Download video and audio separately, then merge
      console.log(`[${jobId}] Downloading video stream (${quality || 'unknown quality'})...`);
      const videoFile = path.join(workDir, 'video_only.mp4');
      const audioFile = path.join(workDir, 'audio_only.m4a');

      // Download video stream
      const videoResponse = await fetch(videoUrl);
      if (!videoResponse.ok) {
        throw new Error(`Video stream download failed: ${videoResponse.status}`);
      }
      const videoBuffer = await videoResponse.arrayBuffer();
      fs.writeFileSync(videoFile, Buffer.from(videoBuffer));
      console.log(`[${jobId}] Downloaded video: ${fs.statSync(videoFile).size} bytes`);

      // Download audio stream
      console.log(`[${jobId}] Downloading audio stream...`);
      const audioResponse = await fetch(audioUrl);
      if (!audioResponse.ok) {
        throw new Error(`Audio stream download failed: ${audioResponse.status}`);
      }
      const audioBuffer = await audioResponse.arrayBuffer();
      fs.writeFileSync(audioFile, Buffer.from(audioBuffer));
      console.log(`[${jobId}] Downloaded audio: ${fs.statSync(audioFile).size} bytes`);

      // Merge video and audio with FFmpeg, and extract segment
      console.log(`[${jobId}] Merging video and audio, extracting segment ${startTime}s to ${endTime}s...`);
      await new Promise((resolve, reject) => {
        const args = [
          '-i', videoFile,
          '-i', audioFile,
          '-ss', String(startTime),
          '-to', String(endTime),
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-avoid_negative_ts', 'make_zero',
          '-y',
          outputFile
        ];

        const ffmpeg = spawn('ffmpeg', args);

        let stderr = '';
        ffmpeg.stderr.on('data', data => {
          stderr += data.toString();
        });

        ffmpeg.on('close', code => {
          if (code === 0) {
            console.log(`[${jobId}] Merge and segment extraction complete`);
            resolve();
          } else {
            console.error(`[${jobId}] FFmpeg merge failed: ${stderr.slice(-500)}`);
            reject(new Error(`FFmpeg merge failed with code ${code}`));
          }
        });
      });
    } else {
      // Video-only stream (audio might be embedded)
      console.log(`[${jobId}] Downloading combined stream (${quality || 'unknown quality'})...`);
      const tempFile = path.join(workDir, 'temp_source.mp4');

      const response = await fetch(videoUrl);
      if (!response.ok) {
        throw new Error(`Stream download failed: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      fs.writeFileSync(tempFile, Buffer.from(buffer));
      console.log(`[${jobId}] Downloaded video: ${fs.statSync(tempFile).size} bytes`);

      // Extract segment with FFmpeg
      console.log(`[${jobId}] Extracting segment ${startTime}s to ${endTime}s...`);
      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-i', tempFile,
          '-ss', String(startTime),
          '-to', String(endTime),
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero',
          '-y',
          outputFile
        ]);

        ffmpeg.stderr.on('data', data => {
          console.log(`[${jobId}] ffmpeg: ${data.toString().substring(0, 100)}`);
        });

        ffmpeg.on('close', code => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`FFmpeg segment extraction failed with code ${code}`));
          }
        });
      });
    }

    if (!fs.existsSync(outputFile)) {
      throw new Error('Output file was not created');
    }

    console.log(`[${jobId}] Extension stream download complete: ${fs.statSync(outputFile).size} bytes`);
    return outputFile;

  } catch (error) {
    console.error(`[${jobId}] Extension stream download failed:`, error.message);
    throw error;
  }
}

/**
 * Process video file with FFmpeg (crop, scale, enhance)
 */
async function processVideoFile({ jobId, inputFile, settings, output, workDir }) {
  const outputFile = path.join(workDir, 'processed.mp4');

  // Get input video info
  const videoInfo = await getVideoInfo(inputFile);
  console.log(`[${jobId}] Input video: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration}s`);

  // Calculate crop for 9:16 aspect ratio (with safe defaults)
  const targetWidth = output?.resolution?.width || 1080;   // Default to 1080
  const targetHeight = output?.resolution?.height || 1920; // Default to 1920
  const targetAspect = 9 / 16;

  // Ensure settings has defaults to prevent crashes
  const safeSettings = settings || {};

  // Generate captions if requested
  let captionFile = null;
  if (safeSettings.captionStyle && safeSettings.captionStyle !== 'none') {
    console.log(`[${jobId}] Generating captions with style: ${safeSettings.captionStyle}`);
    try {
      captionFile = await generateCaptions({
        jobId,
        videoFile: inputFile,
        workDir,
        captionStyle: safeSettings.captionStyle,
        customStyle: safeSettings.customCaptionStyle
      });
    } catch (captionError) {
      console.error(`[${jobId}] Caption generation failed (continuing without captions):`, captionError.message);
    }
  }

  // Build FFmpeg filter chain
  let filters = buildFilterChain({
    inputWidth: videoInfo.width,
    inputHeight: videoInfo.height,
    targetWidth,
    targetHeight,
    reframeMode: safeSettings.reframeMode || 'auto_center',
    cropPosition: safeSettings.cropPosition || 'center',
    autoZoom: safeSettings.autoZoom,
    vignette: safeSettings.vignette,
    colorGrade: safeSettings.colorGrade
  });

  // Add subtitle filter if captions were generated
  if (captionFile && fs.existsSync(captionFile)) {
    // Escape special characters in path for FFmpeg
    const escapedPath = captionFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
    filters = `${filters},ass='${escapedPath}'`;
    console.log(`[${jobId}] Adding captions from: ${captionFile}`);
  }

  // Build audio filters
  const audioFilters = buildAudioFilters({
    enhanceAudio: safeSettings.enhanceAudio,
    removeFiller: safeSettings.removeFiller
  });

  // Get FPS with safe default
  const targetFps = output?.fps || 30;

  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputFile,
      '-vf', filters,
      '-af', audioFilters,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-r', targetFps.toString(),
      '-movflags', '+faststart',
      '-y',
      outputFile
    ];

    console.log(`[${jobId}] FFmpeg command: ffmpeg ${args.join(' ')}`);

    const ffmpegProcess = spawn('ffmpeg', args);

    let stderr = '';

    ffmpegProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      // Log progress from FFmpeg
      const match = stderr.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (match) {
        console.log(`[${jobId}] FFmpeg progress: ${match[1]}`);
      }
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputFile)) {
        console.log(`[${jobId}] Processing completed: ${outputFile}`);
        resolve(outputFile);
      } else {
        console.error(`[${jobId}] FFmpeg failed. Code: ${code}`);
        console.error(`[${jobId}] stderr: ${stderr.slice(-500)}`);
        reject(new Error(`Video processing failed: ${code}`));
      }
    });

    ffmpegProcess.on('error', (error) => {
      reject(new Error(`Failed to start FFmpeg: ${error.message}`));
    });
  });
}

/**
 * Build FFmpeg video filter chain
 */
function buildFilterChain({ inputWidth, inputHeight, targetWidth, targetHeight, reframeMode, cropPosition, autoZoom, vignette, colorGrade }) {
  const filters = [];
  const inputAspect = inputWidth / inputHeight;
  const targetAspect = targetWidth / targetHeight; // 9:16 = 0.5625

  // Normalize reframe mode names (frontend uses 'broll_split', backend used 'b_roll')
  const normalizedMode = reframeMode === 'broll_split' ? 'b_roll' : reframeMode;

  // Step 1: Reframe/Crop based on mode
  switch (normalizedMode) {
    case 'split_screen':
      // Split screen: Show left and right speakers stacked vertically (for podcasts)
      // Take left 1/3 and right 1/3 of the video, stack them
      const splitCropW = Math.floor(inputWidth / 3);
      const splitHalfH = Math.floor(targetHeight / 2);
      filters.push(`split[left][right]`);
      filters.push(`[left]crop=${splitCropW}:${inputHeight}:0:0,scale=${targetWidth}:${splitHalfH}:force_original_aspect_ratio=increase,crop=${targetWidth}:${splitHalfH}[l]`);
      filters.push(`[right]crop=${splitCropW}:${inputHeight}:${inputWidth - splitCropW}:0,scale=${targetWidth}:${splitHalfH}:force_original_aspect_ratio=increase,crop=${targetWidth}:${splitHalfH}[r]`);
      filters.push(`[l][r]vstack`);
      break;

    case 'three_person':
      // Three person: Show three speakers - top (center), bottom-left, bottom-right
      const thirdW = Math.floor(inputWidth / 3);
      const topH = Math.floor(targetHeight * 0.55);
      const bottomH = targetHeight - topH;
      const halfTargetW = Math.floor(targetWidth / 2);
      filters.push(`split=3[center][bl][br]`);
      filters.push(`[center]crop=${thirdW}:${inputHeight}:${thirdW}:0,scale=${targetWidth}:${topH}:force_original_aspect_ratio=increase,crop=${targetWidth}:${topH}[c]`);
      filters.push(`[bl]crop=${thirdW}:${inputHeight}:0:0,scale=${halfTargetW}:${bottomH}:force_original_aspect_ratio=increase,crop=${halfTargetW}:${bottomH}[left]`);
      filters.push(`[br]crop=${thirdW}:${inputHeight}:${2 * thirdW}:0,scale=${halfTargetW}:${bottomH}:force_original_aspect_ratio=increase,crop=${halfTargetW}:${bottomH}[right]`);
      filters.push(`[left][right]hstack[bottom]`);
      filters.push(`[c][bottom]vstack`);
      break;

    case 'gameplay':
      // Gameplay mode: Main video fills most, small facecam area in corner
      // First crop to 9:16, then overlay facecam area
      if (inputAspect > targetAspect) {
        const gameCropW = Math.floor(inputHeight * targetAspect);
        const gameCropX = Math.floor((inputWidth - gameCropW) / 2);
        // Show more of the main game area, with a circle/facecam indicator
        filters.push(`crop=${gameCropW}:${inputHeight}:${gameCropX}:0`);
      } else {
        const gameCropH = Math.floor(inputWidth / targetAspect);
        const gameCropY = Math.floor((inputHeight - gameCropH) / 2);
        filters.push(`crop=${inputWidth}:${gameCropH}:0:${gameCropY}`);
      }
      filters.push(`scale=${targetWidth}:${targetHeight}`);
      // Add a subtle border/glow to indicate facecam area at bottom-left
      const camSize = Math.floor(targetWidth * 0.35);
      const camPadding = 20;
      filters.push(`drawbox=x=${camPadding}:y=${targetHeight - camSize - camPadding}:w=${camSize}:h=${camSize}:color=white@0.3:t=3`);
      break;

    case 'b_roll':
      // B-roll mode: Currently same as auto_center (B-roll would need additional footage)
      // Future: Could add picture-in-picture or overlay effects
      if (inputAspect > targetAspect) {
        const brollCropW = Math.floor(inputHeight * targetAspect);
        const brollCropX = Math.floor((inputWidth - brollCropW) / 2);
        filters.push(`crop=${brollCropW}:${inputHeight}:${brollCropX}:0`);
      } else {
        const brollCropH = Math.floor(inputWidth / targetAspect);
        const brollCropY = Math.floor((inputHeight - brollCropH) / 2);
        filters.push(`crop=${inputWidth}:${brollCropH}:0:${brollCropY}`);
      }
      filters.push(`scale=${targetWidth}:${targetHeight}`);
      // Add subtle Ken Burns effect for B-roll feel
      filters.push(`zoompan=z='if(eq(on,1),1,zoom+0.0003)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${targetWidth}x${targetHeight}:fps=${30}`);
      break;

    case 'auto_center':
    default:
      // Crop to 9:16 based on cropPosition (left/center/right)
      if (inputAspect > targetAspect) {
        // Video is wider than target - crop sides based on position
        const cropWidth = Math.floor(inputHeight * targetAspect);
        let cropX;
        if (cropPosition === 'left') {
          cropX = 0; // Crop from left edge
        } else if (cropPosition === 'right') {
          cropX = inputWidth - cropWidth; // Crop from right edge
        } else {
          cropX = Math.floor((inputWidth - cropWidth) / 2); // Center crop (default)
        }
        filters.push(`crop=${cropWidth}:${inputHeight}:${cropX}:0`);
      } else {
        // Video is taller than target - crop top/bottom (position doesn't apply here)
        const cropHeight = Math.floor(inputWidth / targetAspect);
        const cropY = Math.floor((inputHeight - cropHeight) / 2);
        filters.push(`crop=${inputWidth}:${cropHeight}:0:${cropY}`);
      }
      // Scale to target resolution
      filters.push(`scale=${targetWidth}:${targetHeight}`);
      break;
  }

  // Step 2: Apply visual effects (but not for complex filter chains)
  const isComplexFilter = ['split_screen', 'three_person'].includes(normalizedMode);

  if (!isComplexFilter) {
    if (autoZoom && normalizedMode !== 'b_roll') {
      // Subtle zoom pulse effect
      filters.push(`zoompan=z='1+0.02*sin(2*PI*t/5)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${targetWidth}x${targetHeight}`);
    }

    if (vignette) {
      // Add vignette effect
      filters.push(`vignette=angle=PI/4:mode=forward`);
    }

    if (colorGrade) {
      // Enhance colors for social media (slight saturation boost, contrast)
      filters.push(`eq=saturation=1.15:contrast=1.05:brightness=0.02`);
      filters.push(`unsharp=5:5:0.8:5:5:0`);
    }
  }

  return filters.join(',');
}

/**
 * Build FFmpeg audio filter chain
 */
function buildAudioFilters({ enhanceAudio, removeFiller }) {
  const filters = [];

  if (enhanceAudio) {
    // Audio normalization
    filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
    // High-pass filter to remove rumble
    filters.push('highpass=f=80');
    // Slight compression
    filters.push('acompressor=threshold=-20dB:ratio=4:attack=5:release=50');
  }

  // Default passthrough if no filters
  if (filters.length === 0) {
    filters.push('anull');
  }

  return filters.join(',');
}

/**
 * Apply intro/outro transitions
 */
async function applyTransitions({ jobId, inputFile, introTransition, outroTransition, workDir }) {
  const outputFile = path.join(workDir, 'final.mp4');

  // Get video duration
  const videoInfo = await getVideoInfo(inputFile);
  const duration = videoInfo.duration;

  const filters = [];
  let filterComplex = '';

  // Intro transition
  if (introTransition && introTransition !== 'none') {
    const fadeIn = getTransitionFilter(introTransition, 'in', 0, 0.5);
    filters.push(fadeIn);
  }

  // Outro transition
  if (outroTransition && outroTransition !== 'none') {
    const fadeOut = getTransitionFilter(outroTransition, 'out', duration - 0.5, 0.5);
    filters.push(fadeOut);
  }

  if (filters.length === 0) {
    // No transitions, just copy
    fs.copyFileSync(inputFile, outputFile);
    return outputFile;
  }

  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputFile,
      '-vf', filters.join(','),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'copy',
      '-y',
      outputFile
    ];

    const ffmpegProcess = spawn('ffmpeg', args);

    ffmpegProcess.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputFile)) {
        console.log(`[${jobId}] Transitions applied: ${outputFile}`);
        resolve(outputFile);
      } else {
        // If transitions fail, use original file
        console.log(`[${jobId}] Transitions failed, using original`);
        resolve(inputFile);
      }
    });

    ffmpegProcess.on('error', () => {
      resolve(inputFile);
    });
  });
}

/**
 * Get transition filter string
 */
function getTransitionFilter(type, direction, startTime, duration) {
  const isIn = direction === 'in';

  switch (type) {
    case 'fade':
      return isIn
        ? `fade=t=in:st=${startTime}:d=${duration}`
        : `fade=t=out:st=${startTime}:d=${duration}`;

    case 'zoom':
      return isIn
        ? `zoompan=z='if(lte(t,${duration}),1.2-0.2*t/${duration},1)':d=1:s=1080x1920`
        : `zoompan=z='if(gte(t,${startTime}),1+0.2*(t-${startTime})/${duration},1)':d=1:s=1080x1920`;

    case 'slide':
      return isIn
        ? `crop=iw:ih:0:'if(lte(t,${duration}),ih*(1-t/${duration}),0)'`
        : `crop=iw:ih:0:'if(gte(t,${startTime}),ih*(t-${startTime})/${duration},0)'`;

    case 'glitch':
      // Simple glitch effect using color channel offset
      return isIn
        ? `rgbashift=rh=5:rv=-5:gh=-5:gv=5:bh=3:bv=-3:enable='lte(t,${duration})'`
        : `rgbashift=rh=5:rv=-5:gh=-5:gv=5:bh=3:bv=-3:enable='gte(t,${startTime})'`;

    default:
      return '';
  }
}

/**
 * Get video information using FFprobe
 */
async function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    const result = execSync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`,
      { encoding: 'utf8' }
    );

    try {
      const info = JSON.parse(result);
      const videoStream = info.streams.find(s => s.codec_type === 'video');

      resolve({
        width: videoStream.width,
        height: videoStream.height,
        duration: parseFloat(info.format.duration),
        bitrate: parseInt(info.format.bit_rate)
      });
    } catch (error) {
      reject(new Error('Failed to parse video info'));
    }
  });
}

/**
 * Upload processed video to Cloud Storage
 */
async function uploadToStorage({ jobId, filePath, storage, bucketName, userId, clipId }) {
  const fileName = `processed-clips/${userId}/${clipId}-${Date.now()}.mp4`;
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(fileName);

  console.log(`[${jobId}] Uploading to: ${fileName}`);

  const fileSize = fs.statSync(filePath).size;

  await bucket.upload(filePath, {
    destination: fileName,
    metadata: {
      contentType: 'video/mp4',
      metadata: {
        jobId,
        clipId,
        userId,
        processedAt: new Date().toISOString()
      }
    }
  });

  // Make the file publicly accessible
  await file.makePublic();

  const publicUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
  console.log(`[${jobId}] Upload completed: ${publicUrl}`);

  return {
    outputUrl: publicUrl,
    outputPath: fileName,
    outputSize: fileSize
  };
}

/**
 * Update job progress in Firestore
 */
async function updateProgress(jobRef, progress, message) {
  await jobRef.update({
    progress,
    statusMessage: message,
    updatedAt: Firestore.FieldValue.serverTimestamp()
  });
}

/**
 * Cleanup working directory
 */
function cleanupWorkDir(workDir) {
  try {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
      console.log(`Cleaned up: ${workDir}`);
    }
  } catch (error) {
    console.error(`Cleanup error: ${error.message}`);
  }
}

export { processVideo };
