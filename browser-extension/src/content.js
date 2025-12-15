/**
 * YouTube Video Optimizer - Content Script
 * Runs on YouTube pages to extract video information and stream URLs
 *
 * Security: Runs in isolated content script context, validates all data
 */

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
      return {
        videoId: videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: videoDetails.title || 'Unknown Title',
        channel: videoDetails.author || 'Unknown Channel',
        duration: parseInt(videoDetails.lengthSeconds, 10) || 0,
        thumbnail: getThumbnailUrl(videoId),
        isLive: videoDetails.isLiveContent || false,
        isPrivate: videoDetails.isPrivate || false
      };
    }
  }

  // Method 2: Extract from DOM
  const domInfo = extractFromDOM(videoId);
  if (domInfo) {
    return domInfo;
  }

  // Method 3: Basic info from page
  return {
    videoId: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: document.title.replace(' - YouTube', ''),
    channel: document.querySelector('#owner-name a, #channel-name a')?.textContent || 'Unknown',
    duration: getVideoDuration(),
    thumbnail: getThumbnailUrl(videoId),
    isLive: false,
    isPrivate: false
  };
}

/**
 * Get player data from page scripts
 */
function getPlayerData() {
  // Try window.ytInitialPlayerResponse first
  if (window.ytInitialPlayerResponse) {
    return window.ytInitialPlayerResponse;
  }

  // Search for it in script tags
  const scripts = document.querySelectorAll('script');

  for (const script of scripts) {
    const text = script.textContent;

    if (text.includes('ytInitialPlayerResponse')) {
      const match = text.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch {
          // Continue to next script
        }
      }
    }
  }

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
});

// Initialize when document is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

console.log('YouTube Video Optimizer content script loaded');
