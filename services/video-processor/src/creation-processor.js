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

    // Step 1: Download all images
    await updateProgress(jobRef, 5, 'Downloading images...');
    const imageFiles = await downloadAllImages({ jobId, scenes, workDir });
    console.log(`[${jobId}] Downloaded ${imageFiles.length} images`);

    // Step 2: Download all voiceovers
    await updateProgress(jobRef, 15, 'Downloading voiceovers...');
    const voiceoverFiles = await downloadAllVoiceovers({ jobId, scenes, workDir });
    console.log(`[${jobId}] Downloaded ${voiceoverFiles.length} voiceovers`);

    // Step 3: Download background music (if any)
    let musicFile = null;
    if (manifest.music && manifest.music.url) {
      await updateProgress(jobRef, 20, 'Downloading background music...');
      musicFile = await downloadFile({
        url: manifest.music.url,
        outputPath: path.join(workDir, 'music.mp3'),
        jobId
      });
    }

    // Step 4: Generate Ken Burns video from images
    await updateProgress(jobRef, 25, 'Generating video from images...');
    const videoOnlyFile = await generateKenBurnsVideo({
      jobId,
      jobRef,
      scenes,
      imageFiles,
      workDir,
      output
    });
    console.log(`[${jobId}] Generated Ken Burns video: ${videoOnlyFile}`);

    // Step 5: Combine video with audio (voiceovers + music)
    await updateProgress(jobRef, 70, 'Adding audio...');
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
    await updateProgress(jobRef, 90, 'Uploading final video...');
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

  const fps = output.fps || 30;

  console.log(`[${jobId}] Output resolution: ${width}x${height} @ ${fps}fps`);

  // Build FFmpeg command for Ken Burns effect
  const inputArgs = [];
  const filterParts = [];
  const validScenes = [];

  for (let i = 0; i < scenes.length; i++) {
    const imageFile = imageFiles[i];
    if (!imageFile || !fs.existsSync(imageFile)) {
      console.warn(`[${jobId}] Skipping scene ${i} - no image file`);
      continue;
    }

    const scene = scenes[i];
    const duration = scene.duration || 8;
    const frames = Math.round(duration * fps);

    // Add input with loop for duration
    inputArgs.push('-loop', '1', '-t', String(duration), '-i', imageFile);

    // Get Ken Burns parameters (with defaults)
    const kb = scene.kenBurns || {};
    const startScale = kb.startScale || 1.0;
    const endScale = kb.endScale || 1.2;
    const startX = kb.startX !== undefined ? kb.startX : 0.5;
    const startY = kb.startY !== undefined ? kb.startY : 0.5;
    const endX = kb.endX !== undefined ? kb.endX : 0.5;
    const endY = kb.endY !== undefined ? kb.endY : 0.5;

    // Build zoompan filter for Ken Burns effect
    // Scale image 2x output resolution for smooth zoom (reduced from 4x to save memory)
    const scaleSize = Math.max(width, height) * 2;

    // Zoom expression: interpolate from startScale to endScale
    const zoomExpr = `${startScale}+(${endScale}-${startScale})*on/${frames}`;

    // Pan expressions: interpolate position while keeping frame centered
    // x and y are pixel positions of top-left corner of output frame
    const xExpr = `(iw-iw/zoom)/2+(iw*${startX}-iw/2+(iw*${endX}-iw*${startX})*on/${frames})/zoom`;
    const yExpr = `(ih-ih/zoom)/2+(ih*${startY}-ih/2+(ih*${endY}-ih*${startY})*on/${frames})/zoom`;

    const inputIdx = validScenes.length;
    filterParts.push(
      `[${inputIdx}:v]scale=${scaleSize}:-1:flags=lanczos,` +
      `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${frames}:s=${width}x${height}:fps=${fps},` +
      `setsar=1[v${inputIdx}]`
    );

    validScenes.push({ ...scene, inputIdx, duration });
  }

  if (validScenes.length === 0) {
    throw new Error('No valid scenes with images to process');
  }

  // Add fade transitions between scenes with cumulative offset calculation
  let currentStream = 'v0';
  let cumulativeOffset = 0;

  for (let i = 1; i < validScenes.length; i++) {
    const fadeDuration = 0.5; // 0.5 second crossfade
    const prevDuration = validScenes[i - 1].duration;

    // Offset is cumulative duration minus overlap from previous fades
    cumulativeOffset += prevDuration - fadeDuration;

    // Crossfade between current stream and next scene
    filterParts.push(
      `[${currentStream}][v${i}]xfade=transition=fade:duration=${fadeDuration}:offset=${cumulativeOffset.toFixed(2)}[xf${i}]`
    );
    currentStream = `xf${i}`;
  }

  // Final output mapping
  const filterComplex = filterParts.join(';');

  const ffmpegArgs = [
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', `[${currentStream}]`,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y',
    outputFile
  ];

  console.log(`[${jobId}] Running FFmpeg for Ken Burns video...`);
  console.log(`[${jobId}] Filter complexity: ${validScenes.length} scenes`);
  console.log(`[${jobId}] FFmpeg command: ffmpeg ${ffmpegArgs.slice(0, 20).join(' ')}...`);

  try {
    await runFFmpeg({ jobId, args: ffmpegArgs, jobRef, progressStart: 25, progressEnd: 65 });
    console.log(`[${jobId}] FFmpeg Ken Burns completed successfully`);
  } catch (ffmpegError) {
    console.error(`[${jobId}] FFmpeg Ken Burns FAILED: ${ffmpegError.message}`);
    throw ffmpegError;
  }

  // Verify output
  if (!fs.existsSync(outputFile)) {
    throw new Error('FFmpeg did not produce output file');
  }

  const fileSize = fs.statSync(outputFile).size;
  console.log(`[${jobId}] Ken Burns video created: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

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
    args: ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1', '-q:a', '9', '-y', silenceFile]
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
          args: ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(remainingTime), '-q:a', '9', '-y', sceneSilence]
        });
        listContent.push(`file '${sceneSilence}'`);
      }
    } else {
      // No voiceover - add silence for entire scene duration
      const sceneSilence = path.join(workDir, `silence_full_${i}.mp3`);
      await runFFmpegSimple({
        args: ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(sceneDuration), '-q:a', '9', '-y', sceneSilence]
      });
      listContent.push(`file '${sceneSilence}'`);
    }

    currentTime += sceneDuration;
  }

  // Write concat list
  fs.writeFileSync(listFile, listContent.join('\n'));

  // Concatenate all audio
  await runFFmpegSimple({
    args: ['-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '2', '-y', outputFile]
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
 * Run FFmpeg with progress tracking
 */
function runFFmpeg({ jobId, args, jobRef, progressStart = 0, progressEnd = 100 }) {
  return new Promise((resolve, reject) => {
    console.log(`[${jobId}] FFmpeg command: ffmpeg ${args.slice(0, 10).join(' ')}...`);

    const ffmpeg = spawn('ffmpeg', args);
    let stderr = '';
    let duration = 0;
    let lastLogTime = Date.now();

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
      if (code === 0) {
        resolve();
      } else {
        console.error(`[${jobId}] FFmpeg failed with code ${code}`);
        console.error(`[${jobId}] FFmpeg stderr (last 1000 chars): ${stderr.slice(-1000)}`);
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });
  });
}

/**
 * Run FFmpeg without progress tracking (for simple operations)
 */
function runFFmpegSimple({ args }) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args);
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
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
