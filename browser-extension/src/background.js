/**
 * YouTube Video Optimizer - Background Service Worker
 * Handles video capture, processing, and downloads
 *
 * Security: Validates all inputs, uses secure fetch, sanitizes data
 */

// State
let currentCapture = null;
let isCapturing = false;

// Constants
const APP_ORIGIN = 'https://youtube-video-optimizer.web.app';

/**
 * Message handler for extension communication
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Validate message source for sensitive operations
  if (message.action === 'captureVideo') {
    handleCaptureVideo(message, sendResponse);
    return true; // Keep channel open for async response
  }

  if (message.action === 'cancelCapture') {
    handleCancelCapture();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'getSettings') {
    getSettings().then(sendResponse);
    return true;
  }

  if (message.action === 'saveSettings') {
    saveSettings(message.settings).then(sendResponse);
    return true;
  }

  return false;
});

/**
 * Handle video capture request
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

  if (startTime < 0 || endTime <= startTime || endTime > 36000) { // Max 10 hours
    sendResponse({ success: false, error: 'Invalid time range values' });
    return;
  }

  const duration = endTime - startTime;
  if (duration > 300) { // Max 5 minutes
    sendResponse({ success: false, error: 'Clip duration exceeds maximum (5 minutes)' });
    return;
  }

  isCapturing = true;
  currentCapture = { videoInfo, startTime, endTime, quality, cancelled: false };

  try {
    // Notify popup of progress
    sendProgress(5, 'Getting video stream...');

    // Get the current tab to request video stream from content script
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      throw new Error('Cannot access YouTube tab');
    }

    // Request video stream URL from content script
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

    // Download the video segment
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

    // Create filename
    const safeTitle = sanitizeFilename(videoInfo.title || 'video');
    const filename = `${safeTitle}_${startTime}-${endTime}.mp4`;

    // Download the file
    await downloadBlob(videoBlob, filename);

    sendProgress(100, 'Complete!');

    // Notify popup
    chrome.runtime.sendMessage({
      action: 'captureComplete',
      success: true
    });

    sendResponse({ success: true });

  } catch (error) {
    console.error('Capture error:', error);

    chrome.runtime.sendMessage({
      action: 'captureComplete',
      success: false,
      error: error.message
    });

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
  // For security, validate URLs are from googlevideo.com
  if (videoUrl && !isValidGoogleVideoUrl(videoUrl)) {
    throw new Error('Invalid video URL source');
  }
  if (audioUrl && !isValidGoogleVideoUrl(audioUrl)) {
    throw new Error('Invalid audio URL source');
  }

  // If we have a direct URL with range support, we can use fetch
  // Otherwise, we'll download the full stream and clip locally

  sendProgress(30, 'Fetching video data...');

  // Fetch video
  const videoResponse = await fetch(videoUrl, {
    method: 'GET',
    credentials: 'include'
  });

  if (!videoResponse.ok) {
    throw new Error(`Video fetch failed: ${videoResponse.status}`);
  }

  sendProgress(50, 'Processing video...');

  const videoBuffer = await videoResponse.arrayBuffer();

  // If there's a separate audio stream, fetch it too
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

  // For now, return the video as-is
  // In a full implementation, we'd use WebCodecs API or a WASM library
  // to clip the video to the specified time range
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

      // Listen for download completion
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

      // Cleanup after timeout
      setTimeout(() => {
        chrome.downloads.onChanged.removeListener(listener);
        URL.revokeObjectURL(url);
      }, 300000); // 5 minutes timeout
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
  }).catch(() => {
    // Popup may be closed, ignore error
  });
}

/**
 * Validate video ID format (11 characters, alphanumeric with dash/underscore)
 */
function isValidVideoId(videoId) {
  return /^[a-zA-Z0-9_-]{11}$/.test(videoId);
}

/**
 * Validate URL is from googlevideo.com
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
    .replace(/[<>:"/\\|?*]/g, '') // Remove invalid chars
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .substring(0, 100); // Limit length
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
    // Validate settings
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
    // Set default settings on install
    saveSettings(getDefaultSettings());
  }
});

console.log('YouTube Video Optimizer background service worker loaded');
