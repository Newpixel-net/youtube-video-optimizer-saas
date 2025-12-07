/**
 * YouTube Video Downloader using youtubei.js
 * Handles PO token generation automatically to bypass bot detection
 */

import { Innertube, UniversalCache } from 'youtubei.js';
import { JSDOM } from 'jsdom';
import * as BG from 'bgutils-js';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// Cache for the Innertube instance
let innertubeInstance = null;
let cachedPoToken = null;
let cachedVisitorData = null;
let innertubeExpiry = 0;
const INNERTUBE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Initialize JSDOM environment for BotGuard
 */
function createBotGuardEnvironment() {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://www.youtube.com',
    referrer: 'https://www.youtube.com',
    contentType: 'text/html',
    includeNodeLocations: true,
    storageQuota: 10000000,
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    resources: 'usable',
    beforeParse(window) {
      // Polyfill missing APIs
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
    }
  });

  return dom.window;
}

/**
 * Generate PO Token using BgUtils
 */
async function generatePoToken(visitorData) {
  console.log('[YouTubeDownloader] Generating PO Token with BgUtils...');

  try {
    // Create BotGuard environment
    const bgWindow = createBotGuardEnvironment();

    // Request key for YouTube
    const requestKey = 'O43z0dpjhgX20SCx4KAo';

    // Create BG challenge config
    const bgConfig = {
      fetch: (url, options) => fetch(url, options),
      globalObj: bgWindow,
      identifier: visitorData,
      requestKey
    };

    // Create challenge
    const challenge = await BG.Challenge.create(bgConfig);

    if (!challenge) {
      console.log('[YouTubeDownloader] No challenge returned');
      return null;
    }

    // Get interpreter script
    const interpreterUrl = challenge.interpreterUrl;
    if (interpreterUrl) {
      const vmResponse = await fetch(interpreterUrl);
      const vmCode = await vmResponse.text();

      // Execute in the window context
      bgWindow.eval(vmCode);
    }

    // Get the interpreter JavaScript from challenge
    const interpreterJs = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (interpreterJs) {
      bgWindow.eval(interpreterJs);
    }

    // Generate the PoToken
    const poTokenResult = await BG.PoToken.generate({
      program: challenge.program,
      globalName: challenge.globalName,
      bgConfig
    });

    if (poTokenResult?.poToken) {
      console.log('[YouTubeDownloader] PO Token generated successfully');
      return poTokenResult.poToken;
    }

    console.log('[YouTubeDownloader] Failed to generate PO Token');
    return null;

  } catch (error) {
    console.error('[YouTubeDownloader] PO Token generation error:', error.message);
    return null;
  }
}

/**
 * Get or create Innertube instance with caching
 */
async function getInnertube() {
  const now = Date.now();

  if (innertubeInstance && now < innertubeExpiry && cachedPoToken) {
    console.log('[YouTubeDownloader] Using cached Innertube instance');
    return innertubeInstance;
  }

  console.log('[YouTubeDownloader] Creating new Innertube instance...');

  try {
    // First create a basic instance to get visitor data
    const tempTube = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true
    });

    const visitorData = tempTube.session.context.client.visitorData;
    console.log('[YouTubeDownloader] Got visitor data:', visitorData?.substring(0, 20) + '...');

    // Try to generate PO token
    let poToken = null;
    try {
      poToken = await generatePoToken(visitorData);
    } catch (e) {
      console.log('[YouTubeDownloader] PO Token generation skipped:', e.message);
    }

    // Create final instance with PO token if available
    if (poToken) {
      innertubeInstance = await Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
        po_token: poToken,
        visitor_data: visitorData
      });
      cachedPoToken = poToken;
      cachedVisitorData = visitorData;
      console.log('[YouTubeDownloader] Created Innertube with PO Token');
    } else {
      innertubeInstance = tempTube;
      console.log('[YouTubeDownloader] Created Innertube without PO Token');
    }

    innertubeExpiry = now + INNERTUBE_TTL;
    return innertubeInstance;

  } catch (error) {
    console.error('[YouTubeDownloader] Failed to create Innertube:', error.message);

    // Create minimal instance as fallback
    innertubeInstance = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true
    });
    innertubeExpiry = now + INNERTUBE_TTL;
    return innertubeInstance;
  }
}

/**
 * Get video info and stream URLs
 */
async function getVideoInfo(videoId) {
  const innertube = await getInnertube();

  console.log(`[YouTubeDownloader] Fetching video info for: ${videoId}`);

  const info = await innertube.getInfo(videoId);

  return {
    title: info.basic_info.title,
    duration: info.basic_info.duration,
    author: info.basic_info.author,
    viewCount: info.basic_info.view_count,
    thumbnail: info.basic_info.thumbnail?.[0]?.url
  };
}

/**
 * Download video segment using youtubei.js + FFmpeg for trimming
 */
async function downloadVideoSegment({ jobId, videoId, startTime, endTime, workDir }) {
  const outputFile = path.join(workDir, 'source.mp4');
  const duration = endTime - startTime;

  console.log(`[${jobId}] Downloading video segment: ${startTime}s to ${endTime}s (${duration}s)`);

  try {
    const innertube = await getInnertube();

    // Get video info with streaming data
    console.log(`[${jobId}] Fetching video streaming data...`);
    const info = await innertube.getInfo(videoId);

    if (!info.streaming_data) {
      throw new Error('No streaming data available for this video');
    }

    // Select best format (prefer 1080p or lower)
    const formats = info.streaming_data.adaptive_formats || [];

    // Get best video format (1080p max)
    const videoFormats = formats.filter(f =>
      f.has_video &&
      !f.has_audio &&
      f.height <= 1080
    ).sort((a, b) => (b.height || 0) - (a.height || 0));

    // Get best audio format
    const audioFormats = formats.filter(f =>
      f.has_audio &&
      !f.has_video
    ).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    const videoFormat = videoFormats[0];
    const audioFormat = audioFormats[0];

    if (!videoFormat) {
      throw new Error('No suitable video format found');
    }

    console.log(`[${jobId}] Selected video format: ${videoFormat.quality_label || videoFormat.height}p`);
    console.log(`[${jobId}] Selected audio format: ${audioFormat?.audio_quality || 'N/A'}`);

    // Get decipher URLs
    const videoUrl = videoFormat.decipher(innertube.session.player);
    const audioUrl = audioFormat?.decipher(innertube.session.player);

    console.log(`[${jobId}] Got deciphered video URL`);

    // Download and trim using FFmpeg with input seeking for speed
    const bufferStart = Math.max(0, startTime - 1);
    const bufferDuration = (endTime - bufferStart) + 2;

    return new Promise((resolve, reject) => {
      const args = [
        // Input seeking (fast, before -i)
        '-ss', bufferStart.toString(),
        '-t', bufferDuration.toString(),
        // Video input
        '-i', videoUrl,
      ];

      // Add audio input if available
      if (audioUrl) {
        args.push(
          '-ss', bufferStart.toString(),
          '-t', bufferDuration.toString(),
          '-i', audioUrl
        );
      }

      args.push(
        // Output options
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        // Accurate trimming
        '-ss', (startTime - bufferStart).toString(),
        '-t', duration.toString(),
        '-movflags', '+faststart',
        '-y',
        outputFile
      );

      console.log(`[${jobId}] FFmpeg download command starting...`);

      const ffmpegDownload = spawn('ffmpeg', args);

      let stderr = '';

      ffmpegDownload.stderr.on('data', (data) => {
        stderr += data.toString();
        // Log progress
        const match = stderr.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (match) {
          console.log(`[${jobId}] Download progress: ${match[1]}`);
        }
      });

      ffmpegDownload.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputFile)) {
          const stats = fs.statSync(outputFile);
          console.log(`[${jobId}] Download completed: ${outputFile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
          resolve(outputFile);
        } else {
          console.error(`[${jobId}] FFmpeg download failed. Code: ${code}`);
          console.error(`[${jobId}] Last 500 chars of stderr: ${stderr.slice(-500)}`);
          reject(new Error(`Video download failed: ${code}`));
        }
      });

      ffmpegDownload.on('error', (error) => {
        reject(new Error(`Failed to start FFmpeg: ${error.message}`));
      });
    });

  } catch (error) {
    console.error(`[${jobId}] youtubei.js download failed:`, error.message);

    // Fallback to yt-dlp if youtubei.js fails
    console.log(`[${jobId}] Falling back to yt-dlp...`);
    return downloadWithYtDlp({ jobId, videoId, startTime, endTime, workDir, outputFile });
  }
}

/**
 * Fallback download using yt-dlp (for cases where youtubei.js fails)
 */
async function downloadWithYtDlp({ jobId, videoId, startTime, endTime, workDir, outputFile }) {
  const bufferStart = Math.max(0, startTime - 2);
  const bufferEnd = endTime + 2;

  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
      '--download-sections', `*${bufferStart}-${bufferEnd}`,
      '--force-keyframes-at-cuts',
      '-o', outputFile,
      '--no-playlist',
      '--no-warnings',
      '--extractor-args', 'youtube:player_client=ios,web',
      '--user-agent', 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
      '--sleep-requests', '1',
      '--extractor-retries', '5',
      '--retry-sleep', 'extractor:3',
      '--no-check-certificates',
      '--geo-bypass',
      '--ignore-errors',
      '--merge-output-format', 'mp4',
      `https://www.youtube.com/watch?v=${videoId}`
    ];

    // Add PO token from environment if available
    const poToken = process.env.YOUTUBE_PO_TOKEN;
    if (poToken) {
      args.splice(-1, 0, '--extractor-args', `youtube:po_token=web+${poToken}`);
    }

    console.log(`[${jobId}] yt-dlp fallback starting...`);

    const ytdlpProc = spawn('yt-dlp', args);

    let stdout = '';
    let stderr = '';

    ytdlpProc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ytdlpProc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytdlpProc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputFile)) {
        console.log(`[${jobId}] yt-dlp download completed: ${outputFile}`);
        resolve(outputFile);
      } else {
        console.error(`[${jobId}] yt-dlp download failed. Code: ${code}`);
        console.error(`[${jobId}] stderr: ${stderr}`);
        reject(new Error(`Video download failed: ${stderr || 'Unknown error'}`));
      }
    });

    ytdlpProc.on('error', (error) => {
      reject(new Error(`Failed to start yt-dlp: ${error.message}`));
    });
  });
}

/**
 * Extract frames from video at specific timestamps
 * Returns base64 encoded images
 */
async function extractFramesFromVideo(videoPath, timestamps, outputDir) {
  const frames = [];

  for (const timestamp of timestamps) {
    const outputPath = path.join(outputDir, `frame_${timestamp}.jpg`);

    await new Promise((resolve, reject) => {
      const args = [
        '-ss', timestamp.toString(),
        '-i', videoPath,
        '-vframes', '1',
        '-q:v', '2',
        '-y',
        outputPath
      ];

      const ffmpegExtract = spawn('ffmpeg', args);

      ffmpegExtract.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          const imageBuffer = fs.readFileSync(outputPath);
          frames.push({
            timestamp,
            base64: imageBuffer.toString('base64'),
            path: outputPath
          });
          resolve(true);
        } else {
          resolve(false); // Don't reject, just skip this frame
        }
      });

      ffmpegExtract.on('error', () => resolve(false));
    });
  }

  return frames;
}

/**
 * Extract frames directly from YouTube video at specific timestamps
 * Downloads a small segment and extracts frames
 */
async function extractYouTubeFrames({ videoId, timestamps, workDir }) {
  console.log(`[FrameExtractor] Extracting ${timestamps.length} frames from video ${videoId}`);

  const frames = [];

  try {
    const innertube = await getInnertube();
    const info = await innertube.getInfo(videoId);

    if (!info.streaming_data) {
      throw new Error('No streaming data available');
    }

    // Get a video stream URL
    const formats = info.streaming_data.adaptive_formats || [];
    const videoFormat = formats
      .filter(f => f.has_video && !f.has_audio && f.height <= 720)
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

    if (!videoFormat) {
      throw new Error('No suitable video format');
    }

    const videoUrl = videoFormat.decipher(innertube.session.player);

    // Extract frames directly from stream URL using FFmpeg
    for (const timestamp of timestamps) {
      const outputPath = path.join(workDir, `frame_${timestamp}.jpg`);

      await new Promise((resolve, reject) => {
        const args = [
          '-ss', timestamp.toString(),
          '-i', videoUrl,
          '-vframes', '1',
          '-q:v', '2',
          '-y',
          outputPath
        ];

        const ffmpegExtract = spawn('ffmpeg', args);
        let stderr = '';

        ffmpegExtract.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        ffmpegExtract.on('close', (code) => {
          if (code === 0 && fs.existsSync(outputPath)) {
            const imageBuffer = fs.readFileSync(outputPath);
            frames.push({
              timestamp,
              base64: imageBuffer.toString('base64'),
              mimeType: 'image/jpeg'
            });
            console.log(`[FrameExtractor] Extracted frame at ${timestamp}s`);
            // Clean up
            try { fs.unlinkSync(outputPath); } catch (e) {}
          }
          resolve(true);
        });

        ffmpegExtract.on('error', () => resolve(false));
      });
    }

    return frames;

  } catch (error) {
    console.error('[FrameExtractor] Failed to extract frames:', error.message);
    return frames;
  }
}

export {
  downloadVideoSegment,
  getVideoInfo,
  extractFramesFromVideo,
  extractYouTubeFrames,
  getInnertube
};
