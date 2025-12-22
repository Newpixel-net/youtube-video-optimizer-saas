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
  retryBtn: null,
  // Creator Tools elements
  tabBtns: null,
  tabContents: null,
  tagsContainer: null,
  tagsStats: null,
  tagCount: null,
  avgTagLength: null,
  copyAllTagsBtn: null,
  seoScoreCircle: null,
  seoCircle: null,
  seoScoreText: null,
  seoLabel: null,
  seoBreakdown: null,
  seoSuggestions: null,
  seoSuggestionsList: null,
  // Transcript elements
  transcriptContainer: null,
  transcriptStats: null,
  wordCount: null,
  segmentCount: null,
  copyTranscriptBtn: null
};

// State
let currentVideoInfo = null;
let currentVideoMetadata = null; // Extended metadata for tags/SEO
let isProcessing = false;
let currentTags = [];
let currentTranscript = null;

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
  // Creator Tools elements
  elements.tabBtns = document.querySelectorAll('.tab-btn');
  elements.tabContents = document.querySelectorAll('.tab-content');
  elements.tagsContainer = document.getElementById('tagsContainer');
  elements.tagsStats = document.getElementById('tagsStats');
  elements.tagCount = document.getElementById('tagCount');
  elements.avgTagLength = document.getElementById('avgTagLength');
  elements.copyAllTagsBtn = document.getElementById('copyAllTagsBtn');
  elements.seoScoreCircle = document.getElementById('seoScoreCircle');
  elements.seoCircle = document.getElementById('seoCircle');
  elements.seoScoreText = document.getElementById('seoScoreText');
  elements.seoLabel = document.getElementById('seoLabel');
  elements.seoBreakdown = document.getElementById('seoBreakdown');
  elements.seoSuggestions = document.getElementById('seoSuggestions');
  elements.seoSuggestionsList = document.getElementById('seoSuggestionsList');
  // Transcript elements
  elements.transcriptContainer = document.getElementById('transcriptContainer');
  elements.transcriptStats = document.getElementById('transcriptStats');
  elements.wordCount = document.getElementById('wordCount');
  elements.segmentCount = document.getElementById('segmentCount');
  elements.copyTranscriptBtn = document.getElementById('copyTranscriptBtn');
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

  // Creator Tools tab switching
  elements.tabBtns?.forEach(btn => {
    btn.addEventListener('click', () => handleTabSwitch(btn.dataset.tab));
  });

  // Copy all tags
  elements.copyAllTagsBtn?.addEventListener('click', handleCopyAllTags);

  // Copy transcript
  elements.copyTranscriptBtn?.addEventListener('click', handleCopyTranscript);
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

// ============================================
// CREATOR TOOLS - Tabs, Tags, SEO
// ============================================

/**
 * Handle tab switching
 */
function handleTabSwitch(tabName) {
  // Update button states
  elements.tabBtns?.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Update content visibility
  elements.tabContents?.forEach(content => {
    const isActive = content.id === `tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`;
    content.classList.toggle('active', isActive);
  });

  // Load data for the active tab if needed
  if (tabName === 'tags' && currentTags.length === 0 && currentVideoInfo) {
    loadVideoTags();
  }
  if (tabName === 'transcript' && !currentTranscript && currentVideoInfo) {
    loadTranscript();
  }
  if (tabName === 'seo' && currentVideoInfo) {
    loadSeoAnalysis();
  }
}

/**
 * Load video tags from the content script
 */
async function loadVideoTags() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    const response = await chrome.tabs.sendMessage(tab.id, { action: 'getVideoMetadata' });

    if (response?.success && response.metadata) {
      currentVideoMetadata = response.metadata;
      currentTags = response.metadata.tags || [];
      displayTags(currentTags);
    } else {
      displayNoTags('Could not extract tags from this video');
    }
  } catch (error) {
    console.error('Error loading tags:', error);
    displayNoTags('Failed to load video tags');
  }
}

/**
 * Display tags in the UI
 */
function displayTags(tags) {
  if (!elements.tagsContainer) return;

  if (!tags || tags.length === 0) {
    displayNoTags('This video has no public tags');
    return;
  }

  // Create tags list
  const tagsList = document.createElement('div');
  tagsList.className = 'tags-list';

  tags.forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `<span class="tag-icon">#</span>${sanitizeText(tag)}`;
    chip.title = 'Click to copy';
    chip.addEventListener('click', () => copyTag(chip, tag));
    tagsList.appendChild(chip);
  });

  elements.tagsContainer.innerHTML = '';
  elements.tagsContainer.appendChild(tagsList);

  // Show stats
  if (elements.tagsStats) {
    elements.tagsStats.classList.remove('hidden');
    if (elements.tagCount) elements.tagCount.textContent = tags.length;
    if (elements.avgTagLength) {
      const avgLen = Math.round(tags.reduce((sum, t) => sum + t.length, 0) / tags.length);
      elements.avgTagLength.textContent = avgLen;
    }
  }
}

/**
 * Display no tags message
 */
function displayNoTags(message) {
  if (!elements.tagsContainer) return;

  elements.tagsContainer.innerHTML = `
    <div class="no-tags">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
        <line x1="7" y1="7" x2="7.01" y2="7"/>
      </svg>
      <span>${sanitizeText(message)}</span>
    </div>
  `;

  if (elements.tagsStats) elements.tagsStats.classList.add('hidden');
}

/**
 * Copy a single tag to clipboard
 */
async function copyTag(element, tag) {
  try {
    await navigator.clipboard.writeText(tag);
    element.classList.add('copied');
    setTimeout(() => element.classList.remove('copied'), 1500);
  } catch (error) {
    console.error('Failed to copy tag:', error);
  }
}

/**
 * Handle copy all tags button
 */
async function handleCopyAllTags() {
  if (!currentTags || currentTags.length === 0) return;

  try {
    const tagsText = currentTags.join(', ');
    await navigator.clipboard.writeText(tagsText);

    // Visual feedback
    if (elements.copyAllTagsBtn) {
      elements.copyAllTagsBtn.classList.add('copied');
      const originalText = elements.copyAllTagsBtn.innerHTML;
      elements.copyAllTagsBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Copied!
      `;
      setTimeout(() => {
        elements.copyAllTagsBtn.classList.remove('copied');
        elements.copyAllTagsBtn.innerHTML = originalText;
      }, 2000);
    }
  } catch (error) {
    console.error('Failed to copy all tags:', error);
  }
}

/**
 * Load SEO analysis
 */
async function loadSeoAnalysis() {
  if (!currentVideoMetadata) {
    // Need to fetch metadata first
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getVideoMetadata' });
      if (response?.success && response.metadata) {
        currentVideoMetadata = response.metadata;
        currentTags = response.metadata.tags || [];
      }
    } catch (error) {
      console.error('Error loading metadata for SEO:', error);
      return;
    }
  }

  // Analyze and display SEO score
  const analysis = analyzeSeo(currentVideoInfo, currentVideoMetadata);
  displaySeoScore(analysis);
}

/**
 * Analyze video SEO
 */
function analyzeSeo(videoInfo, metadata) {
  const result = {
    overall: 0,
    title: { score: 0, hint: '', icon: '' },
    description: { score: 0, hint: '', icon: '' },
    tags: { score: 0, hint: '', icon: '' },
    thumbnail: { score: 0, hint: '', icon: '' },
    suggestions: []
  };

  // Title Analysis (0-25 points)
  const title = videoInfo?.title || '';
  const titleLength = title.length;
  if (titleLength >= 40 && titleLength <= 70) {
    result.title.score = 25;
    result.title.hint = `Perfect length (${titleLength} chars)`;
    result.title.icon = '✓';
  } else if (titleLength >= 30 && titleLength < 40) {
    result.title.score = 18;
    result.title.hint = `Good length (${titleLength} chars)`;
    result.title.icon = '○';
    result.suggestions.push('Consider a slightly longer title (40-70 chars optimal)');
  } else if (titleLength > 70 && titleLength <= 100) {
    result.title.score = 15;
    result.title.hint = `Slightly long (${titleLength} chars)`;
    result.title.icon = '○';
    result.suggestions.push('Title may be truncated in search results');
  } else if (titleLength < 30) {
    result.title.score = 10;
    result.title.hint = `Too short (${titleLength} chars)`;
    result.title.icon = '✗';
    result.suggestions.push('Add more descriptive keywords to your title');
  } else {
    result.title.score = 8;
    result.title.hint = `Too long (${titleLength} chars)`;
    result.title.icon = '✗';
    result.suggestions.push('Shorten your title to under 70 characters');
  }

  // Description Analysis (0-25 points)
  const description = metadata?.description || '';
  const descLength = description.length;
  if (descLength >= 200 && descLength <= 5000) {
    result.description.score = 25;
    result.description.hint = `Good length (${descLength} chars)`;
    result.description.icon = '✓';
  } else if (descLength >= 100 && descLength < 200) {
    result.description.score = 15;
    result.description.hint = `Could be longer (${descLength} chars)`;
    result.description.icon = '○';
    result.suggestions.push('Add more detail to your description (aim for 200+ chars)');
  } else if (descLength < 100) {
    result.description.score = 8;
    result.description.hint = `Too short (${descLength} chars)`;
    result.description.icon = '✗';
    result.suggestions.push('Write a detailed description with keywords');
  } else {
    result.description.score = 20;
    result.description.hint = `Very detailed (${descLength} chars)`;
    result.description.icon = '✓';
  }

  // Tags Analysis (0-25 points)
  const tags = metadata?.tags || [];
  const tagCount = tags.length;
  if (tagCount >= 8 && tagCount <= 15) {
    result.tags.score = 25;
    result.tags.hint = `Optimal count (${tagCount} tags)`;
    result.tags.icon = '✓';
  } else if (tagCount >= 5 && tagCount < 8) {
    result.tags.score = 18;
    result.tags.hint = `Good count (${tagCount} tags)`;
    result.tags.icon = '○';
    result.suggestions.push('Consider adding a few more relevant tags');
  } else if (tagCount > 15) {
    result.tags.score = 20;
    result.tags.hint = `Many tags (${tagCount} tags)`;
    result.tags.icon = '○';
  } else if (tagCount >= 1) {
    result.tags.score = 10;
    result.tags.hint = `Few tags (${tagCount} tags)`;
    result.tags.icon = '✗';
    result.suggestions.push('Add more tags to improve discoverability');
  } else {
    result.tags.score = 0;
    result.tags.hint = 'No tags found';
    result.tags.icon = '✗';
    result.suggestions.push('Add relevant tags to your video');
  }

  // Thumbnail Analysis (0-25 points) - Check if custom thumbnail exists
  const hasCustomThumbnail = metadata?.hasCustomThumbnail !== false;
  if (hasCustomThumbnail) {
    result.thumbnail.score = 25;
    result.thumbnail.hint = 'Custom thumbnail detected';
    result.thumbnail.icon = '✓';
  } else {
    result.thumbnail.score = 5;
    result.thumbnail.hint = 'Auto-generated thumbnail';
    result.thumbnail.icon = '✗';
    result.suggestions.push('Use a custom thumbnail for better CTR');
  }

  // Calculate overall score
  result.overall = result.title.score + result.description.score + result.tags.score + result.thumbnail.score;

  return result;
}

/**
 * Display SEO score in the UI
 */
function displaySeoScore(analysis) {
  const score = analysis.overall;

  // Determine score class
  let scoreClass = 'score-low';
  let scoreLabel = 'Needs Work';
  if (score >= 80) {
    scoreClass = 'score-excellent';
    scoreLabel = 'Excellent';
  } else if (score >= 60) {
    scoreClass = 'score-good';
    scoreLabel = 'Good';
  } else if (score >= 40) {
    scoreClass = 'score-medium';
    scoreLabel = 'Average';
  }

  // Update circle
  if (elements.seoScoreCircle) {
    elements.seoScoreCircle.className = 'seo-score-circle ' + scoreClass;
  }
  if (elements.seoCircle) {
    elements.seoCircle.style.strokeDasharray = `${score}, 100`;
  }
  if (elements.seoScoreText) {
    elements.seoScoreText.textContent = score;
  }
  if (elements.seoLabel) {
    elements.seoLabel.textContent = scoreLabel;
    elements.seoLabel.className = 'seo-label ' + scoreClass;
  }

  // Update breakdown items
  updateSeoItem('seoTitle', analysis.title);
  updateSeoItem('seoDescription', analysis.description);
  updateSeoItem('seoTags', analysis.tags);
  updateSeoItem('seoThumbnail', analysis.thumbnail);

  // Show suggestions
  if (analysis.suggestions.length > 0 && elements.seoSuggestions && elements.seoSuggestionsList) {
    elements.seoSuggestions.classList.remove('hidden');
    elements.seoSuggestionsList.innerHTML = analysis.suggestions
      .map(s => `<li>${sanitizeText(s)}</li>`)
      .join('');
  } else if (elements.seoSuggestions) {
    elements.seoSuggestions.classList.add('hidden');
  }
}

/**
 * Update an SEO breakdown item
 */
function updateSeoItem(elementId, data) {
  const element = document.getElementById(elementId);
  if (!element) return;

  // Determine score class
  let scoreClass = 'score-low';
  if (data.score >= 20) scoreClass = 'score-excellent';
  else if (data.score >= 15) scoreClass = 'score-good';
  else if (data.score >= 10) scoreClass = 'score-medium';

  element.className = 'seo-item ' + scoreClass;

  const iconEl = element.querySelector('.seo-item-icon');
  if (iconEl) iconEl.textContent = data.icon;

  const fillEl = element.querySelector('.seo-item-fill');
  if (fillEl) fillEl.style.width = `${(data.score / 25) * 100}%`;

  const hintEl = element.querySelector('.seo-item-hint');
  if (hintEl) hintEl.textContent = data.hint;
}

// ============================================
// TRANSCRIPT VIEWER
// ============================================

/**
 * Load transcript from content script
 */
async function loadTranscript() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    const response = await chrome.tabs.sendMessage(tab.id, { action: 'getTranscript' });

    if (response?.success && response.transcript) {
      currentTranscript = response.transcript;
      displayTranscript(response.transcript, tab.id);
    } else {
      displayNoTranscript(response?.error || 'No transcript available for this video');
    }
  } catch (error) {
    console.error('Error loading transcript:', error);
    displayNoTranscript('Failed to load transcript');
  }
}

/**
 * Display transcript in the UI
 */
function displayTranscript(transcript, tabId) {
  if (!elements.transcriptContainer) return;

  if (!transcript.segments || transcript.segments.length === 0) {
    displayNoTranscript('No transcript segments available');
    return;
  }

  // Create transcript list
  const listEl = document.createElement('div');
  listEl.className = 'transcript-list';

  transcript.segments.forEach(segment => {
    const segmentEl = document.createElement('div');
    segmentEl.className = 'transcript-segment';

    const timeEl = document.createElement('span');
    timeEl.className = 'transcript-time';
    timeEl.textContent = formatTimestamp(segment.start);
    timeEl.title = 'Click to jump to this time';
    timeEl.addEventListener('click', () => seekToTime(tabId, segment.start));

    const textEl = document.createElement('span');
    textEl.className = 'transcript-text';
    textEl.textContent = segment.text;

    segmentEl.appendChild(timeEl);
    segmentEl.appendChild(textEl);
    listEl.appendChild(segmentEl);
  });

  elements.transcriptContainer.innerHTML = '';
  elements.transcriptContainer.appendChild(listEl);

  // Show stats
  if (elements.transcriptStats) {
    elements.transcriptStats.classList.remove('hidden');

    // Count words
    const fullText = transcript.segments.map(s => s.text).join(' ');
    const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length;

    if (elements.wordCount) elements.wordCount.textContent = wordCount.toLocaleString();
    if (elements.segmentCount) elements.segmentCount.textContent = transcript.segments.length;
  }
}

/**
 * Display no transcript message
 */
function displayNoTranscript(message) {
  if (!elements.transcriptContainer) return;

  elements.transcriptContainer.innerHTML = `
    <div class="no-transcript">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <path d="M14 2v6h6"/>
        <line x1="12" y1="18" x2="12" y2="12"/>
        <line x1="9" y1="15" x2="15" y2="15"/>
      </svg>
      <span>${sanitizeText(message)}</span>
    </div>
  `;

  if (elements.transcriptStats) elements.transcriptStats.classList.add('hidden');
}

/**
 * Handle copy transcript button
 */
async function handleCopyTranscript() {
  if (!currentTranscript?.segments) return;

  try {
    // Format transcript with timestamps
    const text = currentTranscript.segments
      .map(s => `[${formatTimestamp(s.start)}] ${s.text}`)
      .join('\n');

    await navigator.clipboard.writeText(text);

    // Visual feedback
    if (elements.copyTranscriptBtn) {
      elements.copyTranscriptBtn.classList.add('copied');
      const originalText = elements.copyTranscriptBtn.innerHTML;
      elements.copyTranscriptBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Copied!
      `;
      setTimeout(() => {
        elements.copyTranscriptBtn.classList.remove('copied');
        elements.copyTranscriptBtn.innerHTML = originalText;
      }, 2000);
    }
  } catch (error) {
    console.error('Failed to copy transcript:', error);
  }
}

/**
 * Format seconds to timestamp (MM:SS or HH:MM:SS)
 */
function formatTimestamp(seconds) {
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Seek to a specific time in the video
 */
async function seekToTime(tabId, seconds) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'seekToTime',
      time: seconds
    });
  } catch (error) {
    console.error('Failed to seek to time:', error);
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
