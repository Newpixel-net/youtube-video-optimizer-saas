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
import { isGpuAvailable, getEncodingParams, getGpuStatus } from './gpu-encoder.js';

// GPU availability - LAZY initialization (don't check at module load to speed up startup)
let gpuEnabled = null;
let gpuChecked = false;

function checkGpuIfNeeded() {
  if (gpuChecked) return gpuEnabled;

  gpuChecked = true;
  try {
    gpuEnabled = isGpuAvailable();
    console.log(`[Processor] GPU enabled: ${gpuEnabled}`);
  } catch (e) {
    console.log(`[Processor] GPU detection failed: ${e.message}, using CPU encoding`);
    gpuEnabled = false;
  }
  return gpuEnabled;
}

/**
 * Validate encoded video output to detect frozen video issues
 * Returns true if video appears valid, false if it seems frozen
 * @param {string} videoPath - Path to the encoded video file
 * @param {number} expectedDuration - Expected duration in seconds
 * @returns {Object} Validation result with isValid flag and details
 */
function validateVideoOutput(videoPath, expectedDuration = 30) {
  try {
    // Get frame count
    const frameCountResult = execSync(
      `ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
      { encoding: 'utf8', timeout: 60000 }
    ).trim();

    const frameCount = parseInt(frameCountResult, 10);

    // Get duration
    const durationResult = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
      { encoding: 'utf8', timeout: 30000 }
    ).trim();

    const duration = parseFloat(durationResult);

    // Calculate actual FPS
    const actualFps = frameCount / duration;

    // Check for frozen video indicators:
    // 1. Frame count too low (< 20 fps equivalent)
    // 2. Frame count way too high (> 60 fps - indicates 1000fps bug)
    const minExpectedFrames = expectedDuration * 20; // At least 20fps
    const maxExpectedFrames = expectedDuration * 60; // No more than 60fps

    const isFrozen = frameCount < minExpectedFrames;
    const is1000fpsBug = frameCount > maxExpectedFrames;

    console.log(`[Validation] Video: ${videoPath}`);
    console.log(`[Validation]   Duration: ${duration.toFixed(2)}s (expected: ~${expectedDuration}s)`);
    console.log(`[Validation]   Frame count: ${frameCount}`);
    console.log(`[Validation]   Actual FPS: ${actualFps.toFixed(2)}`);
    console.log(`[Validation]   Min expected frames: ${minExpectedFrames}`);

    if (isFrozen) {
      console.error(`[Validation] ❌ FROZEN VIDEO DETECTED! Frame count ${frameCount} < ${minExpectedFrames}`);
      return {
        isValid: false,
        reason: 'frozen',
        frameCount,
        duration,
        actualFps,
        message: `Frozen video: only ${frameCount} frames for ${duration}s video (${actualFps.toFixed(1)} fps)`
      };
    }

    if (is1000fpsBug) {
      console.error(`[Validation] ❌ 1000FPS BUG DETECTED! Frame count ${frameCount} > ${maxExpectedFrames}`);
      return {
        isValid: false,
        reason: '1000fps_bug',
        frameCount,
        duration,
        actualFps,
        message: `1000fps bug: ${frameCount} frames for ${duration}s video (${actualFps.toFixed(1)} fps)`
      };
    }

    console.log(`[Validation] ✅ Video appears valid: ${frameCount} frames, ${actualFps.toFixed(1)} fps`);
    return {
      isValid: true,
      frameCount,
      duration,
      actualFps
    };

  } catch (error) {
    console.error(`[Validation] Error validating video: ${error.message}`);
    return {
      isValid: false,
      reason: 'validation_error',
      message: error.message
    };
  }
}

/**
 * Get CPU-only encoding arguments (for fallback when GPU fails)
 * @param {string} quality - 'high', 'medium', 'low'
 * @returns {string[]} FFmpeg CPU encoding arguments
 */
function getCpuEncodingArgs(quality = 'medium') {
  const presets = {
    high: { preset: 'medium', crf: '20' },
    medium: { preset: 'veryfast', crf: '23' },
    low: { preset: 'ultrafast', crf: '28' }
  };
  const p = presets[quality] || presets.medium;

  return [
    '-c:v', 'libx264',
    '-preset', p.preset,
    '-crf', p.crf,
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'main',
    '-level', '4.0',
    '-g', '30',
    '-bf', '0',
  ];
}

/**
 * Get FFmpeg encoding arguments based on GPU availability
 * @param {string} quality - 'high', 'medium', 'low'
 * @returns {string[]} FFmpeg encoding arguments
 */
function getVideoEncodingArgs(quality = 'medium') {
  const encoding = getEncodingParams({ quality });
  return encoding.encoderArgs;
}

/**
 * Get audio encoding arguments
 * @returns {string[]} FFmpeg audio encoding arguments
 */
function getAudioEncodingArgs() {
  return ['-c:a', 'aac', '-b:a', '128k'];
}

/**
 * Download secondary source video for multi-source split screen
 * @param {Object} params
 * @param {string} params.jobId - Job ID for logging
 * @param {Object} params.secondarySource - Secondary source configuration
 * @param {string} params.workDir - Working directory
 * @param {number} params.primaryDuration - Duration of primary clip (for matching)
 * @param {Object} [params.youtubeAuth] - Optional YouTube OAuth credentials
 * @returns {Promise<string|null>} Path to downloaded secondary video, or null
 */
async function downloadSecondarySource({ jobId, secondarySource, workDir, primaryDuration, youtubeAuth }) {
  if (!secondarySource || !secondarySource.enabled) {
    console.log(`[${jobId}] Secondary source not enabled or not provided`);
    return null;
  }

  console.log(`[${jobId}] ========== SECONDARY SOURCE DOWNLOAD ==========`);
  console.log(`[${jobId}] Secondary source config:`, JSON.stringify(secondarySource, null, 2));
  console.log(`[${jobId}] Primary duration: ${primaryDuration}s`);

  const secondaryFile = path.join(workDir, 'secondary.mp4');

  try {
    if (secondarySource.uploadedUrl) {
      // Download from Firebase Storage (uploaded video)
      console.log(`[${jobId}] Downloading secondary from storage URL...`);
      console.log(`[${jobId}] URL: ${secondarySource.uploadedUrl.substring(0, 100)}...`);

      const response = await fetch(secondarySource.uploadedUrl);
      if (!response.ok) {
        throw new Error(`Failed to download secondary video: HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(secondaryFile, Buffer.from(buffer));

      const fileSize = fs.statSync(secondaryFile).size;
      console.log(`[${jobId}] Secondary video downloaded: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

    } else if (secondarySource.youtubeVideoId) {
      // Download from YouTube - use a separate subdirectory to avoid overwriting primary
      console.log(`[${jobId}] Downloading secondary YouTube video: ${secondarySource.youtubeVideoId}`);

      // Create subdirectory for secondary download to avoid file conflicts
      const secondaryWorkDir = path.join(workDir, 'secondary_temp');
      fs.mkdirSync(secondaryWorkDir, { recursive: true });

      const timeOffset = secondarySource.timeOffset || 0;
      console.log(`[${jobId}] Secondary video segment: ${timeOffset}s to ${timeOffset + primaryDuration}s`);

      try {
        const downloadedPath = await downloadVideoSegment({
          jobId: `${jobId}-secondary`,
          videoId: secondarySource.youtubeVideoId,
          startTime: timeOffset,
          endTime: timeOffset + primaryDuration,
          workDir: secondaryWorkDir,  // Use separate directory!
          youtubeAuth  // Pass youtube auth for better download success
        });

        // Move the downloaded file to our target path
        // downloadVideoSegment saves to 'source.mp4' in the workDir
        const expectedPath = path.join(secondaryWorkDir, 'source.mp4');
        if (fs.existsSync(expectedPath)) {
          fs.renameSync(expectedPath, secondaryFile);
          console.log(`[${jobId}] Secondary video moved to: ${secondaryFile}`);
        } else if (fs.existsSync(downloadedPath) && downloadedPath !== secondaryFile) {
          fs.renameSync(downloadedPath, secondaryFile);
          console.log(`[${jobId}] Secondary video renamed to: ${secondaryFile}`);
        }

        // Cleanup temp directory
        try {
          fs.rmSync(secondaryWorkDir, { recursive: true, force: true });
        } catch (cleanupErr) {
          console.warn(`[${jobId}] Could not cleanup secondary temp dir: ${cleanupErr.message}`);
        }

        const fileSize = fs.statSync(secondaryFile).size;
        console.log(`[${jobId}] Secondary YouTube video downloaded: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

      } catch (ytError) {
        console.error(`[${jobId}] YouTube secondary download failed: ${ytError.message}`);
        // Cleanup temp directory on error
        try {
          fs.rmSync(secondaryWorkDir, { recursive: true, force: true });
        } catch (e) {}
        throw ytError;
      }

    } else {
      console.log(`[${jobId}] No valid secondary source URL or video ID found`);
      console.log(`[${jobId}] uploadedUrl: ${secondarySource.uploadedUrl}`);
      console.log(`[${jobId}] youtubeVideoId: ${secondarySource.youtubeVideoId}`);
      console.log(`[${jobId}] youtubeUrl: ${secondarySource.youtubeUrl}`);
      return null;
    }

    // Verify file exists and has content
    if (!fs.existsSync(secondaryFile)) {
      console.error(`[${jobId}] Secondary file does not exist after download`);
      return null;
    }

    const finalSize = fs.statSync(secondaryFile).size;
    if (finalSize < 1000) {
      console.error(`[${jobId}] Secondary file too small: ${finalSize} bytes`);
      return null;
    }

    console.log(`[${jobId}] Secondary source download SUCCESS: ${secondaryFile}`);
    console.log(`[${jobId}] ========== END SECONDARY SOURCE DOWNLOAD ==========`);
    return secondaryFile;

  } catch (error) {
    console.error(`[${jobId}] ========== SECONDARY SOURCE DOWNLOAD FAILED ==========`);
    console.error(`[${jobId}] Error: ${error.message}`);
    console.error(`[${jobId}] Stack: ${error.stack}`);
    return null;
  }
}

/**
 * Download tertiary source video for three_person mode (third video)
 * @param {Object} params
 * @param {string} params.jobId - Job ID for logging
 * @param {Object} params.tertiarySource - Tertiary source configuration
 * @param {string} params.workDir - Working directory
 * @param {number} params.primaryDuration - Duration of primary clip (for matching)
 * @param {Object} [params.youtubeAuth] - Optional YouTube OAuth credentials
 * @returns {Promise<string|null>} Path to downloaded tertiary video, or null
 */
async function downloadTertiarySource({ jobId, tertiarySource, workDir, primaryDuration, youtubeAuth }) {
  if (!tertiarySource || !tertiarySource.enabled) {
    console.log(`[${jobId}] Tertiary source not enabled or not provided`);
    return null;
  }

  console.log(`[${jobId}] ========== TERTIARY SOURCE DOWNLOAD ==========`);
  console.log(`[${jobId}] Tertiary source config:`, JSON.stringify(tertiarySource, null, 2));

  const tertiaryFile = path.join(workDir, 'tertiary.mp4');

  try {
    if (tertiarySource.uploadedUrl) {
      // Download from Firebase Storage (uploaded video)
      console.log(`[${jobId}] Downloading tertiary from storage URL...`);
      console.log(`[${jobId}] URL: ${tertiarySource.uploadedUrl.substring(0, 100)}...`);

      const response = await fetch(tertiarySource.uploadedUrl);
      if (!response.ok) {
        throw new Error(`Failed to download tertiary video: HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(tertiaryFile, Buffer.from(buffer));

      const fileSize = fs.statSync(tertiaryFile).size;
      console.log(`[${jobId}] Tertiary video downloaded: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

    } else if (tertiarySource.youtubeVideoId) {
      // Download from YouTube - use a separate subdirectory
      console.log(`[${jobId}] Downloading tertiary YouTube video: ${tertiarySource.youtubeVideoId}`);

      const tertiaryWorkDir = path.join(workDir, 'tertiary_temp');
      fs.mkdirSync(tertiaryWorkDir, { recursive: true });

      const timeOffset = tertiarySource.timeOffset || 0;
      console.log(`[${jobId}] Tertiary video segment: ${timeOffset}s to ${timeOffset + primaryDuration}s`);

      try {
        await downloadVideoSegment({
          jobId: `${jobId}-tertiary`,
          videoId: tertiarySource.youtubeVideoId,
          startTime: timeOffset,
          endTime: timeOffset + primaryDuration,
          workDir: tertiaryWorkDir,
          youtubeAuth
        });

        const expectedPath = path.join(tertiaryWorkDir, 'source.mp4');
        if (fs.existsSync(expectedPath)) {
          fs.renameSync(expectedPath, tertiaryFile);
          console.log(`[${jobId}] Tertiary video moved to: ${tertiaryFile}`);
        }

        // Cleanup temp directory
        try {
          fs.rmSync(tertiaryWorkDir, { recursive: true, force: true });
        } catch (cleanupErr) {
          console.warn(`[${jobId}] Could not cleanup tertiary temp dir: ${cleanupErr.message}`);
        }

        const fileSize = fs.statSync(tertiaryFile).size;
        console.log(`[${jobId}] Tertiary YouTube video downloaded: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

      } catch (ytError) {
        console.error(`[${jobId}] YouTube tertiary download failed: ${ytError.message}`);
        try {
          fs.rmSync(tertiaryWorkDir, { recursive: true, force: true });
        } catch (e) {}
        throw ytError;
      }

    } else {
      console.log(`[${jobId}] No valid tertiary source URL or video ID found`);
      return null;
    }

    // Verify file exists and has content
    if (!fs.existsSync(tertiaryFile)) {
      console.error(`[${jobId}] Tertiary file does not exist after download`);
      return null;
    }

    const finalSize = fs.statSync(tertiaryFile).size;
    if (finalSize < 1000) {
      console.error(`[${jobId}] Tertiary file too small: ${finalSize} bytes`);
      return null;
    }

    console.log(`[${jobId}] Tertiary source download SUCCESS: ${tertiaryFile}`);
    console.log(`[${jobId}] ========== END TERTIARY SOURCE DOWNLOAD ==========`);
    return tertiaryFile;

  } catch (error) {
    console.error(`[${jobId}] ========== TERTIARY SOURCE DOWNLOAD FAILED ==========`);
    console.error(`[${jobId}] Error: ${error.message}`);
    return null;
  }
}

/**
 * Process video with two sources for split screen modes
 * @param {Object} params
 * @param {string} params.jobId - Job ID for logging
 * @param {string} params.primaryFile - Path to primary video file
 * @param {string} params.secondaryFile - Path to secondary video file
 * @param {Object} params.settings - Processing settings
 * @param {Object} params.output - Output specifications
 * @param {string} params.workDir - Working directory
 * @returns {Promise<string>} Path to processed output file
 */
async function processMultiSourceVideo({ jobId, primaryFile, secondaryFile, settings, output, workDir }) {
  const outputFile = path.join(workDir, 'processed.mp4');

  console.log(`[${jobId}] Processing multi-source video`);
  console.log(`[${jobId}] Primary: ${primaryFile}`);
  console.log(`[${jobId}] Secondary: ${secondaryFile}`);

  // Get video info for both inputs
  const primaryInfo = await getVideoInfo(primaryFile);
  const secondaryInfo = await getVideoInfo(secondaryFile);

  console.log(`[${jobId}] Primary: ${primaryInfo.width}x${primaryInfo.height}, ${primaryInfo.duration}s`);
  console.log(`[${jobId}] Secondary: ${secondaryInfo.width}x${secondaryInfo.height}, ${secondaryInfo.duration}s`);

  const targetWidth = output?.resolution?.width || 1080;
  const targetHeight = output?.resolution?.height || 1920;
  const halfHeight = Math.floor(targetHeight / 2);
  const targetFps = output?.fps || 30;

  const safeSettings = settings || {};
  const position = safeSettings.secondarySource?.position || 'bottom';
  const audioMix = safeSettings.audioMix || {
    primaryVolume: 100,
    secondaryVolume: 0,
    primaryMuted: false,
    secondaryMuted: true
  };

  // Generate captions if requested (from primary audio)
  let captionFile = null;
  if (safeSettings.captionStyle && safeSettings.captionStyle !== 'none') {
    console.log(`[${jobId}] Generating captions with style: ${safeSettings.captionStyle}`);
    try {
      captionFile = await generateCaptions({
        jobId,
        videoFile: primaryFile,
        workDir,
        captionStyle: safeSettings.captionStyle,
        customStyle: safeSettings.customCaptionStyle
      });
    } catch (captionError) {
      console.error(`[${jobId}] Caption generation failed:`, captionError.message);
    }
  }

  // Build complex filter graph for two inputs
  // [0:v] = primary video, [1:v] = secondary video
  // [0:a] = primary audio, [1:a] = secondary audio
  let filterComplex = '';

  // Determine video positions based on settings
  // 'top' means secondary on top, primary on bottom
  // 'bottom' means primary on top, secondary on bottom (default)
  if (position === 'top') {
    filterComplex = `
      [0:v]scale=${targetWidth}:${halfHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${halfHeight},setsar=1[primary];
      [1:v]scale=${targetWidth}:${halfHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${halfHeight},setsar=1[secondary];
      [secondary][primary]vstack=inputs=2[vout]
    `.replace(/\n\s*/g, '');
  } else {
    // Default: primary on top, secondary on bottom
    filterComplex = `
      [0:v]scale=${targetWidth}:${halfHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${halfHeight},setsar=1[primary];
      [1:v]scale=${targetWidth}:${halfHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${halfHeight},setsar=1[secondary];
      [primary][secondary]vstack=inputs=2[vout]
    `.replace(/\n\s*/g, '');
  }

  // Add caption filter if captions were generated
  if (captionFile && fs.existsSync(captionFile)) {
    const escapedPath = captionFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
    filterComplex += `;[vout]ass='${escapedPath}'[vfinal]`;
    console.log(`[${jobId}] Adding captions to multi-source output`);
  } else {
    // Just rename the output
    filterComplex = filterComplex.replace('[vout]', '[vfinal]');
  }

  // Audio mixing
  const primaryVol = audioMix.primaryMuted ? 0 : (audioMix.primaryVolume || 100) / 100;
  const secondaryVol = audioMix.secondaryMuted ? 0 : (audioMix.secondaryVolume || 0) / 100;

  // Add audio filters
  if (primaryVol > 0 && secondaryVol > 0) {
    // Mix both audio tracks
    filterComplex += `;[0:a]volume=${primaryVol}[a0];[1:a]volume=${secondaryVol}[a1];[a0][a1]amix=inputs=2:duration=first[aout]`;
  } else if (primaryVol > 0) {
    // Only primary audio
    filterComplex += `;[0:a]volume=${primaryVol}[aout]`;
  } else if (secondaryVol > 0) {
    // Only secondary audio
    filterComplex += `;[1:a]volume=${secondaryVol}[aout]`;
  } else {
    // Both muted - still need audio output (silent)
    filterComplex += `;[0:a]volume=0[aout]`;
  }

  console.log(`[${jobId}] Multi-source filter complex: ${filterComplex.substring(0, 200)}...`);

  return new Promise((resolve, reject) => {
    // Use GPU encoding if available, otherwise fall back to CPU
    const videoEncoding = getVideoEncodingArgs('medium');
    const audioEncoding = getAudioEncodingArgs();

    const args = [
      '-fflags', '+igndts+genpts',  // Fix broken timestamps from MediaRecorder WebM
      '-i', primaryFile,
      '-fflags', '+igndts+genpts',
      '-i', secondaryFile,
      '-filter_complex', filterComplex,
      '-map', '[vfinal]',
      '-map', '[aout]',
      ...videoEncoding,
      ...audioEncoding,
      '-r', targetFps.toString(),
      '-movflags', '+faststart',
      '-y',
      outputFile
    ];

    console.log(`[${jobId}] FFmpeg multi-source command (${gpuEnabled ? 'GPU' : 'CPU'}): ffmpeg ${args.slice(0, 12).join(' ')}...`);

    const ffmpegProcess = spawn('ffmpeg', args);

    let stderr = '';
    ffmpegProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      const match = stderr.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (match) {
        console.log(`[${jobId}] FFmpeg progress: ${match[1]}`);
      }
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputFile)) {
        console.log(`[${jobId}] Multi-source processing completed: ${outputFile}`);
        resolve(outputFile);
      } else {
        console.error(`[${jobId}] Multi-source FFmpeg failed. Code: ${code}`);
        console.error(`[${jobId}] stderr: ${stderr.slice(-500)}`);
        reject(new Error(`Multi-source video processing failed: ${code}`));
      }
    });

    ffmpegProcess.on('error', (error) => {
      reject(new Error(`Failed to start FFmpeg: ${error.message}`));
    });
  });
}

/**
 * Process video with three sources for three_person mode
 * Layout: Main video on top (full width), two smaller videos on bottom (side by side)
 * @param {Object} params
 * @param {string} params.jobId - Job ID for logging
 * @param {string} params.primaryFile - Path to primary video file (main/top)
 * @param {string} params.secondaryFile - Path to secondary video file (bottom-left)
 * @param {string} params.tertiaryFile - Path to tertiary video file (bottom-right)
 * @param {Object} params.settings - Processing settings
 * @param {Object} params.output - Output specifications
 * @param {string} params.workDir - Working directory
 * @returns {Promise<string>} Path to processed output file
 */
async function processThreeSourceVideo({ jobId, primaryFile, secondaryFile, tertiaryFile, settings, output, workDir }) {
  const outputFile = path.join(workDir, 'processed.mp4');

  console.log(`[${jobId}] Processing three-source video (three_person mode)`);
  console.log(`[${jobId}] Primary (top): ${primaryFile}`);
  console.log(`[${jobId}] Secondary (bottom-left): ${secondaryFile}`);
  console.log(`[${jobId}] Tertiary (bottom-right): ${tertiaryFile}`);

  const targetWidth = output?.resolution?.width || 1080;
  const targetHeight = output?.resolution?.height || 1920;
  const topHeight = Math.floor(targetHeight * 0.5);     // Main video: 50% height
  const bottomHeight = Math.floor(targetHeight * 0.5);  // Bottom videos: 50% height
  const halfWidth = Math.floor(targetWidth / 2);        // Each bottom video: 50% width
  const targetFps = output?.fps || 30;

  const safeSettings = settings || {};
  const audioMix = safeSettings.audioMix || {
    primaryVolume: 100,
    secondaryVolume: 0,
    tertiaryVolume: 0,
    primaryMuted: false,
    secondaryMuted: true,
    tertiaryMuted: true
  };

  // Generate captions if requested (from primary audio)
  let captionFile = null;
  if (safeSettings.captionStyle && safeSettings.captionStyle !== 'none') {
    console.log(`[${jobId}] Generating captions with style: ${safeSettings.captionStyle}`);
    try {
      captionFile = await generateCaptions({
        jobId,
        videoFile: primaryFile,
        workDir,
        captionStyle: safeSettings.captionStyle,
        customStyle: safeSettings.customCaptionStyle
      });
    } catch (captionError) {
      console.error(`[${jobId}] Caption generation failed:`, captionError.message);
    }
  }

  // Build complex filter graph for three inputs
  // [0:v] = primary video (main/top), [1:v] = secondary (bottom-left), [2:v] = tertiary (bottom-right)
  // Layout: Main video at top (full width), two videos at bottom (split)
  let filterComplex = `
    [0:v]scale=${targetWidth}:${topHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${topHeight},setsar=1[main];
    [1:v]scale=${halfWidth}:${bottomHeight}:force_original_aspect_ratio=increase,crop=${halfWidth}:${bottomHeight},setsar=1[left];
    [2:v]scale=${halfWidth}:${bottomHeight}:force_original_aspect_ratio=increase,crop=${halfWidth}:${bottomHeight},setsar=1[right];
    [left][right]hstack=inputs=2[bottom];
    [main][bottom]vstack=inputs=2[vout]
  `.replace(/\n\s*/g, '');

  // Add caption filter if captions were generated
  if (captionFile && fs.existsSync(captionFile)) {
    const escapedPath = captionFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
    filterComplex += `;[vout]ass='${escapedPath}'[vfinal]`;
    console.log(`[${jobId}] Adding captions to three-source output`);
  } else {
    filterComplex = filterComplex.replace('[vout]', '[vfinal]');
  }

  // Audio mixing - use primary audio by default
  const primaryVol = audioMix.primaryMuted ? 0 : (audioMix.primaryVolume || 100) / 100;
  const secondaryVol = audioMix.secondaryMuted ? 0 : (audioMix.secondaryVolume || 0) / 100;
  const tertiaryVol = audioMix.tertiaryMuted ? 0 : (audioMix.tertiaryVolume || 0) / 100;

  // Audio mixing logic
  const activeAudioTracks = [];
  if (primaryVol > 0) activeAudioTracks.push({ input: 0, vol: primaryVol, label: 'a0' });
  if (secondaryVol > 0) activeAudioTracks.push({ input: 1, vol: secondaryVol, label: 'a1' });
  if (tertiaryVol > 0) activeAudioTracks.push({ input: 2, vol: tertiaryVol, label: 'a2' });

  if (activeAudioTracks.length > 1) {
    // Mix multiple audio tracks
    const volumeFilters = activeAudioTracks.map(t => `[${t.input}:a]volume=${t.vol}[${t.label}]`).join(';');
    const mixInputs = activeAudioTracks.map(t => `[${t.label}]`).join('');
    filterComplex += `;${volumeFilters};${mixInputs}amix=inputs=${activeAudioTracks.length}:duration=first[aout]`;
  } else if (activeAudioTracks.length === 1) {
    // Single audio track
    filterComplex += `;[${activeAudioTracks[0].input}:a]volume=${activeAudioTracks[0].vol}[aout]`;
  } else {
    // All muted - use silent primary
    filterComplex += `;[0:a]volume=0[aout]`;
  }

  console.log(`[${jobId}] Three-source filter complex: ${filterComplex.substring(0, 300)}...`);

  return new Promise((resolve, reject) => {
    // Use GPU encoding if available, otherwise fall back to CPU
    const videoEncoding = getVideoEncodingArgs('medium');
    const audioEncoding = getAudioEncodingArgs();

    const args = [
      '-fflags', '+igndts+genpts',
      '-i', primaryFile,
      '-fflags', '+igndts+genpts',
      '-i', secondaryFile,
      '-fflags', '+igndts+genpts',
      '-i', tertiaryFile,
      '-filter_complex', filterComplex,
      '-map', '[vfinal]',
      '-map', '[aout]',
      ...videoEncoding,
      ...audioEncoding,
      '-r', targetFps.toString(),
      '-movflags', '+faststart',
      '-y',
      outputFile
    ];

    console.log(`[${jobId}] FFmpeg three-source command (${gpuEnabled ? 'GPU' : 'CPU'}): ffmpeg ${args.slice(0, 14).join(' ')}...`);

    const ffmpegProcess = spawn('ffmpeg', args);

    let stderr = '';
    ffmpegProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      const match = stderr.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (match) {
        console.log(`[${jobId}] FFmpeg progress: ${match[1]}`);
      }
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputFile)) {
        console.log(`[${jobId}] Three-source processing completed: ${outputFile}`);
        resolve(outputFile);
      } else {
        console.error(`[${jobId}] Three-source FFmpeg failed. Code: ${code}`);
        console.error(`[${jobId}] stderr: ${stderr.slice(-500)}`);
        reject(new Error(`Three-source video processing failed: ${code}`));
      }
    });

    ffmpegProcess.on('error', (error) => {
      reject(new Error(`Failed to start FFmpeg: ${error.message}`));
    });
  });
}

/**
 * Process video with gameplay mode - main video with facecam overlay in corner
 * @param {Object} params
 * @param {string} params.jobId - Job ID for logging
 * @param {string} params.primaryFile - Path to primary video file (gameplay)
 * @param {string} params.secondaryFile - Path to secondary video file (facecam)
 * @param {Object} params.settings - Processing settings
 * @param {Object} params.output - Output specifications
 * @param {string} params.workDir - Working directory
 * @returns {Promise<string>} Path to processed output file
 */
async function processGameplayVideo({ jobId, primaryFile, secondaryFile, settings, output, workDir }) {
  const outputFile = path.join(workDir, 'processed.mp4');

  console.log(`[${jobId}] Processing gameplay video with facecam overlay`);
  console.log(`[${jobId}] Primary (gameplay): ${primaryFile}`);
  console.log(`[${jobId}] Secondary (facecam): ${secondaryFile}`);

  const targetWidth = output?.resolution?.width || 1080;
  const targetHeight = output?.resolution?.height || 1920;
  const facecamWidth = Math.floor(targetWidth * 0.3);   // Facecam: 30% width
  const facecamHeight = Math.floor(facecamWidth * 1.2); // Facecam aspect ratio (portrait)
  const targetFps = output?.fps || 30;
  const margin = 40; // Margin from edge

  const safeSettings = settings || {};
  const position = safeSettings.secondarySource?.position || 'bottom-right';
  const audioMix = safeSettings.audioMix || {
    primaryVolume: 100,
    secondaryVolume: 0,
    primaryMuted: false,
    secondaryMuted: true
  };

  // Calculate facecam position based on setting
  let overlayX, overlayY;
  switch (position) {
    case 'top-left':
      overlayX = margin;
      overlayY = margin;
      break;
    case 'top-right':
      overlayX = targetWidth - facecamWidth - margin;
      overlayY = margin;
      break;
    case 'bottom-left':
      overlayX = margin;
      overlayY = targetHeight - facecamHeight - margin;
      break;
    case 'bottom-right':
    default:
      overlayX = targetWidth - facecamWidth - margin;
      overlayY = targetHeight - facecamHeight - margin;
      break;
  }

  console.log(`[${jobId}] Facecam position: ${position} (${overlayX}, ${overlayY})`);

  // Generate captions if requested (from primary audio)
  let captionFile = null;
  if (safeSettings.captionStyle && safeSettings.captionStyle !== 'none') {
    console.log(`[${jobId}] Generating captions with style: ${safeSettings.captionStyle}`);
    try {
      captionFile = await generateCaptions({
        jobId,
        videoFile: primaryFile,
        workDir,
        captionStyle: safeSettings.captionStyle,
        customStyle: safeSettings.customCaptionStyle
      });
    } catch (captionError) {
      console.error(`[${jobId}] Caption generation failed:`, captionError.message);
    }
  }

  // Build complex filter graph for gameplay with facecam overlay
  // [0:v] = primary (gameplay), [1:v] = secondary (facecam)
  let filterComplex = `
    [0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},setsar=1[gameplay];
    [1:v]scale=${facecamWidth}:${facecamHeight}:force_original_aspect_ratio=increase,crop=${facecamWidth}:${facecamHeight},setsar=1[facecam];
    [gameplay][facecam]overlay=${overlayX}:${overlayY}[vout]
  `.replace(/\n\s*/g, '');

  // Add caption filter if captions were generated
  if (captionFile && fs.existsSync(captionFile)) {
    const escapedPath = captionFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
    filterComplex += `;[vout]ass='${escapedPath}'[vfinal]`;
    console.log(`[${jobId}] Adding captions to gameplay output`);
  } else {
    filterComplex = filterComplex.replace('[vout]', '[vfinal]');
  }

  // Audio mixing
  const primaryVol = audioMix.primaryMuted ? 0 : (audioMix.primaryVolume || 100) / 100;
  const secondaryVol = audioMix.secondaryMuted ? 0 : (audioMix.secondaryVolume || 0) / 100;

  if (primaryVol > 0 && secondaryVol > 0) {
    filterComplex += `;[0:a]volume=${primaryVol}[a0];[1:a]volume=${secondaryVol}[a1];[a0][a1]amix=inputs=2:duration=first[aout]`;
  } else if (primaryVol > 0) {
    filterComplex += `;[0:a]volume=${primaryVol}[aout]`;
  } else if (secondaryVol > 0) {
    filterComplex += `;[1:a]volume=${secondaryVol}[aout]`;
  } else {
    filterComplex += `;[0:a]volume=0[aout]`;
  }

  console.log(`[${jobId}] Gameplay filter complex: ${filterComplex.substring(0, 300)}...`);

  return new Promise((resolve, reject) => {
    // Use GPU encoding if available, otherwise fall back to CPU
    const videoEncoding = getVideoEncodingArgs('medium');
    const audioEncoding = getAudioEncodingArgs();

    const args = [
      '-fflags', '+igndts+genpts',
      '-i', primaryFile,
      '-fflags', '+igndts+genpts',
      '-i', secondaryFile,
      '-filter_complex', filterComplex,
      '-map', '[vfinal]',
      '-map', '[aout]',
      ...videoEncoding,
      ...audioEncoding,
      '-r', targetFps.toString(),
      '-movflags', '+faststart',
      '-y',
      outputFile
    ];

    console.log(`[${jobId}] FFmpeg gameplay command (${gpuEnabled ? 'GPU' : 'CPU'}): ffmpeg ${args.slice(0, 12).join(' ')}...`);

    const ffmpegProcess = spawn('ffmpeg', args);

    let stderr = '';
    ffmpegProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      const match = stderr.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (match) {
        console.log(`[${jobId}] FFmpeg progress: ${match[1]}`);
      }
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputFile)) {
        console.log(`[${jobId}] Gameplay processing completed: ${outputFile}`);
        resolve(outputFile);
      } else {
        console.error(`[${jobId}] Gameplay FFmpeg failed. Code: ${code}`);
        console.error(`[${jobId}] stderr: ${stderr.slice(-500)}`);
        reject(new Error(`Gameplay video processing failed: ${code}`));
      }
    });

    ffmpegProcess.on('error', (error) => {
      reject(new Error(`Failed to start FFmpeg: ${error.message}`));
    });
  });
}

// Feature flag for PTS rescaling fix
// Set PTS_RESCALE_ENABLED=true to enable timestamp correction for MediaRecorder captures
const PTS_RESCALE_ENABLED = process.env.PTS_RESCALE_ENABLED === 'true';

/**
 * Get packet-level PTS span for a stream (video or audio)
 * Returns the actual timestamp span from first to last packet
 *
 * @param {string} filePath - Path to video file
 * @param {string} streamType - 'v' for video, 'a' for audio
 * @returns {Object} { firstPts, lastPts, ptsSpan, packetCount, isValid }
 */
function getPacketPTSSpan(filePath, streamType = 'v') {
  try {
    const cmd = `ffprobe -v error -select_streams ${streamType}:0 -show_entries packet=pts_time -of csv=p=0 "${filePath}"`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 60000 });

    const lines = result.trim().split('\n').filter(line => line.trim() && line.trim() !== 'N/A');
    if (lines.length === 0) {
      return { firstPts: null, lastPts: null, ptsSpan: null, packetCount: 0, isValid: false };
    }

    const timestamps = lines.map(line => parseFloat(line)).filter(t => !isNaN(t) && t >= 0);
    if (timestamps.length === 0) {
      return { firstPts: null, lastPts: null, ptsSpan: null, packetCount: lines.length, isValid: false };
    }

    const firstPts = timestamps[0];
    const lastPts = timestamps[timestamps.length - 1];
    const ptsSpan = lastPts - firstPts;

    return {
      firstPts,
      lastPts,
      ptsSpan,
      packetCount: timestamps.length,
      isValid: ptsSpan > 0
    };
  } catch (err) {
    return { firstPts: null, lastPts: null, ptsSpan: null, packetCount: 0, isValid: false, error: err.message };
  }
}

/**
 * DIAGNOSTIC: Probe PACKET-LEVEL PTS timestamps from a video file
 * This examines individual frame timestamps to distinguish:
 * - "No timestamps were written" (all PTS=0 or N/A)
 * - "Timestamps exist but container metadata is incomplete" (valid PTS per packet)
 *
 * @param {string} jobId - Job ID for logging
 * @param {string} filePath - Path to video file
 * @param {string} stage - Description of pipeline stage
 */
function probePacketPTS(jobId, filePath, stage) {
  console.log(`[${jobId}] ========== PACKET PTS PROBE: ${stage} ==========`);

  try {
    // Get first 10 and last 10 video packet timestamps
    // This tells us if frame-level PTS exists even when container duration=0
    const packetCmd = `ffprobe -v error -select_streams v:0 -show_entries packet=pts,pts_time,dts,dts_time -of csv=p=0 "${filePath}"`;
    const packetResult = execSync(packetCmd, { encoding: 'utf8', timeout: 60000 });

    const lines = packetResult.trim().split('\n').filter(line => line.trim());
    const totalPackets = lines.length;

    console.log(`[${jobId}] Total video packets: ${totalPackets}`);

    if (totalPackets === 0) {
      console.log(`[${jobId}] NO PACKETS FOUND - file may be corrupt or empty`);
      return { stage, totalPackets: 0, hasValidPTS: false };
    }

    // Parse packet data: pts,pts_time,dts,dts_time
    const parsePacket = (line, index) => {
      const parts = line.split(',');
      return {
        index,
        pts: parts[0] === 'N/A' ? null : parseInt(parts[0]),
        pts_time: parts[1] === 'N/A' ? null : parseFloat(parts[1]),
        dts: parts[2] === 'N/A' ? null : parseInt(parts[2]),
        dts_time: parts[3] === 'N/A' ? null : parseFloat(parts[3])
      };
    };

    // Get first 5 packets
    const firstPackets = lines.slice(0, 5).map((line, i) => parsePacket(line, i));
    // Get last 5 packets
    const lastPackets = lines.slice(-5).map((line, i) => parsePacket(line, totalPackets - 5 + i));

    console.log(`[${jobId}] FIRST 5 PACKETS:`);
    firstPackets.forEach(p => {
      console.log(`[${jobId}]   [${p.index}] pts=${p.pts ?? 'N/A'} (${p.pts_time?.toFixed(3) ?? 'N/A'}s), dts=${p.dts ?? 'N/A'}`);
    });

    console.log(`[${jobId}] LAST 5 PACKETS:`);
    lastPackets.forEach(p => {
      console.log(`[${jobId}]   [${p.index}] pts=${p.pts ?? 'N/A'} (${p.pts_time?.toFixed(3) ?? 'N/A'}s), dts=${p.dts ?? 'N/A'}`);
    });

    // Analyze PTS validity
    const allPackets = lines.map((line, i) => parsePacket(line, i));
    const validPtsCount = allPackets.filter(p => p.pts !== null && p.pts >= 0).length;
    const nullPtsCount = allPackets.filter(p => p.pts === null).length;
    const zeroPtsCount = allPackets.filter(p => p.pts === 0).length;

    // Check if PTS values are monotonically increasing (good sign)
    let isMonotonic = true;
    let prevPts = -1;
    for (const p of allPackets) {
      if (p.pts !== null) {
        if (p.pts < prevPts) {
          isMonotonic = false;
          break;
        }
        prevPts = p.pts;
      }
    }

    // Calculate PTS span from actual packets
    const firstValidPts = allPackets.find(p => p.pts !== null)?.pts_time;
    const lastValidPts = [...allPackets].reverse().find(p => p.pts !== null)?.pts_time;
    const ptsSpan = (firstValidPts !== null && lastValidPts !== null)
      ? lastValidPts - firstValidPts
      : null;

    console.log(`[${jobId}] PTS ANALYSIS:`);
    console.log(`[${jobId}]   Valid PTS: ${validPtsCount}/${totalPackets} packets`);
    console.log(`[${jobId}]   Null PTS: ${nullPtsCount}, Zero PTS: ${zeroPtsCount}`);
    console.log(`[${jobId}]   Monotonic: ${isMonotonic}`);
    console.log(`[${jobId}]   PTS span: ${ptsSpan?.toFixed(3) ?? 'N/A'}s (first=${firstValidPts?.toFixed(3) ?? 'N/A'}s, last=${lastValidPts?.toFixed(3) ?? 'N/A'}s)`);

    // Determine if timestamps are fundamentally missing or just container metadata
    const hasValidPTS = validPtsCount > totalPackets * 0.9 && ptsSpan !== null && ptsSpan > 0;

    if (hasValidPTS) {
      console.log(`[${jobId}] CONCLUSION: Timestamps EXIST at packet level (container metadata incomplete)`);
    } else if (validPtsCount === 0 || nullPtsCount === totalPackets) {
      console.log(`[${jobId}] CONCLUSION: NO timestamps written - capture is fundamentally timeless`);
    } else if (zeroPtsCount > totalPackets * 0.5) {
      console.log(`[${jobId}] CONCLUSION: Most PTS are ZERO - timestamps not properly recorded`);
    } else {
      console.log(`[${jobId}] CONCLUSION: Partial/invalid timestamps - inconsistent timing`);
    }

    console.log(`[${jobId}] ========== END PACKET PTS PROBE: ${stage} ==========`);

    return {
      stage,
      totalPackets,
      validPtsCount,
      nullPtsCount,
      zeroPtsCount,
      isMonotonic,
      ptsSpan,
      firstPts: firstValidPts,
      lastPts: lastValidPts,
      hasValidPTS
    };

  } catch (err) {
    console.error(`[${jobId}] PACKET PTS PROBE FAILED: ${err.message}`);
    return { stage, error: err.message };
  }
}

/**
 * DIAGNOSTIC: Probe PTS timestamps from a video file
 * This function extracts actual PTS values to identify where timing invariants are violated.
 *
 * The invariant: PTS span (last_PTS - first_PTS) must equal real-world capture duration
 *
 * @param {string} jobId - Job ID for logging
 * @param {string} filePath - Path to video file
 * @param {string} stage - Description of pipeline stage (e.g., "RAW_WEBM", "AFTER_TRANSCODE")
 * @returns {Object} Diagnostic data
 */
function probePTS(jobId, filePath, stage) {
  console.log(`[${jobId}] ========== PTS DIAGNOSTIC: ${stage} ==========`);
  console.log(`[${jobId}] File: ${filePath}`);

  try {
    // Get comprehensive stream and format info
    const probeCmd = `ffprobe -v error -show_entries stream=codec_type,duration,nb_frames,avg_frame_rate,time_base,start_time,start_pts -show_entries format=duration,start_time -of json "${filePath}"`;
    const probeResult = execSync(probeCmd, { encoding: 'utf8', timeout: 30000 });
    const probeData = JSON.parse(probeResult);

    const result = {
      stage,
      file: filePath,
      format: {
        duration: parseFloat(probeData.format?.duration || 0),
        startTime: parseFloat(probeData.format?.start_time || 0)
      },
      video: null,
      audio: null
    };

    for (const stream of probeData.streams || []) {
      const streamInfo = {
        duration: parseFloat(stream.duration || 0),
        nbFrames: parseInt(stream.nb_frames || 0),
        timeBase: stream.time_base,
        startTime: parseFloat(stream.start_time || 0),
        startPts: parseInt(stream.start_pts || 0),
        avgFrameRate: stream.avg_frame_rate
      };

      // Calculate PTS span if we have frame count and timebase
      if (stream.time_base && streamInfo.nbFrames > 0) {
        const [tbNum, tbDen] = stream.time_base.split('/').map(Number);
        const timebaseValue = tbNum / tbDen;
        streamInfo.timebaseSeconds = timebaseValue;
      }

      if (stream.codec_type === 'video') {
        // Parse frame rate
        if (stream.avg_frame_rate) {
          const [frNum, frDen] = stream.avg_frame_rate.split('/').map(Number);
          streamInfo.fps = frDen ? frNum / frDen : frNum;
          streamInfo.computedDuration = streamInfo.nbFrames / streamInfo.fps;
        }
        result.video = streamInfo;
      } else if (stream.codec_type === 'audio') {
        result.audio = streamInfo;
      }
    }

    // Log diagnostic output
    console.log(`[${jobId}] FORMAT: duration=${result.format.duration.toFixed(3)}s, startTime=${result.format.startTime.toFixed(3)}s`);

    if (result.video) {
      console.log(`[${jobId}] VIDEO: duration=${result.video.duration.toFixed(3)}s, frames=${result.video.nbFrames}, fps=${result.video.fps?.toFixed(2) || 'N/A'}, timebase=${result.video.timeBase}`);
      console.log(`[${jobId}] VIDEO: computedDuration (frames/fps)=${result.video.computedDuration?.toFixed(3) || 'N/A'}s, startTime=${result.video.startTime.toFixed(3)}s`);
    } else {
      console.log(`[${jobId}] VIDEO: No video stream found`);
    }

    if (result.audio) {
      console.log(`[${jobId}] AUDIO: duration=${result.audio.duration.toFixed(3)}s, timebase=${result.audio.timeBase}, startTime=${result.audio.startTime.toFixed(3)}s`);
    } else {
      console.log(`[${jobId}] AUDIO: No audio stream found`);
    }

    // Key diagnostic: Compare video duration to audio duration
    if (result.video && result.audio) {
      const avDelta = Math.abs(result.video.duration - result.audio.duration);
      console.log(`[${jobId}] A/V DELTA: |video - audio| = ${avDelta.toFixed(3)}s`);
      if (avDelta > 0.1) {
        console.log(`[${jobId}] WARNING: A/V duration mismatch exceeds 0.1s threshold`);
      }
    }

    // Key diagnostic: Compare computed duration to reported duration
    if (result.video?.computedDuration && result.video?.duration) {
      const compDelta = Math.abs(result.video.computedDuration - result.video.duration);
      console.log(`[${jobId}] COMPUTED vs REPORTED: |computed - reported| = ${compDelta.toFixed(3)}s`);
      if (compDelta > 0.1) {
        console.log(`[${jobId}] WARNING: Computed duration differs from reported duration`);
      }
    }

    console.log(`[${jobId}] ========== END PTS DIAGNOSTIC: ${stage} ==========`);
    return result;

  } catch (err) {
    console.error(`[${jobId}] PTS DIAGNOSTIC FAILED: ${err.message}`);
    return { stage, error: err.message };
  }
}

/**
 * Validate video A/V sync and duration consistency
 * Checks that video and audio durations match within tolerance
 * @param {string} jobId - Job ID for logging
 * @param {string} filePath - Path to video file
 * @param {number} threshold - Maximum allowed duration mismatch in seconds (default 0.1)
 * @returns {Object} { valid: boolean, error?: string, details: Object }
 */
async function validateVideoSync(jobId, filePath, threshold = 0.1) {
  try {
    const probeCmd = `ffprobe -v error -show_entries stream=codec_type,avg_frame_rate,nb_frames,duration,time_base -show_entries format=duration -of json "${filePath}"`;
    const probeResult = execSync(probeCmd, { encoding: 'utf8', timeout: 30000 });
    const probeData = JSON.parse(probeResult);

    let videoFrames = 0;
    let videoFps = 30;
    let videoDuration = 0;
    let audioDuration = 0;
    const formatDuration = parseFloat(probeData.format?.duration || 0);

    for (const stream of probeData.streams || []) {
      if (stream.codec_type === 'video') {
        videoFrames = parseInt(stream.nb_frames || 0);
        videoDuration = parseFloat(stream.duration || 0);
        // Parse avg_frame_rate (e.g., "30/1" or "30000/1001")
        if (stream.avg_frame_rate) {
          const [num, den] = stream.avg_frame_rate.split('/').map(Number);
          videoFps = den ? num / den : num;
        }
      } else if (stream.codec_type === 'audio') {
        audioDuration = parseFloat(stream.duration || 0);
      }
    }

    // Calculate computed video duration from frames
    const computedVideoDuration = videoFrames > 0 && videoFps > 0 ? videoFrames / videoFps : 0;

    // Log all metrics
    console.log(`[${jobId}] VALIDATION: frames=${videoFrames}, fps=${videoFps.toFixed(2)}, videoDur=${videoDuration.toFixed(3)}s, audioDur=${audioDuration.toFixed(3)}s, formatDur=${formatDuration.toFixed(3)}s, computedDur=${computedVideoDuration.toFixed(3)}s`);

    const errors = [];

    // Check 1: Video duration vs format duration
    if (videoDuration > 0 && formatDuration > 0) {
      const delta = Math.abs(videoDuration - formatDuration);
      if (delta > threshold) {
        errors.push(`video_dur(${videoDuration.toFixed(3)}) vs format_dur(${formatDuration.toFixed(3)}) delta=${delta.toFixed(3)}s`);
      }
    }

    // Check 2: Computed video duration vs actual video duration
    if (computedVideoDuration > 0 && videoDuration > 0) {
      const delta = Math.abs(computedVideoDuration - videoDuration);
      if (delta > threshold) {
        errors.push(`computed_dur(${computedVideoDuration.toFixed(3)}) vs video_dur(${videoDuration.toFixed(3)}) delta=${delta.toFixed(3)}s`);
      }
    }

    // Check 3: Video duration vs audio duration (if audio exists)
    if (audioDuration > 0 && videoDuration > 0) {
      const delta = Math.abs(videoDuration - audioDuration);
      if (delta > threshold) {
        errors.push(`video_dur(${videoDuration.toFixed(3)}) vs audio_dur(${audioDuration.toFixed(3)}) delta=${delta.toFixed(3)}s`);
      }
    }

    if (errors.length > 0) {
      return {
        valid: false,
        error: errors.join('; '),
        details: { videoFrames, videoFps, videoDuration, audioDuration, formatDuration, computedVideoDuration }
      };
    }

    console.log(`[${jobId}] VALIDATION PASSED: A/V sync within ${threshold}s threshold`);
    return {
      valid: true,
      details: { videoFrames, videoFps, videoDuration, audioDuration, formatDuration, computedVideoDuration }
    };

  } catch (err) {
    return {
      valid: false,
      error: `Probe failed: ${err.message}`,
      details: {}
    };
  }
}

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
      const uploadedToStorage = job.extensionStreamData?.uploadedToStorage;

      console.log(`[${jobId}] Extension stream check: source=${extensionStreamSource}, uploadedToStorage=${uploadedToStorage}, videoUrl=${job.extensionStreamData?.videoUrl?.substring(0, 50)}...`);

      // These capture methods upload video to storage and bypass IP-restriction:
      // - mediarecorder_primary: Primary capture method (v2.1+)
      // - mediarecorder_capture: Legacy capture method
      // - mediarecorder_local: Captured but server unavailable (frontend uploaded)
      // - browser_download: Direct download method
      // - source_asset: Video stored as sourceAsset in project (v2.7+)
      // - extension_capture_fallback: Fallback capture from extension at export time
      const uploadedCaptureSources = ['mediarecorder_primary', 'mediarecorder_capture', 'mediarecorder_local', 'browser_download', 'source_asset', 'extension_capture_fallback'];

      // IMPORTANT: If we have a valid storage URL, treat it as uploaded regardless of source type
      const hasValidStorageUrl = job.extensionStreamData?.videoUrl?.includes('storage.googleapis.com') ||
                                  job.extensionStreamData?.videoUrl?.includes('firebasestorage.app');
      const isUploadedCapture = (uploadedCaptureSources.includes(extensionStreamSource) && uploadedToStorage) ||
                                 hasValidStorageUrl;

      console.log(`[${jobId}] isUploadedCapture=${isUploadedCapture} (sourceInList=${uploadedCaptureSources.includes(extensionStreamSource)}, hasValidStorageUrl=${hasValidStorageUrl})`);

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
          // Determine file extension from URL or source type
          // - MediaRecorder produces webm
          // - browser_download and source_asset could be mp4 or webm
          const videoUrl = job.extensionStreamData.videoUrl || '';
          let fileExt = 'webm';
          if (videoUrl.includes('.mp4') || extensionStreamSource === 'browser_download') {
            fileExt = 'mp4';
          } else if (videoUrl.includes('.webm')) {
            fileExt = 'webm';
          }
          const capturedFile = path.join(workDir, `captured.${fileExt}`);
          fs.writeFileSync(capturedFile, Buffer.from(buffer));
          console.log(`[${jobId}] Downloaded ${extensionStreamSource}: ${fs.statSync(capturedFile).size} bytes`);

          // CRITICAL FIX: Remux WebM to fix broken container metadata
          // MediaRecorder WebM files have duration=0 and frames=0 in metadata
          // but valid packet-level timestamps. Remuxing fixes this.
          if (fileExt === 'webm') {
            console.log(`[${jobId}] Remuxing WebM to fix broken container metadata...`);
            const remuxedFile = path.join(workDir, 'captured_remuxed.webm');
            try {
              execSync(`ffmpeg -i "${capturedFile}" -c copy -y "${remuxedFile}"`, {
                timeout: 60000,
                stdio: ['pipe', 'pipe', 'pipe']
              });
              if (fs.existsSync(remuxedFile) && fs.statSync(remuxedFile).size > 0) {
                fs.unlinkSync(capturedFile);
                fs.renameSync(remuxedFile, capturedFile);
                console.log(`[${jobId}] WebM remuxed successfully - metadata fixed`);
              }
            } catch (remuxErr) {
              console.warn(`[${jobId}] WebM remux failed (continuing anyway): ${remuxErr.message}`);
            }
          }

          // DIAGNOSTIC STAGE 1: Probe raw captured file BEFORE any processing
          // This tells us if MediaRecorder produced correct timestamps
          probePTS(jobId, capturedFile, 'STAGE_1_RAW_CAPTURE');
          // PACKET-LEVEL probe to distinguish "no timestamps" vs "container metadata incomplete"
          probePacketPTS(jobId, capturedFile, 'STAGE_1_RAW_CAPTURE');

          // Probe the captured file to get duration, frame count, and audio duration
          // These are needed to calculate correct fps for timestamp correction
          let capturedFileDuration = null;
          let capturedFrameCount = 0;
          let capturedAudioDuration = 0;
          let capturedVideoDuration = 0;

          try {
            const probeCmd = `ffprobe -v quiet -print_format json -show_streams -show_format -count_frames "${capturedFile}"`;
            const probeResult = execSync(probeCmd, { encoding: 'utf8', timeout: 60000 });
            const probeData = JSON.parse(probeResult);

            for (const stream of probeData.streams || []) {
              if (stream.codec_type === 'video') {
                capturedFrameCount = parseInt(stream.nb_frames || stream.nb_read_frames || 0);
                capturedVideoDuration = parseFloat(stream.duration || 0);
              } else if (stream.codec_type === 'audio') {
                capturedAudioDuration = parseFloat(stream.duration || 0);
              }
            }

            capturedFileDuration = parseFloat(probeData.format?.duration) || capturedAudioDuration || capturedVideoDuration;
            console.log(`[${jobId}] Probe: duration=${capturedFileDuration?.toFixed(2)}s, frames=${capturedFrameCount}, audioDur=${capturedAudioDuration.toFixed(2)}s`);
          } catch (probeErr) {
            console.warn(`[${jobId}] Could not probe captured file: ${probeErr.message}`);
          }

          // Calculate the actual fps from frame count and audio duration (audio is usually reliable)
          const targetDuration = capturedAudioDuration || capturedFileDuration || 30;
          const actualFps = capturedFrameCount > 0 ? capturedFrameCount / targetDuration : 30;
          console.log(`[${jobId}] Calculated actualFps: ${actualFps.toFixed(2)} (${capturedFrameCount} frames / ${targetDuration.toFixed(2)}s)`)

          // Check if we need to extract a specific segment from the captured video
          // The extension may have captured more than needed (e.g., full 5 minutes)
          // while the clip only needs a portion (e.g., 30 seconds at 2:00)
          const clipStart = job.startTime || 0;
          const clipEnd = job.endTime || (clipStart + 60);
          const clipDuration = clipEnd - clipStart;

          // Smart detection: if captured file duration is close to clip duration,
          // the capture IS the clip segment - no extraction needed
          const capturedMatchesClip = capturedFileDuration &&
            Math.abs(capturedFileDuration - clipDuration) < 5; // within 5 seconds

          // Only use explicit capture timestamps if they were actually set
          const hasExplicitCaptureTime = job.extensionStreamData?.captureStartTime !== undefined;
          const capturedStart = hasExplicitCaptureTime ? job.extensionStreamData.captureStartTime : clipStart;
          const capturedEnd = hasExplicitCaptureTime ? (job.extensionStreamData.captureEndTime || capturedStart + 300) : clipEnd;

          console.log(`[${jobId}] Clip: ${clipStart}s-${clipEnd}s (${clipDuration}s), Capture: ${capturedStart}s-${capturedEnd}s, matchesClip=${capturedMatchesClip}`);

          // Calculate if segment extraction is needed
          const needsExtraction = !capturedMatchesClip &&
            ((clipStart > capturedStart) || (clipEnd < capturedEnd));

          if (needsExtraction && clipStart >= capturedStart && clipEnd <= capturedEnd) {
            // Extract the specific segment from the captured video
            const relativeStart = clipStart - capturedStart;
            const relativeEnd = clipEnd - capturedStart;
            const duration = relativeEnd - relativeStart;
            console.log(`[${jobId}] Extracting segment ${relativeStart}s-${relativeEnd}s (${duration}s) from captured video`);
            await updateProgress(jobRef, 15, 'Extracting clip segment...');

            // Output as mp4 for better compatibility
            downloadedFile = path.join(workDir, 'source.mp4');

            // FIRST PRINCIPLES: Preserve original timestamps, don't manipulate them.
            // For webm: Re-encode (since -c copy doesn't work reliably for webm)
            // For mp4: Use stream copy for speed
            // In both cases: DO NOT use setpts - preserve original timing
            const useReencode = fileExt === 'webm';

            const ffmpegArgs = [
              // CRITICAL: Fix broken timestamps from MediaRecorder WebM
              // +igndts ignores broken DTS, +genpts generates new PTS
              '-fflags', '+igndts+genpts',
              '-ss', String(relativeStart),   // Seek to start position
              '-i', capturedFile,
              '-t', String(duration),         // Duration to extract
              ...(useReencode
                ? ['-r', '30',        // Force 30fps OUTPUT (fixes 1000fps detection)
                   '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
                   '-c:a', 'aac', '-b:a', '192k']
                : ['-c', 'copy']),
              '-avoid_negative_ts', 'make_zero',
              '-y',
              downloadedFile
            ];

            console.log(`[${jobId}] FFmpeg extraction: ${useReencode ? 're-encoding' : 'stream copy'}`);

            await new Promise((resolve, reject) => {
              const ffmpeg = spawn('ffmpeg', ffmpegArgs);

              let stderr = '';
              ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });
              ffmpeg.on('close', (code) => {
                const fileSize = fs.existsSync(downloadedFile) ? fs.statSync(downloadedFile).size : 0;
                console.log(`[${jobId}] Segment extraction finished: code=${code}, size=${fileSize} bytes`);

                if (code === 0 && fileSize > 0) {
                  console.log(`[${jobId}] Segment extracted successfully: ${fileSize} bytes`);
                  resolve();
                } else if (code === 0 && fileSize === 0) {
                  // Extraction "succeeded" but produced empty file - fall back to full file
                  console.warn(`[${jobId}] Segment extraction produced empty file, using full capture`);
                  downloadedFile = capturedFile;
                  resolve();
                } else {
                  reject(new Error(`FFmpeg segment extraction failed (code ${code}): ${stderr.slice(-300)}`));
                }
              });
              ffmpeg.on('error', reject);
            });

            // Cleanup captured file if we successfully extracted a segment
            if (downloadedFile !== capturedFile) {
              try { fs.unlinkSync(capturedFile); } catch (e) {}
            }
          } else {
            // Capture matches clip - no segment extraction needed
            // But webm files still need to be converted to mp4 for reliable processing
            if (fileExt === 'webm') {
              console.log(`[${jobId}] Converting webm to mp4 for reliable processing...`);
              downloadedFile = path.join(workDir, 'source.mp4');

              // =============================
              // PTS RESCALING FIX (Feature Flag: PTS_RESCALE_ENABLED)
              // =============================
              // Root cause identified: MediaRecorder writes timestamps that are compressed
              // relative to real-world time. The PTS span (~7.5s) doesn't match the actual
              // capture duration (~30s), causing 4x playback speed.
              //
              // Solution: Rescale PTS by factor = realWorldDuration / actualPtsSpan
              // This preserves relative frame timing while stretching to correct duration.

              // Get real-world duration from job (clip endTime - startTime)
              const realWorldDuration = clipDuration; // Already calculated above
              console.log(`[${jobId}] Real-world clip duration: ${realWorldDuration.toFixed(2)}s`);

              // Get actual PTS span from packet-level timestamps
              const videoPtsInfo = getPacketPTSSpan(capturedFile, 'v');
              const audioPtsInfo = getPacketPTSSpan(capturedFile, 'a');

              console.log(`[${jobId}] VIDEO PTS: span=${videoPtsInfo.ptsSpan?.toFixed(3) ?? 'N/A'}s, packets=${videoPtsInfo.packetCount}, first=${videoPtsInfo.firstPts?.toFixed(3) ?? 'N/A'}s, last=${videoPtsInfo.lastPts?.toFixed(3) ?? 'N/A'}s`);
              console.log(`[${jobId}] AUDIO PTS: span=${audioPtsInfo.ptsSpan?.toFixed(3) ?? 'N/A'}s, packets=${audioPtsInfo.packetCount}, first=${audioPtsInfo.firstPts?.toFixed(3) ?? 'N/A'}s, last=${audioPtsInfo.lastPts?.toFixed(3) ?? 'N/A'}s`);

              // Determine if PTS rescaling is needed and calculate scale factor
              let useRescaling = false;
              let scaleFactor = 1.0;
              let videoFilter = null;
              let audioFilter = null;

              if (PTS_RESCALE_ENABLED && videoPtsInfo.isValid && videoPtsInfo.ptsSpan > 0) {
                // Check if PTS span significantly differs from real-world duration (>10% difference)
                const ptsDelta = Math.abs(videoPtsInfo.ptsSpan - realWorldDuration);
                const ptsRatio = realWorldDuration / videoPtsInfo.ptsSpan;

                // NOTE: The browser extension now captures at 1x playback speed for reliable audio.
                // This means PTS span should match the intended clip duration.
                // The rescaling logic below is kept for backward compatibility with older captures
                // that may have been captured at 4x speed.

                const inferredFps = videoPtsInfo.packetCount / videoPtsInfo.ptsSpan;

                console.log(`[${jobId}] PTS ANALYSIS: ptsSpan=${videoPtsInfo.ptsSpan.toFixed(3)}s, realWorld=${realWorldDuration.toFixed(2)}s, ratio=${ptsRatio.toFixed(3)}, delta=${ptsDelta.toFixed(3)}s`);
                console.log(`[${jobId}] FRAME RATE CHECK: ${videoPtsInfo.packetCount} frames / ${videoPtsInfo.ptsSpan.toFixed(3)}s = ${inferredFps.toFixed(2)} fps (likely 4x speedup artifact)`);

                if (ptsDelta > realWorldDuration * 0.1) {
                  // PTS span differs by more than 10% - rescaling needed
                  useRescaling = true;
                  scaleFactor = ptsRatio;

                  // Video filter: scale PTS by factor
                  // setpts=PTS*scaleFactor stretches timestamps proportionally
                  videoFilter = `setpts=PTS*${scaleFactor.toFixed(6)}`;

                  // Audio: check if it has same compression factor
                  if (audioPtsInfo.isValid && audioPtsInfo.ptsSpan > 0) {
                    const audioRatio = realWorldDuration / audioPtsInfo.ptsSpan;
                    const audioVideoDelta = Math.abs(audioRatio - ptsRatio);

                    console.log(`[${jobId}] AUDIO PTS ratio: ${audioRatio.toFixed(3)}, video ratio: ${ptsRatio.toFixed(3)}, delta: ${audioVideoDelta.toFixed(3)}`);

                    if (audioVideoDelta < 0.1) {
                      // Audio captured via Web Audio API while video played at 4x.
                      // Extension uses createMediaElementSource() + createMediaStreamDestination()
                      // to properly capture audio at the actual playback rate.
                      //
                      // Audio content is at 4x speed (7.5s of 4x-pitch audio for 30s video).
                      // Need to slow it down by 4x using atempo to get normal-speed audio.
                      //
                      // atempo range is 0.5-2.0, so for 0.25 (4x slowdown) we chain:
                      // atempo=0.5,atempo=0.5 = 0.25
                      //
                      const targetAtempo = 1 / scaleFactor;  // e.g., 0.25 for 4x slowdown
                      let chainCount = 1;
                      // Find minimum chains needed (each atempo must be >= 0.5)
                      while (Math.pow(targetAtempo, 1/chainCount) < 0.5 && chainCount < 10) {
                        chainCount++;
                      }
                      const singleAtempo = Math.pow(targetAtempo, 1/chainCount);
                      audioFilter = Array(chainCount).fill(`atempo=${singleAtempo.toFixed(6)}`).join(',');
                      console.log(`[${jobId}] AUDIO: targetAtempo=${targetAtempo.toFixed(4)}, chains=${chainCount}, each=${singleAtempo.toFixed(4)}`);
                      console.log(`[${jobId}] AUDIO: Using atempo to slow down 4x-speed captured audio`);
                    } else {
                      console.log(`[${jobId}] AUDIO: Different compression ratio - may cause A/V desync`);
                      // Don't filter audio - it might already be correct
                      audioFilter = null;
                    }
                  } else {
                    console.log(`[${jobId}] AUDIO: No valid PTS span - skipping audio rescaling`);
                  }

                  console.log(`[${jobId}] PTS RESCALING: scaleFactor=${scaleFactor.toFixed(3)} (${videoPtsInfo.ptsSpan.toFixed(2)}s → ${realWorldDuration.toFixed(2)}s)`);
                  console.log(`[${jobId}] Video filter: ${videoFilter}`);
                  console.log(`[${jobId}] Audio filter: ${audioFilter || 'none'}`);
                } else {
                  console.log(`[${jobId}] PTS span within 10% of real-world duration - no rescaling needed`);
                }
              } else if (!PTS_RESCALE_ENABLED) {
                console.log(`[${jobId}] PTS_RESCALE_ENABLED=false - skipping timestamp correction`);
              } else {
                console.log(`[${jobId}] Invalid video PTS span - cannot rescale`);
              }

              // Build FFmpeg arguments
              // CRITICAL: +igndts ignores broken DTS, +genpts generates new PTS
              const ffmpegArgs = ['-fflags', '+igndts+genpts', '-i', capturedFile];

              if (useRescaling && videoFilter) {
                ffmpegArgs.push('-vf', videoFilter);
                if (audioFilter) {
                  ffmpegArgs.push('-af', audioFilter);
                }
              }

              // CRITICAL: Fix MediaRecorder WebM timestamp issues
              // -r 30 forces 30fps output (fixes FFmpeg detecting 1000fps)
              ffmpegArgs.push(
                '-r', '30',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
                '-c:a', 'aac', '-b:a', '192k',
                '-y',
                downloadedFile
              );

              console.log(`[${jobId}] FFmpeg transcode: ${ffmpegArgs.join(' ')}`);

              await new Promise((resolve, reject) => {
                const ffmpeg = spawn('ffmpeg', ffmpegArgs);

                let stderr = '';
                ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });
                ffmpeg.on('close', async (code) => {
                  const fileSize = fs.existsSync(downloadedFile) ? fs.statSync(downloadedFile).size : 0;
                  if (code === 0 && fileSize > 1000) {
                    console.log(`[${jobId}] Converted to mp4: ${fileSize} bytes`);

                    // DIAGNOSTIC STAGE 2: Probe AFTER transcode (WebM → MP4)
                    probePTS(jobId, downloadedFile, 'STAGE_2_AFTER_TRANSCODE');

                    // VALIDATION GATE: Verify PTS span matches expected duration
                    if (useRescaling) {
                      const outputVideoPts = getPacketPTSSpan(downloadedFile, 'v');
                      const outputAudioPts = getPacketPTSSpan(downloadedFile, 'a');

                      console.log(`[${jobId}] ========== POST-FIX VALIDATION ==========`);
                      console.log(`[${jobId}] OUTPUT VIDEO PTS: span=${outputVideoPts.ptsSpan?.toFixed(3) ?? 'N/A'}s, expected=${realWorldDuration.toFixed(2)}s`);
                      console.log(`[${jobId}] OUTPUT AUDIO PTS: span=${outputAudioPts.ptsSpan?.toFixed(3) ?? 'N/A'}s`);

                      if (outputVideoPts.isValid) {
                        const outputDelta = Math.abs(outputVideoPts.ptsSpan - realWorldDuration);
                        const tolerance = realWorldDuration * 0.05; // 5% tolerance

                        if (outputDelta <= tolerance) {
                          console.log(`[${jobId}] VALIDATION PASSED: Output PTS span within 5% of expected (delta=${outputDelta.toFixed(3)}s)`);
                        } else {
                          console.warn(`[${jobId}] VALIDATION WARNING: Output PTS span differs by ${outputDelta.toFixed(3)}s (>${tolerance.toFixed(3)}s tolerance)`);
                        }

                        // Check A/V sync if both streams exist
                        if (outputAudioPts.isValid) {
                          const avDelta = Math.abs(outputVideoPts.ptsSpan - outputAudioPts.ptsSpan);
                          if (avDelta <= 0.5) {
                            console.log(`[${jobId}] A/V SYNC: OK (delta=${avDelta.toFixed(3)}s)`);
                          } else {
                            console.warn(`[${jobId}] A/V SYNC WARNING: Video/Audio span differ by ${avDelta.toFixed(3)}s`);
                          }
                        }
                      }
                      console.log(`[${jobId}] ========== END VALIDATION ==========`);
                    }

                    try { fs.unlinkSync(capturedFile); } catch (e) {}
                    resolve();
                  } else {
                    console.warn(`[${jobId}] webm->mp4 conversion failed: ${stderr.slice(-300)}`);
                    downloadedFile = capturedFile;
                    resolve();
                  }
                });
                ffmpeg.on('error', () => {
                  downloadedFile = capturedFile;
                  resolve();
                });
              });
            } else {
              downloadedFile = capturedFile;
              console.log(`[${jobId}] Using captured video directly (segment matches clip)`);
            }
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

    // Step 2: Check for multi-source modes (split screen, three_person, gameplay)
    let processedFile;
    const secondarySource = job.settings?.secondarySource;
    const tertiarySource = job.settings?.tertiarySource;
    const reframeMode = job.settings?.reframeMode || 'auto_center';

    // Detailed logging for multi-source detection
    console.log(`[${jobId}] ========== MULTI-SOURCE MODE CHECK ==========`);
    console.log(`[${jobId}] Reframe mode: ${reframeMode}`);
    console.log(`[${jobId}] Secondary source exists: ${!!secondarySource}`);
    if (secondarySource) {
      console.log(`[${jobId}] Secondary enabled: ${secondarySource.enabled}`);
      console.log(`[${jobId}] Secondary type: ${secondarySource.type}`);
      console.log(`[${jobId}] Secondary uploadedUrl: ${secondarySource.uploadedUrl ? 'YES' : 'NO'}`);
      console.log(`[${jobId}] Secondary youtubeVideoId: ${secondarySource.youtubeVideoId || 'NO'}`);
      console.log(`[${jobId}] Secondary position: ${secondarySource.position}`);
    }
    console.log(`[${jobId}] Tertiary source exists: ${!!tertiarySource}`);
    if (tertiarySource) {
      console.log(`[${jobId}] Tertiary enabled: ${tertiarySource.enabled}`);
      console.log(`[${jobId}] Tertiary uploadedUrl: ${tertiarySource.uploadedUrl ? 'YES' : 'NO'}`);
      console.log(`[${jobId}] Tertiary youtubeVideoId: ${tertiarySource.youtubeVideoId || 'NO'}`);
    }

    const hasSecondary = secondarySource?.enabled && (secondarySource.uploadedUrl || secondarySource.youtubeVideoId);
    const hasTertiary = tertiarySource?.enabled && (tertiarySource.uploadedUrl || tertiarySource.youtubeVideoId);

    // Determine processing mode
    const isThreePersonMode = reframeMode === 'three_person' && hasSecondary && hasTertiary;
    const isGameplayMode = reframeMode === 'gameplay' && hasSecondary;
    const isSplitScreenMode = ['split_screen', 'broll_split'].includes(reframeMode) && hasSecondary;

    console.log(`[${jobId}] Is three_person mode: ${isThreePersonMode}`);
    console.log(`[${jobId}] Is gameplay mode: ${isGameplayMode}`);
    console.log(`[${jobId}] Is split_screen mode: ${isSplitScreenMode}`);
    console.log(`[${jobId}] ========================================`);

    const primaryDuration = (job.endTime || 60) - (job.startTime || 0);

    if (isThreePersonMode) {
      // Three person mode: main video at top, two videos at bottom
      console.log(`[${jobId}] Starting three-source processing (three_person mode)`);
      await updateProgress(jobRef, 35, 'Downloading secondary videos...');

      const secondaryFile = await downloadSecondarySource({
        jobId,
        secondarySource,
        workDir,
        primaryDuration,
        youtubeAuth
      });

      const tertiaryFile = await downloadTertiarySource({
        jobId,
        tertiarySource,
        workDir,
        primaryDuration,
        youtubeAuth
      });

      if (secondaryFile && tertiaryFile) {
        console.log(`[${jobId}] All three sources downloaded, starting three-source processing`);
        await updateProgress(jobRef, 50, 'Processing three person split...');
        processedFile = await processThreeSourceVideo({
          jobId,
          primaryFile: downloadedFile,
          secondaryFile,
          tertiaryFile,
          settings: job.settings,
          output: job.output,
          workDir
        });
      } else if (secondaryFile) {
        // Fallback to two-source if tertiary failed
        console.warn(`[${jobId}] Tertiary download failed, falling back to two-source split`);
        await updateProgress(jobRef, 50, 'Processing split screen (partial)...');
        processedFile = await processMultiSourceVideo({
          jobId,
          primaryFile: downloadedFile,
          secondaryFile,
          settings: job.settings,
          output: job.output,
          workDir
        });
      } else {
        // Fallback to single-source
        console.error(`[${jobId}] Secondary download failed, falling back to single-source`);
        processedFile = await processVideoFile({
          jobId,
          inputFile: downloadedFile,
          settings: job.settings,
          output: job.output,
          workDir
        });
      }
    } else if (isGameplayMode) {
      // Gameplay mode: main video with facecam overlay in corner
      console.log(`[${jobId}] Starting gameplay processing with facecam overlay`);
      await updateProgress(jobRef, 35, 'Downloading facecam video...');

      const secondaryFile = await downloadSecondarySource({
        jobId,
        secondarySource,
        workDir,
        primaryDuration,
        youtubeAuth
      });

      if (secondaryFile) {
        console.log(`[${jobId}] Facecam downloaded, starting gameplay processing`);
        await updateProgress(jobRef, 50, 'Processing gameplay with facecam...');
        processedFile = await processGameplayVideo({
          jobId,
          primaryFile: downloadedFile,
          secondaryFile,
          settings: job.settings,
          output: job.output,
          workDir
        });
      } else {
        // Fallback to single-source if facecam download failed
        console.warn(`[${jobId}] Facecam download failed, processing without overlay`);
        processedFile = await processVideoFile({
          jobId,
          inputFile: downloadedFile,
          settings: job.settings,
          output: job.output,
          workDir
        });
      }
    } else if (isSplitScreenMode) {
      // Split screen mode: two videos stacked
      console.log(`[${jobId}] Starting split screen processing with mode: ${reframeMode}`);
      await updateProgress(jobRef, 35, 'Downloading secondary video...');

      const secondaryFile = await downloadSecondarySource({
        jobId,
        secondarySource,
        workDir,
        primaryDuration,
        youtubeAuth
      });

      if (secondaryFile) {
        console.log(`[${jobId}] Secondary source downloaded successfully, starting multi-source processing`);
        await updateProgress(jobRef, 50, 'Processing split screen...');
        processedFile = await processMultiSourceVideo({
          jobId,
          primaryFile: downloadedFile,
          secondaryFile,
          settings: job.settings,
          output: job.output,
          workDir
        });
      } else {
        // Fallback to single-source if secondary download failed
        console.error(`[${jobId}] FALLBACK: Secondary source download failed, using single-source processing`);
        await updateProgress(jobRef, 40, 'Processing video (single source fallback)...');
        processedFile = await processVideoFile({
          jobId,
          inputFile: downloadedFile,
          settings: job.settings,
          output: job.output,
          workDir
        });
      }
    } else {
      // Standard single-source processing
      console.log(`[${jobId}] Using standard single-source processing`);
      processedFile = await processVideoFile({
        jobId,
        inputFile: downloadedFile,
        settings: job.settings,
        output: job.output,
        workDir
      });
    }

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

  // Log incoming settings for debugging
  console.log(`[${jobId}] ========== PROCESSING SETTINGS ==========`);
  console.log(`[${jobId}] reframeMode: ${safeSettings.reframeMode || 'auto_center (default)'}`);
  console.log(`[${jobId}] cropPosition: ${safeSettings.cropPosition} (type: ${typeof safeSettings.cropPosition})`);
  console.log(`[${jobId}] All settings:`, JSON.stringify(safeSettings, null, 2));
  console.log(`[${jobId}] ==========================================`);

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

  // Determine if this is a complex filter mode (uses labeled streams)
  const reframeMode = safeSettings.reframeMode || 'auto_center';
  const normalizedMode = reframeMode === 'broll_split' ? 'b_roll' : reframeMode;
  const isComplexFilter = ['split_screen', 'three_person'].includes(normalizedMode);

  // Build FFmpeg filter chain
  let filters = buildFilterChain({
    inputWidth: videoInfo.width,
    inputHeight: videoInfo.height,
    targetWidth,
    targetHeight,
    reframeMode: reframeMode,
    cropPosition: safeSettings.cropPosition !== undefined ? safeSettings.cropPosition : 50,
    autoZoom: safeSettings.autoZoom,
    vignette: safeSettings.vignette,
    colorGrade: safeSettings.colorGrade
  });

  // Add subtitle filter if captions were generated
  let escapedCaptionPath = null;
  if (captionFile) {
    if (fs.existsSync(captionFile)) {
      const captionSize = fs.statSync(captionFile).size;
      console.log(`[${jobId}] Caption file verified: ${captionFile} (${captionSize} bytes)`);
      // Escape special characters in path for FFmpeg
      escapedCaptionPath = captionFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");

      if (isComplexFilter) {
        // For complex filter graphs (split_screen, three_person), we need to:
        // 1. Label the final output of the filter chain
        // 2. Apply ASS filter to that labeled output
        // The filter ends with 'vstack' - we need to add output label and ASS filter
        filters = `${filters}[vout];[vout]ass='${escapedCaptionPath}'`;
        console.log(`[${jobId}] Adding captions to complex filter chain`);
      } else {
        // For simple filter chains, just append the ASS filter
        filters = `${filters},ass='${escapedCaptionPath}'`;
        console.log(`[${jobId}] Adding captions to simple filter chain`);
      }
    } else {
      console.error(`[${jobId}] Caption file NOT FOUND: ${captionFile} - video will be exported without captions`);
    }
  }

  // Build audio filters
  const audioFilters = buildAudioFilters({
    enhanceAudio: safeSettings.enhanceAudio,
    removeFiller: safeSettings.removeFiller
  });

  // Get FPS with safe default
  const targetFps = output?.fps || 30;

  // For complex filter graphs with labeled streams, use -filter_complex
  // For simple linear chains, use -vf
  const filterFlag = isComplexFilter ? '-filter_complex' : '-vf';

  // Calculate expected duration for validation using actual video info
  const expectedDuration = videoInfo.duration || 30;

  /**
   * Run FFmpeg encoding with specified encoder args
   * @param {string[]} encoderArgs - Video encoding arguments
   * @param {string} encoderName - Name for logging (GPU/CPU)
   * @returns {Promise<string>} Output file path
   */
  const runFFmpegEncode = (encoderArgs, encoderName) => {
    return new Promise((resolve, reject) => {
      const audioEncoding = getAudioEncodingArgs();

      // NOTE: -fflags +igndts+genpts REMOVED for MP4 input
      // The WebM→MP4 transcode step already fixed timestamps with -r 30
      // Using fflags on properly formatted MP4 was confusing NVENC
      const args = [
        '-i', inputFile,
        filterFlag, filters,
        '-af', audioFilters,
        ...encoderArgs,
        ...audioEncoding,
        '-r', targetFps.toString(),
        '-movflags', '+faststart',
        '-y',
        outputFile
      ];

      console.log(`[${jobId}] FFmpeg command (${encoderName}): ffmpeg ${args.join(' ')}`);

      const ffmpegProcess = spawn('ffmpeg', args);

      let stderr = '';

      ffmpegProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        // Log progress from FFmpeg
        const match = stderr.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (match) {
          console.log(`[${jobId}] FFmpeg progress (${encoderName}): ${match[1]}`);
        }
      });

      ffmpegProcess.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputFile)) {
          console.log(`[${jobId}] FFmpeg ${encoderName} encoding completed: ${outputFile}`);
          resolve(outputFile);
        } else {
          console.error(`[${jobId}] FFmpeg ${encoderName} failed. Code: ${code}`);
          console.error(`[${jobId}] stderr: ${stderr.slice(-500)}`);
          reject(new Error(`Video processing failed (${encoderName}): ${code}`));
        }
      });

      ffmpegProcess.on('error', (error) => {
        reject(new Error(`Failed to start FFmpeg (${encoderName}): ${error.message}`));
      });
    });
  };

  // Main encoding logic with validation and retry
  try {
    // First attempt: Use GPU if available
    const primaryEncoderArgs = getVideoEncodingArgs('medium');
    const primaryEncoderName = checkGpuIfNeeded() ? 'GPU' : 'CPU';

    await runFFmpegEncode(primaryEncoderArgs, primaryEncoderName);

    // CRITICAL: Validate output to detect frozen video
    console.log(`[${jobId}] Validating ${primaryEncoderName} output...`);
    const validation = validateVideoOutput(outputFile, expectedDuration);

    if (validation.isValid) {
      console.log(`[${jobId}] ✅ ${primaryEncoderName} output validated successfully`);
      return outputFile;
    }

    // If GPU output is frozen and we were using GPU, retry with CPU
    if (checkGpuIfNeeded() && !validation.isValid) {
      console.warn(`[${jobId}] ⚠️ ${primaryEncoderName} output validation FAILED: ${validation.message}`);
      console.log(`[${jobId}] 🔄 Retrying with CPU encoding (libx264)...`);

      // Delete failed output
      try { fs.unlinkSync(outputFile); } catch (e) {}

      // Retry with CPU
      const cpuEncoderArgs = getCpuEncodingArgs('medium');
      await runFFmpegEncode(cpuEncoderArgs, 'CPU-FALLBACK');

      // Validate CPU output
      console.log(`[${jobId}] Validating CPU fallback output...`);
      const cpuValidation = validateVideoOutput(outputFile, expectedDuration);

      if (cpuValidation.isValid) {
        console.log(`[${jobId}] ✅ CPU fallback output validated successfully`);
        return outputFile;
      } else {
        console.error(`[${jobId}] ❌ CPU fallback also failed validation: ${cpuValidation.message}`);
        // Return anyway - let the user see the result and report
        console.warn(`[${jobId}] ⚠️ Returning video despite validation failure for debugging`);
        return outputFile;
      }
    }

    // If we weren't using GPU and validation failed, return anyway for debugging
    console.warn(`[${jobId}] ⚠️ Output validation failed but no fallback available: ${validation.message}`);
    return outputFile;

  } catch (error) {
    throw error;
  }
}

/**
 * Build FFmpeg video filter chain
 */
function buildFilterChain({ inputWidth, inputHeight, targetWidth, targetHeight, reframeMode, cropPosition, autoZoom, vignette, colorGrade }) {
  const filters = [];

  // Validate and fix input dimensions - CRITICAL for crop calculations
  // If dimensions are invalid, assume standard 16:9 HD (1920x1080)
  let validWidth = inputWidth;
  let validHeight = inputHeight;

  if (!inputWidth || !inputHeight || inputWidth <= 0 || inputHeight <= 0) {
    console.error(`[FFmpeg] INVALID INPUT DIMENSIONS: ${inputWidth}x${inputHeight} - assuming 1920x1080`);
    validWidth = 1920;
    validHeight = 1080;
  }

  const inputAspect = validWidth / validHeight;
  const targetAspect = targetWidth / targetHeight; // 9:16 = 0.5625

  console.log(`[FFmpeg] Building filter chain:`);
  console.log(`[FFmpeg]   Input: ${validWidth}x${validHeight} (aspect: ${inputAspect.toFixed(4)}) ${inputWidth !== validWidth ? '[USING DEFAULTS]' : ''}`);
  console.log(`[FFmpeg]   Target: ${targetWidth}x${targetHeight} (aspect: ${targetAspect.toFixed(4)})`);
  console.log(`[FFmpeg]   Mode: ${reframeMode}, CropPosition: ${cropPosition}`);

  // Normalize reframe mode names (frontend uses 'broll_split', backend used 'b_roll')
  const normalizedMode = reframeMode === 'broll_split' ? 'b_roll' : reframeMode;

  // Check if this is a complex filter mode (uses split/labeled streams)
  const isComplexMode = ['split_screen', 'three_person'].includes(normalizedMode);

  // NOTE: fps filter REMOVED - it was causing NVENC to freeze on already-30fps input
  // The WebM→MP4 transcode already uses -r 30 to fix VFR issues
  // The final encoding command also uses -r 30 for output framerate
  // Adding fps filter here was redundant and interfered with NVENC frame handling

  // Step 1: Reframe/Crop based on mode
  switch (normalizedMode) {
    case 'split_screen':
      // Split screen: Show left and right speakers stacked vertically (for podcasts)
      // Take left 1/3 and right 1/3 of the video, stack them
      const splitCropW = Math.floor(validWidth / 3);
      const splitHalfH = Math.floor(targetHeight / 2);
      filters.push(`split[left][right]`);
      filters.push(`[left]crop=${splitCropW}:${validHeight}:0:0,scale=${targetWidth}:${splitHalfH}:force_original_aspect_ratio=increase,crop=${targetWidth}:${splitHalfH}[l]`);
      filters.push(`[right]crop=${splitCropW}:${validHeight}:${validWidth - splitCropW}:0,scale=${targetWidth}:${splitHalfH}:force_original_aspect_ratio=increase,crop=${targetWidth}:${splitHalfH}[r]`);
      filters.push(`[l][r]vstack`);
      break;

    case 'three_person':
      // Three person: Show three speakers - top (center), bottom-left, bottom-right
      const thirdW = Math.floor(validWidth / 3);
      const topH = Math.floor(targetHeight * 0.55);
      const bottomH = targetHeight - topH;
      const halfTargetW = Math.floor(targetWidth / 2);
      filters.push(`split=3[center][bl][br]`);
      filters.push(`[center]crop=${thirdW}:${validHeight}:${thirdW}:0,scale=${targetWidth}:${topH}:force_original_aspect_ratio=increase,crop=${targetWidth}:${topH}[c]`);
      filters.push(`[bl]crop=${thirdW}:${validHeight}:0:0,scale=${halfTargetW}:${bottomH}:force_original_aspect_ratio=increase,crop=${halfTargetW}:${bottomH}[left]`);
      filters.push(`[br]crop=${thirdW}:${validHeight}:${2 * thirdW}:0,scale=${halfTargetW}:${bottomH}:force_original_aspect_ratio=increase,crop=${halfTargetW}:${bottomH}[right]`);
      filters.push(`[left][right]hstack[bottom]`);
      filters.push(`[c][bottom]vstack`);
      break;

    case 'gameplay':
      // Gameplay mode: Main video fills most, small facecam area in corner
      // First crop to 9:16, then overlay facecam area
      if (inputAspect > targetAspect) {
        const gameCropW = Math.floor(validHeight * targetAspect);
        const gameCropX = Math.floor((validWidth - gameCropW) / 2);
        // Show more of the main game area, with a circle/facecam indicator
        filters.push(`crop=${gameCropW}:${validHeight}:${gameCropX}:0`);
      } else {
        const gameCropH = Math.floor(validWidth / targetAspect);
        const gameCropY = Math.floor((validHeight - gameCropH) / 2);
        filters.push(`crop=${validWidth}:${gameCropH}:0:${gameCropY}`);
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
        const brollCropW = Math.floor(validHeight * targetAspect);
        const brollCropX = Math.floor((validWidth - brollCropW) / 2);
        filters.push(`crop=${brollCropW}:${validHeight}:${brollCropX}:0`);
      } else {
        const brollCropH = Math.floor(validWidth / targetAspect);
        const brollCropY = Math.floor((validHeight - brollCropH) / 2);
        filters.push(`crop=${validWidth}:${brollCropH}:0:${brollCropY}`);
      }
      filters.push(`scale=${targetWidth}:${targetHeight}`);
      // Add subtle Ken Burns effect for B-roll feel
      filters.push(`zoompan=z='if(eq(on,1),1,zoom+0.0003)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${targetWidth}x${targetHeight}:fps=${30}`);
      break;

    case 'auto_center':
    default:
      // Crop to 9:16 based on cropPosition
      // Supports both legacy strings ('left', 'center', 'right') and numeric percentage (0-100)
      console.log(`[FFmpeg] ========== CROP CALCULATION DEBUG ==========`);
      console.log(`[FFmpeg] Input: ${validWidth}x${validHeight}, Aspect: ${inputAspect.toFixed(4)}`);
      console.log(`[FFmpeg] Target aspect: ${targetAspect.toFixed(4)} (9:16 = 0.5625)`);
      console.log(`[FFmpeg] cropPosition received: '${cropPosition}' (type: ${typeof cropPosition})`);
      console.log(`[FFmpeg] auto_center mode: inputAspect(${inputAspect.toFixed(4)}) > targetAspect(${targetAspect.toFixed(4)}) = ${inputAspect > targetAspect}`);

      // Check if input aspect ratio is close to 16:9 (standard video)
      const expected16by9 = 16 / 9; // 1.7778
      const aspectDelta = Math.abs(inputAspect - expected16by9);
      if (aspectDelta > 0.05) {
        console.warn(`[FFmpeg] WARNING: Input aspect ratio ${inputAspect.toFixed(4)} differs from 16:9 (${expected16by9.toFixed(4)}) by ${(aspectDelta * 100).toFixed(2)}%`);
        console.warn(`[FFmpeg] This may cause crop position to differ from preview!`);
      }

      if (inputAspect > targetAspect) {
        // Video is wider than target - crop sides based on position
        // For 16:9 (1920x1080) -> 9:16: cropWidth = 1080 * 0.5625 = 607
        const cropWidth = Math.floor(validHeight * targetAspect);
        let cropX;

        // Handle both legacy string values and new numeric percentage
        if (cropPosition === 'left') {
          cropX = 0; // Crop from left edge
          console.log(`[FFmpeg] Using 'left' position -> cropX = 0`);
        } else if (cropPosition === 'right') {
          cropX = validWidth - cropWidth; // Crop from right edge
          console.log(`[FFmpeg] Using 'right' position -> cropX = ${cropX}`);
        } else if (cropPosition === 'center') {
          cropX = Math.floor((validWidth - cropWidth) / 2); // Center crop
          console.log(`[FFmpeg] Using 'center' position -> cropX = ${cropX}`);
        } else if (typeof cropPosition === 'number' || !isNaN(parseInt(cropPosition, 10))) {
          // Numeric percentage (0-100)
          // 0% = left edge (cropX = 0)
          // 100% = right edge (cropX = validWidth - cropWidth)
          const percent = Math.max(0, Math.min(100, parseInt(cropPosition, 10)));
          const maxCropX = validWidth - cropWidth;
          cropX = Math.floor((percent / 100) * maxCropX);

          // Enhanced debugging for numeric position
          const cropStartPercent = ((cropX / validWidth) * 100).toFixed(2);
          const cropCenterPercent = (((cropX + cropWidth/2) / validWidth) * 100).toFixed(2);
          console.log(`[FFmpeg] Numeric position: ${percent}%`);
          console.log(`[FFmpeg] Calculation: cropX = floor((${percent}/100) * ${maxCropX}) = ${cropX}`);
          console.log(`[FFmpeg] Crop region: starts at ${cropStartPercent}%, center at ${cropCenterPercent}%`);
          console.log(`[FFmpeg] CSS equivalent: object-position ${percent}% should show same region`);
        } else {
          // Default to center if unrecognized
          cropX = Math.floor((validWidth - cropWidth) / 2);
          console.log(`[FFmpeg] WARNING: Unrecognized cropPosition '${cropPosition}', defaulting to center -> cropX = ${cropX}`);
        }

        // Validate crop dimensions
        if (cropWidth <= 0 || cropWidth > validWidth || cropX < 0 || cropX > validWidth - cropWidth) {
          console.error(`[FFmpeg] INVALID CROP: crop=${cropWidth}:${validHeight}:${cropX}:0 for input ${validWidth}x${validHeight}`);
          // Fallback to center crop with corrected values
          const safeCropWidth = Math.min(cropWidth, validWidth);
          cropX = Math.floor((validWidth - safeCropWidth) / 2);
          filters.push(`crop=${safeCropWidth}:${validHeight}:${cropX}:0`);
        } else {
          filters.push(`crop=${cropWidth}:${validHeight}:${cropX}:0`);
        }

        console.log(`[FFmpeg] FINAL CROP FILTER: crop=${cropWidth}:${validHeight}:${cropX}:0`);
        console.log(`[FFmpeg] ==============================================`);

      } else {
        // Video is taller than target - crop top/bottom (position doesn't apply here)
        const cropHeight = Math.floor(validWidth / targetAspect);
        const cropY = Math.floor((validHeight - cropHeight) / 2);

        // Validate crop dimensions
        if (cropHeight <= 0 || cropHeight > validHeight || cropY < 0) {
          console.error(`[FFmpeg] INVALID CROP: crop=${validWidth}:${cropHeight}:0:${cropY} for input ${validWidth}x${validHeight}`);
          // Fallback to full frame
          filters.push(`crop=${validWidth}:${validHeight}:0:0`);
        } else {
          filters.push(`crop=${validWidth}:${cropHeight}:0:${cropY}`);
        }

        console.log(`[FFmpeg] CROP FILTER (vertical): crop=${validWidth}:${cropHeight}:0:${cropY}`);
      }
      // Scale to target resolution
      filters.push(`scale=${targetWidth}:${targetHeight}`);
      console.log(`[FFmpeg] SCALE FILTER: scale=${targetWidth}:${targetHeight}`);
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

  // For complex filter graphs (with labeled streams), join with semicolons
  // For simple linear chains, join with commas
  const filterChain = isComplexFilter ? filters.join(';') : filters.join(',');

  console.log(`[FFmpeg] COMPLETE FILTER CHAIN (${isComplexFilter ? 'complex' : 'simple'}): ${filterChain}`);
  console.log(`[FFmpeg] Filter count: ${filters.length}`);

  return filterChain;
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
    // Use GPU encoding if available, otherwise fall back to CPU
    const videoEncoding = getVideoEncodingArgs('medium');

    const args = [
      '-fflags', '+igndts+genpts',
      '-i', inputFile,
      '-vf', filters.join(','),
      ...videoEncoding,
      '-r', '30',
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

      if (!videoStream) {
        console.error(`[FFprobe] No video stream found in file: ${filePath}`);
        reject(new Error('No video stream found in file'));
        return;
      }

      const videoInfo = {
        width: videoStream.width,
        height: videoStream.height,
        duration: parseFloat(info.format.duration),
        bitrate: parseInt(info.format.bit_rate)
      };

      console.log(`[FFprobe] Video info for ${filePath}: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.duration}s`);

      resolve(videoInfo);
    } catch (error) {
      console.error(`[FFprobe] Failed to parse video info: ${error.message}`);
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
