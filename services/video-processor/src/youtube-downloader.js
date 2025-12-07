/**
 * YouTube Video Downloader using youtubei.js
 * Handles PO token generation automatically to bypass bot detection
 */

import { Innertube, UniversalCache } from 'youtubei.js';
import { JSDOM } from 'jsdom';
import { BG } from 'bgutils-js';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// Cache for the Innertube instance
let innertubeInstance = null;
let innertubeExpiry = 0;
const INNERTUBE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Initialize JSDOM environment for BotGuard
 */
function initBotGuardEnvironment() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://www.youtube.com',
    pretendToBeVisual: true,
    runScripts: 'dangerously'
  });

  // Make DOM globals available
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.location = dom.window.location;

  return dom;
}

/**
 * Generate PO Token using BgUtils
 */
async function generatePoToken(innertube) {
  try {
    console.log('[YouTubeDownloader] Generating PO Token...');

    // Get attestation challenge
    const requestKey = 'O43z0dpjhgX20SCx4KAo';
    const bgConfig = {
      fetch: (url, options) => fetch(url, options),
      globalObj: global,
      identifier: innertube.session.context.client.visitorData,
      requestKey
    };

    const bgChallenge = await BG.Challenge.create(bgConfig);

    if (!bgChallenge) {
      console.log('[YouTubeDownloader] No challenge required, proceeding without PO token');
      return null;
    }

    const interpreterJavascript = bgChallenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue;

    if (interpreterJavascript) {
      // Execute the challenge in JSDOM environment
      const dom = initBotGuardEnvironment();

      new dom.window.Function(interpreterJavascript)();

      const poTokenResult = await BG.PoToken.generate({
        program: bgChallenge.program,
        globalName: bgChallenge.globalName,
        bgConfig
      });

      console.log('[YouTubeDownloader] PO Token generated successfully');
      return poTokenResult.poToken;
    }

    return null;
  } catch (error) {
    console.error('[YouTubeDownloader] PO Token generation failed:', error.message);
    return null;
  }
}

/**
 * Get or create Innertube instance with caching
 */
async function getInnertube() {
  const now = Date.now();

  if (innertubeInstance && now < innertubeExpiry) {
    console.log('[YouTubeDownloader] Using cached Innertube instance');
    return innertubeInstance;
  }

  console.log('[YouTubeDownloader] Creating new Innertube instance...');

  // Create Innertube with local session generation
  innertubeInstance = await Innertube.create({
    cache: new UniversalCache(false), // Don't use file cache in Cloud Run
    generate_session_locally: true,
    retrieve_player: true
  });

  // Try to generate PO token
  try {
    const poToken = await generatePoToken(innertubeInstance);
    if (poToken) {
      innertubeInstance.session.po_token = poToken;
    }
  } catch (e) {
    console.log('[YouTubeDownloader] Continuing without PO token:', e.message);
  }

  innertubeExpiry = now + INNERTUBE_TTL;
  return innertubeInstance;
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

      const ffmpegProcess = spawn('ffmpeg', args);

      let stderr = '';

      ffmpegProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        // Log progress
        const match = stderr.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (match) {
          console.log(`[${jobId}] Download progress: ${match[1]}`);
        }
      });

      ffmpegProcess.on('close', (code) => {
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

      ffmpegProcess.on('error', (error) => {
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

    const ytdlpProcess = spawn('yt-dlp', args);

    let stdout = '';
    let stderr = '';

    ytdlpProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ytdlpProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytdlpProcess.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputFile)) {
        console.log(`[${jobId}] yt-dlp download completed: ${outputFile}`);
        resolve(outputFile);
      } else {
        console.error(`[${jobId}] yt-dlp download failed. Code: ${code}`);
        console.error(`[${jobId}] stderr: ${stderr}`);
        reject(new Error(`Video download failed: ${stderr || 'Unknown error'}`));
      }
    });

    ytdlpProcess.on('error', (error) => {
      reject(new Error(`Failed to start yt-dlp: ${error.message}`));
    });
  });
}

/**
 * Extract frames from a video for thumbnail reference
 */
async function extractVideoFrames({ videoId, timestamps, workDir }) {
  const frames = [];

  try {
    const innertube = await getInnertube();
    const info = await innertube.getInfo(videoId);

    // Get video storyboard/thumbnails at specific times
    if (info.storyboards?.length > 0) {
      const storyboard = info.storyboards[0];
      // Use storyboard images as frame references
      for (const timestamp of timestamps) {
        const thumbUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        frames.push({
          timestamp,
          url: thumbUrl,
          type: 'storyboard'
        });
      }
    }

    // Also get max resolution thumbnail
    frames.push({
      timestamp: 0,
      url: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      type: 'maxres'
    });

    frames.push({
      timestamp: 0,
      url: `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
      type: 'sd'
    });

  } catch (error) {
    console.error('[YouTubeDownloader] Frame extraction failed:', error.message);
  }

  return frames;
}

export {
  downloadVideoSegment,
  getVideoInfo,
  extractVideoFrames,
  getInnertube
};
