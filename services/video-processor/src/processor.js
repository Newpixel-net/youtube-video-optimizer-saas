/**
 * Video Processor
 * Core video processing logic using FFmpeg and youtubei.js
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Firestore } from '@google-cloud/firestore';
import { downloadVideoSegment } from './youtube-downloader.js';

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

    // Update progress
    await updateProgress(jobRef, 10, 'Downloading video...');

    // Step 1: Download the video segment
    const downloadedFile = await downloadVideoSegment({
      jobId,
      videoId: job.videoId,
      startTime: job.startTime,
      endTime: job.endTime,
      workDir,
      youtubeAuth // Pass user's YouTube OAuth credentials if available
    });

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
    if (job.settings.introTransition !== 'none' || job.settings.outroTransition !== 'none') {
      finalFile = await applyTransitions({
        jobId,
        inputFile: processedFile,
        introTransition: job.settings.introTransition,
        outroTransition: job.settings.outroTransition,
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
 * Process video file with FFmpeg (crop, scale, enhance)
 */
async function processVideoFile({ jobId, inputFile, settings, output, workDir }) {
  const outputFile = path.join(workDir, 'processed.mp4');

  // Get input video info
  const videoInfo = await getVideoInfo(inputFile);
  console.log(`[${jobId}] Input video: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration}s`);

  // Calculate crop for 9:16 aspect ratio
  const targetWidth = output.resolution.width;   // 720 or 1080
  const targetHeight = output.resolution.height; // 1280 or 1920
  const targetAspect = 9 / 16;

  // Build FFmpeg filter chain
  const filters = buildFilterChain({
    inputWidth: videoInfo.width,
    inputHeight: videoInfo.height,
    targetWidth,
    targetHeight,
    reframeMode: settings.reframeMode,
    autoZoom: settings.autoZoom,
    vignette: settings.vignette,
    colorGrade: settings.colorGrade
  });

  // Build audio filters
  const audioFilters = buildAudioFilters({
    enhanceAudio: settings.enhanceAudio,
    removeFiller: settings.removeFiller
  });

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
      '-r', output.fps.toString(),
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
function buildFilterChain({ inputWidth, inputHeight, targetWidth, targetHeight, reframeMode, autoZoom, vignette, colorGrade }) {
  const filters = [];
  const inputAspect = inputWidth / inputHeight;
  const targetAspect = targetWidth / targetHeight; // 9:16 = 0.5625

  // Step 1: Reframe/Crop based on mode
  switch (reframeMode) {
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
      // Center crop to 9:16
      if (inputAspect > targetAspect) {
        // Video is wider than target - crop sides
        const cropWidth = Math.floor(inputHeight * targetAspect);
        const cropX = Math.floor((inputWidth - cropWidth) / 2);
        filters.push(`crop=${cropWidth}:${inputHeight}:${cropX}:0`);
      } else {
        // Video is taller than target - crop top/bottom
        const cropHeight = Math.floor(inputWidth / targetAspect);
        const cropY = Math.floor((inputHeight - cropHeight) / 2);
        filters.push(`crop=${inputWidth}:${cropHeight}:0:${cropY}`);
      }
      // Scale to target resolution
      filters.push(`scale=${targetWidth}:${targetHeight}`);
      break;
  }

  // Step 2: Apply visual effects (but not for complex filter chains)
  const isComplexFilter = ['split_screen', 'three_person'].includes(reframeMode);

  if (!isComplexFilter) {
    if (autoZoom && reframeMode !== 'b_roll') {
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
