/**
 * YouTube Video Downloader with multiple fallbacks
 * Priority: yt-dlp (with POT provider) > Video Download API > youtubei.js > other fallbacks
 *
 * The POT (Proof of Origin Token) provider is critical for bypassing YouTube's bot detection.
 * See: https://github.com/Brainicism/bgutil-ytdlp-pot-provider
 */

import { Innertube, ClientType } from 'youtubei.js';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// RapidAPI YT-API configuration (legacy, disabled)
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_HOST = 'yt-api.p.rapidapi.com';

// Video Download API - reliable third-party service
// Supports time segments, 99%+ uptime, production-ready
// See: https://video-download-api.com/
const VIDEO_DOWNLOAD_API_KEY = process.env.VIDEO_DOWNLOAD_API_KEY || '';
const VIDEO_DOWNLOAD_API_URL = 'https://api.video-download-api.com';

// Cache for Innertube instances per client type
const innertubeCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Download video using FFmpeg (handles YouTube URLs better than fetch)
 * @param {Object} params
 * @param {string} params.jobId - Job ID for logging
 * @param {string} params.downloadUrl - Direct video URL
 * @param {string} params.outputFile - Output file path
 */
async function downloadWithFFmpeg({ jobId, downloadUrl, outputFile }) {
  console.log(`[${jobId}] Using FFmpeg to download video...`);
  console.log(`[${jobId}] FFmpeg target URL: ${downloadUrl.substring(0, 100)}...`);

  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '-headers', 'Referer: https://www.youtube.com/\r\nOrigin: https://www.youtube.com\r\n',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-timeout', '30000000',  // 30 second timeout in microseconds
      '-i', downloadUrl,
      '-c', 'copy',
      outputFile
    ];

    const ffmpegProc = spawn('ffmpeg', args);
    let stderr = '';
    let lastProgress = Date.now();

    // Set a timeout - kill if no progress for 60 seconds
    const timeoutCheck = setInterval(() => {
      if (Date.now() - lastProgress > 60000) {
        console.error(`[${jobId}] FFmpeg timeout - no progress for 60s, killing...`);
        ffmpegProc.kill('SIGKILL');
        clearInterval(timeoutCheck);
      }
    }, 10000);

    ffmpegProc.stderr.on('data', (data) => {
      stderr += data.toString();
      lastProgress = Date.now();
      // Log progress
      const timeMatch = stderr.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (timeMatch) {
        console.log(`[${jobId}] FFmpeg progress: ${timeMatch[1]}`);
      }
      // Log errors immediately
      if (stderr.includes('403 Forbidden') || stderr.includes('Server returned')) {
        console.error(`[${jobId}] FFmpeg HTTP error detected: ${stderr.slice(-300)}`);
      }
    });

    ffmpegProc.on('close', (code) => {
      clearInterval(timeoutCheck);
      if (code === 0 && fs.existsSync(outputFile)) {
        const stats = fs.statSync(outputFile);
        if (stats.size > 1000) {  // At least 1KB
          console.log(`[${jobId}] FFmpeg download complete: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
          resolve(outputFile);
        } else {
          console.error(`[${jobId}] FFmpeg output too small: ${stats.size} bytes`);
          reject(new Error('FFmpeg output file too small'));
        }
      } else {
        console.error(`[${jobId}] FFmpeg download failed with code ${code}`);
        console.error(`[${jobId}] FFmpeg stderr (last 500): ${stderr.slice(-500)}`);
        reject(new Error(`FFmpeg download failed: ${stderr.slice(-200)}`));
      }
    });

    ffmpegProc.on('error', (error) => {
      clearInterval(timeoutCheck);
      console.error(`[${jobId}] FFmpeg spawn error: ${error.message}`);
      reject(new Error(`FFmpeg error: ${error.message}`));
    });
  });
}

/**
 * Download video using RapidAPI (paid, reliable)
 * API: youtube-video-download-info (~$0.0003 per download)
 * @param {Object} params
 * @param {string} params.jobId - Job ID for logging
 * @param {string} params.videoId - YouTube video ID
 * @param {string} params.workDir - Working directory path
 * @param {string} params.outputFile - Output file path
 */
async function downloadWithRapidAPI({ jobId, videoId, workDir, outputFile }) {
  // Log key status (masked for security)
  const keyStatus = RAPIDAPI_KEY ? `configured (${RAPIDAPI_KEY.substring(0, 8)}...)` : 'NOT CONFIGURED';
  console.log(`[${jobId}] RapidAPI key status: ${keyStatus}`);

  if (!RAPIDAPI_KEY) {
    throw new Error('RapidAPI key not configured - set RAPIDAPI_KEY environment variable');
  }

  console.log(`[${jobId}] Trying RapidAPI YT-API download for video: ${videoId}`);

  try {
    // Step 1: Get download URL from YT-API on RapidAPI
    const apiUrl = `https://${RAPIDAPI_HOST}/dl?id=${videoId}`;
    console.log(`[${jobId}] YT-API request: ${apiUrl}`);

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': RAPIDAPI_KEY,
        'X-RapidAPI-Host': RAPIDAPI_HOST
      }
    });

    console.log(`[${jobId}] YT-API response status: ${response.status}`);

    if (!response.ok) {
      const text = await response.text();
      console.error(`[${jobId}] YT-API error response: ${text.substring(0, 500)}`);
      throw new Error(`YT-API request failed: ${response.status} - ${text.substring(0, 200)}`);
    }

    const data = await response.json();
    console.log(`[${jobId}] YT-API response received, status: ${data.status}, formats: ${data.formats?.length || 0}`);

    // YT-API returns status: "OK" on success
    if (data.status !== 'OK') {
      console.error(`[${jobId}] YT-API error: status=${data.status}, message=${data.message || 'unknown'}`);
      throw new Error(`YT-API returned status: ${data.status} - ${data.message || 'unknown error'}`);
    }

    // YT-API returns formats array with combined video+audio streams
    if (!data.formats || data.formats.length === 0) {
      console.error(`[${jobId}] YT-API returned no formats. Full response keys: ${Object.keys(data).join(', ')}`);
      throw new Error('No download formats returned from YT-API');
    }

    // Log available formats for debugging
    console.log(`[${jobId}] Available formats: ${data.formats.map(f => `${f.qualityLabel || f.quality}(${f.mimeType?.split(';')[0]})`).join(', ')}`);

    // Find best quality MP4 format (prefer 720p, then 360p)
    let downloadUrl = null;
    let selectedQuality = null;

    // Quality preference order: 720p > 480p > 360p > 144p
    const qualityOrder = ['720p', '480p', '360p', '240p', '144p'];

    for (const quality of qualityOrder) {
      const format = data.formats.find(f =>
        f.qualityLabel === quality &&
        f.mimeType &&
        f.mimeType.includes('video/mp4')
      );
      if (format && format.url) {
        downloadUrl = format.url;
        selectedQuality = quality;
        console.log(`[${jobId}] Selected format: ${quality} MP4`);
        break;
      }
    }

    // If no MP4 found at preferred quality, try any MP4
    if (!downloadUrl) {
      const mp4Format = data.formats.find(f => f.url && f.mimeType && f.mimeType.includes('video/mp4'));
      if (mp4Format) {
        downloadUrl = mp4Format.url;
        selectedQuality = mp4Format.qualityLabel || 'unknown';
        console.log(`[${jobId}] Fallback to any MP4: ${selectedQuality}`);
      }
    }

    // If still no URL, try any video format
    if (!downloadUrl) {
      const anyFormat = data.formats.find(f => f.url && f.mimeType && f.mimeType.includes('video/'));
      if (anyFormat) {
        downloadUrl = anyFormat.url;
        selectedQuality = anyFormat.qualityLabel || 'unknown';
        console.log(`[${jobId}] Fallback to any video: ${selectedQuality} (${anyFormat.mimeType})`);
      }
    }

    if (!downloadUrl) {
      console.error(`[${jobId}] No usable download URL found in ${data.formats.length} formats`);
      throw new Error('No valid download URL in YT-API response');
    }

    console.log(`[${jobId}] YT-API: Downloading ${selectedQuality} video...`);
    console.log(`[${jobId}] Download URL domain: ${new URL(downloadUrl).hostname}`);

    // Step 2: Download the video file - YouTube URLs require specific headers
    const videoResponse = await fetch(downloadUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity;q=1, *;q=0',
        'Range': 'bytes=0-',
        'Referer': 'https://www.youtube.com/',
        'Origin': 'https://www.youtube.com',
        'Sec-Fetch-Dest': 'video',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'Connection': 'keep-alive'
      }
    });

    // YouTube may return 206 Partial Content or 200 OK
    if (!videoResponse.ok && videoResponse.status !== 206) {
      console.error(`[${jobId}] Fetch failed with ${videoResponse.status}, trying FFmpeg download...`);
      // Log response headers for debugging
      const respHeaders = {};
      videoResponse.headers.forEach((v, k) => respHeaders[k] = v);
      console.error(`[${jobId}] Response headers: ${JSON.stringify(respHeaders)}`);

      // Fallback to FFmpeg for downloading (handles YouTube URLs better)
      return await downloadWithFFmpeg({ jobId, downloadUrl, outputFile });
    }

    // Get content length if available
    const contentLength = videoResponse.headers.get('content-length');
    console.log(`[${jobId}] Downloading video, size: ${contentLength ? (parseInt(contentLength) / 1024 / 1024).toFixed(2) + ' MB' : 'unknown'}`);

    // Stream to file for better memory handling
    const buffer = await videoResponse.arrayBuffer();
    fs.writeFileSync(outputFile, Buffer.from(buffer));

    const stats = fs.statSync(outputFile);
    console.log(`[${jobId}] YT-API download complete: ${(stats.size / 1024 / 1024).toFixed(2)} MB saved to ${outputFile}`);

    return outputFile;

  } catch (error) {
    console.error(`[${jobId}] YT-API download failed:`, error.message);
    console.error(`[${jobId}] Error details:`, error.stack?.split('\n').slice(0, 3).join('\n'));
    throw error;
  }
}

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
  // Try multiple client types - some work better than others depending on video/region
  // ANDROID and IOS clients often bypass restrictions that affect WEB/TV
  const clientsToTry = youtubeAuth?.accessToken
    ? ['WEB', 'ANDROID', 'IOS', 'TV', 'TV_EMBEDDED']
    : ['ANDROID', 'IOS', 'TV', 'TV_EMBEDDED', 'WEB', 'ANDROID_MUSIC'];

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

  // Log authentication status
  if (youtubeAuth?.accessToken) {
    console.log(`[${jobId}] YouTube OAuth available (used for metadata, not downloads)`);
  } else {
    console.log(`[${jobId}] No YouTube OAuth - using standard download methods`);
  }

  // PRIMARY METHOD: Try yt-dlp first (most reliable, updated frequently)
  console.log(`[${jobId}] Trying yt-dlp (primary method)...`);
  try {
    return await downloadWithYtDlp({ jobId, videoId, startTime, endTime, workDir, outputFile, youtubeAuth });
  } catch (ytdlpError) {
    console.warn(`[${jobId}] yt-dlp failed: ${ytdlpError.message}`);
  }

  // SECONDARY METHOD: Try youtubei.js (JavaScript library)
  console.log(`[${jobId}] Trying youtubei.js (secondary method)...`);
  try {
    const result = await downloadWithYoutubeijs({ jobId, videoId, startTime, endTime, workDir, outputFile, youtubeAuth });
    return result;
  } catch (ytjsError) {
    console.warn(`[${jobId}] youtubei.js failed: ${ytjsError.message}`);
  }

  // TERTIARY METHODS: Try various fallbacks
  // Try Video Download API if configured (paid, reliable)
  if (VIDEO_DOWNLOAD_API_KEY) {
    console.log(`[${jobId}] Trying Video Download API (paid service)...`);
    try {
      return await downloadWithVideoDownloadAPI({ jobId, videoId, startTime, endTime, workDir, outputFile });
    } catch (apiError) {
      console.warn(`[${jobId}] Video Download API failed: ${apiError.message}`);
    }
  }

  // Try Invidious (open-source YouTube frontend)
  console.log(`[${jobId}] Trying Invidious API...`);
  try {
    const invidiousOutput = path.join(workDir, 'invidious_source.mp4');
    await downloadWithInvidious({ jobId, videoId, workDir, outputFile: invidiousOutput });
    return await trimVideoSegment({ jobId, inputFile: invidiousOutput, outputFile, startTime, endTime });
  } catch (invidiousError) {
    console.warn(`[${jobId}] Invidious failed: ${invidiousError.message}`);
  }

  // Try Piped (another open-source YouTube frontend)
  console.log(`[${jobId}] Trying Piped API...`);
  try {
    const pipedOutput = path.join(workDir, 'piped_source.mp4');
    await downloadWithPiped({ jobId, videoId, workDir, outputFile: pipedOutput });
    return await trimVideoSegment({ jobId, inputFile: pipedOutput, outputFile, startTime, endTime });
  } catch (pipedError) {
    console.warn(`[${jobId}] Piped failed: ${pipedError.message}`);
  }

  // Try direct extraction from YouTube page
  console.log(`[${jobId}] Trying direct extraction...`);
  try {
    const directOutput = path.join(workDir, 'direct_source.mp4');
    await downloadWithDirectExtraction({ jobId, videoId, workDir, outputFile: directOutput });
    return await trimVideoSegment({ jobId, inputFile: directOutput, outputFile, startTime, endTime });
  } catch (directError) {
    console.warn(`[${jobId}] Direct extraction failed: ${directError.message}`);
  }

  // Try Cobalt API (known to be broken for YouTube as of late 2024)
  console.log(`[${jobId}] Trying Cobalt API (last resort)...`);
  try {
    const cobaltOutput = path.join(workDir, 'cobalt_source.mp4');
    await downloadWithCobalt({ jobId, videoId, workDir, outputFile: cobaltOutput });
    return await trimVideoSegment({ jobId, inputFile: cobaltOutput, outputFile, startTime, endTime });
  } catch (cobaltError) {
    console.warn(`[${jobId}] Cobalt failed: ${cobaltError.message}`);
  }

  // Try alternative APIs
  console.log(`[${jobId}] Trying alternative APIs...`);
  try {
    const altOutput = path.join(workDir, 'alt_source.mp4');
    await downloadWithAlternativeAPIs({ jobId, videoId, workDir, outputFile: altOutput });
    return await trimVideoSegment({ jobId, inputFile: altOutput, outputFile, startTime, endTime });
  } catch (altError) {
    console.warn(`[${jobId}] Alternative APIs failed: ${altError.message}`);
  }

  // All methods failed
  console.error(`[${jobId}] All download methods failed`);
  throw new Error(
    'Video download failed. YouTube has strengthened bot detection. ' +
    'Please try: 1) Upload the video directly, or 2) Use the browser extension to capture the video while playing it on YouTube.'
  );
}

/**
 * Download using youtubei.js library
 */
async function downloadWithYoutubeijs({ jobId, videoId, startTime, endTime, workDir, outputFile, youtubeAuth }) {
  const duration = endTime - startTime;

  // Try multiple clients - some work better than others
  const { info, innertube, clientType } = await getVideoInfoWithFallback(videoId, youtubeAuth);

  console.log(`[${jobId}] Got video info via ${clientType} client`);

  // Select best format (prefer 1080p or lower)
  const formats = info.streaming_data?.adaptive_formats || [];

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
}

/**
 * Helper to trim video segment with FFmpeg
 */
async function trimVideoSegment({ jobId, inputFile, outputFile, startTime, endTime }) {
  const bufferStart = Math.max(0, startTime - 1);
  const segmentDuration = (endTime - startTime) + 2;

  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-ss', bufferStart.toString(),
      '-t', segmentDuration.toString(),
      '-i', inputFile,
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
      // Cleanup source file
      try {
        if (fs.existsSync(inputFile)) {
          fs.unlinkSync(inputFile);
        }
      } catch (e) {}

      if (code === 0 && fs.existsSync(outputFile)) {
        console.log(`[${jobId}] Segment trim complete`);
        resolve(outputFile);
      } else {
        reject(new Error(`Segment trim failed: ${stderr.slice(-200)}`));
      }
    });

    ffmpegProc.on('error', (error) => {
      reject(new Error(`Trim FFmpeg error: ${error.message}`));
    });
  });
}

/**
 * Check if the POT (Proof of Origin Token) server is running
 * The POT server is required for bypassing YouTube's bot detection
 */
async function checkPotServer() {
  try {
    const response = await fetch('http://127.0.0.1:4416/ping', {
      method: 'GET',
      signal: AbortSignal.timeout(2000)
    });
    return response.ok;
  } catch (e) {
    return false;
  }
}

/**
 * Download using yt-dlp with multiple client configurations
 * Tries different YouTube client types to bypass restrictions
 * Uses POT (Proof of Origin Token) server for bot detection bypass
 */
async function downloadWithYtDlp({ jobId, videoId, startTime, endTime, workDir, outputFile, youtubeAuth }) {
  const bufferStart = Math.max(0, startTime - 2);
  const bufferEnd = endTime + 2;

  // Check if POT server is running (critical for bypassing bot detection)
  const potServerRunning = await checkPotServer();
  if (potServerRunning) {
    console.log(`[${jobId}] POT server is running on port 4416 - bot detection bypass enabled`);
  } else {
    console.warn(`[${jobId}] WARNING: POT server is NOT running - downloads may fail with bot detection`);
  }

  // Try multiple client configurations - different clients bypass different restrictions
  const clientConfigs = [
    'web',                       // Web client (best with POT tokens)
    'tv,tv_embedded',            // TV clients often work when web fails
    'android,android_creator',   // Android clients have different restrictions
    'ios',                       // iOS client
    'web_creator,mweb',          // Web creator client
    'default'                    // Let yt-dlp choose
  ];

  let lastError = null;

  for (const clients of clientConfigs) {
    console.log(`[${jobId}] yt-dlp trying clients: ${clients}`);

    try {
      const result = await tryYtDlpWithClient({
        jobId,
        videoId,
        bufferStart,
        bufferEnd,
        outputFile,
        clients
      });
      return result;
    } catch (error) {
      console.warn(`[${jobId}] yt-dlp with ${clients} failed: ${error.message}`);
      lastError = error;
      // Continue to next client config
    }
  }

  throw lastError || new Error('All yt-dlp client configurations failed');
}

/**
 * Try yt-dlp with a specific client configuration
 * Uses POT (Proof of Origin Token) server on localhost:4416 to bypass bot detection
 */
async function tryYtDlpWithClient({ jobId, videoId, bufferStart, bufferEnd, outputFile, clients }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
      '--download-sections', `*${bufferStart}-${bufferEnd}`,
      '--force-keyframes-at-cuts',
      '-o', outputFile,
      '--no-playlist',
      '--verbose',  // Enable verbose logging to see POT server interactions
      '--sleep-requests', '0.5',
      '--extractor-retries', '3',
      '--retry-sleep', 'extractor:2',
      '--no-check-certificates',
      '--geo-bypass',
      '--merge-output-format', 'mp4',
      '--socket-timeout', '30',
      '--retries', '2',
      '--fragment-retries', '2',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

    // CRITICAL: Configure POT (Proof of Origin Token) provider
    // The POT server runs on localhost:4416 and generates tokens to bypass YouTube's bot detection
    // See: https://github.com/Brainicism/bgutil-ytdlp-pot-provider
    let extractorArgs = 'youtube:getpot_bgutil_baseurl=http://127.0.0.1:4416';

    // Add client configuration unless using default
    if (clients !== 'default') {
      extractorArgs += `;player_client=${clients}`;
    }

    args.push('--extractor-args', extractorArgs);

    // Add video URL
    args.push(`https://www.youtube.com/watch?v=${videoId}`);

    const ytdlpProc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';

    ytdlpProc.stdout.on('data', (data) => {
      stdout += data.toString();
      const line = data.toString().trim();
      if (line.includes('[download]') || line.includes('Downloading')) {
        console.log(`[${jobId}] yt-dlp: ${line}`);
      }
    });

    ytdlpProc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytdlpProc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputFile)) {
        const stats = fs.statSync(outputFile);
        if (stats.size > 10000) { // At least 10KB
          console.log(`[${jobId}] yt-dlp success: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
          resolve(outputFile);
        } else {
          reject(new Error('Downloaded file too small'));
        }
      } else {
        // Parse error type
        let errorType = 'unknown';
        if (stderr.includes('Sign in to confirm') || stderr.includes('bot')) {
          errorType = 'bot_detection';
        } else if (stderr.includes('403')) {
          errorType = 'forbidden';
        } else if (stderr.includes('private')) {
          errorType = 'private';
        } else if (stderr.includes('age-restricted')) {
          errorType = 'age_restricted';
        } else if (stderr.includes('unavailable')) {
          errorType = 'unavailable';
        }

        reject(new Error(`yt-dlp failed (${errorType}): ${stderr.slice(-150)}`));
      }
    });

    ytdlpProc.on('error', (error) => {
      reject(new Error(`yt-dlp spawn error: ${error.message}`));
    });
  });
}

/**
 * Download using Video Download API (video-download-api.com)
 * Reliable third-party service with ~99% uptime, supports time segments
 * This is a PAID service - set VIDEO_DOWNLOAD_API_KEY environment variable
 */
async function downloadWithVideoDownloadAPI({ jobId, videoId, startTime, endTime, workDir, outputFile }) {
  if (!VIDEO_DOWNLOAD_API_KEY) {
    throw new Error('VIDEO_DOWNLOAD_API_KEY not configured');
  }

  console.log(`[${jobId}] Trying Video Download API (reliable third-party)...`);

  try {
    // Request video download with time segment
    const response = await fetch(`${VIDEO_DOWNLOAD_API_URL}/v1/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VIDEO_DOWNLOAD_API_KEY}`
      },
      body: JSON.stringify({
        url: `https://www.youtube.com/watch?v=${videoId}`,
        format: 'mp4',
        quality: '1080',
        start_time: Math.max(0, startTime - 1),
        end_time: endTime + 1
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    if (!data.download_url) {
      throw new Error('No download URL in response');
    }

    console.log(`[${jobId}] Video Download API returned URL, downloading...`);

    // Download the file
    const downloadResponse = await fetch(data.download_url);
    if (!downloadResponse.ok) {
      throw new Error(`Download failed: ${downloadResponse.status}`);
    }

    const buffer = await downloadResponse.arrayBuffer();
    fs.writeFileSync(outputFile, Buffer.from(buffer));

    const stats = fs.statSync(outputFile);
    console.log(`[${jobId}] Video Download API complete: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    return outputFile;

  } catch (error) {
    console.error(`[${jobId}] Video Download API failed:`, error.message);
    throw error;
  }
}

/**
 * Fallback download using Cobalt API (cobalt.tools)
 * NOTE: Cobalt YouTube support is currently BROKEN as of late 2024
 * See: https://github.com/imputnet/cobalt - "YouTube will not be available until further notice"
 */
async function downloadWithCobalt({ jobId, videoId, workDir, outputFile }) {
  console.log(`[${jobId}] Trying Cobalt API fallback (may be broken for YouTube)...`);

  try {
    // Try multiple Cobalt instances
    const cobaltInstances = [
      process.env.COBALT_API_URL,
      'https://api.cobalt.tools',
      'https://cobalt-api.kwiatekmiki.com'
    ].filter(Boolean);

    let lastError = null;
    let result = null;

    for (const cobaltUrl of cobaltInstances) {
      try {
        console.log(`[${jobId}] Trying Cobalt instance: ${cobaltUrl}`);

        const response = await fetch(cobaltUrl, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: `https://www.youtube.com/watch?v=${videoId}`,
            videoQuality: '1080',
            youtubeVideoCodec: 'h264',
            filenameStyle: 'basic'
          })
        });

        if (response.ok) {
          result = await response.json();
          if (result.status !== 'error' && result.url) {
            console.log(`[${jobId}] Cobalt instance ${cobaltUrl} returned download URL`);
            break;
          }
        }
        lastError = new Error(`Cobalt ${cobaltUrl} failed: ${response.status}`);
      } catch (instanceError) {
        lastError = instanceError;
        console.log(`[${jobId}] Cobalt instance ${cobaltUrl} failed: ${instanceError.message}`);
      }
    }

    if (!result || result.status === 'error') {
      throw lastError || new Error('All Cobalt instances failed');
    }

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
  } catch (error) {
    console.error(`[${jobId}] Cobalt fallback failed:`, error.message);
    throw error;
  }
}

/**
 * Fallback download using Invidious API
 * Invidious is an open-source YouTube frontend with download capabilities
 */
async function downloadWithInvidious({ jobId, videoId, workDir, outputFile }) {
  console.log(`[${jobId}] Trying Invidious API fallback...`);

  // List of public Invidious instances
  const invidiousInstances = [
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://invidious.private.coffee',
    'https://invidious.protokolla.fi',
    'https://iv.datura.network'
  ];

  for (const instance of invidiousInstances) {
    try {
      console.log(`[${jobId}] Trying Invidious instance: ${instance}`);

      // Get video info from Invidious
      const infoResponse = await fetch(`${instance}/api/v1/videos/${videoId}`, {
        headers: { 'Accept': 'application/json' }
      });

      if (!infoResponse.ok) continue;

      const videoInfo = await infoResponse.json();

      // Find best format (prefer 720p or 1080p mp4)
      const formats = videoInfo.adaptiveFormats || videoInfo.formatStreams || [];
      const videoFormat = formats
        .filter(f => f.type?.includes('video/mp4') || f.container === 'mp4')
        .filter(f => {
          const quality = parseInt(f.qualityLabel) || parseInt(f.quality) || 0;
          return quality <= 1080;
        })
        .sort((a, b) => {
          const qualA = parseInt(a.qualityLabel) || parseInt(a.quality) || 0;
          const qualB = parseInt(b.qualityLabel) || parseInt(b.quality) || 0;
          return qualB - qualA;
        })[0];

      if (!videoFormat || !videoFormat.url) continue;

      console.log(`[${jobId}] Found format: ${videoFormat.qualityLabel || videoFormat.quality}`);

      // Download using FFmpeg
      return new Promise((resolve, reject) => {
        const ffmpegArgs = [
          '-i', videoFormat.url,
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
            console.log(`[${jobId}] Invidious download complete`);
            resolve(outputFile);
          } else {
            reject(new Error(`Invidious FFmpeg failed: ${stderr.slice(-200)}`));
          }
        });

        ffmpegProc.on('error', (error) => {
          reject(new Error(`Invidious FFmpeg error: ${error.message}`));
        });
      });
    } catch (instanceError) {
      console.log(`[${jobId}] Invidious instance ${instance} failed: ${instanceError.message}`);
    }
  }

  throw new Error('All Invidious instances failed');
}

/**
 * Fallback download using Piped API
 * Piped is another open-source YouTube frontend
 */
async function downloadWithPiped({ jobId, videoId, workDir, outputFile }) {
  console.log(`[${jobId}] Trying Piped API fallback...`);

  // List of public Piped instances
  const pipedInstances = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://api.piped.privacydev.net',
    'https://pipedapi.in.projectsegfau.lt'
  ];

  for (const instance of pipedInstances) {
    try {
      console.log(`[${jobId}] Trying Piped instance: ${instance}`);

      // Get streams from Piped
      const streamsResponse = await fetch(`${instance}/streams/${videoId}`, {
        headers: { 'Accept': 'application/json' }
      });

      if (!streamsResponse.ok) continue;

      const streams = await streamsResponse.json();

      // Find best video stream
      const videoStreams = streams.videoStreams || [];
      const videoStream = videoStreams
        .filter(s => s.format === 'MPEG_4' || s.mimeType?.includes('video/mp4'))
        .filter(s => {
          const height = parseInt(s.quality) || s.height || 0;
          return height <= 1080;
        })
        .sort((a, b) => {
          const qualA = parseInt(a.quality) || a.height || 0;
          const qualB = parseInt(b.quality) || b.height || 0;
          return qualB - qualA;
        })[0];

      if (!videoStream || !videoStream.url) continue;

      console.log(`[${jobId}] Found Piped stream: ${videoStream.quality}`);

      // Download using FFmpeg
      return new Promise((resolve, reject) => {
        const ffmpegArgs = [
          '-i', videoStream.url,
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
            console.log(`[${jobId}] Piped download complete`);
            resolve(outputFile);
          } else {
            reject(new Error(`Piped FFmpeg failed: ${stderr.slice(-200)}`));
          }
        });

        ffmpegProc.on('error', (error) => {
          reject(new Error(`Piped FFmpeg error: ${error.message}`));
        });
      });
    } catch (instanceError) {
      console.log(`[${jobId}] Piped instance ${instance} failed: ${instanceError.message}`);
    }
  }

  throw new Error('All Piped instances failed');
}

/**
 * Tier-2 Download: SaveFrom-style extraction (direct video page parsing)
 * Uses YouTube's own player API to extract stream URLs
 */
async function downloadWithDirectExtraction({ jobId, videoId, workDir, outputFile }) {
  console.log(`[${jobId}] Trying direct extraction method...`);

  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];

  for (const userAgent of userAgents) {
    try {
      console.log(`[${jobId}] Trying with user agent: ${userAgent.substring(0, 50)}...`);

      // Fetch the video page
      const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive'
        }
      });

      if (!response.ok) continue;

      const html = await response.text();

      // Extract player response from page
      const playerMatch = html.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/s);
      if (!playerMatch) {
        console.log(`[${jobId}] No player response found in page`);
        continue;
      }

      let playerResponse;
      try {
        playerResponse = JSON.parse(playerMatch[1]);
      } catch (e) {
        console.log(`[${jobId}] Failed to parse player response`);
        continue;
      }

      // Check if video is playable
      const status = playerResponse.playabilityStatus?.status;
      if (status !== 'OK') {
        console.log(`[${jobId}] Video not playable: ${status}`);
        continue;
      }

      // Get streaming data
      const streamingData = playerResponse.streamingData;
      if (!streamingData) {
        console.log(`[${jobId}] No streaming data found`);
        continue;
      }

      // Find best format
      const formats = [...(streamingData.formats || []), ...(streamingData.adaptiveFormats || [])];

      // Prefer combined format (video+audio) for simplicity
      let bestFormat = formats
        .filter(f => f.url && f.mimeType?.includes('video/mp4'))
        .filter(f => f.height && f.height <= 1080)
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

      if (!bestFormat) {
        // Try adaptive formats separately
        const videoFormat = formats
          .filter(f => f.url && f.mimeType?.includes('video/mp4') && !f.audioQuality)
          .filter(f => f.height && f.height <= 1080)
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

        if (videoFormat) {
          bestFormat = videoFormat;
        }
      }

      if (!bestFormat || !bestFormat.url) {
        console.log(`[${jobId}] No suitable format with URL found`);
        continue;
      }

      console.log(`[${jobId}] Found format: ${bestFormat.qualityLabel || bestFormat.height + 'p'}`);

      // Download with FFmpeg
      return new Promise((resolve, reject) => {
        const ffmpegArgs = [
          '-user_agent', userAgent,
          '-i', bestFormat.url,
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
            console.log(`[${jobId}] Direct extraction download complete`);
            resolve(outputFile);
          } else {
            reject(new Error(`Direct extraction FFmpeg failed: ${stderr.slice(-200)}`));
          }
        });

        ffmpegProc.on('error', (error) => {
          reject(new Error(`Direct extraction FFmpeg error: ${error.message}`));
        });
      });
    } catch (error) {
      console.log(`[${jobId}] Direct extraction attempt failed: ${error.message}`);
    }
  }

  throw new Error('All direct extraction attempts failed');
}

/**
 * Tier-2 Download: Using AllTube/SSYouTube style APIs
 */
async function downloadWithAlternativeAPIs({ jobId, videoId, workDir, outputFile }) {
  console.log(`[${jobId}] Trying alternative download APIs...`);

  // List of alternative YouTube download APIs
  const alternativeAPIs = [
    {
      name: 'loader.to',
      getUrl: async (vid) => {
        const res = await fetch(`https://api.loader.to/youtube-dl/api?url=https://www.youtube.com/watch?v=${vid}&f=mp4`, {
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();
        return data?.downloadLink || data?.link;
      }
    },
    {
      name: 'onlinevideoconverter',
      getUrl: async (vid) => {
        const res = await fetch(`https://api.onlinevideoconverter.pro/api/convert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${vid}` })
        });
        const data = await res.json();
        return data?.downloadUrl || data?.url;
      }
    },
    {
      name: 'yt5s',
      getUrl: async (vid) => {
        const res = await fetch(`https://yt5s.biz/api/ajaxSearch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `q=https://www.youtube.com/watch?v=${vid}&vt=mp4`
        });
        const data = await res.json();
        if (data?.links?.mp4) {
          const formats = Object.values(data.links.mp4);
          const best = formats.find(f => f.q === '720p' || f.q === '1080p') || formats[0];
          return best?.url;
        }
        return null;
      }
    }
  ];

  for (const api of alternativeAPIs) {
    try {
      console.log(`[${jobId}] Trying ${api.name}...`);
      const downloadUrl = await api.getUrl(videoId);

      if (!downloadUrl) {
        console.log(`[${jobId}] ${api.name} returned no URL`);
        continue;
      }

      console.log(`[${jobId}] ${api.name} provided download URL`);

      // Download with FFmpeg
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
            console.log(`[${jobId}] ${api.name} download complete`);
            resolve(outputFile);
          } else {
            reject(new Error(`${api.name} FFmpeg failed: ${stderr.slice(-200)}`));
          }
        });

        ffmpegProc.on('error', (error) => {
          reject(new Error(`${api.name} FFmpeg error: ${error.message}`));
        });
      });
    } catch (error) {
      console.log(`[${jobId}] ${api.name} failed: ${error.message}`);
    }
  }

  throw new Error('All alternative APIs failed');
}

/**
 * Tier-2 Download: Google Video Cache (experimental)
 * Sometimes YouTube videos are cached on Google's video servers
 */
async function downloadFromGoogleCache({ jobId, videoId, workDir, outputFile }) {
  console.log(`[${jobId}] Trying Google video cache...`);

  // Try various Google video cache patterns
  const cachePatterns = [
    `https://redirector.googlevideo.com/videoplayback?id=${videoId}`,
    `https://r1---sn-n4v7sn76.googlevideo.com/videoplayback?id=${videoId}`
  ];

  // This is a fallback that usually doesn't work, but worth trying
  console.log(`[${jobId}] Google cache method skipped (requires specific server info)`);
  throw new Error('Google cache not available for this video');
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
