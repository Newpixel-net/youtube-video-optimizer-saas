/**
 * YouTube Video Downloader with RapidAPI (YT-API) + youtubei.js fallback
 * Priority: RapidAPI YT-API (paid, reliable) > youtubei.js > yt-dlp > other fallbacks
 */

import { Innertube, ClientType } from 'youtubei.js';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// RapidAPI YT-API configuration - set via environment variable
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_HOST = 'yt-api.p.rapidapi.com';

// Cache for Innertube instances per client type
const innertubeCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

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

    // Step 2: Download the video file with streaming to handle large files
    const videoResponse = await fetch(downloadUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!videoResponse.ok) {
      throw new Error(`Video download failed: ${videoResponse.status} ${videoResponse.statusText}`);
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

  // Method 1: Try RapidAPI first (most reliable paid option)
  if (RAPIDAPI_KEY) {
    try {
      const rapidApiOutput = path.join(workDir, 'rapidapi_source.mp4');
      await downloadWithRapidAPI({ jobId, videoId, workDir, outputFile: rapidApiOutput });

      // RapidAPI downloads full video, so we need to trim to the segment
      console.log(`[${jobId}] Trimming RapidAPI download to segment...`);
      return await trimVideoSegment({ jobId, inputFile: rapidApiOutput, outputFile, startTime, endTime });
    } catch (rapidApiError) {
      console.log(`[${jobId}] RapidAPI failed: ${rapidApiError.message}, trying other methods...`);
    }
  } else {
    console.log(`[${jobId}] RapidAPI key not configured, skipping paid download`);
  }

  // Log if we have YouTube authentication
  if (youtubeAuth?.accessToken) {
    console.log(`[${jobId}] Using authenticated YouTube session`);
  } else {
    console.log(`[${jobId}] No YouTube auth - using unauthenticated mode`);
  }

  try {
    // Method 2: Try youtubei.js with multiple clients (pass auth if available)
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
        console.log(`[${jobId}] Cobalt failed, trying Invidious...`);

        try {
          // Invidious downloads full video, we'll trim it
          const invidiousOutput = path.join(workDir, 'invidious_source.mp4');
          await downloadWithInvidious({ jobId, videoId, workDir, outputFile: invidiousOutput });

          // Trim to desired segment
          console.log(`[${jobId}] Trimming Invidious download to segment...`);
          return await trimVideoSegment({ jobId, inputFile: invidiousOutput, outputFile, startTime, endTime });
        } catch (invidiousError) {
          console.log(`[${jobId}] Invidious failed, trying Piped...`);

          try {
            // Piped downloads full video, we'll trim it
            const pipedOutput = path.join(workDir, 'piped_source.mp4');
            await downloadWithPiped({ jobId, videoId, workDir, outputFile: pipedOutput });

            // Trim to desired segment
            console.log(`[${jobId}] Trimming Piped download to segment...`);
            return await trimVideoSegment({ jobId, inputFile: pipedOutput, outputFile, startTime, endTime });
          } catch (pipedError) {
            console.log(`[${jobId}] Piped failed, trying direct extraction...`);

            try {
              // Direct page parsing method
              const directOutput = path.join(workDir, 'direct_source.mp4');
              await downloadWithDirectExtraction({ jobId, videoId, workDir, outputFile: directOutput });

              // Trim to desired segment
              console.log(`[${jobId}] Trimming direct extraction download to segment...`);
              return await trimVideoSegment({ jobId, inputFile: directOutput, outputFile, startTime, endTime });
            } catch (directError) {
              console.log(`[${jobId}] Direct extraction failed, trying alternative APIs...`);

              try {
                // Alternative download APIs (Tier-2)
                const altOutput = path.join(workDir, 'alt_source.mp4');
                await downloadWithAlternativeAPIs({ jobId, videoId, workDir, outputFile: altOutput });

                // Trim to desired segment
                console.log(`[${jobId}] Trimming alternative API download to segment...`);
                return await trimVideoSegment({ jobId, inputFile: altOutput, outputFile, startTime, endTime });
              } catch (altError) {
                console.error(`[${jobId}] All download methods failed (8 methods tried)`);
                // Return a more helpful error message
                const errorMsg = ytdlpError.message.includes('Sign in to confirm')
                  ? 'YouTube requires authentication. Please ensure your YouTube account is connected and try again. If the issue persists, the video may have restrictions.'
                  : `Video download failed after trying 8 methods (RapidAPI, youtubei.js, yt-dlp, Cobalt, Invidious, Piped, Direct, AltAPIs). The video may be age-restricted, private, or geo-blocked. Consider uploading the video directly.`;
                throw new Error(errorMsg);
              }
            }
          }
        }
      }
    }
  }
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
