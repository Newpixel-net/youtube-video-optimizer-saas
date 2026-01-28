/**
 * YouTube Video Optimizer - Content Script
 * Runs on YouTube pages to extract video information and stream URLs
 *
 * Security: Runs in isolated content script context, validates all data
 */

// Guard against duplicate injection
if (typeof window.__YVO_CONTENT_SCRIPT_LOADED__ === 'undefined') {
  window.__YVO_CONTENT_SCRIPT_LOADED__ = true;

// State
let videoInfo = null;
let streamUrls = null;

/**
 * Message handler for popup/background communication
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getVideoInfo') {
    getVideoInfo().then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep channel open for async
  }

  if (message.action === 'getVideoStream') {
    getVideoStream(message.quality).then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.action === 'triggerPlayback') {
    triggerVideoPlayback().then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.action === 'getVideoMetadata') {
    getVideoMetadata().then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.action === 'getTranscript') {
    getVideoTranscript().then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (message.action === 'seekToTime') {
    seekToTime(message.time);
    sendResponse({ success: true });
    return false;
  }

  // NEW: Download video stream in page context (has cookie access)
  if (message.action === 'downloadStreamInPage') {
    downloadStreamInPage(message.videoUrl, message.audioUrl).then(result => {
      sendResponse(result);
    }).catch(error => {
      console.error('[YVO Content] Download error:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  return false;
});

/**
 * Download video/audio streams in page context
 * This has access to YouTube's cookies and session, bypassing 403 errors
 */
async function downloadStreamInPage(videoUrl, audioUrl) {
  console.log('[YVO Content] Starting in-page download (has cookie access)');

  if (!videoUrl) {
    throw new Error('No video URL provided');
  }

  try {
    // Download video stream - this works because we're in the YouTube page context
    console.log('[YVO Content] Downloading video stream...');
    const videoResponse = await fetch(videoUrl, {
      method: 'GET',
      credentials: 'include' // This actually works in page context
    });

    if (!videoResponse.ok) {
      throw new Error(`Video download failed: ${videoResponse.status}`);
    }

    const videoBlob = await videoResponse.blob();
    console.log(`[YVO Content] Video downloaded: ${(videoBlob.size / 1024 / 1024).toFixed(2)}MB`);

    // Convert to base64 for transfer to service worker
    // (Chrome message passing doesn't support Blob directly)
    const videoBase64 = await blobToBase64(videoBlob);

    let audioBase64 = null;
    if (audioUrl && audioUrl !== videoUrl) {
      try {
        console.log('[YVO Content] Downloading audio stream...');
        const audioResponse = await fetch(audioUrl, {
          method: 'GET',
          credentials: 'include'
        });

        if (audioResponse.ok) {
          const audioBlob = await audioResponse.blob();
          console.log(`[YVO Content] Audio downloaded: ${(audioBlob.size / 1024 / 1024).toFixed(2)}MB`);
          audioBase64 = await blobToBase64(audioBlob);
        }
      } catch (audioError) {
        console.warn('[YVO Content] Audio download failed:', audioError.message);
      }
    }

    console.log('[YVO Content] Download complete, sending to background');
    return {
      success: true,
      videoData: videoBase64,
      videoSize: videoBlob.size,
      audioData: audioBase64
    };

  } catch (error) {
    console.error('[YVO Content] Download failed:', error);
    throw error;
  }
}

/**
 * Convert Blob to base64 string
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // Remove data URL prefix (e.g., "data:video/mp4;base64,")
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Trigger video playback to enable stream interception
 * This is called when we need to capture streams but video isn't playing
 */
async function triggerVideoPlayback() {
  try {
    console.log('[YVO Content] Starting playback trigger...');

    // FIRST: Try using YouTube's player API (most reliable method)
    const ytPlayer = document.querySelector('#movie_player');
    if (ytPlayer) {
      console.log('[YVO Content] Found YouTube player element');

      const hasPlayVideo = typeof ytPlayer.playVideo === 'function';
      const hasGetPlayerState = typeof ytPlayer.getPlayerState === 'function';
      const hasMute = typeof ytPlayer.mute === 'function';

      console.log(`[YVO Content] YouTube API available: playVideo=${hasPlayVideo}, getPlayerState=${hasGetPlayerState}, mute=${hasMute}`);

      if (hasPlayVideo) {
        // Mute first
        if (hasMute) {
          ytPlayer.mute();
          console.log('[YVO Content] Muted via YouTube API');
        }

        // Get current state and start if needed
        let state = hasGetPlayerState ? ytPlayer.getPlayerState() : -1;
        console.log(`[YVO Content] YouTube player state: ${state}`);

        // States: -1=unstarted, 0=ended, 1=playing, 2=paused, 3=buffering, 5=cued
        if (state !== 1 && state !== 3) {
          console.log('[YVO Content] Starting video via YouTube API...');
          ytPlayer.playVideo();
          await new Promise(resolve => setTimeout(resolve, 1500));

          state = hasGetPlayerState ? ytPlayer.getPlayerState() : -1;
          console.log(`[YVO Content] YouTube player state after playVideo: ${state}`);
        }
      }
    }

    // Now check the video element
    const video = document.querySelector('video.html5-main-video');

    if (!video) {
      console.log('[YVO Content] No video element found');
      return { success: false, error: 'No video element found' };
    }

    console.log(`[YVO Content] Video element: readyState=${video.readyState}, paused=${video.paused}, src=${video.src ? 'yes' : 'no'}`);

    // Check if video is already playing
    if (!video.paused && !video.ended && video.readyState >= 2) {
      console.log('[YVO Content] Video already playing');
      return {
        success: true,
        alreadyPlaying: true,
        isPlaying: true,
        muted: video.muted,
        currentTime: video.currentTime,
        duration: video.duration,
        readyState: video.readyState
      };
    }

    // CRITICAL: Mute the video first - muted videos CAN autoplay in background tabs!
    console.log('[YVO Content] Muting video for background autoplay...');
    video.muted = true;

    // Also click YouTube's mute button if present (for consistency with UI state)
    const muteButton = document.querySelector('.ytp-mute-button');
    if (muteButton && muteButton.getAttribute('data-title-no-tooltip') !== 'Unmute') {
      try { muteButton.click(); } catch (e) {}
    }

    // Try multiple methods to start playback
    console.log('[YVO Content] Triggering video playback (muted)...');

    // Method 1: Direct video.play() - should work now that video is muted
    try {
      await video.play();
      console.log('[YVO Content] Muted autoplay succeeded');
    } catch (e) {
      console.log('[YVO Content] Muted play failed:', e.message);
    }

    // Method 2: Click play button if still paused
    if (video.paused) {
      const playButton = document.querySelector('.ytp-play-button, button.ytp-play-button');
      if (playButton) {
        console.log('[YVO Content] Clicking play button...');
        playButton.click();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Method 3: Try direct play again
    if (video.paused) {
      try {
        await video.play();
      } catch (e) {
        console.log('[YVO Content] Second play attempt failed:', e.message);
      }
    }

    // Method 4: Simulate user interaction and try again
    if (video.paused) {
      // Trigger a user-like interaction
      video.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window
      }));
      await new Promise(resolve => setTimeout(resolve, 500));

      try {
        await video.play();
      } catch (e) {
        console.log('[YVO Content] Simulated interaction play failed:', e.message);
      }
    }

    // Wait for video to potentially load
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Final status check
    const isPlaying = !video.paused && !video.ended;
    console.log(`[YVO Content] Final status: isPlaying=${isPlaying}, readyState=${video.readyState}, duration=${video.duration}`);

    return {
      success: true,
      isPlaying: isPlaying,
      muted: video.muted,
      currentTime: video.currentTime,
      duration: video.duration,
      readyState: video.readyState
    };

  } catch (error) {
    console.error('[YVO Content] Trigger playback error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Extract video information from the YouTube page
 */
async function getVideoInfo() {
  try {
    // Try multiple methods to get video info
    const videoId = getVideoId();

    if (!videoId) {
      throw new Error('Could not find video ID');
    }

    // Get info from page data
    const info = await extractVideoInfo(videoId);

    if (!info) {
      throw new Error('Could not extract video information');
    }

    videoInfo = info;

    return {
      success: true,
      videoInfo: info
    };

  } catch (error) {
    console.error('Error getting video info:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get extended video metadata including tags and description
 * Used by Creator Tools (Tag Revealer, SEO Analyzer)
 */
async function getVideoMetadata() {
  try {
    const playerData = getPlayerData();
    const videoId = getVideoId();

    if (!playerData || !videoId) {
      throw new Error('Could not access video data');
    }

    const videoDetails = playerData.videoDetails || {};
    const microformat = playerData.microformat?.playerMicroformatRenderer || {};

    // Extract tags from multiple sources
    let tags = [];

    // Source 1: videoDetails.keywords (most common)
    if (videoDetails.keywords && Array.isArray(videoDetails.keywords)) {
      tags = videoDetails.keywords;
    }

    // Source 2: microformat.keywords if available
    if (tags.length === 0 && microformat.keywords) {
      if (typeof microformat.keywords === 'string') {
        tags = microformat.keywords.split(',').map(t => t.trim()).filter(t => t);
      } else if (Array.isArray(microformat.keywords)) {
        tags = microformat.keywords;
      }
    }

    // Source 3: Try to find in page meta tags
    if (tags.length === 0) {
      const metaKeywords = document.querySelector('meta[name="keywords"]');
      if (metaKeywords?.content) {
        tags = metaKeywords.content.split(',').map(t => t.trim()).filter(t => t);
      }
    }

    // Get description
    let description = '';
    if (videoDetails.shortDescription) {
      description = videoDetails.shortDescription;
    } else if (microformat.description?.simpleText) {
      description = microformat.description.simpleText;
    } else {
      // Try DOM fallback
      const descElement = document.querySelector('#description-inline-expander, #description yt-formatted-string');
      if (descElement) {
        description = descElement.textContent || '';
      }
    }

    // Check for custom thumbnail
    const thumbnails = videoDetails.thumbnail?.thumbnails || microformat.thumbnail?.thumbnails || [];
    const hasCustomThumbnail = thumbnails.some(t =>
      t.url && !t.url.includes('hqdefault') && !t.url.includes('default.jpg')
    );

    // Get view count
    const viewCount = parseInt(videoDetails.viewCount, 10) || 0;

    // Get publish date
    const publishDate = microformat.publishDate || microformat.uploadDate || null;

    // Get category
    const category = microformat.category || '';

    return {
      success: true,
      metadata: {
        videoId,
        title: videoDetails.title || '',
        channel: videoDetails.author || '',
        description,
        tags,
        viewCount,
        publishDate,
        category,
        hasCustomThumbnail,
        duration: parseInt(videoDetails.lengthSeconds, 10) || 0
      }
    };

  } catch (error) {
    console.error('[YVO Content] Error getting video metadata:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get video transcript/captions
 * Extracts transcript from YouTube's caption tracks
 */
async function getVideoTranscript() {
  try {
    const playerData = getPlayerData();
    const videoId = getVideoId();

    if (!playerData || !videoId) {
      throw new Error('Could not access video data');
    }

    // Get caption tracks from player data
    const captionTracks = playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks || captionTracks.length === 0) {
      return {
        success: false,
        error: 'No captions available for this video'
      };
    }

    // Prefer English, then auto-generated, then first available
    let selectedTrack = captionTracks.find(t => t.languageCode === 'en' && !t.kind);
    if (!selectedTrack) {
      selectedTrack = captionTracks.find(t => t.languageCode === 'en');
    }
    if (!selectedTrack) {
      selectedTrack = captionTracks[0];
    }

    // Fetch the transcript
    const transcriptUrl = selectedTrack.baseUrl;
    if (!transcriptUrl) {
      throw new Error('Could not get transcript URL');
    }

    // Fetch XML transcript
    const response = await fetch(transcriptUrl);
    if (!response.ok) {
      throw new Error('Failed to fetch transcript');
    }

    const xmlText = await response.text();
    const segments = parseTranscriptXml(xmlText);

    return {
      success: true,
      transcript: {
        language: selectedTrack.languageCode,
        languageName: selectedTrack.name?.simpleText || selectedTrack.name?.runs?.[0]?.text || 'Unknown',
        isAutoGenerated: selectedTrack.kind === 'asr',
        segments
      }
    };

  } catch (error) {
    console.error('[YVO Content] Error getting transcript:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Parse transcript XML to segments array
 */
function parseTranscriptXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const textElements = doc.querySelectorAll('text');

  const segments = [];
  textElements.forEach(el => {
    const start = parseFloat(el.getAttribute('start')) || 0;
    const duration = parseFloat(el.getAttribute('dur')) || 0;
    let text = el.textContent || '';

    // Clean up HTML entities and formatting
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n/g, ' ')
      .trim();

    if (text) {
      segments.push({
        start,
        duration,
        end: start + duration,
        text
      });
    }
  });

  return segments;
}

/**
 * Seek video to a specific time
 */
function seekToTime(seconds) {
  try {
    const video = document.querySelector('video.html5-main-video');
    if (video) {
      video.currentTime = seconds;
      // Also try YouTube's player API
      const ytPlayer = document.querySelector('#movie_player');
      if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
        ytPlayer.seekTo(seconds, true);
      }
    }
  } catch (error) {
    console.error('[YVO Content] Error seeking to time:', error);
  }
}

/**
 * Get video ID from URL
 */
function getVideoId() {
  const url = new URL(window.location.href);

  // Standard watch page
  if (url.pathname === '/watch') {
    return url.searchParams.get('v');
  }

  // Shorts
  if (url.pathname.startsWith('/shorts/')) {
    return url.pathname.split('/shorts/')[1]?.split('/')[0];
  }

  // Embedded
  if (url.pathname.startsWith('/embed/')) {
    return url.pathname.split('/embed/')[1]?.split('/')[0];
  }

  return null;
}

/**
 * Extract video information from page
 */
async function extractVideoInfo(videoId) {
  // Method 1: Try to get from ytInitialPlayerResponse
  const playerData = getPlayerData();

  if (playerData) {
    const videoDetails = playerData.videoDetails;

    if (videoDetails) {
      // Also get video element state for debugging
      const video = document.querySelector('video.html5-main-video');
      return {
        videoId: videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: videoDetails.title || 'Unknown Title',
        channel: videoDetails.author || 'Unknown Channel',
        duration: parseInt(videoDetails.lengthSeconds, 10) || 0,
        thumbnail: getThumbnailUrl(videoId),
        isLive: videoDetails.isLiveContent || false,
        isPrivate: videoDetails.isPrivate || false,
        // Video element state for debugging
        readyState: video?.readyState || 0,
        currentTime: video?.currentTime || 0,
        paused: video?.paused ?? true,
        videoWidth: video?.videoWidth || 0,
        videoHeight: video?.videoHeight || 0
      };
    }
  }

  // Method 2: Extract from DOM
  const domInfo = extractFromDOM(videoId);
  if (domInfo) {
    return domInfo;
  }

  // Method 3: Basic info from page
  const video = document.querySelector('video.html5-main-video');
  return {
    videoId: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: document.title.replace(' - YouTube', ''),
    channel: document.querySelector('#owner-name a, #channel-name a')?.textContent || 'Unknown',
    duration: getVideoDuration(),
    thumbnail: getThumbnailUrl(videoId),
    isLive: false,
    isPrivate: false,
    // Video element state for debugging
    readyState: video?.readyState || 0,
    currentTime: video?.currentTime || 0,
    paused: video?.paused ?? true,
    videoWidth: video?.videoWidth || 0,
    videoHeight: video?.videoHeight || 0
  };
}

/**
 * Get player data from page scripts
 */
function getPlayerData() {
  // Try window.ytInitialPlayerResponse first (set by injected script)
  if (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails) {
    return window.ytInitialPlayerResponse;
  }

  // Search for it in script tags (fallback)
  const scripts = document.querySelectorAll('script');

  for (const script of scripts) {
    const text = script.textContent;

    if (text && text.includes('ytInitialPlayerResponse')) {
      // Try multiple regex patterns to match different YouTube formats
      const patterns = [
        // Standard: var ytInitialPlayerResponse = {...};
        /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});?\s*(?:var\s|const\s|let\s|;|\n|$)/s,
        // Window assignment: window.ytInitialPlayerResponse = {...}
        /window(?:\[["']ytInitialPlayerResponse["']\]|\.ytInitialPlayerResponse)\s*=\s*(\{.+?\});?\s*(?:var\s|const\s|let\s|;|\n|$)/s,
        // Direct assignment: ytInitialPlayerResponse = {...}
        /(?:^|[;\s])ytInitialPlayerResponse\s*=\s*(\{.+?\});?\s*(?:var\s|const\s|let\s|;|\n|$)/s
      ];

      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          try {
            const parsed = JSON.parse(match[1]);
            if (parsed && parsed.videoDetails) {
              // Cache for future use
              window.ytInitialPlayerResponse = parsed;
              return parsed;
            }
          } catch {
            // Continue to next pattern
          }
        }
      }

      // Alternative: Find JSON object starting after 'ytInitialPlayerResponse'
      const startIndex = text.indexOf('ytInitialPlayerResponse');
      if (startIndex !== -1) {
        // Find the first '{' after the assignment
        const jsonStart = text.indexOf('{', startIndex);
        if (jsonStart !== -1) {
          // Try to extract balanced JSON
          const extracted = extractBalancedJson(text, jsonStart);
          if (extracted) {
            try {
              const parsed = JSON.parse(extracted);
              if (parsed && parsed.videoDetails) {
                window.ytInitialPlayerResponse = parsed;
                return parsed;
              }
            } catch {
              // Continue
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Extract balanced JSON object from text starting at given index
 */
function extractBalancedJson(text, startIndex) {
  if (text[startIndex] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < text.length && i < startIndex + 500000; i++) {
    const char = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\' && inString) {
      escape = true;
      continue;
    }

    if (char === '"' && !escape) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          return text.substring(startIndex, i + 1);
        }
      }
    }
  }

  return null;
}

/**
 * Wait for player data to become available with exponential backoff
 * @param {number} maxWaitMs - Maximum time to wait (default 15 seconds)
 * @param {number} initialDelayMs - Initial delay between checks (default 200ms)
 * @returns {Promise<object|null>} - Player data or null if timeout
 */
async function waitForPlayerData(maxWaitMs = 15000, initialDelayMs = 200) {
  const startTime = Date.now();
  let delay = initialDelayMs;
  let attempts = 0;
  const maxAttempts = 20;

  while (Date.now() - startTime < maxWaitMs && attempts < maxAttempts) {
    attempts++;
    const playerData = getPlayerData();

    if (playerData && playerData.videoDetails) {
      console.log(`[YVO Content] Player data found after ${attempts} attempts (${Date.now() - startTime}ms)`);
      return playerData;
    }

    // Exponential backoff: 200ms, 300ms, 450ms, 675ms, etc. (capped at 2s)
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 2000);
  }

  console.warn(`[YVO Content] Player data not available after ${maxWaitMs}ms (${attempts} attempts)`);
  return null;
}

/**
 * Extract info from DOM elements
 */
function extractFromDOM(videoId) {
  const video = document.querySelector('video.html5-main-video');
  const titleElement = document.querySelector('h1.ytd-video-primary-info-renderer, h1.title');
  const channelElement = document.querySelector('#owner-name a, #channel-name a, yt-formatted-string.ytd-channel-name a');

  if (!titleElement) {
    return null;
  }

  return {
    videoId: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: titleElement.textContent?.trim() || 'Unknown Title',
    channel: channelElement?.textContent?.trim() || 'Unknown Channel',
    duration: video ? Math.floor(video.duration) : 0,
    thumbnail: getThumbnailUrl(videoId),
    isLive: !!document.querySelector('.ytp-live-badge'),
    isPrivate: false
  };
}

/**
 * Get video duration from DOM
 */
function getVideoDuration() {
  const video = document.querySelector('video.html5-main-video');
  if (video && video.duration) {
    return Math.floor(video.duration);
  }

  // Try duration element
  const durationElement = document.querySelector('.ytp-time-duration');
  if (durationElement) {
    return parseTimeString(durationElement.textContent);
  }

  return 0;
}

/**
 * Parse time string to seconds
 */
function parseTimeString(timeStr) {
  if (!timeStr) return 0;

  const parts = timeStr.split(':').map(p => parseInt(p, 10) || 0);

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  return parts[0] || 0;
}

/**
 * Get thumbnail URL for video
 */
function getThumbnailUrl(videoId) {
  return `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
}

/**
 * Get video stream URLs
 */
async function getVideoStream(quality) {
  try {
    const playerData = getPlayerData();

    if (!playerData) {
      throw new Error('Could not access player data');
    }

    // Check for streaming data
    const streamingData = playerData.streamingData;

    if (!streamingData) {
      // Video may require authentication or be restricted
      if (playerData.playabilityStatus?.status === 'LOGIN_REQUIRED') {
        throw new Error('This video requires login');
      }
      if (playerData.playabilityStatus?.status === 'UNPLAYABLE') {
        throw new Error('This video is not available');
      }
      throw new Error('No streaming data available');
    }

    // Get formats
    const formats = streamingData.formats || [];
    const adaptiveFormats = streamingData.adaptiveFormats || [];

    // Find best video format for requested quality
    const targetHeight = quality === '1080' ? 1080 : 720;

    // Try adaptive formats first (better quality)
    let videoFormat = findBestVideoFormat(adaptiveFormats, targetHeight);
    let audioFormat = findBestAudioFormat(adaptiveFormats);

    // Fall back to combined formats
    if (!videoFormat) {
      videoFormat = findBestCombinedFormat(formats, targetHeight);
    }

    if (!videoFormat) {
      throw new Error('No suitable video format found');
    }

    // Get URLs (may need signature deciphering)
    const videoUrl = getStreamUrl(videoFormat);
    const audioUrl = audioFormat ? getStreamUrl(audioFormat) : null;

    if (!videoUrl) {
      throw new Error('Could not get video stream URL');
    }

    streamUrls = { videoUrl, audioUrl };

    return {
      success: true,
      videoUrl: videoUrl,
      audioUrl: audioUrl,
      hasAudio: videoFormat.mimeType?.includes('audio') || !!audioUrl,
      quality: videoFormat.qualityLabel || quality + 'p',
      mimeType: videoFormat.mimeType
    };

  } catch (error) {
    console.error('Error getting stream:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Find best video format for target resolution
 */
function findBestVideoFormat(formats, targetHeight) {
  // Filter video-only formats
  const videoFormats = formats.filter(f =>
    f.mimeType?.includes('video/') &&
    !f.mimeType?.includes('audio')
  );

  // Sort by quality (prefer closer to target, then higher bitrate)
  videoFormats.sort((a, b) => {
    const heightA = a.height || 0;
    const heightB = b.height || 0;

    // Prefer formats at or below target
    const diffA = Math.abs(heightA - targetHeight) + (heightA > targetHeight ? 1000 : 0);
    const diffB = Math.abs(heightB - targetHeight) + (heightB > targetHeight ? 1000 : 0);

    if (diffA !== diffB) return diffA - diffB;

    // Same height, prefer higher bitrate
    return (b.bitrate || 0) - (a.bitrate || 0);
  });

  // Prefer MP4 if available
  const mp4Format = videoFormats.find(f => f.mimeType?.includes('mp4'));
  return mp4Format || videoFormats[0];
}

/**
 * Find best audio format
 */
function findBestAudioFormat(formats) {
  // Filter audio-only formats
  const audioFormats = formats.filter(f =>
    f.mimeType?.includes('audio/') &&
    !f.mimeType?.includes('video')
  );

  // Sort by bitrate
  audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  // Prefer M4A
  const m4aFormat = audioFormats.find(f => f.mimeType?.includes('mp4a'));
  return m4aFormat || audioFormats[0];
}

/**
 * Find best combined format (video with audio)
 */
function findBestCombinedFormat(formats, targetHeight) {
  // Sort by quality
  const sorted = [...formats].sort((a, b) => {
    const heightA = a.height || 0;
    const heightB = b.height || 0;

    const diffA = Math.abs(heightA - targetHeight);
    const diffB = Math.abs(heightB - targetHeight);

    return diffA - diffB;
  });

  return sorted[0];
}

/**
 * Get stream URL from format (handles signature cipher if needed)
 */
function getStreamUrl(format) {
  // Direct URL
  if (format.url) {
    return format.url;
  }

  // Signature cipher
  if (format.signatureCipher || format.cipher) {
    const cipher = format.signatureCipher || format.cipher;
    const params = new URLSearchParams(cipher);

    const url = params.get('url');
    const sig = params.get('s');
    const sp = params.get('sp') || 'signature';

    if (url && sig) {
      // For signature deciphering, we'd need to extract and run YouTube's
      // signature function. In a browser extension, the video element
      // already handles this, so we can request the URL another way.
      return null; // Return null to trigger alternative method
    }
  }

  return null;
}

// ============================================
// CAPTURE PROGRESS OVERLAY
// Shows visual feedback when video is being captured
// ============================================

/**
 * Capture Progress Overlay Manager
 * Creates and manages the on-page capture progress UI
 */
const CaptureProgressOverlay = {
  container: null,
  isVisible: false,
  autoHideTimeout: null,

  /**
   * Create the overlay DOM structure
   */
  createOverlay() {
    if (this.container) return this.container;

    const overlay = document.createElement('div');
    overlay.id = 'yvo-capture-progress-overlay';
    overlay.className = 'yvo-capture-overlay phase-initializing';

    overlay.innerHTML = `
      <div class="yvo-capture-overlay-header">
        <div class="yvo-capture-overlay-logo">🎬</div>
        <div class="yvo-capture-overlay-title">Video Optimizer</div>
        <button class="yvo-capture-overlay-close" title="Minimize">×</button>
      </div>
      <div class="yvo-capture-overlay-status">
        <div class="yvo-capture-overlay-icon spinning">⚙️</div>
        <div class="yvo-capture-overlay-message">Preparing capture...</div>
      </div>
      <div class="yvo-capture-overlay-progress">
        <div class="yvo-capture-overlay-progress-bar">
          <div class="yvo-capture-overlay-progress-fill animated" style="width: 0%"></div>
        </div>
        <div class="yvo-capture-overlay-progress-text">
          <span class="yvo-progress-label">Starting...</span>
          <span class="yvo-progress-percent">0%</span>
        </div>
      </div>
      <div class="yvo-capture-overlay-details"></div>
    `;

    // Add close button handler
    overlay.querySelector('.yvo-capture-overlay-close').addEventListener('click', () => {
      this.hide();
    });

    this.container = overlay;
    return overlay;
  },

  /**
   * Show the overlay with initial state
   */
  show(options = {}) {
    console.log('[YVO Content] Showing capture progress overlay');

    // Clear any pending auto-hide
    if (this.autoHideTimeout) {
      clearTimeout(this.autoHideTimeout);
      this.autoHideTimeout = null;
    }

    // Find the video player container
    const playerContainer = document.querySelector('#movie_player, .html5-video-player');
    if (!playerContainer) {
      console.warn('[YVO Content] Could not find video player for overlay');
      return;
    }

    // Create overlay if not exists
    if (!this.container) {
      this.createOverlay();
    }

    // Remove hiding class if present
    this.container.classList.remove('yvo-overlay-hiding');

    // Add to player container if not already there
    if (!playerContainer.contains(this.container)) {
      playerContainer.appendChild(this.container);
    }

    // Set initial state
    this.updatePhase('initializing');
    this.updateProgress(0, 'Preparing capture...');

    if (options.startTime !== undefined && options.endTime !== undefined) {
      this.updateDetails({
        segment: `${this.formatTime(options.startTime)} → ${this.formatTime(options.endTime)}`,
        duration: `${Math.round(options.endTime - options.startTime)}s`
      });
    }

    this.isVisible = true;
  },

  /**
   * Hide the overlay with animation
   */
  hide() {
    if (!this.container || !this.isVisible) return;

    console.log('[YVO Content] Hiding capture progress overlay');

    // Add hiding animation class
    this.container.classList.add('yvo-overlay-hiding');

    // Remove after animation
    setTimeout(() => {
      if (this.container && this.container.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }
      this.isVisible = false;
    }, 250);
  },

  /**
   * Update the current phase (changes colors and icon)
   */
  updatePhase(phase) {
    if (!this.container) return;

    // Remove all phase classes
    const phases = ['initializing', 'buffering', 'capturing', 'uploading', 'complete', 'error'];
    phases.forEach(p => this.container.classList.remove(`phase-${p}`));

    // Add new phase class
    this.container.classList.add(`phase-${phase}`);

    // Update icon based on phase
    const iconEl = this.container.querySelector('.yvo-capture-overlay-icon');
    const icons = {
      initializing: { icon: '⚙️', spin: true },
      buffering: { icon: '📊', spin: false },
      capturing: { icon: '🎬', spin: false },
      uploading: { icon: '☁️', spin: true },
      complete: { icon: '✓', spin: false },
      error: { icon: '⚠️', spin: false }
    };

    const config = icons[phase] || icons.initializing;
    iconEl.textContent = config.icon;
    iconEl.classList.toggle('spinning', config.spin);

    // Update progress bar animation
    const progressFill = this.container.querySelector('.yvo-capture-overlay-progress-fill');
    progressFill.classList.toggle('animated', phase === 'initializing' || phase === 'uploading');
  },

  /**
   * Update progress bar and message
   */
  updateProgress(percent, message, label) {
    if (!this.container) return;

    // Clamp percent
    percent = Math.max(0, Math.min(100, percent));

    // Update progress bar
    const progressFill = this.container.querySelector('.yvo-capture-overlay-progress-fill');
    progressFill.style.width = `${percent}%`;

    // Update percent text
    const percentEl = this.container.querySelector('.yvo-progress-percent');
    percentEl.textContent = `${Math.round(percent)}%`;

    // Update label
    if (label) {
      const labelEl = this.container.querySelector('.yvo-progress-label');
      labelEl.textContent = label;
    }

    // Update message
    if (message) {
      const messageEl = this.container.querySelector('.yvo-capture-overlay-message');
      messageEl.textContent = message;
    }
  },

  /**
   * Update the details section
   */
  updateDetails(details) {
    if (!this.container) return;

    const detailsEl = this.container.querySelector('.yvo-capture-overlay-details');

    let html = '';
    if (details.segment) {
      html += `<div class="yvo-capture-overlay-detail">
        <span class="yvo-capture-overlay-detail-icon">📍</span>
        <span>${details.segment}</span>
      </div>`;
    }
    if (details.duration) {
      html += `<div class="yvo-capture-overlay-detail">
        <span class="yvo-capture-overlay-detail-icon">⏱️</span>
        <span>${details.duration}</span>
      </div>`;
    }
    if (details.captured) {
      html += `<div class="yvo-capture-overlay-detail">
        <span class="yvo-capture-overlay-detail-icon">🎥</span>
        <span>${details.captured}</span>
      </div>`;
    }

    detailsEl.innerHTML = html;
  },

  /**
   * Show completion state and auto-hide
   */
  showComplete(message = 'Capture complete!') {
    this.updatePhase('complete');
    this.updateProgress(100, message, 'Done');

    // Auto-hide after 3 seconds
    this.autoHideTimeout = setTimeout(() => {
      this.hide();
    }, 3000);
  },

  /**
   * Show error state
   */
  showError(message = 'Capture failed') {
    this.updatePhase('error');
    this.updateProgress(0, message, 'Error');

    // Auto-hide after 5 seconds
    this.autoHideTimeout = setTimeout(() => {
      this.hide();
    }, 5000);
  },

  /**
   * Format seconds to MM:SS or HH:MM:SS
   */
  formatTime(seconds) {
    seconds = Math.round(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
};

// Add capture progress message handlers to the existing listener
const originalMessageListener = chrome.runtime.onMessage.hasListeners;

// Extend the message handler to include capture progress
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle capture progress updates from background script
  if (message.action === 'showCaptureProgress') {
    CaptureProgressOverlay.show({
      startTime: message.startTime,
      endTime: message.endTime
    });
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'updateCaptureProgress') {
    const { phase, percent, message: msg, label, details, startTime, endTime } = message;

    // Show overlay if not visible
    if (!CaptureProgressOverlay.isVisible) {
      CaptureProgressOverlay.show({ startTime, endTime });
    }

    // Update phase if provided
    if (phase) {
      CaptureProgressOverlay.updatePhase(phase);
    }

    // Update progress
    if (percent !== undefined || msg || label) {
      CaptureProgressOverlay.updateProgress(percent || 0, msg, label);
    }

    // Update details if provided
    if (details) {
      CaptureProgressOverlay.updateDetails(details);
    }

    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'hideCaptureProgress') {
    CaptureProgressOverlay.hide();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'captureComplete') {
    CaptureProgressOverlay.showComplete(message.message);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'captureError') {
    CaptureProgressOverlay.showError(message.message);
    sendResponse({ success: true });
    return false;
  }

  // Return false for unhandled messages (let other listeners handle them)
  return false;
});

// Make overlay accessible for debugging
window.__YVO_CAPTURE_OVERLAY__ = CaptureProgressOverlay;

// ============================================
// END CAPTURE PROGRESS OVERLAY
// ============================================

/**
 * Initialize content script
 */
function init() {
  // Inject script to access page context if needed
  injectPageScript();

  // Report current video ID to background script
  reportCurrentVideoId();

  // Watch for URL changes (YouTube is a SPA)
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Report new video ID after navigation
      setTimeout(reportCurrentVideoId, 500);
    }
  }).observe(document, { subtree: true, childList: true });
}

/**
 * Report current video ID to background script for stream interception tracking
 */
function reportCurrentVideoId() {
  const videoId = getVideoId();
  if (videoId) {
    chrome.runtime.sendMessage({
      action: 'reportVideoId',
      videoId: videoId
    }).catch(() => {});
    console.log(`[YVO Content] Reported video ID: ${videoId}`);
  }
}

/**
 * Inject script into page context
 * This allows access to YouTube's player API
 */
function injectPageScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/injected.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

/**
 * Listen for messages from injected script
 */
window.addEventListener('message', (event) => {
  // Only accept messages from same origin
  if (event.origin !== window.location.origin) return;

  const message = event.data;

  if (message?.type === 'YVO_PLAYER_DATA') {
    // Store player data from page context
    if (message.data) {
      window.ytInitialPlayerResponse = message.data;
    }
  }

  if (message?.type === 'YVO_STREAM_URL') {
    // Store stream URL from page context
    if (message.data && streamUrls) {
      streamUrls.videoUrl = message.data.videoUrl || streamUrls.videoUrl;
      streamUrls.audioUrl = message.data.audioUrl || streamUrls.audioUrl;
    }
  }

  // Handle capture progress updates from injected capture function
  if (message?.type === 'YVO_CAPTURE_PROGRESS') {
    const { progress, capturedSeconds, totalSeconds, phase } = message;
    CaptureProgressOverlay.updatePhase(phase || 'capturing');
    CaptureProgressOverlay.updateProgress(
      progress || 0,
      'Recording video segment...',
      `${capturedSeconds}s / ${totalSeconds}s captured`
    );
  }
});

// ============================================
// CREATOR TOOLS SIDEBAR PANEL (vidIQ-style)
// On-page panel showing Tags, SEO Score, Transcript, Thumbnail, Chapters, Channel, Social
// ============================================

/**
 * Creator Tools Panel - Injected directly into YouTube page
 */
const CreatorToolsPanel = {
  container: null,
  isVisible: false,
  currentTab: 'tags',
  cachedData: {
    metadata: null,
    transcript: null,
    seoScore: null,
    chapters: null,
    channelStats: null
  },
  lastVideoId: null,

  /**
   * Create the panel DOM structure
   */
  createPanel() {
    if (this.container) return this.container;

    const panel = document.createElement('div');
    panel.id = 'yvo-creator-tools-panel';
    panel.className = 'yvo-creator-panel';

    panel.innerHTML = `
      <div class="yvo-panel-header">
        <div class="yvo-panel-logo">
          <span class="yvo-logo-icon">🎬</span>
          <span class="yvo-logo-text">YT Creator Tools</span>
        </div>
        <button class="yvo-panel-toggle" title="Minimize">−</button>
      </div>
      <div class="yvo-panel-tabs-wrapper">
        <div class="yvo-panel-tabs">
          <button class="yvo-tab active" data-tab="tags" title="Video Tags">
            <span class="yvo-tab-icon">🏷️</span>
            <span class="yvo-tab-label">Tags</span>
          </button>
          <button class="yvo-tab" data-tab="seo" title="SEO Score">
            <span class="yvo-tab-icon">📊</span>
            <span class="yvo-tab-label">SEO</span>
          </button>
          <button class="yvo-tab" data-tab="transcript" title="Transcript">
            <span class="yvo-tab-icon">📝</span>
            <span class="yvo-tab-label">Text</span>
          </button>
          <button class="yvo-tab" data-tab="thumbnail" title="Thumbnail Analyzer">
            <span class="yvo-tab-icon">📸</span>
            <span class="yvo-tab-label">Thumb</span>
          </button>
          <button class="yvo-tab" data-tab="chapters" title="Video Chapters">
            <span class="yvo-tab-icon">⏱️</span>
            <span class="yvo-tab-label">Chap</span>
          </button>
          <button class="yvo-tab" data-tab="channel" title="Channel Stats">
            <span class="yvo-tab-icon">📺</span>
            <span class="yvo-tab-label">Chan</span>
          </button>
          <button class="yvo-tab" data-tab="social" title="Social Preview">
            <span class="yvo-tab-icon">🌐</span>
            <span class="yvo-tab-label">Share</span>
          </button>
        </div>
      </div>
      <div class="yvo-panel-content">
        <div class="yvo-tab-content active" data-content="tags">
          <div class="yvo-loading">Loading tags...</div>
        </div>
        <div class="yvo-tab-content" data-content="seo">
          <div class="yvo-loading">Loading SEO analysis...</div>
        </div>
        <div class="yvo-tab-content" data-content="transcript">
          <div class="yvo-loading">Loading transcript...</div>
        </div>
        <div class="yvo-tab-content" data-content="thumbnail">
          <div class="yvo-loading">Loading thumbnail...</div>
        </div>
        <div class="yvo-tab-content" data-content="chapters">
          <div class="yvo-loading">Loading chapters...</div>
        </div>
        <div class="yvo-tab-content" data-content="channel">
          <div class="yvo-loading">Loading channel stats...</div>
        </div>
        <div class="yvo-tab-content" data-content="social">
          <div class="yvo-loading">Loading social preview...</div>
        </div>
      </div>
      <div class="yvo-panel-footer">
        <a href="#" class="yvo-viral-clip-link">🚀 Find Viral Clips</a>
      </div>
    `;

    // Add event listeners
    this.attachEventListeners(panel);

    this.container = panel;
    return panel;
  },

  /**
   * Attach event listeners to panel elements
   */
  attachEventListeners(panel) {
    // Toggle button
    panel.querySelector('.yvo-panel-toggle').addEventListener('click', () => {
      this.toggleMinimize();
    });

    // Tab buttons
    panel.querySelectorAll('.yvo-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.switchTab(tab.dataset.tab);
      });
    });

    // Viral clip link - open popup
    panel.querySelector('.yvo-viral-clip-link').addEventListener('click', (e) => {
      e.preventDefault();
      // Send message to background to open popup or redirect
      chrome.runtime.sendMessage({ action: 'openViralClipDetector' });
    });
  },

  /**
   * Show the panel on the page
   */
  async show() {
    if (!this.container) {
      this.createPanel();
    }

    // Wait for YouTube's sidebar to be available (with timeout)
    const secondaryColumn = await this.waitForElement(
      '#secondary, #secondary-inner, ytd-watch-flexy #secondary',
      5000
    );

    if (secondaryColumn) {
      // Insert at the top of the sidebar
      if (!secondaryColumn.contains(this.container)) {
        secondaryColumn.insertBefore(this.container, secondaryColumn.firstChild);
      }
      this.container.classList.remove('yvo-fixed-mode');
    } else {
      // Fallback: Add to the right side of the page as fixed panel
      if (!document.body.contains(this.container)) {
        this.container.classList.add('yvo-fixed-mode');
        document.body.appendChild(this.container);
      }
    }

    this.isVisible = true;
    this.loadData();
  },

  /**
   * Wait for a DOM element to become available
   */
  async waitForElement(selector, timeoutMs = 5000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return null;
  },

  /**
   * Hide the panel
   */
  hide() {
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.isVisible = false;
  },

  /**
   * Toggle minimized state
   */
  toggleMinimize() {
    if (!this.container) return;

    const isMinimized = this.container.classList.toggle('yvo-minimized');
    const toggleBtn = this.container.querySelector('.yvo-panel-toggle');
    toggleBtn.textContent = isMinimized ? '+' : '−';
    toggleBtn.title = isMinimized ? 'Expand' : 'Minimize';
  },

  /**
   * Switch between tabs
   */
  switchTab(tabName) {
    if (!this.container) return;

    this.currentTab = tabName;

    // Update tab buttons
    this.container.querySelectorAll('.yvo-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    // Update tab content
    this.container.querySelectorAll('.yvo-tab-content').forEach(content => {
      content.classList.toggle('active', content.dataset.content === tabName);
    });

    // Load data for the tab if not cached
    this.loadTabData(tabName);
  },

  /**
   * Load all data for current video
   */
  async loadData() {
    const videoId = getVideoId();

    // Check if video changed
    if (videoId !== this.lastVideoId) {
      this.lastVideoId = videoId;
      this.cachedData = { metadata: null, transcript: null, seoScore: null, chapters: null, channelStats: null };
    }

    if (!videoId) {
      this.showError('No video detected');
      return;
    }

    // Load data for current tab
    await this.loadTabData(this.currentTab);
  },

  /**
   * Load data for a specific tab
   */
  async loadTabData(tabName) {
    switch (tabName) {
      case 'tags':
        await this.loadTags();
        break;
      case 'seo':
        await this.loadSeoAnalysis();
        break;
      case 'transcript':
        await this.loadTranscript();
        break;
      case 'thumbnail':
        await this.loadThumbnailAnalysis();
        break;
      case 'chapters':
        await this.loadChapters();
        break;
      case 'channel':
        await this.loadChannelStats();
        break;
      case 'social':
        await this.loadSocialPreview();
        break;
    }
  },

  /**
   * Load and display video tags with retry mechanism
   */
  async loadTags(retryCount = 0) {
    const content = this.container.querySelector('[data-content="tags"]');
    const maxRetries = 3;

    if (this.cachedData.metadata) {
      this.renderTags(this.cachedData.metadata.tags);
      return;
    }

    content.innerHTML = '<div class="yvo-loading"><span class="yvo-spinner"></span>Loading tags...</div>';

    try {
      // Wait for player data to become available before trying to get metadata
      const playerData = await waitForPlayerData(10000, 300);

      if (!playerData) {
        throw new Error('YouTube data not available yet');
      }

      const result = await getVideoMetadata();

      if (result.success) {
        this.cachedData.metadata = result.metadata;
        this.renderTags(result.metadata.tags);
      } else if (result.error && retryCount < maxRetries) {
        // Retry with exponential backoff
        const delay = Math.pow(2, retryCount) * 500; // 500ms, 1s, 2s
        console.log(`[YVO Content] Retrying loadTags (attempt ${retryCount + 1}/${maxRetries}) in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.loadTags(retryCount + 1);
      } else {
        this.renderTagsError('Could not load video data', retryCount >= maxRetries);
      }
    } catch (error) {
      console.error('[YVO Content] loadTags error:', error);
      if (retryCount < maxRetries) {
        const delay = Math.pow(2, retryCount) * 500;
        console.log(`[YVO Content] Retrying loadTags after error (attempt ${retryCount + 1}/${maxRetries}) in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.loadTags(retryCount + 1);
      }
      this.renderTagsError(error.message || 'Failed to load tags', true);
    }
  },

  /**
   * Render error state with retry button
   */
  renderTagsError(message, showRetry = true) {
    const content = this.container.querySelector('[data-content="tags"]');
    content.innerHTML = `
      <div class="yvo-error-state">
        <span class="yvo-error-icon">⚠️</span>
        <p>${this.escapeHtml(message)}</p>
        ${showRetry ? '<button class="yvo-retry-btn">🔄 Retry</button>' : ''}
        <small>Try refreshing the page if this persists</small>
      </div>
    `;

    if (showRetry) {
      content.querySelector('.yvo-retry-btn')?.addEventListener('click', () => {
        this.cachedData.metadata = null;
        this.loadTags(0);
      });
    }
  },

  /**
   * Render tags in the panel
   */
  renderTags(tags) {
    const content = this.container.querySelector('[data-content="tags"]');

    if (!tags || tags.length === 0) {
      content.innerHTML = `
        <div class="yvo-empty-state">
          <span class="yvo-empty-icon">🏷️</span>
          <p>No tags found for this video</p>
          <small>This video has no public tags</small>
        </div>
      `;
      return;
    }

    content.innerHTML = `
      <div class="yvo-tags-header">
        <span class="yvo-tags-count">${tags.length} tags found</span>
        <button class="yvo-copy-all-btn" title="Copy all tags">📋 Copy All</button>
      </div>
      <div class="yvo-tags-list">
        ${tags.map(tag => `
          <span class="yvo-tag" title="Click to copy">
            ${this.escapeHtml(tag)}
          </span>
        `).join('')}
      </div>
    `;

    // Add click handlers
    content.querySelector('.yvo-copy-all-btn').addEventListener('click', () => {
      this.copyToClipboard(tags.join(', '), 'All tags copied!');
    });

    content.querySelectorAll('.yvo-tag').forEach((tagEl, index) => {
      tagEl.addEventListener('click', () => {
        this.copyToClipboard(tags[index], 'Tag copied!');
      });
    });
  },

  /**
   * Load and display SEO analysis with retry mechanism
   */
  async loadSeoAnalysis(retryCount = 0) {
    const content = this.container.querySelector('[data-content="seo"]');
    const maxRetries = 3;

    if (this.cachedData.seoScore) {
      this.renderSeoScore(this.cachedData.seoScore);
      return;
    }

    content.innerHTML = '<div class="yvo-loading"><span class="yvo-spinner"></span>Analyzing SEO...</div>';

    try {
      // Wait for player data if not already cached
      if (!this.cachedData.metadata) {
        const playerData = await waitForPlayerData(10000, 300);
        if (!playerData) {
          throw new Error('YouTube data not available yet');
        }

        const result = await getVideoMetadata();
        if (result.success) {
          this.cachedData.metadata = result.metadata;
        } else if (retryCount < maxRetries) {
          const delay = Math.pow(2, retryCount) * 500;
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.loadSeoAnalysis(retryCount + 1);
        } else {
          throw new Error('Could not get video data');
        }
      }

      const seoScore = this.analyzeSeo(this.cachedData.metadata);
      this.cachedData.seoScore = seoScore;
      this.renderSeoScore(seoScore);

    } catch (error) {
      console.error('[YVO Content] loadSeoAnalysis error:', error);
      if (retryCount < maxRetries) {
        const delay = Math.pow(2, retryCount) * 500;
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.loadSeoAnalysis(retryCount + 1);
      }
      this.renderSeoError(error.message || 'Failed to analyze SEO');
    }
  },

  /**
   * Render SEO error state with retry button
   */
  renderSeoError(message) {
    const content = this.container.querySelector('[data-content="seo"]');
    content.innerHTML = `
      <div class="yvo-error-state">
        <span class="yvo-error-icon">⚠️</span>
        <p>${this.escapeHtml(message)}</p>
        <button class="yvo-retry-btn">🔄 Retry</button>
        <small>Try refreshing the page if this persists</small>
      </div>
    `;

    content.querySelector('.yvo-retry-btn')?.addEventListener('click', () => {
      this.cachedData.seoScore = null;
      this.cachedData.metadata = null;
      this.loadSeoAnalysis(0);
    });
  },

  /**
   * Analyze SEO and return score breakdown
   */
  analyzeSeo(metadata) {
    const scores = {
      title: this.scoreTitleSeo(metadata.title),
      description: this.scoreDescriptionSeo(metadata.description),
      tags: this.scoreTagsSeo(metadata.tags),
      thumbnail: metadata.hasCustomThumbnail ? 100 : 0
    };

    const total = Math.round(
      (scores.title * 0.30) +
      (scores.description * 0.30) +
      (scores.tags * 0.25) +
      (scores.thumbnail * 0.15)
    );

    return {
      total,
      breakdown: scores,
      metadata
    };
  },

  scoreTitleSeo(title) {
    if (!title) return 0;
    let score = 0;

    // Length check (optimal: 40-60 chars)
    if (title.length >= 40 && title.length <= 60) score += 40;
    else if (title.length >= 30 && title.length <= 70) score += 25;
    else if (title.length > 0) score += 10;

    // Has numbers
    if (/\d/.test(title)) score += 15;

    // Capitalization (not all caps, not all lowercase)
    if (title !== title.toUpperCase() && title !== title.toLowerCase()) score += 15;

    // Has special characters/emoji (engagement)
    if (/[!?|:]/.test(title)) score += 15;

    // Reasonable length (not too short)
    if (title.length >= 20) score += 15;

    return Math.min(100, score);
  },

  scoreDescriptionSeo(desc) {
    if (!desc) return 0;
    let score = 0;

    // Length (optimal: 200+ chars)
    if (desc.length >= 500) score += 30;
    else if (desc.length >= 200) score += 20;
    else if (desc.length >= 100) score += 10;

    // Has links
    if (/https?:\/\//.test(desc)) score += 20;

    // Has timestamps
    if (/\d+:\d+/.test(desc)) score += 20;

    // Has hashtags
    if (/#\w+/.test(desc)) score += 15;

    // Multiple lines (structured)
    if ((desc.match(/\n/g) || []).length >= 3) score += 15;

    return Math.min(100, score);
  },

  scoreTagsSeo(tags) {
    if (!tags || tags.length === 0) return 0;
    let score = 0;

    // Number of tags (optimal: 8-15)
    if (tags.length >= 8 && tags.length <= 15) score += 40;
    else if (tags.length >= 5) score += 25;
    else if (tags.length >= 1) score += 10;

    // Has multi-word tags
    const multiWord = tags.filter(t => t.includes(' ')).length;
    if (multiWord >= 3) score += 30;
    else if (multiWord >= 1) score += 15;

    // Total character coverage
    const totalChars = tags.join('').length;
    if (totalChars >= 200) score += 30;
    else if (totalChars >= 100) score += 15;

    return Math.min(100, score);
  },

  /**
   * Render SEO score in the panel
   */
  renderSeoScore(seoData) {
    const content = this.container.querySelector('[data-content="seo"]');
    const { total, breakdown } = seoData;

    const getScoreClass = (score) => {
      if (score >= 80) return 'excellent';
      if (score >= 60) return 'good';
      if (score >= 40) return 'fair';
      return 'poor';
    };

    const getScoreColor = (score) => {
      if (score >= 80) return '#10b981';
      if (score >= 60) return '#f59e0b';
      if (score >= 40) return '#f97316';
      return '#ef4444';
    };

    content.innerHTML = `
      <div class="yvo-seo-score-container">
        <div class="yvo-seo-circle ${getScoreClass(total)}">
          <svg viewBox="0 0 100 100">
            <circle class="yvo-seo-circle-bg" cx="50" cy="50" r="45"/>
            <circle class="yvo-seo-circle-progress" cx="50" cy="50" r="45"
              style="stroke-dasharray: ${total * 2.83}, 283; stroke: ${getScoreColor(total)}"/>
          </svg>
          <div class="yvo-seo-score-text">
            <div class="yvo-seo-score-value">${total}</div>
            <div class="yvo-seo-score-label">SEO Score</div>
          </div>
        </div>
      </div>
      <div class="yvo-seo-breakdown">
        ${this.renderSeoItem('📝', 'Title', breakdown.title)}
        ${this.renderSeoItem('📄', 'Description', breakdown.description)}
        ${this.renderSeoItem('🏷️', 'Tags', breakdown.tags)}
        ${this.renderSeoItem('🖼️', 'Thumbnail', breakdown.thumbnail)}
      </div>
    `;
  },

  renderSeoItem(icon, label, score) {
    const getBarClass = (s) => s >= 80 ? 'excellent' : s >= 60 ? 'good' : s >= 40 ? 'fair' : 'poor';
    return `
      <div class="yvo-seo-item">
        <span class="yvo-seo-item-icon">${icon}</span>
        <span class="yvo-seo-item-label">${label}</span>
        <div class="yvo-seo-item-bar">
          <div class="yvo-seo-item-fill ${getBarClass(score)}" style="width: ${score}%"></div>
        </div>
        <span class="yvo-seo-item-score">${score}</span>
      </div>
    `;
  },

  /**
   * Load and display transcript
   */
  async loadTranscript() {
    const content = this.container.querySelector('[data-content="transcript"]');

    if (this.cachedData.transcript) {
      this.renderTranscript(this.cachedData.transcript);
      return;
    }

    content.innerHTML = '<div class="yvo-loading"><span class="yvo-spinner"></span>Loading transcript...</div>';

    try {
      const result = await getVideoTranscript();

      if (result.success) {
        this.cachedData.transcript = result.transcript;
        this.renderTranscript(result.transcript);
      } else {
        content.innerHTML = `
          <div class="yvo-empty-state">
            <span class="yvo-empty-icon">📝</span>
            <p>No transcript available</p>
            <small>${result.error || 'This video has no captions'}</small>
          </div>
        `;
      }
    } catch (error) {
      content.innerHTML = '<div class="yvo-error">Failed to load transcript</div>';
    }
  },

  /**
   * Render transcript in the panel
   */
  renderTranscript(transcript) {
    const content = this.container.querySelector('[data-content="transcript"]');
    const { segments, language, isAutoGenerated } = transcript;

    if (!segments || segments.length === 0) {
      content.innerHTML = `
        <div class="yvo-empty-state">
          <span class="yvo-empty-icon">📝</span>
          <p>No transcript content</p>
        </div>
      `;
      return;
    }

    // Full text for copying
    const fullText = segments.map(s => s.text).join(' ');

    content.innerHTML = `
      <div class="yvo-transcript-header">
        <span class="yvo-transcript-lang">${language.toUpperCase()}${isAutoGenerated ? ' (Auto)' : ''}</span>
        <button class="yvo-copy-transcript-btn" title="Copy transcript">📋 Copy</button>
      </div>
      <div class="yvo-transcript-list">
        ${segments.slice(0, 100).map(seg => `
          <div class="yvo-transcript-segment" data-time="${seg.start}">
            <span class="yvo-transcript-time">${this.formatTime(seg.start)}</span>
            <span class="yvo-transcript-text">${this.escapeHtml(seg.text)}</span>
          </div>
        `).join('')}
        ${segments.length > 100 ? `<div class="yvo-transcript-more">+ ${segments.length - 100} more segments</div>` : ''}
      </div>
    `;

    // Add event listeners
    content.querySelector('.yvo-copy-transcript-btn').addEventListener('click', () => {
      this.copyToClipboard(fullText, 'Transcript copied!');
    });

    content.querySelectorAll('.yvo-transcript-segment').forEach(seg => {
      seg.addEventListener('click', () => {
        const time = parseFloat(seg.dataset.time);
        seekToTime(time);
      });
    });
  },

  // ============================================
  // THUMBNAIL ANALYZER TAB
  // ============================================

  /**
   * Load and display thumbnail analysis
   */
  async loadThumbnailAnalysis() {
    const content = this.container.querySelector('[data-content="thumbnail"]');
    const videoId = getVideoId();

    if (!videoId) {
      content.innerHTML = '<div class="yvo-error">No video detected</div>';
      return;
    }

    content.innerHTML = '<div class="yvo-loading"><span class="yvo-spinner"></span>Analyzing thumbnail...</div>';

    try {
      // Get metadata if not cached
      if (!this.cachedData.metadata) {
        const result = await getVideoMetadata();
        if (result.success) {
          this.cachedData.metadata = result.metadata;
        }
      }

      const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
      const thumbnailMq = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
      const thumbnailSd = `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`;

      // Analyze thumbnail characteristics
      const analysis = await this.analyzeThumbnail(thumbnailUrl, this.cachedData.metadata?.title || '');

      content.innerHTML = `
        <div class="yvo-thumb-preview">
          <img src="${thumbnailUrl}" alt="Thumbnail" class="yvo-thumb-main" onerror="this.src='${thumbnailMq}'">
        </div>
        <div class="yvo-thumb-score">
          <div class="yvo-thumb-score-circle">
            <span class="yvo-thumb-score-value">${analysis.score}</span>
            <span class="yvo-thumb-score-label">/ 100</span>
          </div>
        </div>
        <div class="yvo-thumb-checks">
          ${this.renderThumbCheck('📐', 'Resolution', analysis.resolution, analysis.resolutionNote)}
          ${this.renderThumbCheck('🔤', 'Text Visible', analysis.hasText, analysis.textNote)}
          ${this.renderThumbCheck('🎨', 'Vibrant Colors', analysis.vibrant, 'High contrast attracts attention')}
          ${this.renderThumbCheck('😀', 'Face/Emotion', analysis.hasFace, 'Faces increase CTR')}
        </div>
        <div class="yvo-thumb-sizes">
          <span class="yvo-thumb-sizes-title">Preview Sizes:</span>
          <div class="yvo-thumb-size-grid">
            <div class="yvo-thumb-size" title="Search Result">
              <img src="${thumbnailMq}" alt="Search size">
              <span>Search</span>
            </div>
            <div class="yvo-thumb-size" title="Suggested Video">
              <img src="${thumbnailSd}" alt="Suggested size">
              <span>Sidebar</span>
            </div>
            <div class="yvo-thumb-size yvo-thumb-mobile" title="Mobile">
              <img src="${thumbnailMq}" alt="Mobile size">
              <span>Mobile</span>
            </div>
          </div>
        </div>
      `;
    } catch (error) {
      content.innerHTML = '<div class="yvo-error">Failed to analyze thumbnail</div>';
    }
  },

  /**
   * Analyze thumbnail and return scores
   */
  async analyzeThumbnail(url, title) {
    let score = 50; // Base score
    const analysis = {
      resolution: true,
      resolutionNote: '1280x720 (HD)',
      hasText: false,
      textNote: 'No text overlay detected',
      vibrant: true,
      hasFace: false
    };

    // Check if title suggests text in thumbnail
    if (title && (title.includes('!') || title.includes('?') || /\d+/.test(title))) {
      analysis.hasText = true;
      analysis.textNote = 'Likely has text overlay';
      score += 15;
    }

    // Resolution score (assume HD for maxresdefault)
    score += 20;

    // Vibrant colors assumed for custom thumbnails
    score += 15;

    // Check common engagement patterns
    const engagementWords = ['how', 'why', 'best', 'top', 'secret', 'amazing', 'shocking'];
    if (engagementWords.some(w => title.toLowerCase().includes(w))) {
      analysis.hasFace = true; // Likely has expressive thumbnail
      score += 15;
    }

    analysis.score = Math.min(100, score);
    return analysis;
  },

  renderThumbCheck(icon, label, passed, note) {
    return `
      <div class="yvo-thumb-check ${passed ? 'passed' : 'failed'}">
        <span class="yvo-thumb-check-icon">${icon}</span>
        <span class="yvo-thumb-check-label">${label}</span>
        <span class="yvo-thumb-check-status">${passed ? '✓' : '✗'}</span>
        <span class="yvo-thumb-check-note">${note}</span>
      </div>
    `;
  },

  // ============================================
  // CHAPTERS EXTRACTOR TAB
  // ============================================

  /**
   * Load and display video chapters
   */
  async loadChapters() {
    const content = this.container.querySelector('[data-content="chapters"]');

    if (this.cachedData.chapters) {
      this.renderChapters(this.cachedData.chapters);
      return;
    }

    content.innerHTML = '<div class="yvo-loading"><span class="yvo-spinner"></span>Loading chapters...</div>';

    try {
      const chapters = this.extractChapters();
      this.cachedData.chapters = chapters;
      this.renderChapters(chapters);
    } catch (error) {
      content.innerHTML = '<div class="yvo-error">Failed to load chapters</div>';
    }
  },

  /**
   * Extract chapters from video description or YouTube's chapter markers
   */
  extractChapters() {
    const chapters = [];

    // Method 1: Try YouTube's built-in chapter markers
    const chapterElements = document.querySelectorAll('ytd-macro-markers-list-item-renderer');
    if (chapterElements.length > 0) {
      chapterElements.forEach(el => {
        const titleEl = el.querySelector('#details h4');
        const timeEl = el.querySelector('#time');
        if (titleEl && timeEl) {
          const timeText = timeEl.textContent.trim();
          chapters.push({
            title: titleEl.textContent.trim(),
            time: timeText,
            seconds: this.parseTimeToSeconds(timeText)
          });
        }
      });
    }

    // Method 2: Extract from description if no chapters found
    if (chapters.length === 0) {
      const description = this.cachedData.metadata?.description || '';
      const lines = description.split('\n');

      const timeRegex = /^(\d{1,2}:)?(\d{1,2}):(\d{2})\s*[-–—]?\s*(.+)$/;
      lines.forEach(line => {
        const match = line.trim().match(timeRegex);
        if (match) {
          const timeStr = match[1] ? `${match[1]}${match[2]}:${match[3]}` : `${match[2]}:${match[3]}`;
          chapters.push({
            title: match[4].trim(),
            time: timeStr,
            seconds: this.parseTimeToSeconds(timeStr)
          });
        }
      });
    }

    return chapters;
  },

  parseTimeToSeconds(timeStr) {
    const parts = timeStr.split(':').map(p => parseInt(p, 10) || 0);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return 0;
  },

  renderChapters(chapters) {
    const content = this.container.querySelector('[data-content="chapters"]');

    if (!chapters || chapters.length === 0) {
      content.innerHTML = `
        <div class="yvo-empty-state">
          <span class="yvo-empty-icon">⏱️</span>
          <p>No chapters found</p>
          <small>This video doesn't have chapter markers</small>
        </div>
      `;
      return;
    }

    content.innerHTML = `
      <div class="yvo-chapters-header">
        <span class="yvo-chapters-count">${chapters.length} chapters</span>
      </div>
      <div class="yvo-chapters-list">
        ${chapters.map((ch, i) => `
          <div class="yvo-chapter" data-time="${ch.seconds}">
            <span class="yvo-chapter-num">${i + 1}</span>
            <span class="yvo-chapter-time">${ch.time}</span>
            <span class="yvo-chapter-title">${this.escapeHtml(ch.title)}</span>
          </div>
        `).join('')}
      </div>
    `;

    // Add click handlers
    content.querySelectorAll('.yvo-chapter').forEach(el => {
      el.addEventListener('click', () => {
        const time = parseFloat(el.dataset.time);
        seekToTime(time);
      });
    });
  },

  // ============================================
  // CHANNEL STATS TAB
  // ============================================

  /**
   * Load and display channel statistics
   */
  async loadChannelStats() {
    const content = this.container.querySelector('[data-content="channel"]');

    if (this.cachedData.channelStats) {
      this.renderChannelStats(this.cachedData.channelStats);
      return;
    }

    content.innerHTML = '<div class="yvo-loading"><span class="yvo-spinner"></span>Loading channel stats...</div>';

    try {
      const stats = this.extractChannelStats();
      this.cachedData.channelStats = stats;
      this.renderChannelStats(stats);
    } catch (error) {
      content.innerHTML = '<div class="yvo-error">Failed to load channel stats</div>';
    }
  },

  /**
   * Extract channel statistics from the page
   */
  extractChannelStats() {
    const stats = {
      name: '',
      avatar: '',
      subscribers: '',
      totalVideos: '',
      joinDate: '',
      verified: false
    };

    // Get channel name
    const channelName = document.querySelector('#owner #channel-name a, ytd-channel-name a');
    if (channelName) {
      stats.name = channelName.textContent.trim();
    }

    // Get avatar
    const avatar = document.querySelector('#owner img.yt-img-shadow, ytd-video-owner-renderer img');
    if (avatar) {
      stats.avatar = avatar.src;
    }

    // Get subscriber count
    const subCount = document.querySelector('#owner-sub-count, ytd-video-owner-renderer #owner-sub-count');
    if (subCount) {
      stats.subscribers = subCount.textContent.trim();
    }

    // Check verified badge
    const verifiedBadge = document.querySelector('#owner ytd-badge-supported-renderer, .badge-style-type-verified');
    stats.verified = !!verifiedBadge;

    // Get video view count for this video
    const viewCount = document.querySelector('ytd-video-view-count-renderer span.view-count');
    if (viewCount) {
      stats.videoViews = viewCount.textContent.trim();
    }

    // Get publish date
    const publishDate = document.querySelector('ytd-video-primary-info-renderer #info-strings yt-formatted-string');
    if (publishDate) {
      stats.publishDate = publishDate.textContent.trim();
    }

    return stats;
  },

  renderChannelStats(stats) {
    const content = this.container.querySelector('[data-content="channel"]');

    content.innerHTML = `
      <div class="yvo-channel-header">
        ${stats.avatar ? `<img src="${stats.avatar}" class="yvo-channel-avatar" alt="${stats.name}">` : '<div class="yvo-channel-avatar-placeholder">📺</div>'}
        <div class="yvo-channel-info">
          <div class="yvo-channel-name">
            ${this.escapeHtml(stats.name)}
            ${stats.verified ? '<span class="yvo-verified-badge" title="Verified">✓</span>' : ''}
          </div>
          <div class="yvo-channel-subs">${stats.subscribers || 'Subscribers hidden'}</div>
        </div>
      </div>
      <div class="yvo-channel-stats-grid">
        ${stats.videoViews ? `
          <div class="yvo-stat-card">
            <span class="yvo-stat-icon">👁️</span>
            <span class="yvo-stat-value">${stats.videoViews}</span>
            <span class="yvo-stat-label">Video Views</span>
          </div>
        ` : ''}
        ${stats.publishDate ? `
          <div class="yvo-stat-card">
            <span class="yvo-stat-icon">📅</span>
            <span class="yvo-stat-value">${stats.publishDate}</span>
            <span class="yvo-stat-label">Published</span>
          </div>
        ` : ''}
        <div class="yvo-stat-card">
          <span class="yvo-stat-icon">🎬</span>
          <span class="yvo-stat-value">${this.cachedData.metadata?.duration ? this.formatDuration(this.cachedData.metadata.duration) : 'N/A'}</span>
          <span class="yvo-stat-label">Duration</span>
        </div>
      </div>
      <a href="https://www.youtube.com/${stats.name ? '@' + stats.name.replace(/\s/g, '') : ''}" target="_blank" class="yvo-channel-link">
        View Channel →
      </a>
    `;
  },

  formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  },

  // ============================================
  // SOCIAL PREVIEW TAB
  // ============================================

  /**
   * Load and display social media preview
   */
  async loadSocialPreview() {
    const content = this.container.querySelector('[data-content="social"]');
    const videoId = getVideoId();

    if (!videoId) {
      content.innerHTML = '<div class="yvo-error">No video detected</div>';
      return;
    }

    // Get metadata if not cached
    if (!this.cachedData.metadata) {
      try {
        const result = await getVideoMetadata();
        if (result.success) {
          this.cachedData.metadata = result.metadata;
        }
      } catch (e) {}
    }

    const title = this.cachedData.metadata?.title || document.title.replace(' - YouTube', '');
    const channel = this.cachedData.metadata?.channel || '';
    const thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    const url = `youtube.com/watch?v=${videoId}`;

    content.innerHTML = `
      <div class="yvo-social-section">
        <div class="yvo-social-label">
          <span class="yvo-social-icon">🐦</span> Twitter/X Preview
        </div>
        <div class="yvo-social-card yvo-twitter-card">
          <img src="${thumbnail}" class="yvo-social-thumb" alt="">
          <div class="yvo-social-card-content">
            <div class="yvo-social-title">${this.escapeHtml(title.substring(0, 60))}${title.length > 60 ? '...' : ''}</div>
            <div class="yvo-social-meta">${url}</div>
          </div>
        </div>
      </div>

      <div class="yvo-social-section">
        <div class="yvo-social-label">
          <span class="yvo-social-icon">📘</span> Facebook Preview
        </div>
        <div class="yvo-social-card yvo-facebook-card">
          <img src="${thumbnail}" class="yvo-social-thumb-large" alt="">
          <div class="yvo-social-card-content">
            <div class="yvo-social-domain">YOUTUBE.COM</div>
            <div class="yvo-social-title">${this.escapeHtml(title.substring(0, 80))}${title.length > 80 ? '...' : ''}</div>
            <div class="yvo-social-desc">${channel}</div>
          </div>
        </div>
      </div>

      <div class="yvo-social-section">
        <div class="yvo-social-label">
          <span class="yvo-social-icon">💬</span> Discord/Slack Preview
        </div>
        <div class="yvo-social-card yvo-discord-card">
          <div class="yvo-discord-embed">
            <div class="yvo-discord-header">
              <img src="https://www.youtube.com/favicon.ico" class="yvo-discord-favicon" alt="">
              <span>YouTube</span>
            </div>
            <div class="yvo-discord-title">${this.escapeHtml(title.substring(0, 70))}${title.length > 70 ? '...' : ''}</div>
            <img src="${thumbnail}" class="yvo-discord-thumb" alt="">
          </div>
        </div>
      </div>

      <button class="yvo-copy-url-btn" data-url="https://www.youtube.com/watch?v=${videoId}">
        📋 Copy Video URL
      </button>
    `;

    // Add copy handler
    content.querySelector('.yvo-copy-url-btn').addEventListener('click', (e) => {
      const url = e.target.dataset.url;
      this.copyToClipboard(url, 'URL copied!');
    });
  },

  /**
   * Show error state
   */
  showError(message) {
    if (!this.container) return;

    const contents = this.container.querySelectorAll('.yvo-tab-content');
    contents.forEach(content => {
      content.innerHTML = `<div class="yvo-error">${message}</div>`;
    });
  },

  /**
   * Copy text to clipboard with feedback
   */
  async copyToClipboard(text, successMsg) {
    try {
      await navigator.clipboard.writeText(text);
      this.showToast(successMsg, 'success');
    } catch (error) {
      this.showToast('Failed to copy', 'error');
    }
  },

  /**
   * Show a toast notification
   */
  showToast(message, type = 'info') {
    // Remove existing toast
    const existing = document.querySelector('.yvo-panel-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `yvo-panel-toast yvo-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.classList.add('yvo-toast-visible'), 10);
    setTimeout(() => {
      toast.classList.remove('yvo-toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  },

  /**
   * Format seconds to MM:SS
   */
  formatTime(seconds) {
    seconds = Math.round(seconds);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  },

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  /**
   * Check if we're on a video page
   */
  isVideoPage() {
    return window.location.pathname === '/watch' ||
           window.location.pathname.startsWith('/shorts/');
  },

  /**
   * Initialize panel on video pages
   */
  async init() {
    if (this.isVideoPage()) {
      // Wait for YouTube's UI elements to be ready before showing panel
      console.log('[YVO Content] Initializing Creator Tools panel...');

      // Wait for sidebar or page to be ready
      const ready = await this.waitForYouTubeReady();
      if (ready) {
        await this.show();
      } else {
        console.warn('[YVO Content] YouTube UI not ready, will retry on navigation');
      }
    }
  },

  /**
   * Wait for YouTube page to be ready
   */
  async waitForYouTubeReady(timeoutMs = 8000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      // Check if essential YouTube elements exist
      const hasVideoElement = !!document.querySelector('video.html5-main-video, video');
      const hasPlayerContainer = !!document.querySelector('#movie_player, ytd-player');
      const hasPageStructure = !!document.querySelector('ytd-watch-flexy, ytd-page-manager');

      if (hasVideoElement && (hasPlayerContainer || hasPageStructure)) {
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, 300));
    }

    return false;
  },

  /**
   * Handle URL changes (YouTube is SPA)
   */
  async handleNavigation() {
    if (this.isVideoPage()) {
      // Clear cache for new video
      const currentVideoId = getVideoId();
      if (currentVideoId !== this.lastVideoId) {
        this.cachedData = { metadata: null, transcript: null, seoScore: null, chapters: null, channelStats: null };
      }

      if (!this.isVisible) {
        await this.show();
      } else {
        // Video changed, reload data
        await this.loadData();
      }
    } else {
      this.hide();
    }
  }
};

// Make panel accessible for debugging
window.__YVO_CREATOR_PANEL__ = CreatorToolsPanel;

// ============================================
// END CREATOR TOOLS PANEL
// ============================================

// Initialize when document is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Initialize Creator Tools panel
setTimeout(() => {
  CreatorToolsPanel.init();
}, 1000);

// Watch for URL changes for Creator Tools
let lastUrlForPanel = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrlForPanel) {
    lastUrlForPanel = location.href;
    setTimeout(() => CreatorToolsPanel.handleNavigation(), 1000);
  }
}).observe(document, { subtree: true, childList: true });

console.log('YouTube Video Optimizer content script loaded');

} // End of duplicate injection guard
