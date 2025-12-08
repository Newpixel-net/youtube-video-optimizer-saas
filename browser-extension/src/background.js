/**
 * YouTube Video Optimizer - Background Service Worker
 * Handles video capture and Video Wizard integration
 *
 * Security: Validates all inputs, uses secure fetch, sanitizes data
 */

// State
let currentCapture = null;
let isCapturing = false;
let storedVideoData = null; // Video data captured from YouTube for Video Wizard

// Intercepted stream URLs from actual network requests (keyed by video ID)
const interceptedStreams = new Map();
const STREAM_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Track which video ID is playing in which tab
const tabVideoMap = new Map();

// Constants
const WIZARD_ORIGINS = [
  'https://ytseo.siteuo.com',
  'https://youtube-video-optimizer.web.app',
  'https://ytseo-6d1b0.web.app'
];

/**
 * Network request interception to capture actual stream URLs
 * This captures the REAL URLs that YouTube's player uses (after signature deciphering)
 */
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;

    // Only process googlevideo.com requests (actual video/audio streams)
    if (!url.includes('.googlevideo.com/')) return;

    try {
      const urlObj = new URL(url);
      const params = urlObj.searchParams;

      // Extract video ID from the URL
      // YouTube stream URLs contain 'id' parameter with video ID or embedded in 'ei' param
      let videoId = null;

      // Try to get from initiator URL (the YouTube page that made the request)
      if (details.initiator && details.initiator.includes('youtube.com')) {
        // Check for video ID in initiator
        const initiatorMatch = details.initiator.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        if (initiatorMatch) {
          videoId = initiatorMatch[1];
        }
      }

      // Also try to extract from documentUrl
      if (!videoId && details.documentUrl) {
        const docMatch = details.documentUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
        if (docMatch) {
          videoId = docMatch[1];
        }
      }

      // Check if this is a video or audio stream
      const mime = params.get('mime');
      const itag = params.get('itag');
      const range = params.get('range');

      // Skip range requests (partial downloads) - we want the full stream URL
      if (range && range !== '0-') return;

      // Determine if video or audio based on mime type or itag
      const isVideo = mime?.startsWith('video/') ||
                      ['18', '22', '37', '38', '82', '83', '84', '85', '136', '137', '298', '299', '264', '271', '313', '315', '266', '138'].includes(itag);
      const isAudio = mime?.startsWith('audio/') ||
                      ['139', '140', '141', '171', '172', '249', '250', '251'].includes(itag);

      if (!isVideo && !isAudio) return;

      // Get video ID from tab tracking if we couldn't extract it from URL
      if (!videoId && details.tabId && details.tabId > 0) {
        videoId = tabVideoMap.get(details.tabId);
      }

      if (!videoId) {
        // Can't determine video ID - skip this request
        return;
      }

      // Store the intercepted URL
      if (!interceptedStreams.has(videoId)) {
        interceptedStreams.set(videoId, {
          capturedAt: Date.now(),
          videoUrls: [],
          audioUrls: []
        });
      }

      const streams = interceptedStreams.get(videoId);

      // Add URL if not already present (avoid duplicates)
      if (isVideo && !streams.videoUrls.includes(url)) {
        streams.videoUrls.push(url);
        console.log(`[YVO] Captured video stream for ${videoId}: itag=${itag}, mime=${mime}`);
      } else if (isAudio && !streams.audioUrls.includes(url)) {
        streams.audioUrls.push(url);
        console.log(`[YVO] Captured audio stream for ${videoId}: itag=${itag}, mime=${mime}`);
      }

      // Update timestamp
      streams.capturedAt = Date.now();

    } catch (e) {
      // Ignore parsing errors
    }
  },
  { urls: ['*://*.googlevideo.com/*'] }
);

/**
 * Get intercepted streams for a video ID
 */
function getInterceptedStreams(videoId) {
  const streams = interceptedStreams.get(videoId);

  if (!streams) {
    return null;
  }

  // Check if expired
  if (Date.now() - streams.capturedAt > STREAM_CACHE_TTL) {
    interceptedStreams.delete(videoId);
    return null;
  }

  // Return the best streams (first ones captured are usually best quality)
  return {
    videoUrl: streams.videoUrls[0] || null,
    audioUrl: streams.audioUrls[0] || null,
    allVideoUrls: streams.videoUrls,
    allAudioUrls: streams.audioUrls,
    capturedAt: streams.capturedAt
  };
}

/**
 * Clean up old cached streams periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const [videoId, streams] of interceptedStreams.entries()) {
    if (now - streams.capturedAt > STREAM_CACHE_TTL) {
      interceptedStreams.delete(videoId);
      console.log(`[YVO] Cleaned up expired streams for ${videoId}`);
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

/**
 * Message handler for extension communication
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Log for debugging
  console.log('[YVO Background] Message:', message.action, 'from:', sender?.url || 'unknown');

  switch (message.action) {
    // Video Wizard integration
    case 'captureVideoForWizard':
      handleCaptureForWizard(message, sendResponse);
      return true;

    case 'getStoredVideoData':
      sendResponse({ videoData: storedVideoData });
      return false;

    case 'getInterceptedStreams':
      const streams = getInterceptedStreams(message.videoId);
      sendResponse({ success: !!streams, streams: streams });
      return false;

    case 'reportVideoId':
      // Content script reporting which video is currently playing
      if (message.videoId && sender.tab?.id) {
        tabVideoMap.set(sender.tab.id, message.videoId);
        console.log(`[YVO] Tab ${sender.tab.id} is playing video ${message.videoId}`);
      }
      sendResponse({ success: true });
      return false;

    case 'storeVideoForWizard':
      storedVideoData = message.videoData;
      sendResponse({ success: true });
      return false;

    case 'clearStoredVideoData':
      storedVideoData = null;
      sendResponse({ success: true });
      return false;

    // Popup capture (standalone mode)
    case 'captureVideo':
      handleCaptureVideo(message, sendResponse);
      return true;

    case 'cancelCapture':
      handleCancelCapture();
      sendResponse({ success: true });
      return false;

    case 'getSettings':
      getSettings().then(sendResponse);
      return true;

    case 'saveSettings':
      saveSettings(message.settings).then(sendResponse);
      return true;

    default:
      return false;
  }
});

/**
 * Handle video capture request from Video Wizard
 * This captures video info and stream URLs to pass to the wizard
 *
 * ENHANCED: If no streams are available, automatically opens YouTube tab to capture them
 */
async function handleCaptureForWizard(message, sendResponse) {
  const { videoId, youtubeUrl, autoCapture = true } = message;

  if (!videoId || !isValidVideoId(videoId)) {
    sendResponse({ success: false, error: 'Invalid video ID' });
    return;
  }

  console.log(`[YVO Background] Capture request for video: ${videoId}`);

  try {
    // PRIORITY 1: Check if we already have intercepted streams (from previous playback)
    let intercepted = getInterceptedStreams(videoId);
    if (intercepted && intercepted.videoUrl) {
      console.log(`[YVO Background] Using cached intercepted streams for ${videoId}`);
      const videoInfo = await getBasicVideoInfo(videoId, youtubeUrl);
      sendResponse({
        success: true,
        videoInfo: videoInfo,
        streamData: {
          videoUrl: intercepted.videoUrl,
          audioUrl: intercepted.audioUrl,
          quality: 'intercepted',
          mimeType: 'video/mp4',
          capturedAt: intercepted.capturedAt,
          source: 'network_intercept_cached'
        },
        message: 'Using previously intercepted stream URLs.'
      });
      return;
    }

    // Find existing YouTube tab with this video
    const tabs = await chrome.tabs.query({
      url: ['*://www.youtube.com/*', '*://youtube.com/*']
    });

    let targetTab = tabs.find(tab => {
      try {
        const url = new URL(tab.url);
        return url.searchParams.get('v') === videoId ||
               tab.url.includes(`/shorts/${videoId}`) ||
               tab.url.includes(`/embed/${videoId}`);
      } catch {
        return false;
      }
    });

    // If no tab exists and autoCapture is enabled, open a new tab to capture streams
    if (!targetTab && autoCapture) {
      console.log(`[YVO Background] No YouTube tab found, opening video to capture streams...`);

      try {
        const captureResult = await openAndCaptureStreams(videoId, youtubeUrl);

        if (captureResult.success && captureResult.streamData) {
          sendResponse(captureResult);
          return;
        } else {
          console.warn(`[YVO Background] Auto-capture failed:`, captureResult.error);
          // Continue to try other methods
        }
      } catch (autoCaptureError) {
        console.warn(`[YVO Background] Auto-capture error:`, autoCaptureError.message);
        // Continue to try other methods
      }

      // Re-check for intercepted streams after auto-capture attempt
      intercepted = getInterceptedStreams(videoId);
      if (intercepted && intercepted.videoUrl) {
        const videoInfo = await getBasicVideoInfo(videoId, youtubeUrl);
        sendResponse({
          success: true,
          videoInfo: videoInfo,
          streamData: {
            videoUrl: intercepted.videoUrl,
            audioUrl: intercepted.audioUrl,
            quality: 'intercepted',
            mimeType: 'video/mp4',
            capturedAt: intercepted.capturedAt,
            source: 'network_intercept_auto'
          },
          message: 'Streams captured by auto-opening YouTube video.'
        });
        return;
      }
    }

    // Try to get info from existing tab
    if (targetTab) {
      const videoInfo = await chrome.tabs.sendMessage(targetTab.id, {
        action: 'getVideoInfo'
      });

      if (!videoInfo?.success) {
        sendResponse({
          success: false,
          error: videoInfo?.error || 'Failed to get video info from YouTube'
        });
        return;
      }

      // Check for intercepted streams again (in case video started playing)
      intercepted = getInterceptedStreams(videoId);
      let streamData = null;

      if (intercepted && intercepted.videoUrl) {
        console.log(`[YVO Background] Using INTERCEPTED stream URLs for ${videoId}`);
        streamData = {
          videoUrl: intercepted.videoUrl,
          audioUrl: intercepted.audioUrl,
          quality: 'intercepted',
          mimeType: 'video/mp4',
          capturedAt: intercepted.capturedAt,
          source: 'network_intercept'
        };
      } else {
        // Try content script extraction (may fail due to signature cipher)
        console.log(`[YVO Background] No intercepted streams, trying content script...`);
        try {
          const streamResponse = await chrome.tabs.sendMessage(targetTab.id, {
            action: 'getVideoStream',
            quality: '720'
          });

          if (streamResponse?.success && streamResponse.videoUrl) {
            streamData = {
              videoUrl: streamResponse.videoUrl,
              audioUrl: streamResponse.audioUrl,
              quality: streamResponse.quality,
              mimeType: streamResponse.mimeType,
              source: 'content_script'
            };
          }
        } catch (streamError) {
          console.warn('[YVO Background] Content script stream capture failed:', streamError.message);
        }
      }

      // If still no streams and autoCapture is enabled, trigger playback
      if (!streamData && autoCapture) {
        console.log(`[YVO Background] No streams yet, triggering video playback...`);
        try {
          await chrome.tabs.sendMessage(targetTab.id, { action: 'triggerPlayback' });

          // Wait for playback to trigger network interception
          await new Promise(resolve => setTimeout(resolve, 3000));

          intercepted = getInterceptedStreams(videoId);
          if (intercepted && intercepted.videoUrl) {
            streamData = {
              videoUrl: intercepted.videoUrl,
              audioUrl: intercepted.audioUrl,
              quality: 'intercepted',
              mimeType: 'video/mp4',
              capturedAt: intercepted.capturedAt,
              source: 'network_intercept_triggered'
            };
          }
        } catch (playError) {
          console.warn('[YVO Background] Trigger playback failed:', playError.message);
        }
      }

      // Log what we captured
      if (streamData) {
        console.log(`[YVO Background] Captured streams (${streamData.source}):`, {
          hasVideo: !!streamData.videoUrl,
          hasAudio: !!streamData.audioUrl,
          quality: streamData.quality
        });
      } else {
        console.warn(`[YVO Background] No stream URLs captured for ${videoId}`);
      }

      // Store for later retrieval
      storedVideoData = {
        videoInfo: videoInfo.videoInfo,
        streamData: streamData,
        capturedAt: Date.now()
      };

      sendResponse({
        success: true,
        videoInfo: videoInfo.videoInfo,
        streamData: streamData
      });
      return;
    }

    // No tab and auto-capture failed - return basic info without streams
    const basicInfo = await getBasicVideoInfo(videoId, youtubeUrl);
    sendResponse({
      success: true,
      videoInfo: basicInfo,
      streamData: null,
      message: 'Could not capture streams. The video will be downloaded server-side.'
    });

  } catch (error) {
    console.error('[YVO Background] Capture for wizard error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Get basic video info without requiring a tab
 */
async function getBasicVideoInfo(videoId, youtubeUrl) {
  return {
    videoId: videoId,
    url: youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`,
    title: null, // Will be fetched by backend
    channel: null,
    duration: null,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
  };
}

/**
 * Open YouTube video in a new tab and wait for stream interception
 * This is the key function that enables reliable stream capture
 */
async function openAndCaptureStreams(videoId, youtubeUrl) {
  const url = youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`;

  console.log(`[YVO Background] Opening YouTube tab for stream capture: ${videoId}`);

  return new Promise(async (resolve) => {
    let captureTab = null;
    let checkInterval = null;
    let timeoutId = null;

    const cleanup = () => {
      if (checkInterval) clearInterval(checkInterval);
      if (timeoutId) clearTimeout(timeoutId);
    };

    try {
      // Open the YouTube video in a new tab
      captureTab = await chrome.tabs.create({
        url: url,
        active: false // Open in background so user can continue working
      });

      console.log(`[YVO Background] Opened capture tab ${captureTab.id}`);

      // Track this tab for the video ID
      tabVideoMap.set(captureTab.id, videoId);

      // Wait for tab to load and start playing
      let attempts = 0;
      const maxAttempts = 20; // 20 attempts * 500ms = 10 seconds max

      checkInterval = setInterval(async () => {
        attempts++;

        // Check if we got intercepted streams
        const intercepted = getInterceptedStreams(videoId);

        if (intercepted && intercepted.videoUrl) {
          cleanup();
          console.log(`[YVO Background] Streams captured after ${attempts} checks`);

          // Try to get video info from the tab
          let videoInfo = null;
          try {
            const infoResponse = await chrome.tabs.sendMessage(captureTab.id, {
              action: 'getVideoInfo'
            });
            if (infoResponse?.success) {
              videoInfo = infoResponse.videoInfo;
            }
          } catch (e) {
            console.warn('[YVO Background] Could not get video info from tab:', e.message);
          }

          // Close the capture tab after a short delay
          setTimeout(() => {
            try {
              chrome.tabs.remove(captureTab.id).catch(() => {});
            } catch (e) {}
          }, 1000);

          resolve({
            success: true,
            videoInfo: videoInfo || {
              videoId: videoId,
              url: url,
              thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
            },
            streamData: {
              videoUrl: intercepted.videoUrl,
              audioUrl: intercepted.audioUrl,
              quality: 'intercepted',
              mimeType: 'video/mp4',
              capturedAt: intercepted.capturedAt,
              source: 'network_intercept_auto'
            },
            message: 'Streams captured by auto-opening YouTube video.'
          });
          return;
        }

        // Try to trigger playback if tab is loaded
        if (attempts === 5 || attempts === 10 || attempts === 15) {
          try {
            await chrome.tabs.sendMessage(captureTab.id, { action: 'triggerPlayback' });
            console.log(`[YVO Background] Triggered playback attempt ${attempts}`);
          } catch (e) {
            // Tab might not be ready yet
          }
        }

        // Check if we've exceeded max attempts
        if (attempts >= maxAttempts) {
          cleanup();

          // Close the capture tab
          try {
            chrome.tabs.remove(captureTab.id).catch(() => {});
          } catch (e) {}

          resolve({
            success: false,
            error: 'Timeout waiting for stream capture. Please try opening the video in YouTube first.'
          });
        }
      }, 500);

      // Set absolute timeout
      timeoutId = setTimeout(() => {
        cleanup();
        try {
          if (captureTab) chrome.tabs.remove(captureTab.id).catch(() => {});
        } catch (e) {}
        resolve({
          success: false,
          error: 'Stream capture timeout'
        });
      }, 15000); // 15 second absolute timeout

    } catch (error) {
      cleanup();
      console.error('[YVO Background] Failed to open capture tab:', error);
      resolve({
        success: false,
        error: `Failed to open YouTube tab: ${error.message}`
      });
    }
  });
}

/**
 * Handle video capture request (standalone popup mode)
 */
async function handleCaptureVideo(message, sendResponse) {
  if (isCapturing) {
    sendResponse({ success: false, error: 'Capture already in progress' });
    return;
  }

  const { videoInfo, startTime, endTime, quality } = message;

  // Validate inputs
  if (!videoInfo?.videoId) {
    sendResponse({ success: false, error: 'Invalid video information' });
    return;
  }

  if (!isValidVideoId(videoInfo.videoId)) {
    sendResponse({ success: false, error: 'Invalid video ID format' });
    return;
  }

  if (typeof startTime !== 'number' || typeof endTime !== 'number') {
    sendResponse({ success: false, error: 'Invalid time range' });
    return;
  }

  if (startTime < 0 || endTime <= startTime || endTime > 36000) {
    sendResponse({ success: false, error: 'Invalid time range values' });
    return;
  }

  const duration = endTime - startTime;
  if (duration > 300) {
    sendResponse({ success: false, error: 'Clip duration exceeds maximum (5 minutes)' });
    return;
  }

  isCapturing = true;
  currentCapture = { videoInfo, startTime, endTime, quality, cancelled: false };

  try {
    sendProgress(5, 'Getting video stream...');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      throw new Error('Cannot access YouTube tab');
    }

    const streamResponse = await chrome.tabs.sendMessage(tab.id, {
      action: 'getVideoStream',
      quality: quality
    });

    if (currentCapture.cancelled) {
      sendResponse({ success: false, error: 'Capture cancelled' });
      return;
    }

    if (!streamResponse?.success) {
      throw new Error(streamResponse?.error || 'Failed to get video stream');
    }

    sendProgress(20, 'Downloading video segment...');

    const videoBlob = await downloadVideoSegment(
      streamResponse.videoUrl,
      streamResponse.audioUrl,
      startTime,
      endTime
    );

    if (currentCapture.cancelled) {
      sendResponse({ success: false, error: 'Capture cancelled' });
      return;
    }

    sendProgress(80, 'Preparing download...');

    const safeTitle = sanitizeFilename(videoInfo.title || 'video');
    const filename = `${safeTitle}_${startTime}-${endTime}.mp4`;

    await downloadBlob(videoBlob, filename);

    sendProgress(100, 'Complete!');

    chrome.runtime.sendMessage({
      action: 'captureComplete',
      success: true
    }).catch(() => {});

    sendResponse({ success: true });

  } catch (error) {
    console.error('Capture error:', error);

    chrome.runtime.sendMessage({
      action: 'captureComplete',
      success: false,
      error: error.message
    }).catch(() => {});

    sendResponse({ success: false, error: error.message });

  } finally {
    isCapturing = false;
    currentCapture = null;
  }
}

/**
 * Handle capture cancellation
 */
function handleCancelCapture() {
  if (currentCapture) {
    currentCapture.cancelled = true;
  }
  isCapturing = false;
}

/**
 * Download video segment
 */
async function downloadVideoSegment(videoUrl, audioUrl, startTime, endTime) {
  if (videoUrl && !isValidGoogleVideoUrl(videoUrl)) {
    throw new Error('Invalid video URL source');
  }
  if (audioUrl && !isValidGoogleVideoUrl(audioUrl)) {
    throw new Error('Invalid audio URL source');
  }

  sendProgress(30, 'Fetching video data...');

  const videoResponse = await fetch(videoUrl, {
    method: 'GET',
    credentials: 'include'
  });

  if (!videoResponse.ok) {
    throw new Error(`Video fetch failed: ${videoResponse.status}`);
  }

  sendProgress(50, 'Processing video...');

  const videoBuffer = await videoResponse.arrayBuffer();

  let audioBuffer = null;
  if (audioUrl && audioUrl !== videoUrl) {
    sendProgress(60, 'Fetching audio data...');

    const audioResponse = await fetch(audioUrl, {
      method: 'GET',
      credentials: 'include'
    });

    if (audioResponse.ok) {
      audioBuffer = await audioResponse.arrayBuffer();
    }
  }

  sendProgress(70, 'Creating video file...');

  return new Blob([videoBuffer], { type: 'video/mp4' });
}

/**
 * Download blob as file
 */
async function downloadBlob(blob, filename) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);

    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        URL.revokeObjectURL(url);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const listener = (delta) => {
        if (delta.id === downloadId) {
          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(listener);
            URL.revokeObjectURL(url);
            resolve();
          } else if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            URL.revokeObjectURL(url);
            reject(new Error('Download was interrupted'));
          }
        }
      };

      chrome.downloads.onChanged.addListener(listener);

      setTimeout(() => {
        chrome.downloads.onChanged.removeListener(listener);
        URL.revokeObjectURL(url);
      }, 300000);
    });
  });
}

/**
 * Send progress update to popup
 */
function sendProgress(percent, status) {
  chrome.runtime.sendMessage({
    action: 'progressUpdate',
    percent: percent,
    status: status
  }).catch(() => {});
}

/**
 * Validate video ID format
 */
function isValidVideoId(videoId) {
  return /^[a-zA-Z0-9_-]{11}$/.test(videoId);
}

/**
 * Validate URL is from Google/YouTube
 */
function isValidGoogleVideoUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith('.googlevideo.com') ||
           parsed.hostname.endsWith('.youtube.com') ||
           parsed.hostname.endsWith('.ytimg.com');
  } catch {
    return false;
  }
}

/**
 * Sanitize filename
 */
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 100);
}

/**
 * Get settings from storage
 */
async function getSettings() {
  try {
    const result = await chrome.storage.sync.get(['settings']);
    return result.settings || getDefaultSettings();
  } catch {
    return getDefaultSettings();
  }
}

/**
 * Save settings to storage
 */
async function saveSettings(settings) {
  try {
    const validSettings = {
      defaultQuality: ['720', '1080'].includes(settings.defaultQuality)
        ? settings.defaultQuality
        : '720',
      defaultDuration: Math.min(Math.max(5, settings.defaultDuration || 30), 60),
      autoDownload: Boolean(settings.autoDownload)
    };

    await chrome.storage.sync.set({ settings: validSettings });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Get default settings
 */
function getDefaultSettings() {
  return {
    defaultQuality: '720',
    defaultDuration: 30,
    autoDownload: true
  };
}

/**
 * Installation handler
 */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    saveSettings(getDefaultSettings());
    console.log('[YVO Extension] Installed successfully');
  } else if (details.reason === 'update') {
    console.log('[YVO Extension] Updated to version', chrome.runtime.getManifest().version);
  }
});

console.log('[YVO Extension] Background service worker loaded');
