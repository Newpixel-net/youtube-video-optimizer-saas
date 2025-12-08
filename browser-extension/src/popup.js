/**
 * YouTube Video Optimizer - Popup Script
 * Handles the popup UI and communication with content/background scripts
 *
 * Security: Uses strict CSP, validates all inputs, sanitizes data
 */

// DOM Elements
const elements = {
  statusIndicator: null,
  statusDot: null,
  statusText: null,
  notYoutube: null,
  videoSection: null,
  processingSection: null,
  successSection: null,
  errorSection: null,
  thumbnailImg: null,
  videoTitle: null,
  videoChannel: null,
  videoDuration: null,
  startTime: null,
  endTime: null,
  clipDuration: null,
  progressFill: null,
  progressText: null,
  processingStatus: null,
  errorMessage: null,
  captureBtn: null,
  openAppBtn: null,
  cancelBtn: null,
  processInAppBtn: null,
  captureAnotherBtn: null,
  retryBtn: null,
  settingsBtn: null
};

// State
let currentVideoInfo = null;
let isProcessing = false;
let videoDurationSeconds = 0;

// Constants
const APP_URL = 'https://youtube-video-optimizer.web.app';
const MAX_CLIP_DURATION = 60; // seconds for Shorts

/**
 * Initialize the popup
 */
async function init() {
  // Cache DOM elements
  cacheElements();

  // Attach event listeners
  attachEventListeners();

  // Check current tab
  await checkCurrentTab();
}

/**
 * Cache DOM elements for performance
 */
function cacheElements() {
  elements.statusIndicator = document.getElementById('statusIndicator');
  elements.statusDot = elements.statusIndicator?.querySelector('.status-dot');
  elements.statusText = elements.statusIndicator?.querySelector('.status-text');
  elements.notYoutube = document.getElementById('notYoutube');
  elements.videoSection = document.getElementById('videoSection');
  elements.processingSection = document.getElementById('processingSection');
  elements.successSection = document.getElementById('successSection');
  elements.errorSection = document.getElementById('errorSection');
  elements.thumbnailImg = document.getElementById('thumbnailImg');
  elements.videoTitle = document.getElementById('videoTitle');
  elements.videoChannel = document.getElementById('videoChannel');
  elements.videoDuration = document.getElementById('videoDuration');
  elements.startTime = document.getElementById('startTime');
  elements.endTime = document.getElementById('endTime');
  elements.clipDuration = document.getElementById('clipDuration');
  elements.progressFill = document.getElementById('progressFill');
  elements.progressText = document.getElementById('progressText');
  elements.processingStatus = document.getElementById('processingStatus');
  elements.errorMessage = document.getElementById('errorMessage');
  elements.captureBtn = document.getElementById('captureBtn');
  elements.openAppBtn = document.getElementById('openAppBtn');
  elements.cancelBtn = document.getElementById('cancelBtn');
  elements.processInAppBtn = document.getElementById('processInAppBtn');
  elements.captureAnotherBtn = document.getElementById('captureAnotherBtn');
  elements.retryBtn = document.getElementById('retryBtn');
  elements.settingsBtn = document.getElementById('settingsBtn');
}

/**
 * Attach event listeners
 */
function attachEventListeners() {
  elements.captureBtn?.addEventListener('click', handleCapture);
  elements.openAppBtn?.addEventListener('click', handleOpenApp);
  elements.cancelBtn?.addEventListener('click', handleCancel);
  elements.processInAppBtn?.addEventListener('click', handleProcessInApp);
  elements.captureAnotherBtn?.addEventListener('click', handleCaptureAnother);
  elements.retryBtn?.addEventListener('click', handleRetry);
  elements.settingsBtn?.addEventListener('click', handleSettings);

  // Time input handlers
  elements.startTime?.addEventListener('input', handleTimeInput);
  elements.startTime?.addEventListener('blur', formatTimeInput);
  elements.endTime?.addEventListener('input', handleTimeInput);
  elements.endTime?.addEventListener('blur', formatTimeInput);
}

/**
 * Check if current tab is a YouTube video page
 */
async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url) {
      showNotYoutube();
      return;
    }

    const url = new URL(tab.url);
    const isYoutube = url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com';
    const isVideoPage = url.pathname === '/watch' && url.searchParams.has('v');

    if (!isYoutube || !isVideoPage) {
      showNotYoutube();
      return;
    }

    // Get video info from content script
    await getVideoInfo(tab.id);

  } catch (error) {
    console.error('Error checking tab:', error);
    showNotYoutube();
  }
}

/**
 * Get video information from content script
 */
async function getVideoInfo(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'getVideoInfo' });

    if (response?.success && response.videoInfo) {
      currentVideoInfo = response.videoInfo;
      displayVideoInfo(response.videoInfo);
      showVideoSection();
    } else {
      showError(response?.error || 'Failed to get video information');
    }
  } catch (error) {
    console.error('Error getting video info:', error);
    // Content script may not be loaded yet
    showError('Please refresh the YouTube page and try again');
  }
}

/**
 * Display video information in the popup
 */
function displayVideoInfo(videoInfo) {
  // Sanitize and display
  if (elements.thumbnailImg) {
    // Validate thumbnail URL
    if (videoInfo.thumbnail && isValidThumbnailUrl(videoInfo.thumbnail)) {
      elements.thumbnailImg.src = videoInfo.thumbnail;
    }
  }

  if (elements.videoTitle) {
    elements.videoTitle.textContent = sanitizeText(videoInfo.title || 'Unknown Title');
  }

  if (elements.videoChannel) {
    elements.videoChannel.textContent = sanitizeText(videoInfo.channel || 'Unknown Channel');
  }

  if (elements.videoDuration) {
    videoDurationSeconds = videoInfo.duration || 0;
    elements.videoDuration.textContent = formatDuration(videoDurationSeconds);
  }

  // Set default clip range
  if (elements.startTime) {
    elements.startTime.value = '0:00';
  }

  if (elements.endTime) {
    const endSeconds = Math.min(30, videoDurationSeconds);
    elements.endTime.value = formatDuration(endSeconds);
  }

  updateClipDuration();
}

/**
 * Validate thumbnail URL (only allow YouTube/Google domains)
 */
function isValidThumbnailUrl(url) {
  try {
    const parsed = new URL(url);
    const validHosts = ['i.ytimg.com', 'img.youtube.com', 'i9.ytimg.com'];
    return validHosts.some(host => parsed.hostname === host || parsed.hostname.endsWith('.' + host));
  } catch {
    return false;
  }
}

/**
 * Sanitize text to prevent XSS
 */
function sanitizeText(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.textContent;
}

/**
 * Handle time input changes
 */
function handleTimeInput(e) {
  // Only allow numbers and colons
  e.target.value = e.target.value.replace(/[^0-9:]/g, '');
  updateClipDuration();
}

/**
 * Format time input on blur
 */
function formatTimeInput(e) {
  const seconds = parseTimeToSeconds(e.target.value);
  e.target.value = formatDuration(seconds);
  updateClipDuration();
}

/**
 * Update clip duration display
 */
function updateClipDuration() {
  const startSeconds = parseTimeToSeconds(elements.startTime?.value || '0:00');
  const endSeconds = parseTimeToSeconds(elements.endTime?.value || '0:30');

  let duration = endSeconds - startSeconds;

  if (duration < 0) duration = 0;
  if (duration > videoDurationSeconds) duration = videoDurationSeconds;

  if (elements.clipDuration) {
    elements.clipDuration.textContent = `${duration}s`;

    // Add warning if over 60 seconds
    if (duration > MAX_CLIP_DURATION) {
      elements.clipDuration.classList.add('duration-warning');
    } else {
      elements.clipDuration.classList.remove('duration-warning');
    }
  }
}

/**
 * Parse time string to seconds
 */
function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;

  const parts = timeStr.split(':').map(p => parseInt(p, 10) || 0);

  if (parts.length === 3) {
    // H:MM:SS
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    // M:SS
    return parts[0] * 60 + parts[1];
  } else {
    // Just seconds
    return parts[0] || 0;
  }
}

/**
 * Format seconds to time string
 */
function formatDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds));

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Handle capture button click
 */
async function handleCapture() {
  if (isProcessing || !currentVideoInfo) return;

  const startSeconds = parseTimeToSeconds(elements.startTime?.value || '0:00');
  const endSeconds = parseTimeToSeconds(elements.endTime?.value || '0:30');
  const quality = document.querySelector('input[name="quality"]:checked')?.value || '720';

  // Validate
  if (startSeconds >= endSeconds) {
    showError('Start time must be before end time');
    return;
  }

  if (endSeconds > videoDurationSeconds) {
    showError('End time exceeds video duration');
    return;
  }

  const duration = endSeconds - startSeconds;
  if (duration > 300) { // 5 minutes max
    showError('Clip duration cannot exceed 5 minutes');
    return;
  }

  isProcessing = true;
  showProcessing();

  try {
    // Send capture request to background script
    const response = await chrome.runtime.sendMessage({
      action: 'captureVideo',
      videoInfo: currentVideoInfo,
      startTime: startSeconds,
      endTime: endSeconds,
      quality: quality
    });

    if (response?.success) {
      showSuccess();
    } else {
      showError(response?.error || 'Capture failed');
    }
  } catch (error) {
    console.error('Capture error:', error);
    showError(error.message || 'An error occurred during capture');
  } finally {
    isProcessing = false;
  }
}

/**
 * Handle cancel button click
 */
function handleCancel() {
  isProcessing = false;
  chrome.runtime.sendMessage({ action: 'cancelCapture' });
  showVideoSection();
}

/**
 * Handle open app button click
 */
function handleOpenApp() {
  chrome.tabs.create({ url: APP_URL });
}

/**
 * Handle process in app button click
 */
function handleProcessInApp() {
  // Open app with video URL
  if (currentVideoInfo?.url) {
    const appUrl = `${APP_URL}?video=${encodeURIComponent(currentVideoInfo.url)}`;
    chrome.tabs.create({ url: appUrl });
  } else {
    chrome.tabs.create({ url: APP_URL });
  }
}

/**
 * Handle capture another button click
 */
function handleCaptureAnother() {
  showVideoSection();
}

/**
 * Handle retry button click
 */
function handleRetry() {
  showVideoSection();
}

/**
 * Handle settings button click
 */
function handleSettings() {
  // Open options page if exists, otherwise show alert
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
}

/**
 * UI State Management
 */
function showNotYoutube() {
  hideAllSections();
  elements.notYoutube?.classList.remove('hidden');
  updateStatus('warning', 'Not on YouTube');
}

function showVideoSection() {
  hideAllSections();
  elements.videoSection?.classList.remove('hidden');
  updateStatus('ready', 'Ready');
}

function showProcessing() {
  hideAllSections();
  elements.processingSection?.classList.remove('hidden');
  updateStatus('processing', 'Processing...');
  updateProgress(0, 'Initializing...');
}

function showSuccess() {
  hideAllSections();
  elements.successSection?.classList.remove('hidden');
  updateStatus('ready', 'Done');
}

function showError(message) {
  hideAllSections();
  elements.errorSection?.classList.remove('hidden');
  if (elements.errorMessage) {
    elements.errorMessage.textContent = sanitizeText(message);
  }
  updateStatus('error', 'Error');
}

function hideAllSections() {
  elements.notYoutube?.classList.add('hidden');
  elements.videoSection?.classList.add('hidden');
  elements.processingSection?.classList.add('hidden');
  elements.successSection?.classList.add('hidden');
  elements.errorSection?.classList.add('hidden');
}

function updateStatus(status, text) {
  if (elements.statusDot) {
    elements.statusDot.className = 'status-dot';
    if (status === 'error') elements.statusDot.classList.add('error');
    if (status === 'warning') elements.statusDot.classList.add('warning');
  }
  if (elements.statusText) {
    elements.statusText.textContent = text;
  }
}

function updateProgress(percent, statusText) {
  if (elements.progressFill) {
    elements.progressFill.style.width = `${percent}%`;
  }
  if (elements.progressText) {
    elements.progressText.textContent = `${Math.round(percent)}%`;
  }
  if (elements.processingStatus && statusText) {
    elements.processingStatus.textContent = statusText;
  }
}

/**
 * Listen for progress updates from background script
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'progressUpdate') {
    updateProgress(message.percent, message.status);
  } else if (message.action === 'captureComplete') {
    isProcessing = false;
    if (message.success) {
      showSuccess();
    } else {
      showError(message.error || 'Capture failed');
    }
  }
});

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
