/**
 * YouTube Video Downloader using youtubei.js
 * Supports both unauthenticated (TV client) and authenticated (OAuth) downloads
 */

import { Innertube, ClientType } from 'youtubei.js';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// Cache for Innertube instances per client type
const innertubeCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Get or create Innertube instance for a specific client
 * @param {string} clientType - The client type (TV, TV_EMBEDDED, WEB, etc.)
 * @param {Object} [youtubeAuth] - Optional OAuth credentials
 */
async function getInnertubeForClient(clientType = 'TV', youtubeAuth = null) {
  // For authenticated requests, don't cache (token might change)
  if (youtubeAuth?.accessToken) {
    console.log(`[YouTubeDownloader] Creating authenticated ${clientType} client...`);

    try {
      const instance = await Innertube.create({
        client_type: ClientType[clientType] || clientType,
        generate_session_locally: true,
        retrieve_player: true
      });

      // Set OAuth credentials for the session
      // This enables authenticated requests
      if (instance.session) {
        instance.session.context.client.visitorData = undefined;
        // Add access token to request headers
        instance.session.http.fetch = async (input, init = {}) => {
          init.headers = init.headers || {};
          init.headers['Authorization'] = `Bearer ${youtubeAuth.accessToken}`;
          return fetch(input, init);
        };
      }

      return instance;
    } catch (error) {
      console.error(`[YouTubeDownloader] Failed to create authenticated ${clientType} client:`, error.message);
      throw error;
    }
  }

  // For unauthenticated, use cache
  const cacheKey = clientType;
  const cached = innertubeCache.get(cacheKey);

  if (cached && Date.now() < cached.expiry) {
    console.log(`[YouTubeDownloader] Using cached ${clientType} client`);
    return cached.instance;
  }

  console.log(`[YouTubeDownloader] Creating new ${clientType} client...`);

  try {
    const instance = await Innertube.create({
      client_type: ClientType[clientType] || clientType,
      generate_session_locally: true,
      retrieve_player: true
    });

    innertubeCache.set(cacheKey, {
      instance,
      expiry: Date.now() + CACHE_TTL
    });

    return instance;
  } catch (error) {
    console.error(`[YouTubeDownloader] Failed to create ${clientType} client:`, error.message);
    throw error;
  }
}

/**
 * Try to get video info using multiple clients
 * @param {string} videoId - YouTube video ID
 * @param {Object} [youtubeAuth] - Optional OAuth credentials
 */
async function getVideoInfoWithFallback(videoId, youtubeAuth = null) {
  // If we have OAuth credentials, try authenticated WEB client first
  // This should have fewer restrictions
  const clientsToTry = youtubeAuth?.accessToken
    ? ['WEB', 'TV', 'TV_EMBEDDED']
    : ['TV', 'TV_EMBEDDED', 'WEB'];

  for (const clientType of clientsToTry) {
    try {
      console.log(`[YouTubeDownloader] Trying ${clientType} client for video ${videoId}${youtubeAuth ? ' (authenticated)' : ''}...`);

      const innertube = await getInnertubeForClient(clientType, youtubeAuth);
      const info = await innertube.getInfo(videoId);

      if (info.streaming_data?.adaptive_formats?.length > 0) {
        console.log(`[YouTubeDownloader] Success with ${clientType} client - found ${info.streaming_data.adaptive_formats.length} formats`);
        return { info, innertube, clientType };
      }

      console.log(`[YouTubeDownloader] ${clientType} client returned no adaptive formats`);
    } catch (error) {
      console.log(`[YouTubeDownloader] ${clientType} client failed: ${error.message}`);
    }
  }

  throw new Error('All YouTube clients failed to retrieve video info');
}

/**
 * Get video info
 */
async function getVideoInfo(videoId) {
  const { info } = await getVideoInfoWithFallback(videoId);

  return {
    title: info.basic_info.title,
    duration: info.basic_info.duration,
    author: info.basic_info.author,
    viewCount: info.basic_info.view_count,
    thumbnail: info.basic_info.thumbnail?.[0]?.url
  };
}

/**
 * Download video segment using youtubei.js + FFmpeg
 * @param {Object} params
 * @param {string} params.jobId - Job ID for logging
 * @param {string} params.videoId - YouTube video ID
 * @param {number} params.startTime - Start time in seconds
 * @param {number} params.endTime - End time in seconds
 * @param {string} params.workDir - Working directory path
 * @param {Object} [params.youtubeAuth] - Optional YouTube OAuth credentials
 * @param {string} [params.youtubeAuth.accessToken] - OAuth access token
 */
async function downloadVideoSegment({ jobId, videoId, startTime, endTime, workDir, youtubeAuth }) {
  const outputFile = path.join(workDir, 'source.mp4');
  const duration = endTime - startTime;

  console.log(`[${jobId}] Downloading video segment: ${startTime}s to ${endTime}s (${duration}s)`);

  // Log if we have YouTube authentication
  if (youtubeAuth?.accessToken) {
    console.log(`[${jobId}] Using authenticated YouTube session`);
  } else {
    console.log(`[${jobId}] No YouTube auth - using unauthenticated mode`);
  }

  try {
    // Try youtubei.js with multiple clients (pass auth if available)
    const { info, innertube, clientType } = await getVideoInfoWithFallback(videoId, youtubeAuth);

    console.log(`[${jobId}] Got video info via ${clientType} client${youtubeAuth ? ' (authenticated)' : ''}`);

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

    console.log(`[${jobId}] Selected video: ${videoFormat.quality_label || videoFormat.height}p`);
    console.log(`[${jobId}] Selected audio: ${audioFormat?.audio_quality || 'N/A'}`);

    // Get stream URLs
    let videoUrl, audioUrl;

    try {
      videoUrl = videoFormat.decipher(innertube.session.player);
      audioUrl = audioFormat?.decipher(innertube.session.player);
    } catch (decipherError) {
      // Try getting URL directly if decipher fails
      console.log(`[${jobId}] Decipher failed, trying direct URL...`);
      videoUrl = videoFormat.url;
      audioUrl = audioFormat?.url;
    }

    if (!videoUrl) {
      throw new Error('Could not get video URL');
    }

    console.log(`[${jobId}] Got stream URLs, starting FFmpeg download...`);

    // Download and trim using FFmpeg
    const bufferStart = Math.max(0, startTime - 1);
    const bufferDuration = (endTime - bufferStart) + 2;

    return new Promise((resolve, reject) => {
      const args = [
        '-ss', bufferStart.toString(),
        '-t', bufferDuration.toString(),
        '-i', videoUrl,
      ];

      if (audioUrl) {
        args.push(
          '-ss', bufferStart.toString(),
          '-t', bufferDuration.toString(),
          '-i', audioUrl
        );
      }

      args.push(
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ss', (startTime - bufferStart).toString(),
        '-t', duration.toString(),
        '-movflags', '+faststart',
        '-y',
        outputFile
      );

      console.log(`[${jobId}] FFmpeg starting...`);

      const ffmpegProc = spawn('ffmpeg', args);
      let stderr = '';

      ffmpegProc.stderr.on('data', (data) => {
        stderr += data.toString();
        const match = stderr.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (match) {
          console.log(`[${jobId}] Progress: ${match[1]}`);
        }
      });

      ffmpegProc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputFile)) {
          const stats = fs.statSync(outputFile);
          console.log(`[${jobId}] Download complete: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
          resolve(outputFile);
        } else {
          console.error(`[${jobId}] FFmpeg failed with code ${code}`);
          reject(new Error(`FFmpeg failed: ${stderr.slice(-300)}`));
        }
      });

      ffmpegProc.on('error', (error) => {
        reject(new Error(`FFmpeg error: ${error.message}`));
      });
    });

  } catch (error) {
    console.error(`[${jobId}] youtubei.js download failed:`, error.message);
    console.log(`[${jobId}] Falling back to yt-dlp...`);

    try {
      return await downloadWithYtDlp({ jobId, videoId, startTime, endTime, workDir, outputFile, youtubeAuth });
    } catch (ytdlpError) {
      console.error(`[${jobId}] yt-dlp also failed:`, ytdlpError.message);
      console.log(`[${jobId}] Trying Cobalt API as final fallback...`);

      try {
        // Cobalt downloads full video, we'll trim it with FFmpeg
        const cobaltOutput = path.join(workDir, 'cobalt_source.mp4');
        await downloadWithCobalt({ jobId, videoId, workDir, outputFile: cobaltOutput });

        // Trim to desired segment
        console.log(`[${jobId}] Trimming Cobalt download to segment...`);
        const bufferStart = Math.max(0, startTime - 1);
        const segmentDuration = (endTime - startTime) + 2;

        return new Promise((resolve, reject) => {
          const ffmpegArgs = [
            '-ss', bufferStart.toString(),
            '-t', segmentDuration.toString(),
            '-i', cobaltOutput,
            '-c', 'copy',
            '-y',
            outputFile
          ];

          const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
          let stderr = '';

          ffmpegProc.stderr.on('data', (data) => {
            stderr += data.toString();
          });

          ffmpegProc.on('close', (code) => {
            // Cleanup cobalt source
            try {
              if (fs.existsSync(cobaltOutput)) {
                fs.unlinkSync(cobaltOutput);
              }
            } catch (e) {}

            if (code === 0 && fs.existsSync(outputFile)) {
              console.log(`[${jobId}] Cobalt segment trim complete`);
              resolve(outputFile);
            } else {
              reject(new Error(`Segment trim failed: ${stderr.slice(-200)}`));
            }
          });

          ffmpegProc.on('error', (error) => {
            reject(new Error(`Trim FFmpeg error: ${error.message}`));
          });
        });
      } catch (cobaltError) {
        console.error(`[${jobId}] All download methods failed`);
        // Return a more helpful error message
        const errorMsg = ytdlpError.message.includes('Sign in to confirm')
          ? 'YouTube requires authentication. Please ensure your YouTube account is connected and try again. If the issue persists, the video may have restrictions.'
          : `Video download failed after trying multiple methods. Last error: ${cobaltError.message}`;
        throw new Error(errorMsg);
      }
    }
  }
}

/**
 * Fallback download using yt-dlp with TV client
 * @param {Object} params
 * @param {string} params.jobId - Job ID for logging
 * @param {string} params.videoId - YouTube video ID
 * @param {number} params.startTime - Start time in seconds
 * @param {number} params.endTime - End time in seconds
 * @param {string} params.workDir - Working directory path
 * @param {string} params.outputFile - Output file path
 * @param {Object} [params.youtubeAuth] - Optional YouTube OAuth credentials
 */
async function downloadWithYtDlp({ jobId, videoId, startTime, endTime, workDir, outputFile, youtubeAuth }) {
  const bufferStart = Math.max(0, startTime - 2);
  const bufferEnd = endTime + 2;

  return new Promise((resolve, reject) => {
    // Use tv_simply client which has fewer restrictions
    const args = [
      '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
      '--download-sections', `*${bufferStart}-${bufferEnd}`,
      '--force-keyframes-at-cuts',
      '-o', outputFile,
      '--no-playlist',
      '--no-warnings',
      // Use tv_simply client which generally works better
      '--extractor-args', 'youtube:player_client=tv_simply,tv,web',
      '--sleep-requests', '1',
      '--extractor-retries', '5',
      '--retry-sleep', 'extractor:3',
      '--no-check-certificates',
      '--geo-bypass',
      '--ignore-errors',
      '--merge-output-format', 'mp4'
    ];

    // Add OAuth authorization header if available
    if (youtubeAuth?.accessToken) {
      args.push('--add-header', `Authorization: Bearer ${youtubeAuth.accessToken}`);
      console.log(`[${jobId}] yt-dlp using OAuth authentication`);
    }

    // Add PO token if available from environment (fallback for unauthenticated)
    const poToken = process.env.YOUTUBE_PO_TOKEN;
    if (poToken && !youtubeAuth?.accessToken) {
      args.push('--extractor-args', `youtube:po_token=tv+${poToken}`);
    }

    // Add the video URL at the end
    args.push(`https://www.youtube.com/watch?v=${videoId}`);

    console.log(`[${jobId}] yt-dlp starting with tv_simply client...`);

    const ytdlpProc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';

    ytdlpProc.stdout.on('data', (data) => {
      stdout += data.toString();
      console.log(`[${jobId}] yt-dlp: ${data.toString().trim()}`);
    });

    ytdlpProc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytdlpProc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputFile)) {
        console.log(`[${jobId}] yt-dlp download complete`);
        resolve(outputFile);
      } else {
        console.error(`[${jobId}] yt-dlp failed with code ${code}`);
        console.error(`[${jobId}] stderr: ${stderr}`);
        reject(new Error(`Video download failed: ${stderr || 'Unknown error'}`));
      }
    });

    ytdlpProc.on('error', (error) => {
      reject(new Error(`yt-dlp error: ${error.message}`));
    });
  });
}

/**
 * Fallback download using Cobalt API (cobalt.tools)
 * Cobalt is an open-source video download service that handles YouTube restrictions better
 */
async function downloadWithCobalt({ jobId, videoId, workDir, outputFile }) {
  console.log(`[${jobId}] Trying Cobalt API fallback...`);

  try {
    // Cobalt API endpoint (using public instance - consider self-hosting for production)
    const cobaltUrl = process.env.COBALT_API_URL || 'https://api.cobalt.tools';

    const response = await fetch(`${cobaltUrl}/api/json`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: `https://www.youtube.com/watch?v=${videoId}`,
        vCodec: 'h264',
        vQuality: '1080',
        aFormat: 'mp3',
        filenamePattern: 'basic',
        isAudioOnly: false,
        disableMetadata: true
      })
    });

    if (!response.ok) {
      throw new Error(`Cobalt API returned ${response.status}`);
    }

    const result = await response.json();

    if (result.status === 'error') {
      throw new Error(result.text || 'Cobalt API error');
    }

    if (result.status === 'redirect' || result.status === 'stream') {
      const downloadUrl = result.url;

      console.log(`[${jobId}] Cobalt provided download URL, downloading with FFmpeg...`);

      // Download using FFmpeg
      return new Promise((resolve, reject) => {
        const ffmpegArgs = [
          '-i', downloadUrl,
          '-c', 'copy',
          '-y',
          outputFile
        ];

        const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
        let stderr = '';

        ffmpegProc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        ffmpegProc.on('close', (code) => {
          if (code === 0 && fs.existsSync(outputFile)) {
            console.log(`[${jobId}] Cobalt download complete`);
            resolve(outputFile);
          } else {
            reject(new Error(`Cobalt FFmpeg failed: ${stderr.slice(-200)}`));
          }
        });

        ffmpegProc.on('error', (error) => {
          reject(new Error(`Cobalt FFmpeg error: ${error.message}`));
        });
      });
    }

    throw new Error('Cobalt returned unexpected response');

  } catch (error) {
    console.error(`[${jobId}] Cobalt fallback failed:`, error.message);
    throw error;
  }
}

/**
 * Extract frames from YouTube video at specific timestamps
 */
async function extractYouTubeFrames({ videoId, timestamps, workDir }) {
  console.log(`[FrameExtractor] Extracting ${timestamps.length} frames from video ${videoId}`);

  const frames = [];

  try {
    const { info, innertube, clientType } = await getVideoInfoWithFallback(videoId);

    console.log(`[FrameExtractor] Got video info via ${clientType} client`);

    // Get a lower quality video stream for faster frame extraction
    const formats = info.streaming_data?.adaptive_formats || [];
    const videoFormat = formats
      .filter(f => f.has_video && !f.has_audio && f.height <= 720)
      .sort((a, b) => (a.height || 0) - (b.height || 0))[0]; // Get lowest quality

    if (!videoFormat) {
      throw new Error('No suitable video format for frame extraction');
    }

    let videoUrl;
    try {
      videoUrl = videoFormat.decipher(innertube.session.player);
    } catch (e) {
      videoUrl = videoFormat.url;
    }

    if (!videoUrl) {
      throw new Error('Could not get video URL for frame extraction');
    }

    // Extract frames using FFmpeg
    for (const timestamp of timestamps) {
      const outputPath = path.join(workDir, `frame_${timestamp}.jpg`);

      await new Promise((resolve) => {
        const args = [
          '-ss', timestamp.toString(),
          '-i', videoUrl,
          '-vframes', '1',
          '-q:v', '2',
          '-y',
          outputPath
        ];

        const ffmpegProc = spawn('ffmpeg', args);

        ffmpegProc.on('close', (code) => {
          if (code === 0 && fs.existsSync(outputPath)) {
            try {
              const imageBuffer = fs.readFileSync(outputPath);
              frames.push({
                timestamp,
                base64: imageBuffer.toString('base64'),
                mimeType: 'image/jpeg'
              });
              console.log(`[FrameExtractor] Extracted frame at ${timestamp}s`);
              fs.unlinkSync(outputPath);
            } catch (e) {
              console.log(`[FrameExtractor] Failed to read frame at ${timestamp}s`);
            }
          }
          resolve(true);
        });

        ffmpegProc.on('error', () => resolve(false));
      });
    }

    return frames;

  } catch (error) {
    console.error('[FrameExtractor] Failed:', error.message);
    return frames;
  }
}

export {
  downloadVideoSegment,
  getVideoInfo,
  extractYouTubeFrames,
  getInnertubeForClient
};
