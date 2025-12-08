/**
 * YouTube Video Optimizer - Popup Script
 * Handles the popup UI and Video Wizard integration
 */

// DOM Elements
const elements = {
  statusIndicator: null,
  statusDot: null,
  statusText: null,
  wizardActive: null,
  youtubeReady: null,
  notYoutube: null,
  processingSection: null,
  successSection: null,
  errorSection: null,
  thumbnailImg: null,
  videoTitle: null,
  videoChannel: null,
  videoDuration: null,
  progressFill: null,
  progressText: null,
  processingStatus: null,
  errorMessage: null,
  sendToWizardBtn: null,
  openWizardBtn: null,
  openWizardSuccessBtn: null,
  cancelBtn: null,
  captureAnotherBtn: null,
  retryBtn: null
};

// State
let currentVideoInfo = null;
let isProcessing = false;

// Constants
const WIZARD_URL = 'https://ytseo.siteuo.com/video-wizard.html';
const WIZARD_HOSTS = ['ytseo.siteuo.com', 'youtube-video-optimizer.web.app', 'ytseo-6d1b0.web.app'];

/**
 * Initialize the popup
 */
async function init() {
  cacheElements();
  attachEventListeners();
  await checkCurrentTab();
}

/**
 * Cache DOM elements
 */
function cacheElements() {
  elements.statusIndicator = document.getElementById('statusIndicator');
  elements.statusDot = elements.statusIndicator?.querySelector('.status-dot');
  elements.statusText = elements.statusIndicator?.querySelector('.status-text');
  elements.wizardActive = document.getElementById('wizardActive');
  elements.youtubeReady = document.getElementById('youtubeReady');
  elements.notYoutube = document.getElementById('notYoutube');
  elements.processingSection = document.getElementById('processingSection');
  elements.successSection = document.getElementById('successSection');
  elements.errorSection = document.getElementById('errorSection');
  elements.thumbnailImg = document.getElementById('thumbnailImg');
  elements.videoTitle = document.getElementById('videoTitle');
  elements.videoChannel = document.getElementById('videoChannel');
  elements.videoDuration = document.getElementById('videoDuration');
  elements.progressFill = document.getElementById('progressFill');
  elements.progressText = document.getElementById('progressText');
  elements.processingStatus = document.getElementById('processingStatus');
  elements.errorMessage = document.getElementById('errorMessage');
  elements.sendToWizardBtn = document.getElementById('sendToWizardBtn');
  elements.openWizardBtn = document.getElementById('openWizardBtn');
  elements.openWizardSuccessBtn = document.getElementById('openWizardSuccessBtn');
  elements.cancelBtn = document.getElementById('cancelBtn');
  elements.captureAnotherBtn = document.getElementById('captureAnotherBtn');
  elements.retryBtn = document.getElementById('retryBtn');
}

/**
 * Attach event listeners
 */
function attachEventListeners() {
  elements.sendToWizardBtn?.addEventListener('click', handleSendToWizard);
  elements.openWizardBtn?.addEventListener('click', handleOpenWizard);
  elements.openWizardSuccessBtn?.addEventListener('click', handleOpenWizard);
  elements.cancelBtn?.addEventListener('click', handleCancel);
  elements.captureAnotherBtn?.addEventListener('click', handleCaptureAnother);
  elements.retryBtn?.addEventListener('click', handleRetry);
}

/**
 * Check current tab and show appropriate UI
 */
async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url) {
      showNotYoutube();
      return;
    }

    const url = new URL(tab.url);

    // Check if on Video Wizard
    if (WIZARD_HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) {
      showWizardActive();
      return;
    }

    // Check if on YouTube video page
    const isYoutube = url.hostname === 'www.youtube.com' || url.hostname === 'youtube.com';
    const isVideoPage = url.pathname === '/watch' && url.searchParams.has('v');
    const isShortsPage = url.pathname.startsWith('/shorts/');

    if (isYoutube && (isVideoPage || isShortsPage)) {
      await getVideoInfo(tab.id);
      return;
    }

    showNotYoutube();

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
      showYoutubeReady();
    } else {
      showError(response?.error || 'Failed to get video information');
    }
  } catch (error) {
    console.error('Error getting video info:', error);
    showError('Please refresh the YouTube page and try again');
  }
}

/**
 * Display video information
 */
function displayVideoInfo(videoInfo) {
  if (elements.thumbnailImg && videoInfo.thumbnail) {
    if (isValidThumbnailUrl(videoInfo.thumbnail)) {
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
    elements.videoDuration.textContent = formatDuration(videoInfo.duration || 0);
  }
}

/**
 * Validate thumbnail URL
 */
function isValidThumbnailUrl(url) {
  try {
    const parsed = new URL(url);
    return ['i.ytimg.com', 'img.youtube.com', 'i9.ytimg.com'].some(
      host => parsed.hostname === host || parsed.hostname.endsWith('.' + host)
    );
  } catch {
    return false;
  }
}

/**
 * Sanitize text
 */
function sanitizeText(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.textContent;
}

/**
 * Format duration to time string
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
 * Handle send to wizard button
 */
async function handleSendToWizard() {
  if (isProcessing || !currentVideoInfo) return;

  isProcessing = true;
  showProcessing();

  try {
    // Store video info for wizard to retrieve
    await chrome.runtime.sendMessage({
      action: 'storeVideoForWizard',
      videoData: {
        videoInfo: currentVideoInfo,
        capturedAt: Date.now()
      }
    });

    updateProgress(50, 'Video info captured...');

    // Open Video Wizard with the video URL
    const videoUrl = currentVideoInfo.url || `https://www.youtube.com/watch?v=${currentVideoInfo.videoId}`;
    const wizardUrl = `${WIZARD_URL}?youtube=${encodeURIComponent(videoUrl)}`;

    await chrome.tabs.create({ url: wizardUrl });

    updateProgress(100, 'Complete!');
    showSuccess();

  } catch (error) {
    console.error('Send to wizard error:', error);
    showError(error.message || 'Failed to send to Video Wizard');
  } finally {
    isProcessing = false;
  }
}

/**
 * Handle open wizard button
 */
function handleOpenWizard() {
  chrome.tabs.create({ url: WIZARD_URL });
}

/**
 * Handle cancel button
 */
function handleCancel() {
  isProcessing = false;
  chrome.runtime.sendMessage({ action: 'cancelCapture' });
  checkCurrentTab();
}

/**
 * Handle capture another button
 */
function handleCaptureAnother() {
  checkCurrentTab();
}

/**
 * Handle retry button
 */
function handleRetry() {
  checkCurrentTab();
}

/**
 * UI State Management
 */
function hideAllSections() {
  elements.wizardActive?.classList.add('hidden');
  elements.youtubeReady?.classList.add('hidden');
  elements.notYoutube?.classList.add('hidden');
  elements.processingSection?.classList.add('hidden');
  elements.successSection?.classList.add('hidden');
  elements.errorSection?.classList.add('hidden');
}

function showWizardActive() {
  hideAllSections();
  elements.wizardActive?.classList.remove('hidden');
  updateStatus('ready', 'Connected');
}

function showYoutubeReady() {
  hideAllSections();
  elements.youtubeReady?.classList.remove('hidden');
  updateStatus('ready', 'Ready');
}

function showNotYoutube() {
  hideAllSections();
  elements.notYoutube?.classList.remove('hidden');
  updateStatus('warning', 'Inactive');
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
