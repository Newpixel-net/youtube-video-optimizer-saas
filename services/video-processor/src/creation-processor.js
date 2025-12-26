/**
 * Creation Processor
 * Processes creation wizard exports - creates videos from images with Ken Burns effect
 *
 * Input: Array of scenes with images, voiceovers, and Ken Burns parameters
 * Output: MP4 video file in Firebase Storage
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Firestore } from '@google-cloud/firestore';
import { isGpuAvailable, getEncodingParams } from './gpu-encoder.js';
import { Agent, fetch as undiciFetch } from 'undici';

// Create a custom agent with longer timeouts for Cloud Run cold starts (especially GPU instances)
// GPU instances can take 60-90 seconds to cold start
const coldStartAgent = new Agent({
  headersTimeout: 180000,  // 3 minutes for headers (handles cold start)
  bodyTimeout: 900000,     // 15 minutes for body (handles long scene processing)
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 180000
});

// GPU availability - lazy initialization
let gpuEnabled = null;
let gpuChecked = false;

function checkGpuIfNeeded() {
  if (gpuChecked) return gpuEnabled;

  gpuChecked = true;
  try {
    gpuEnabled = isGpuAvailable();
    console.log(`[Creation Processor] GPU enabled: ${gpuEnabled}`);
  } catch (e) {
    console.log(`[Creation Processor] GPU detection failed: ${e.message}, using CPU encoding`);
    gpuEnabled = false;
  }
  return gpuEnabled;
}

// Track active FFmpeg processes for cancellation
const activeProcesses = new Map();

/**
 * Check if job has been cancelled
 */
async function checkCancelled(jobRef, jobId) {
  try {
    const jobDoc = await jobRef.get();
    if (jobDoc.exists) {
      const status = jobDoc.data().status;
      if (status === 'cancelled') {
        console.log(`[${jobId}] Job was cancelled by user`);
        return true;
      }
    }
  } catch (err) {
    console.warn(`[${jobId}] Could not check cancellation status:`, err.message);
  }
  return false;
}

/**
 * Kill active FFmpeg process for a job
 */
export function cancelJob(jobId) {
  const proc = activeProcesses.get(jobId);
  if (proc) {
    console.log(`[${jobId}] Killing FFmpeg process`);
    proc.kill('SIGTERM');
    activeProcesses.delete(jobId);
    return true;
  }
  return false;
}

/**
 * Process a creation wizard export job
 * Creates a video from images with Ken Burns effect and voiceovers
 */
export async function processCreationExport({ jobId, jobRef, job, storage, bucketName, tempDir }) {
  const workDir = path.join(tempDir, `creation-${jobId}`);

  try {
    // Create work directory
    fs.mkdirSync(workDir, { recursive: true });
    console.log(`[${jobId}] Created work directory: ${workDir}`);

    const { manifest, output } = job;
    const scenes = manifest.scenes || [];

    if (scenes.length === 0) {
      throw new Error('No scenes provided in manifest');
    }

    console.log(`[${jobId}] Processing ${scenes.length} scenes`);
    console.log(`[${jobId}] Output settings: ${output.quality}, ${output.aspectRatio}, ${output.fps}fps`);

    // Check cancellation before starting
    if (await checkCancelled(jobRef, jobId)) {
      throw new Error('Job cancelled by user');
    }

    // Step 1: Download all images
    await updateProgress(jobRef, 5, 'Preparing your images...');
    const imageFiles = await downloadAllImages({ jobId, scenes, workDir });
    console.log(`[${jobId}] Downloaded ${imageFiles.length} images`);

    // Check cancellation after downloading images
    if (await checkCancelled(jobRef, jobId)) {
      throw new Error('Job cancelled by user');
    }

    // Step 2: Download all voiceovers
    await updateProgress(jobRef, 15, 'Loading voiceovers...');
    const voiceoverFiles = await downloadAllVoiceovers({ jobId, scenes, workDir });
    console.log(`[${jobId}] Downloaded ${voiceoverFiles.length} voiceovers`);

    // Check cancellation after downloading voiceovers
    if (await checkCancelled(jobRef, jobId)) {
      throw new Error('Job cancelled by user');
    }

    // Step 3: Download background music (if any)
    let musicFile = null;
    if (manifest.music && manifest.music.url) {
      await updateProgress(jobRef, 20, 'Loading background music...');
      musicFile = await downloadFile({
        url: manifest.music.url,
        outputPath: path.join(workDir, 'music.mp3'),
        jobId
      });
    }

    // Check cancellation before video generation (the longest step)
    if (await checkCancelled(jobRef, jobId)) {
      throw new Error('Job cancelled by user');
    }

    // Step 4: Generate Ken Burns video from images
    // Determine if we should use parallel processing
    // VIDEO_PROCESSOR_URL must be set explicitly during deployment (e.g., https://video-processor-xxx.us-central1.run.app)
    const serviceUrl = process.env.VIDEO_PROCESSOR_URL || null;
    const parallelEnabled = process.env.PARALLEL_SCENES === 'true';
    const useParallel = parallelEnabled && serviceUrl && scenes.length >= 3;

    if (!serviceUrl && parallelEnabled) {
      console.log(`[${jobId}] WARNING: PARALLEL_SCENES=true but VIDEO_PROCESSOR_URL not set - using sequential mode`);
    }

    let videoOnlyFile;

    if (useParallel) {
      // PARALLEL MODE: Process scenes across multiple Cloud Run instances
      console.log(`[${jobId}] ========================================`);
      console.log(`[${jobId}] PARALLEL PROCESSING MODE`);
      console.log(`[${jobId}] Service URL: ${serviceUrl}`);
      console.log(`[${jobId}] Scenes: ${scenes.length}`);
      console.log(`[${jobId}] ========================================`);

      await updateProgress(jobRef, 25, `Processing ${scenes.length} scenes in parallel...`);

      // Get image URLs directly from scenes (they're already in storage)
      const imageUrls = scenes.map(scene => scene.imageUrl);

      // Process all scenes in parallel
      const sceneVideoUrls = await processSceneParallel({
        jobId,
        jobRef,
        scenes,
        imageUrls,
        output,
        serviceUrl
      });

      console.log(`[${jobId}] Parallel processing complete: ${sceneVideoUrls.length} scenes`);

      // Download scene videos for concatenation
      await updateProgress(jobRef, 56, 'Downloading rendered scenes...');
      const sceneVideos = [];
      for (let i = 0; i < sceneVideoUrls.length; i++) {
        const sceneVideoPath = path.join(workDir, `scene_parallel_${i}.mp4`);
        await downloadFile({
          url: sceneVideoUrls[i],
          outputPath: sceneVideoPath,
          jobId
        });
        sceneVideos.push(sceneVideoPath);
        console.log(`[${jobId}] Downloaded scene ${i + 1}/${sceneVideoUrls.length}`);
      }

      // Concatenate scene videos
      await updateProgress(jobRef, 60, 'Assembling your video...');
      videoOnlyFile = await concatenateSceneVideos({
        jobId,
        sceneVideos,
        workDir,
        output
      });

    } else {
      // SEQUENTIAL MODE: Process scenes one at a time (original behavior)
      await updateProgress(jobRef, 25, 'Creating video scenes...');
      videoOnlyFile = await generateKenBurnsVideo({
        jobId,
        jobRef,
        scenes,
        imageFiles,
        workDir,
        output
      });
    }

    console.log(`[${jobId}] Generated Ken Burns video: ${videoOnlyFile}`);

    // Check cancellation after video generation
    if (await checkCancelled(jobRef, jobId)) {
      throw new Error('Job cancelled by user');
    }

    // Step 5: Combine video with audio (voiceovers + music)
    await updateProgress(jobRef, 70, 'Adding voiceovers and music...');
    const finalVideoFile = await combineVideoWithAudio({
      jobId,
      jobRef,
      videoFile: videoOnlyFile,
      scenes,
      voiceoverFiles,
      musicFile,
      musicVolume: manifest.music?.volume || 0.3,
      workDir,
      output
    });
    console.log(`[${jobId}] Created final video with audio: ${finalVideoFile}`);

    // Step 6: Upload to storage
    await updateProgress(jobRef, 90, 'Uploading your video...');
    const result = await uploadToStorage({
      jobId,
      filePath: finalVideoFile,
      storage,
      bucketName,
      userId: job.userId,
      projectId: job.projectId
    });

    // Cleanup
    cleanupWorkDir(workDir);

    await updateProgress(jobRef, 100, 'Export complete!');

    return result;

  } catch (error) {
    console.error(`[${jobId}] Creation export failed:`, error);
    cleanupWorkDir(workDir);
    throw error;
  }
}

/**
 * Download all scene images
 */
async function downloadAllImages({ jobId, scenes, workDir }) {
  const imageFiles = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const imageUrl = scene.imageUrl;

    if (!imageUrl) {
      console.warn(`[${jobId}] Scene ${i} has no image URL, skipping`);
      imageFiles.push(null);
      continue;
    }

    const ext = imageUrl.includes('.png') ? 'png' : 'jpg';
    const outputPath = path.join(workDir, `scene_${i}.${ext}`);

    try {
      await downloadFile({ url: imageUrl, outputPath, jobId });
      imageFiles.push(outputPath);
      console.log(`[${jobId}] Downloaded image ${i + 1}/${scenes.length}`);
    } catch (error) {
      console.error(`[${jobId}] Failed to download image ${i}:`, error.message);
      imageFiles.push(null);
    }
  }

  return imageFiles;
}

/**
 * Download all scene voiceovers
 */
async function downloadAllVoiceovers({ jobId, scenes, workDir }) {
  const voiceoverFiles = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const voiceoverUrl = scene.voiceoverUrl;

    if (!voiceoverUrl) {
      console.log(`[${jobId}] Scene ${i} has no voiceover`);
      voiceoverFiles.push(null);
      continue;
    }

    const ext = voiceoverUrl.includes('.wav') ? 'wav' : 'mp3';
    const outputPath = path.join(workDir, `voice_${i}.${ext}`);

    try {
      await downloadFile({ url: voiceoverUrl, outputPath, jobId });
      voiceoverFiles.push(outputPath);
      console.log(`[${jobId}] Downloaded voiceover ${i + 1}/${scenes.length}`);
    } catch (error) {
      console.error(`[${jobId}] Failed to download voiceover ${i}:`, error.message);
      voiceoverFiles.push(null);
    }
  }

  return voiceoverFiles;
}

/**
 * Download a file from URL to local path
 */
async function downloadFile({ url, outputPath, jobId }) {
  console.log(`[${jobId}] Downloading: ${url.substring(0, 80)}...`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));

  const fileSize = fs.statSync(outputPath).size;
  console.log(`[${jobId}] Downloaded ${(fileSize / 1024).toFixed(1)} KB to ${path.basename(outputPath)}`);

  return outputPath;
}

/**
 * Generate Ken Burns video from images using FFmpeg
 * Supports different render quality modes for speed vs quality tradeoff
 */
async function generateKenBurnsVideo({ jobId, jobRef, scenes, imageFiles, workDir, output }) {
  const outputFile = path.join(workDir, 'video_only.mp4');

  // Determine output resolution
  const resolutions = {
    '720p': { width: 1280, height: 720 },
    '1080p': { width: 1920, height: 1080 },
    '4k': { width: 3840, height: 2160 }
  };

  let { width, height } = resolutions[output.quality] || resolutions['1080p'];

  // Adjust for aspect ratio
  if (output.aspectRatio === '9:16') {
    [width, height] = [height * 9 / 16, height]; // Vertical video
    width = Math.round(width);
  } else if (output.aspectRatio === '1:1') {
    width = height = Math.min(width, height);
  }

  // RENDER QUALITY MODES - User can choose speed vs quality tradeoff
  // 'fast' = Quick export (~50% faster), good quality
  // 'balanced' = Default, good balance of speed and quality
  // 'best' = Highest quality, slower processing
  const renderQuality = output.renderQuality || 'balanced';

  const qualitySettings = {
    fast: {
      scaleMultiplier: 1.3,  // Less upscaling = faster
      preset: 'ultrafast',   // Fastest encoding
      fps: 24,               // Fewer frames
      crf: '26'              // Slightly lower quality
    },
    balanced: {
      scaleMultiplier: 1.5,  // Moderate upscaling
      preset: 'fast',        // Good speed
      fps: 30,               // Standard
      crf: '23'              // Good quality
    },
    best: {
      scaleMultiplier: 2.0,  // Full upscaling for smoothest zoom
      preset: 'medium',      // Better compression
      fps: 30,               // Standard
      crf: '20'              // High quality
    }
  };

  const settings = qualitySettings[renderQuality] || qualitySettings.balanced;
  const fps = output.fps || settings.fps;

  console.log(`[${jobId}] ========================================`);
  console.log(`[${jobId}] Render Quality: ${renderQuality.toUpperCase()}`);
  console.log(`[${jobId}]   Scale: ${settings.scaleMultiplier}x`);
  console.log(`[${jobId}]   Preset: ${settings.preset}`);
  console.log(`[${jobId}]   FPS: ${fps}`);
  console.log(`[${jobId}]   CRF: ${settings.crf}`);
  console.log(`[${jobId}] Output: ${width}x${height}`);
  console.log(`[${jobId}] ========================================`);

  // Build FFmpeg command for Ken Burns effect
  // SIMPLIFIED APPROACH: Process scenes one at a time, then concatenate
  // This is more reliable than one massive filter_complex

  const sceneVideos = [];

  for (let i = 0; i < scenes.length; i++) {
    const imageFile = imageFiles[i];
    if (!imageFile || !fs.existsSync(imageFile)) {
      console.warn(`[${jobId}] Skipping scene ${i} - no image file`);
      continue;
    }

    const scene = scenes[i];
    const duration = scene.duration || 8;
    const frames = Math.round(duration * fps);
    const sceneOutput = path.join(workDir, `scene_video_${i}.mp4`);

    // Get Ken Burns parameters (with defaults)
    const kb = scene.kenBurns || {};
    const startScale = kb.startScale || 1.0;
    const endScale = kb.endScale || 1.2;
    const startX = kb.startX !== undefined ? kb.startX : 0.5;
    const startY = kb.startY !== undefined ? kb.startY : 0.5;
    const endX = kb.endX !== undefined ? kb.endX : 0.5;
    const endY = kb.endY !== undefined ? kb.endY : 0.5;

    // Zoom expression
    const zoomExpr = `${startScale}+(${endScale}-${startScale})*on/${frames}`;
    const xExpr = `(iw-iw/zoom)/2`;
    const yExpr = `(ih-ih/zoom)/2`;

    // Ken Burns filter with quality-dependent scaling
    // Higher scaleMultiplier = smoother zoom but slower processing
    const scaleWidth = Math.round(width * settings.scaleMultiplier);
    const filterComplex = `scale=${scaleWidth}:-1,zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${frames}:s=${width}x${height}:fps=${fps},setsar=1`;

    // CRITICAL: Use -framerate 1 to ensure only 1 input frame is created from the image
    // Without this, FFmpeg creates 25fps input (default), causing zoompan to process
    // each input frame separately, resulting in 300x more frames than intended
    const sceneArgs = [
      '-loop', '1',
      '-framerate', '1',
      '-t', String(duration),
      '-i', imageFile,
      '-vf', filterComplex,
      '-c:v', 'libx264',
      '-preset', settings.preset,
      '-crf', settings.crf,
      '-pix_fmt', 'yuv420p',
      '-y',
      sceneOutput
    ];

    console.log(`[${jobId}] Processing scene ${i + 1}/${scenes.length}...`);

    // Update progress for each scene with user-friendly message
    const sceneProgress = 25 + Math.round((i / scenes.length) * 35);
    await updateProgress(jobRef, sceneProgress, `Creating scene ${i + 1} of ${scenes.length} with Ken Burns effect...`);

    try {
      await runFFmpegSimple({ args: sceneArgs, logPrefix: `[${jobId}] [Scene ${i + 1}] ` });
      sceneVideos.push(sceneOutput);
      console.log(`[${jobId}] Scene ${i + 1} complete`);
    } catch (err) {
      console.error(`[${jobId}] Scene ${i + 1} failed:`, err.message);
      // Continue with other scenes
    }
  }

  if (sceneVideos.length === 0) {
    throw new Error('No scenes were successfully rendered');
  }

  console.log(`[${jobId}] Rendered ${sceneVideos.length} scene videos, concatenating...`);
  await updateProgress(jobRef, 60, 'Assembling your video...');

  // Create concat file
  const concatFile = path.join(workDir, 'concat.txt');
  const concatContent = sceneVideos.map(f => `file '${f}'`).join('\n');
  fs.writeFileSync(concatFile, concatContent);

  console.log(`[${jobId}] Concatenating ${sceneVideos.length} scene videos...`);

  // First concatenate to intermediate file (CPU encoded)
  const intermediateFile = path.join(workDir, 'video_intermediate.mp4');
  const concatArgs = [
    '-f', 'concat',
    '-safe', '0',
    '-i', concatFile,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y',
    intermediateFile
  ];

  try {
    await runFFmpegSimple({ args: concatArgs, logPrefix: `[${jobId}] [Concat] ` });
    console.log(`[${jobId}] Concatenation completed successfully`);
  } catch (concatError) {
    console.error(`[${jobId}] Concatenation FAILED: ${concatError.message}`);
    throw concatError;
  }

  // Verify intermediate file
  if (!fs.existsSync(intermediateFile)) {
    throw new Error('FFmpeg did not produce intermediate file');
  }

  const intermediateSize = fs.statSync(intermediateFile).size;
  console.log(`[${jobId}] Intermediate video: ${(intermediateSize / 1024 / 1024).toFixed(2)} MB`);

  // GPU RE-ENCODING PASS
  // Use NVENC for fast final encoding (like processor.js does)
  const useGpu = checkGpuIfNeeded();
  await updateProgress(jobRef, 62, useGpu ? 'Optimizing video with GPU...' : 'Finalizing video...');

  if (useGpu) {
    console.log(`[${jobId}] [GPU PASS] Re-encoding with NVENC...`);

    // NVENC re-encoding (no filters, just fast re-encode)
    const gpuArgs = [
      '-i', intermediateFile,
      '-c:v', 'h264_nvenc',
      '-preset', 'p4',
      '-b:v', '4M',
      '-maxrate', '6M',
      '-bufsize', '8M',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-y',
      outputFile
    ];

    console.log(`[${jobId}] [GPU PASS] FFmpeg: ffmpeg ${gpuArgs.slice(0, 8).join(' ')}...`);

    try {
      await runFFmpegSimple({ args: gpuArgs, logPrefix: `[${jobId}] [GPU] ` });
      console.log(`[${jobId}] [GPU PASS] NVENC encoding completed`);

      // Validate GPU output
      const gpuFileSize = fs.statSync(outputFile).size;
      const gpuBitrateRatio = gpuFileSize / intermediateSize;

      // If GPU output is suspiciously small (< 25% of input), it might be frozen
      if (gpuBitrateRatio < 0.25) {
        console.error(`[${jobId}] [GPU PASS] ⚠️ SUSPICIOUS: GPU output only ${(gpuBitrateRatio * 100).toFixed(1)}% of input - possible frozen video!`);
        console.log(`[${jobId}] [FALLBACK] Falling back to CPU encoding...`);

        // CPU fallback
        await updateProgress(jobRef, 64, 'Finalizing video (CPU)...');
        const cpuArgs = [
          '-i', intermediateFile,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'copy',
          '-movflags', '+faststart',
          '-y',
          outputFile
        ];
        await runFFmpegSimple({ args: cpuArgs, logPrefix: `[${jobId}] [CPU Fallback] ` });
        console.log(`[${jobId}] [FALLBACK] CPU encoding completed`);
      } else {
        console.log(`[${jobId}] [GPU PASS] ✅ GPU output valid: ${(gpuFileSize / 1024 / 1024).toFixed(2)} MB (${(gpuBitrateRatio * 100).toFixed(1)}% of input)`);
      }
    } catch (gpuError) {
      console.error(`[${jobId}] [GPU PASS] NVENC failed: ${gpuError.message}`);
      console.log(`[${jobId}] [FALLBACK] Falling back to CPU encoding...`);

      // CPU fallback on GPU failure
      await updateProgress(jobRef, 64, 'Finalizing video (CPU)...');
      const cpuArgs = [
        '-i', intermediateFile,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        '-y',
        outputFile
      ];
      await runFFmpegSimple({ args: cpuArgs, logPrefix: `[${jobId}] [CPU Fallback] ` });
      console.log(`[${jobId}] [FALLBACK] CPU encoding completed`);
    }
  } else {
    // No GPU - just use the intermediate file
    console.log(`[${jobId}] No GPU available, using CPU-encoded intermediate as final`);
    fs.renameSync(intermediateFile, outputFile);
  }

  // Cleanup intermediate file if it still exists
  if (fs.existsSync(intermediateFile)) {
    try {
      fs.unlinkSync(intermediateFile);
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  // Verify final output
  if (!fs.existsSync(outputFile)) {
    throw new Error('FFmpeg did not produce output file');
  }

  const fileSize = fs.statSync(outputFile).size;
  console.log(`[${jobId}] Ken Burns video created: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

  return outputFile;
}

/**
 * Concatenate pre-rendered scene videos (used in parallel processing mode)
 * Downloads and concatenates scene videos that were processed by separate workers
 */
async function concatenateSceneVideos({ jobId, sceneVideos, workDir, output }) {
  const outputFile = path.join(workDir, 'video_only.mp4');

  console.log(`[${jobId}] Concatenating ${sceneVideos.length} scene videos...`);

  // Create concat file
  const concatFile = path.join(workDir, 'concat.txt');
  const concatContent = sceneVideos.map(f => `file '${f}'`).join('\n');
  fs.writeFileSync(concatFile, concatContent);

  // First concatenate with stream copy (fast)
  const intermediateFile = path.join(workDir, 'video_intermediate.mp4');
  const concatArgs = [
    '-f', 'concat',
    '-safe', '0',
    '-i', concatFile,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y',
    intermediateFile
  ];

  await runFFmpegSimple({ args: concatArgs, logPrefix: `[${jobId}] [Concat] ` });
  console.log(`[${jobId}] Concatenation completed`);

  if (!fs.existsSync(intermediateFile)) {
    throw new Error('Concatenation failed - no output file');
  }

  const intermediateSize = fs.statSync(intermediateFile).size;
  console.log(`[${jobId}] Intermediate video: ${(intermediateSize / 1024 / 1024).toFixed(2)} MB`);

  // GPU RE-ENCODING PASS (if available)
  const useGpu = checkGpuIfNeeded();

  if (useGpu) {
    console.log(`[${jobId}] [GPU PASS] Re-encoding with NVENC...`);

    const gpuArgs = [
      '-i', intermediateFile,
      '-c:v', 'h264_nvenc',
      '-preset', 'p4',
      '-b:v', '4M',
      '-maxrate', '6M',
      '-bufsize', '8M',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-y',
      outputFile
    ];

    try {
      await runFFmpegSimple({ args: gpuArgs, logPrefix: `[${jobId}] [GPU] ` });
      console.log(`[${jobId}] [GPU PASS] NVENC encoding completed`);
    } catch (gpuError) {
      console.error(`[${jobId}] [GPU PASS] Failed: ${gpuError.message}, using CPU`);
      fs.renameSync(intermediateFile, outputFile);
    }
  } else {
    // No GPU - use intermediate file
    console.log(`[${jobId}] No GPU available, using concatenated output`);
    fs.renameSync(intermediateFile, outputFile);
  }

  // Cleanup intermediate file if it still exists
  if (fs.existsSync(intermediateFile)) {
    try { fs.unlinkSync(intermediateFile); } catch (e) { }
  }

  if (!fs.existsSync(outputFile)) {
    throw new Error('Concatenation produced no output file');
  }

  const fileSize = fs.statSync(outputFile).size;
  console.log(`[${jobId}] Final concatenated video: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

  return outputFile;
}

/**
 * Combine video with voiceovers and background music
 */
async function combineVideoWithAudio({ jobId, jobRef, videoFile, scenes, voiceoverFiles, musicFile, musicVolume, workDir, output }) {
  const outputFile = path.join(workDir, 'final_output.mp4');

  // Check if we have any audio to add
  const hasVoiceovers = voiceoverFiles.some(f => f !== null);
  const hasMusic = musicFile && fs.existsSync(musicFile);

  if (!hasVoiceovers && !hasMusic) {
    // No audio - just copy video
    console.log(`[${jobId}] No audio to add, copying video as-is`);
    fs.copyFileSync(videoFile, outputFile);
    return outputFile;
  }

  // First, concatenate all voiceovers with proper timing
  let voiceoverConcatFile = null;
  if (hasVoiceovers) {
    voiceoverConcatFile = await concatenateVoiceovers({
      jobId,
      scenes,
      voiceoverFiles,
      workDir,
      totalDuration: scenes.reduce((sum, s) => sum + (s.duration || 8), 0)
    });
  }

  // Build FFmpeg command to combine video with audio
  const inputArgs = ['-i', videoFile];
  const filterParts = [];
  let audioStream = null;

  if (voiceoverConcatFile && fs.existsSync(voiceoverConcatFile)) {
    inputArgs.push('-i', voiceoverConcatFile);
    audioStream = '1:a';
  }

  if (hasMusic) {
    inputArgs.push('-i', musicFile);
    const musicIdx = inputArgs.filter(a => a === '-i').length - 1;

    if (audioStream) {
      // Mix voiceover with music
      const voiceVol = 1.0;
      const musVol = musicVolume || 0.3;
      filterParts.push(
        `[1:a]volume=${voiceVol}[voice]`,
        `[${musicIdx}:a]volume=${musVol},aloop=loop=-1:size=2e+09[music]`,
        `[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`
      );
      audioStream = '[aout]';
    } else {
      // Just music, loop it and set volume
      filterParts.push(
        `[${musicIdx}:a]volume=${musicVolume || 0.3},aloop=loop=-1:size=2e+09[aout]`
      );
      audioStream = '[aout]';
    }
  }

  const ffmpegArgs = [...inputArgs];

  if (filterParts.length > 0) {
    ffmpegArgs.push('-filter_complex', filterParts.join(';'));
  }

  ffmpegArgs.push(
    '-map', '0:v',
    '-map', audioStream || '1:a',
    '-c:v', 'copy', // Just copy video stream
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest', // End when shortest stream ends
    '-movflags', '+faststart',
    '-y',
    outputFile
  );

  console.log(`[${jobId}] Combining video with audio...`);
  await runFFmpeg({ jobId, args: ffmpegArgs, jobRef, progressStart: 70, progressEnd: 88 });

  if (!fs.existsSync(outputFile)) {
    throw new Error('Failed to create final video with audio');
  }

  const fileSize = fs.statSync(outputFile).size;
  console.log(`[${jobId}] Final video created: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

  return outputFile;
}

/**
 * Concatenate voiceovers with proper timing (silence between scenes)
 */
async function concatenateVoiceovers({ jobId, scenes, voiceoverFiles, workDir, totalDuration }) {
  const outputFile = path.join(workDir, 'voiceovers_concat.mp3');

  // Create a concat list file with silence padding
  const listFile = path.join(workDir, 'voice_list.txt');
  const silenceFile = path.join(workDir, 'silence.mp3');

  // Generate 1 second of silence
  await runFFmpegSimple({
    args: ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1', '-q:a', '9', '-y', silenceFile],
    logPrefix: `[${jobId}] [Audio] `
  });

  let currentTime = 0;
  const listContent = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const voiceFile = voiceoverFiles[i];
    const sceneDuration = scene.duration || 8;

    if (voiceFile && fs.existsSync(voiceFile)) {
      // Get voiceover duration
      const voiceDuration = await getAudioDuration(voiceFile);

      // Add voiceover
      listContent.push(`file '${voiceFile}'`);

      // Add silence to fill remaining scene duration
      const remainingTime = sceneDuration - voiceDuration;
      if (remainingTime > 0.1) {
        // Generate exact silence duration
        const sceneSilence = path.join(workDir, `silence_${i}.mp3`);
        await runFFmpegSimple({
          args: ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(remainingTime), '-q:a', '9', '-y', sceneSilence],
          logPrefix: `[${jobId}] [Audio] `
        });
        listContent.push(`file '${sceneSilence}'`);
      }
    } else {
      // No voiceover - add silence for entire scene duration
      const sceneSilence = path.join(workDir, `silence_full_${i}.mp3`);
      await runFFmpegSimple({
        args: ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(sceneDuration), '-q:a', '9', '-y', sceneSilence],
        logPrefix: `[${jobId}] [Audio] `
      });
      listContent.push(`file '${sceneSilence}'`);
    }

    currentTime += sceneDuration;
  }

  // Write concat list
  fs.writeFileSync(listFile, listContent.join('\n'));

  // Concatenate all audio
  console.log(`[${jobId}] [Audio] Concatenating voiceovers...`);
  await runFFmpegSimple({
    args: ['-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '2', '-y', outputFile],
    logPrefix: `[${jobId}] [Audio] `
  });

  if (!fs.existsSync(outputFile)) {
    console.warn(`[${jobId}] Failed to concatenate voiceovers`);
    return null;
  }

  console.log(`[${jobId}] Concatenated voiceovers: ${(fs.statSync(outputFile).size / 1024).toFixed(1)} KB`);
  return outputFile;
}

/**
 * Get audio file duration using ffprobe
 */
async function getAudioDuration(filePath) {
  try {
    const result = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    return parseFloat(result) || 0;
  } catch (error) {
    console.error(`Failed to get audio duration: ${error.message}`);
    return 0;
  }
}

/**
 * Run FFmpeg with progress tracking and cancellation support
 */
function runFFmpeg({ jobId, args, jobRef, progressStart = 0, progressEnd = 100 }) {
  return new Promise((resolve, reject) => {
    console.log(`[${jobId}] FFmpeg command: ffmpeg ${args.slice(0, 10).join(' ')}...`);

    const ffmpeg = spawn('ffmpeg', args);
    let stderr = '';
    let duration = 0;
    let lastLogTime = Date.now();
    let lastCancelCheck = Date.now();
    let cancelled = false;

    // Track this process for potential cancellation
    activeProcesses.set(jobId, ffmpeg);

    // Check for cancellation every 10 seconds during FFmpeg execution
    const cancelCheckInterval = setInterval(async () => {
      if (await checkCancelled(jobRef, jobId)) {
        cancelled = true;
        console.log(`[${jobId}] Cancellation detected, killing FFmpeg process`);
        ffmpeg.kill('SIGTERM');
        clearInterval(cancelCheckInterval);
      }
    }, 10000);

    ffmpeg.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;

      // Log FFmpeg output periodically (every 5 seconds)
      const now = Date.now();
      if (now - lastLogTime > 5000) {
        // Check for errors in recent output
        if (chunk.toLowerCase().includes('error') || chunk.toLowerCase().includes('invalid')) {
          console.error(`[${jobId}] FFmpeg error detected: ${chunk.slice(0, 500)}`);
        } else {
          // Log progress indication
          const frameMatch = chunk.match(/frame=\s*(\d+)/);
          if (frameMatch) {
            console.log(`[${jobId}] FFmpeg progress: frame ${frameMatch[1]}`);
          }
        }
        lastLogTime = now;
      }

      // Parse progress from FFmpeg output
      const durationMatch = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2})/);
      if (durationMatch && duration === 0) {
        duration = parseInt(durationMatch[1]) * 3600 +
                   parseInt(durationMatch[2]) * 60 +
                   parseInt(durationMatch[3]);
      }

      const timeMatch = chunk.match(/time=(\d{2}):(\d{2}):(\d{2})/);
      if (timeMatch && duration > 0) {
        const currentTime = parseInt(timeMatch[1]) * 3600 +
                           parseInt(timeMatch[2]) * 60 +
                           parseInt(timeMatch[3]);
        const ffmpegProgress = Math.min(currentTime / duration, 1);
        const overallProgress = progressStart + (progressEnd - progressStart) * ffmpegProgress;

        // Update progress (throttled)
        if (Math.random() < 0.1) { // Update ~10% of the time
          updateProgress(jobRef, Math.round(overallProgress), 'Processing video...').catch(() => {});
        }
      }
    });

    ffmpeg.on('close', (code) => {
      clearInterval(cancelCheckInterval);
      activeProcesses.delete(jobId);

      if (cancelled) {
        reject(new Error('Job cancelled by user'));
      } else if (code === 0) {
        resolve();
      } else {
        console.error(`[${jobId}] FFmpeg failed with code ${code}`);
        console.error(`[${jobId}] FFmpeg stderr (last 1000 chars): ${stderr.slice(-1000)}`);
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      clearInterval(cancelCheckInterval);
      activeProcesses.delete(jobId);
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });
  });
}

/**
 * Run FFmpeg without progress tracking (for simple operations)
 * Added logging to prevent Cloud Run from thinking container is idle
 */
function runFFmpegSimple({ args, logPrefix = '' }) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args);
    let stderr = '';
    let lastLogTime = Date.now();

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();

      // Log progress every 10 seconds to keep Cloud Run alive
      const now = Date.now();
      if (now - lastLogTime > 10000) {
        const frameMatch = stderr.match(/frame=\s*(\d+)/g);
        if (frameMatch) {
          const lastFrame = frameMatch[frameMatch.length - 1];
          console.log(`${logPrefix}FFmpeg progress: ${lastFrame}`);
        } else {
          console.log(`${logPrefix}FFmpeg processing...`);
        }
        lastLogTime = now;
      }
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.error(`${logPrefix}FFmpeg failed with code ${code}`);
        console.error(`${logPrefix}FFmpeg stderr: ${stderr.slice(-500)}`);
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });
  });
}

/**
 * Upload processed video to Cloud Storage
 */
async function uploadToStorage({ jobId, filePath, storage, bucketName, userId, projectId }) {
  const fileName = `creation-exports/${userId}/${projectId}-${Date.now()}.mp4`;
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
        projectId,
        userId,
        processedAt: new Date().toISOString(),
        type: 'creation_export'
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
    currentStage: message,  // Frontend expects currentStage
    statusMessage: message, // Keep for backwards compatibility
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

/**
 * Process a single scene with Ken Burns effect
 * Used for parallel scene processing - each scene runs in its own Cloud Run instance
 *
 * @param {Object} params Scene processing parameters
 * @param {number} params.sceneIndex - Index of the scene (0-based)
 * @param {string} params.imageUrl - URL of the source image
 * @param {number} params.duration - Scene duration in seconds
 * @param {Object} params.kenBurns - Ken Burns effect parameters
 * @param {Object} params.output - Output settings (width, height, fps, renderQuality)
 * @param {string} params.parentJobId - Parent job ID for logging
 * @param {Object} params.storage - Google Cloud Storage instance
 * @param {string} params.bucketName - Storage bucket name
 * @param {string} params.tempDir - Temporary directory path
 * @returns {Object} Result with sceneVideoUrl
 */
export async function processSceneKenBurns({
  sceneIndex,
  imageUrl,
  duration = 8,
  kenBurns = {},
  output = {},
  parentJobId,
  storage,
  bucketName,
  tempDir
}) {
  const startTime = Date.now();
  const sceneId = `scene_${sceneIndex}_${Date.now()}`;
  const logPrefix = `[${parentJobId}:S${sceneIndex}]`;

  console.log(`${logPrefix} ========================================`);
  console.log(`${logPrefix} Processing scene ${sceneIndex}`);
  console.log(`${logPrefix} Image: ${imageUrl?.substring(0, 80)}...`);
  console.log(`${logPrefix} Duration: ${duration}s`);

  // Create work directory for this scene
  const workDir = path.join(tempDir, `scene_${parentJobId}_${sceneIndex}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // Step 1: Download the image
    const imageFile = path.join(workDir, 'source.jpg');
    console.log(`${logPrefix} Downloading image...`);
    await downloadFile({ url: imageUrl, outputPath: imageFile, jobId: logPrefix });

    if (!fs.existsSync(imageFile)) {
      throw new Error('Failed to download image');
    }

    // Step 2: Determine output resolution
    const resolutions = {
      '720p': { width: 1280, height: 720 },
      '1080p': { width: 1920, height: 1080 },
      '4k': { width: 3840, height: 2160 }
    };

    let { width, height } = resolutions[output.quality] || resolutions['1080p'];

    // Adjust for aspect ratio
    if (output.aspectRatio === '9:16') {
      [width, height] = [height * 9 / 16, height];
      width = Math.round(width);
    } else if (output.aspectRatio === '1:1') {
      width = height = Math.min(width, height);
    }

    // Step 3: Get quality settings
    const renderQuality = output.renderQuality || 'balanced';
    const qualitySettings = {
      fast: { scaleMultiplier: 1.3, preset: 'ultrafast', fps: 24, crf: '26' },
      balanced: { scaleMultiplier: 1.5, preset: 'fast', fps: 30, crf: '23' },
      best: { scaleMultiplier: 2.0, preset: 'medium', fps: 30, crf: '20' }
    };
    const settings = qualitySettings[renderQuality] || qualitySettings.balanced;
    const fps = output.fps || settings.fps;

    console.log(`${logPrefix} Quality: ${renderQuality}, Scale: ${settings.scaleMultiplier}x, FPS: ${fps}`);

    // Step 4: Build Ken Burns FFmpeg command
    const frames = Math.round(duration * fps);
    const kb = kenBurns;
    const startScale = kb.startScale || 1.0;
    const endScale = kb.endScale || 1.2;

    const zoomExpr = `${startScale}+(${endScale}-${startScale})*on/${frames}`;
    const xExpr = `(iw-iw/zoom)/2`;
    const yExpr = `(ih-ih/zoom)/2`;

    const scaleWidth = Math.round(width * settings.scaleMultiplier);
    const filterComplex = `scale=${scaleWidth}:-1,zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${frames}:s=${width}x${height}:fps=${fps},setsar=1`;

    const sceneOutput = path.join(workDir, 'scene_output.mp4');

    // CRITICAL: Use -framerate 1 to ensure only 1 input frame is created from the image
    // Without this, FFmpeg creates 25fps input (default), causing zoompan to process
    // each input frame separately, resulting in 300x more frames than intended
    const sceneArgs = [
      '-loop', '1',
      '-framerate', '1',
      '-t', String(duration),
      '-i', imageFile,
      '-vf', filterComplex,
      '-c:v', 'libx264',
      '-preset', settings.preset,
      '-crf', settings.crf,
      '-pix_fmt', 'yuv420p',
      '-y',
      sceneOutput
    ];

    console.log(`${logPrefix} Rendering Ken Burns effect...`);
    await runFFmpegSimple({ args: sceneArgs, logPrefix: `${logPrefix} ` });

    if (!fs.existsSync(sceneOutput)) {
      throw new Error('FFmpeg did not produce output file');
    }

    const outputSize = fs.statSync(sceneOutput).size;
    console.log(`${logPrefix} Scene rendered: ${(outputSize / 1024 / 1024).toFixed(2)} MB`);

    // Step 5: Upload to temporary storage
    const bucket = storage.bucket(bucketName);
    const tempFileName = `temp-scenes/${parentJobId}/scene_${sceneIndex}.mp4`;
    const file = bucket.file(tempFileName);

    console.log(`${logPrefix} Uploading to: ${tempFileName}`);

    await bucket.upload(sceneOutput, {
      destination: tempFileName,
      metadata: {
        contentType: 'video/mp4',
        metadata: {
          parentJobId,
          sceneIndex: String(sceneIndex),
          processedAt: new Date().toISOString(),
          type: 'scene_video'
        }
      }
    });

    // Make publicly accessible for concatenation
    await file.makePublic();

    const sceneVideoUrl = `https://storage.googleapis.com/${bucketName}/${tempFileName}`;
    const processingTime = Date.now() - startTime;

    console.log(`${logPrefix} ========================================`);
    console.log(`${logPrefix} Scene ${sceneIndex} COMPLETE`);
    console.log(`${logPrefix} URL: ${sceneVideoUrl}`);
    console.log(`${logPrefix} Time: ${(processingTime / 1000).toFixed(1)}s`);
    console.log(`${logPrefix} ========================================`);

    // Cleanup work directory
    cleanupWorkDir(workDir);

    return {
      success: true,
      sceneIndex,
      sceneVideoUrl,
      duration,
      outputSize,
      processingTime
    };

  } catch (error) {
    console.error(`${logPrefix} Scene processing FAILED:`, error.message);
    cleanupWorkDir(workDir);

    return {
      success: false,
      sceneIndex,
      error: error.message,
      processingTime: Date.now() - startTime
    };
  }
}

/**
 * Process multiple scenes in parallel by calling this service's /process-scene endpoint
 * This distributes work across multiple Cloud Run instances
 *
 * @param {Object} params Parallel processing parameters
 * @param {string} params.jobId - Parent job ID
 * @param {Object} params.jobRef - Firestore job reference for progress updates
 * @param {Array} params.scenes - Array of scene objects
 * @param {Array} params.imageUrls - Array of image URLs (already uploaded to storage)
 * @param {Object} params.output - Output settings
 * @param {string} params.serviceUrl - URL of this video processor service
 * @returns {Array} Array of scene video URLs
 */
export async function processSceneParallel({
  jobId,
  jobRef,
  scenes,
  imageUrls,
  output,
  serviceUrl
}) {
  console.log(`[${jobId}] ========================================`);
  console.log(`[${jobId}] PARALLEL SCENE PROCESSING`);
  console.log(`[${jobId}] Scenes: ${scenes.length}`);
  console.log(`[${jobId}] Service URL: ${serviceUrl}`);
  console.log(`[${jobId}] ========================================`);

  // Verify service URL is reachable before starting parallel processing
  // Use longer timeout to handle cold starts
  try {
    console.log(`[${jobId}] Verifying service connectivity...`);
    const healthCheck = await undiciFetch(`${serviceUrl}/health`, {
      method: 'GET',
      dispatcher: coldStartAgent,
      signal: AbortSignal.timeout(60000) // 60 second timeout for health check (handles cold start)
    });
    if (healthCheck.ok) {
      const healthData = await healthCheck.json();
      console.log(`[${jobId}] Service health check passed:`, healthData.status || 'ok');
    } else {
      console.warn(`[${jobId}] Health check returned ${healthCheck.status} - proceeding anyway`);
    }
  } catch (healthError) {
    console.error(`[${jobId}] Health check failed: ${healthError.message}`);
    console.error(`[${jobId}] Cause: ${healthError.cause?.message || healthError.cause?.code || 'unknown'}`);
    console.error(`[${jobId}] This may indicate VIDEO_PROCESSOR_URL is misconfigured`);
    // Continue anyway - individual scene requests will fail with more details
  }

  await updateProgress(jobRef, 25, `Processing ${scenes.length} scenes in parallel...`);

  // Create all scene processing promises with proper timeout
  // Each scene can take up to 10 minutes, so we set a 15-minute timeout per scene
  const SCENE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

  // Helper function for fetch with retries (handles Cloud Run cold starts and transient failures)
  // Uses undici with custom agent that has longer timeouts for GPU cold starts
  const fetchWithRetry = async (url, options, sceneIndex, maxRetries = 3) => {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[${jobId}] Scene ${sceneIndex} - fetch attempt ${attempt}/${maxRetries}`);
        // Use undici fetch with custom agent for longer timeouts
        const response = await undiciFetch(url, {
          ...options,
          dispatcher: coldStartAgent
        });
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        return await response.json();
      } catch (error) {
        lastError = error;
        // Don't retry on abort (timeout)
        if (error.name === 'AbortError') {
          throw error;
        }
        // Log retry info
        const causeMsg = error.cause?.message || error.cause?.code || 'unknown';
        console.error(`[${jobId}] Scene ${sceneIndex} fetch attempt ${attempt} failed: ${error.message} (cause: ${causeMsg})`);

        if (attempt < maxRetries) {
          // Longer backoff for cold start errors: 5s, 10s, 20s
          const isColdStartError = causeMsg.includes('Timeout') || causeMsg.includes('timeout');
          const baseDelay = isColdStartError ? 5000 : 2000;
          const delay = Math.pow(2, attempt) * baseDelay;
          console.log(`[${jobId}] Scene ${sceneIndex} - retrying in ${delay/1000}s...${isColdStartError ? ' (cold start detected)' : ''}`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  };

  // Track scene statuses for UI feedback - start as 'queued'
  const sceneStatuses = scenes.map((_, i) => ({
    index: i,
    status: 'queued',
    startedAt: null,
    completedAt: null,
    error: null
  }));

  // Helper to generate status message showing which scenes are complete vs rendering
  const generateStatusMessage = () => {
    const complete = sceneStatuses.filter(s => s.status === 'complete').map(s => s.index + 1);
    const rendering = sceneStatuses.filter(s => s.status === 'rendering').map(s => s.index + 1);
    const failed = sceneStatuses.filter(s => s.status === 'failed').map(s => s.index + 1);

    let msg = '';
    if (complete.length > 0) {
      msg += `✓ Scene${complete.length > 1 ? 's' : ''} ${complete.join(', ')} complete`;
    }
    if (rendering.length > 0) {
      if (msg) msg += ' | ';
      msg += `Rendering scene${rendering.length > 1 ? 's' : ''} ${rendering.join(', ')}...`;
    }
    if (failed.length > 0) {
      if (msg) msg += ' | ';
      msg += `✗ Scene${failed.length > 1 ? 's' : ''} ${failed.join(', ')} failed`;
    }
    if (!msg) {
      msg = `Starting ${scenes.length} scenes...`;
    }
    return msg;
  };

  // Helper to update Firestore with current scene statuses
  const updateSceneProgress = async () => {
    const completedScenes = sceneStatuses.filter(s => s.status === 'complete' || s.status === 'failed').length;
    const progress = 26 + Math.round((completedScenes / scenes.length) * 30);
    const statusMsg = generateStatusMessage();

    await jobRef.update({
      sceneStatuses: sceneStatuses,
      progress,
      currentStage: statusMsg,
      statusMessage: statusMsg,
      scenesCompleted: sceneStatuses.filter(s => s.status === 'complete').length,
      scenesTotal: scenes.length
    });
  };

  // Update Firestore with initial scene statuses
  await jobRef.update({
    sceneStatuses: sceneStatuses,
    progress: 26,
    currentStage: `Starting ${scenes.length} scenes in parallel...`,
    statusMessage: `Starting ${scenes.length} scenes in parallel...`,
    scenesCompleted: 0,
    scenesTotal: scenes.length
  });

  // Create scene promises with status tracking
  const scenePromises = scenes.map((scene, index) => {
    const requestBody = {
      sceneIndex: index,
      imageUrl: imageUrls[index],
      duration: scene.duration || 8,
      kenBurns: scene.kenBurns || {},
      output: {
        quality: output.quality,
        aspectRatio: output.aspectRatio,
        fps: output.fps,
        renderQuality: output.renderQuality
      },
      parentJobId: jobId
    };

    // Create abort controller for timeout (15 min total including retries)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SCENE_TIMEOUT_MS);

    // Mark scene as rendering when fetch starts
    sceneStatuses[index].status = 'rendering';
    sceneStatuses[index].startedAt = new Date().toISOString();

    return fetchWithRetry(
      `${serviceUrl}/process-scene`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      },
      index
    )
      .then(result => {
        clearTimeout(timeoutId);
        return result;
      })
      .catch(error => {
        clearTimeout(timeoutId);
        // Get detailed error info
        let errorMsg;
        if (error.name === 'AbortError') {
          errorMsg = `Scene ${index} timed out after ${SCENE_TIMEOUT_MS/1000}s`;
        } else if (error.cause) {
          errorMsg = `${error.message}: ${error.cause.message || error.cause.code || error.cause}`;
        } else {
          errorMsg = error.message;
        }
        console.error(`[${jobId}] Scene ${index} FINAL fetch error after retries: ${errorMsg}`);
        console.error(`[${jobId}] Scene ${index} error details:`, {
          name: error.name,
          message: error.message,
          cause: error.cause?.message || error.cause?.code || 'none',
          serviceUrl: serviceUrl
        });
        return {
          success: false,
          sceneIndex: index,
          error: errorMsg
        };
      });
  });

  // Update UI immediately to show all scenes are now rendering
  await updateSceneProgress();

  // Start a periodic progress updater (every 15 seconds) to keep UI fresh
  const progressInterval = setInterval(async () => {
    const renderingCount = sceneStatuses.filter(s => s.status === 'rendering').length;
    if (renderingCount > 0) {
      const elapsedSec = Math.round((Date.now() - new Date(sceneStatuses[0].startedAt).getTime()) / 1000);
      console.log(`[${jobId}] Progress update: ${renderingCount} scenes still rendering (${elapsedSec}s elapsed)`);
      await updateSceneProgress();
    }
  }, 15000); // Update every 15 seconds

  // Track progress as scenes complete - with detailed status updates
  let completedCount = 0;
  const results = await Promise.all(
    scenePromises.map(async (promise, index) => {
      const result = await promise;
      completedCount++;

      // Update scene status (preserve startedAt)
      sceneStatuses[result.sceneIndex].status = result.success ? 'complete' : 'failed';
      sceneStatuses[result.sceneIndex].completedAt = new Date().toISOString();
      sceneStatuses[result.sceneIndex].error = result.error || null;

      // Generate dynamic status message
      const statusMsg = generateStatusMessage();
      console.log(`[${jobId}] Scene ${result.sceneIndex + 1} ${result.success ? 'complete' : 'failed'} (${completedCount}/${scenes.length})`);

      // Update Firestore with progress and scene statuses
      await updateSceneProgress();

      return result;
    })
  );

  // Stop the periodic progress updater
  clearInterval(progressInterval);

  // Log all results for debugging
  console.log(`[${jobId}] ========================================`);
  console.log(`[${jobId}] PARALLEL PROCESSING RESULTS`);
  results.forEach((r, i) => {
    if (r.success) {
      console.log(`[${jobId}] Scene ${i}: SUCCESS - ${r.sceneVideoUrl}`);
    } else {
      console.log(`[${jobId}] Scene ${i}: FAILED - ${r.error}`);
    }
  });
  console.log(`[${jobId}] ========================================`);

  // Collect successful scene videos
  const successfulScenes = results
    .filter(r => r.success)
    .sort((a, b) => a.sceneIndex - b.sceneIndex);

  console.log(`[${jobId}] Parallel processing complete: ${successfulScenes.length}/${scenes.length} scenes succeeded`);

  if (successfulScenes.length === 0) {
    // Log detailed failure info
    const failedScenes = results.filter(r => !r.success);
    const errorSummary = failedScenes.map(f => `S${f.sceneIndex}: ${f.error}`).join('; ');
    throw new Error(`All scene processing failed. Errors: ${errorSummary}`);
  }

  return successfulScenes.map(r => r.sceneVideoUrl);
}
