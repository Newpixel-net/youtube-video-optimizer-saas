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
              '-ss', String(relativeStart),   // Seek to start position
              '-i', capturedFile,
              '-t', String(duration),         // Duration to extract
              ...(useReencode
                ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
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

                // IMPORTANT: The browser extension captures at 4x playback speed to reduce capture time.
                // This means a 30-second clip is captured in ~7.5 seconds of real time.
                // MediaRecorder writes timestamps for the actual capture time (~7.5s), not the video time (30s).
                // We MUST rescale PTS to match the intended clip duration.
                //
                // Example: 23s clip → captured in ~5.75s → PTS span ~5.7s → ratio ~4x
                // The "25 fps" we see is NOT natural - it's 6 fps captured at 4x speed.

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
                      // Audio has same compression - rescale it too
                      audioFilter = `atempo=${(1/scaleFactor).toFixed(6)}`;
                      // Note: atempo only supports 0.5-2.0 range, may need chaining for larger factors
                      if (scaleFactor > 2.0) {
                        // For 4x scaling, need to chain: atempo=0.5,atempo=0.5
                        const atempoValue = 1 / scaleFactor;
                        if (atempoValue < 0.5) {
                          // Chain multiple atempo filters
                          const chainCount = Math.ceil(Math.log(scaleFactor) / Math.log(2));
                          const singleAtempo = Math.pow(atempoValue, 1/chainCount);
                          audioFilter = Array(chainCount).fill(`atempo=${singleAtempo.toFixed(6)}`).join(',');
                        }
                      }
                      console.log(`[${jobId}] AUDIO: Same compression detected, applying atempo filter`);
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
              const ffmpegArgs = ['-i', capturedFile];

              if (useRescaling && videoFilter) {
                ffmpegArgs.push('-vf', videoFilter);
                if (audioFilter) {
                  ffmpegArgs.push('-af', audioFilter);
                }
              }

              ffmpegArgs.push(
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
