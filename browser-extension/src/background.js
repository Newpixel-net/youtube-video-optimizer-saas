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

// Constants
const WIZARD_ORIGINS = [
  'https://ytseo.siteuo.com',
  'https://youtube-video-optimizer.web.app',
  'https://ytseo-6d1b0.web.app'
];

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
 */
async function handleCaptureForWizard(message, sendResponse) {
  const { videoId, youtubeUrl } = message;

  if (!videoId || !isValidVideoId(videoId)) {
    sendResponse({ success: false, error: 'Invalid video ID' });
    return;
  }

  try {
    // Find YouTube tab with this video
    const tabs = await chrome.tabs.query({
      url: ['*://www.youtube.com/*', '*://youtube.com/*']
    });

    const targetTab = tabs.find(tab => {
      const url = new URL(tab.url);
      return url.searchParams.get('v') === videoId ||
             tab.url.includes(`/shorts/${videoId}`) ||
             tab.url.includes(`/embed/${videoId}`);
    });

    if (!targetTab) {
      // No YouTube tab with this video - try to get basic info
      sendResponse({
        success: true,
        videoInfo: {
          videoId: videoId,
          url: youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`
        },
        streamData: null,
        message: 'Video tab not found. Open the video on YouTube for better capture.'
      });
      return;
    }

    // Get video info from the YouTube tab
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

    // Try to get stream URLs
    let streamData = null;
    try {
      const streamResponse = await chrome.tabs.sendMessage(targetTab.id, {
        action: 'getVideoStream',
        quality: '720'
      });

      if (streamResponse?.success) {
        streamData = {
          videoUrl: streamResponse.videoUrl,
          audioUrl: streamResponse.audioUrl,
          quality: streamResponse.quality,
          mimeType: streamResponse.mimeType
        };
      }
    } catch (streamError) {
      console.warn('[YVO Background] Could not get stream URLs:', streamError);
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

  } catch (error) {
    console.error('[YVO Background] Capture for wizard error:', error);
    sendResponse({ success: false, error: error.message });
  }
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
