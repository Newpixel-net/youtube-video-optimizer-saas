/**
 * YouTube Video Optimizer - Background Service Worker
 * Handles video capture and Video Wizard integration
 *
 * Security: Validates all inputs, uses secure fetch, sanitizes data
 */

console.log('[EXT][BG] Service worker starting...');

// Global error handler to catch any unhandled errors
self.addEventListener('error', (event) => {
  console.error('[EXT][BG] Unhandled error:', event.error);
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('[EXT][BG] Unhandled promise rejection:', event.reason);
});

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

// Video Processor Service URL for uploading captured streams
// The extension downloads video streams (which are IP-restricted to user's browser)
// and uploads them to our server, bypassing the IP restriction
const VIDEO_PROCESSOR_URL = 'https://video-processor-382790048044.us-central1.run.app';

// ============================================
// CAPTURE PROGRESS OVERLAY HELPERS
// Send progress updates to content script on YouTube page
// ============================================

/**
 * Send capture progress update to the YouTube tab's content script
 * This shows the visual overlay on the YouTube page
 */
async function sendCaptureProgress(tabId, options) {
  if (!tabId) {
    console.log('[EXT][BG] sendCaptureProgress: No tabId provided');
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'updateCaptureProgress',
      ...options
    });
  } catch (err) {
    // Ignore errors - content script might not be ready
    console.log('[EXT][BG] sendCaptureProgress error (non-fatal):', err.message);
  }
}

/**
 * Show the capture progress overlay on YouTube tab
 */
async function showCaptureOverlay(tabId, startTime, endTime) {
  if (!tabId) return;

  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'showCaptureProgress',
      startTime,
      endTime
    });
    console.log(`[EXT][BG] Capture overlay shown on tab ${tabId}`);
  } catch (err) {
    console.log('[EXT][BG] showCaptureOverlay error (non-fatal):', err.message);
  }
}

/**
 * Hide the capture progress overlay
 */
async function hideCaptureOverlay(tabId) {
  if (!tabId) return;

  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'hideCaptureProgress'
    });
  } catch (err) {
    // Ignore
  }
}

/**
 * Show capture completion on overlay
 */
async function showCaptureComplete(tabId, message = 'Capture complete!') {
  if (!tabId) return;

  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'captureComplete',
      message
    });
  } catch (err) {
    // Ignore
  }
}

/**
 * Show capture error on overlay
 */
async function showCaptureError(tabId, message = 'Capture failed') {
  if (!tabId) return;

  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'captureError',
      message
    });
  } catch (err) {
    // Ignore
  }
}

/**
 * Format seconds to MM:SS or HH:MM:SS for overlay display
 */
function formatTimeForOverlay(seconds) {
  if (seconds === undefined || seconds === null) return '--:--';
  seconds = Math.round(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ============================================
// END CAPTURE PROGRESS OVERLAY HELPERS
// ============================================

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
      // Extended itag list for comprehensive format coverage
      const videoItags = [
        // Legacy formats (progressive)
        '18', '22', '37', '38',
        // 3D formats
        '82', '83', '84', '85',
        // DASH video (H.264)
        '133', '134', '135', '136', '137', '138', // 240p-4320p
        '160', // 144p
        '264', '266', // 1440p, 2160p
        '298', '299', // 720p60, 1080p60
        '304', '305', // 1440p60, 2160p60
        // DASH video (VP9)
        '242', '243', '244', '247', '248', // 240p-1080p
        '271', '272', // 1440p, 2160p
        '278', // 144p
        '302', '303', // 720p60, 1080p60
        '308', // 1440p60
        '313', '315', // 2160p, 2160p60
        // DASH video (VP9 HDR)
        '330', '331', '332', '333', '334', '335', '336', '337',
        // DASH video (AV1)
        '394', '395', '396', '397', '398', '399', '400', '401', '402',
        '571', '694', '695', '696', '697', '698', '699', '700', '701', '702'
      ];
      const audioItags = [
        // DASH audio (AAC)
        '139', '140', '141',
        // DASH audio (Vorbis)
        '171', '172',
        // DASH audio (Opus)
        '249', '250', '251',
        // DASH audio (AAC HE)
        '256', '258',
        // DASH audio (AC3/EAC3)
        '325', '328'
      ];
      const isVideo = mime?.startsWith('video/') || videoItags.includes(itag);
      const isAudio = mime?.startsWith('audio/') || audioItags.includes(itag);

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
 * Keep service worker alive during operations
 * Chrome service workers can terminate after 30s of inactivity
 */
let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    // Just access chrome.runtime to keep the service worker alive
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000); // Every 20 seconds
  console.log('[EXT][BG] Keep-alive started');
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
    console.log('[EXT][BG] Keep-alive stopped');
  }
}

/**
 * Message handler for extension communication
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Log EVERY message immediately for debugging
  console.log('[EXT][BG] ========================================');
  console.log('[EXT][BG] === MESSAGE RECEIVED ===');
  console.log('[EXT][BG] Action:', message?.action);
  console.log('[EXT][BG] From:', sender?.url || sender?.origin || 'unknown');
  console.log('[EXT][BG] ========================================');

  try {
    switch (message.action) {
      // Video Wizard integration
      case 'captureVideoForWizard':
        console.log('[EXT][BG] Handling captureVideoForWizard...');
        console.log('[EXT][BG] Message details:', JSON.stringify(message).substring(0, 300));

        // Start keep-alive to prevent service worker termination during capture
        startKeepAlive();

        // IMMEDIATELY acknowledge the request - don't wait for capture to complete
        // This prevents "message channel closed" errors from Chrome's service worker limits
        // The actual result will be stored in chrome.storage and polled by wizard-bridge
        sendResponse({ acknowledged: true, bridgeRequestId: message.bridgeRequestId });

        // Start capture asynchronously - result goes to chrome.storage
        handleCaptureForWizard(message).catch(err => {
          console.error('[EXT][BG] Capture error:', err.message);
        }).finally(() => {
          // Stop keep-alive when capture completes
          stopKeepAlive();
        });
        return false; // Channel can close now - we use storage for result

    case 'getStoredVideoData':
      const hasData = !!storedVideoData?.streamData?.videoData;
      const dataSize = storedVideoData?.streamData?.videoData?.length || 0;
      console.log(`[EXT][BG] getStoredVideoData: hasData=${hasData}, size=${(dataSize / 1024 / 1024).toFixed(2)}MB`);
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

    case 'openViralClipDetector':
      // Open the web app for viral clip detection
      // Get current tab's video ID and open wizard with it
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const currentTab = tabs[0];
        let wizardUrl = 'https://ytseo.siteuo.com';

        // If on a YouTube video page, pass the video URL
        if (currentTab?.url?.includes('youtube.com/watch')) {
          const videoUrl = encodeURIComponent(currentTab.url);
          wizardUrl = `https://ytseo.siteuo.com/?video=${videoUrl}`;
        }

        chrome.tabs.create({ url: wizardUrl });
      });
      sendResponse({ success: true });
      return false;

    default:
      console.log('[EXT][BG] Unknown action:', message?.action);
      return false;
    }
  } catch (error) {
    console.error('[EXT][BG] Error in message handler:', error);
    sendResponse({ success: false, error: error.message });
    return false;
  }
});

console.log('[EXT][BG] Service worker ready, message listener registered');

/**
 * Handle video capture request from Video Wizard
 * EXTENSION-ONLY CAPTURE - MediaRecorder is the primary method
 * Results are stored in chrome.storage for wizard-bridge to poll
 *
 * NOW SUPPORTS: Segment capture with startTime/endTime parameters
 */
async function handleCaptureForWizard(message) {
  const { videoId, youtubeUrl, autoCapture = true, startTime, endTime, quality, autoOpenTab = false, bridgeRequestId } = message;

  console.log(`[EXT][CAPTURE] === START === videoId=${videoId} autoCapture=${autoCapture} autoOpenTab=${autoOpenTab} bridgeRequestId=${bridgeRequestId || 'none'}`);

  // Store result in chrome.storage - wizard-bridge polls this for the result
  // This is the ONLY reliable way to return results from long-running operations
  // because Chrome's message channels timeout after ~30 seconds
  let responseSent = false;
  const storeResult = async (response) => {
    if (responseSent) {
      console.log('[EXT][CAPTURE] Result already stored, ignoring duplicate');
      return;
    }
    responseSent = true;

    // Calculate response size for diagnostics
    let responseSize = 0;
    try {
      responseSize = JSON.stringify(response).length;
    } catch (e) {
      responseSize = -1;
    }
    const sizeMB = (responseSize / 1024 / 1024).toFixed(2);
    console.log(`[EXT][CAPTURE] === RESULT === success=${response?.success} error=${response?.error || 'none'} size=${sizeMB}MB`);

    // Store result in chrome.storage - this is the PRIMARY communication method
    if (bridgeRequestId) {
      try {
        const storagePayload = {
          [`bridge_result_${bridgeRequestId}`]: {
            response: response,
            timestamp: Date.now()
          }
        };
        await chrome.storage.local.set(storagePayload);
        console.log(`[EXT][CAPTURE] Result stored in chrome.storage (bridgeRequestId=${bridgeRequestId}, size=${sizeMB}MB)`);
      } catch (storageError) {
        console.error('[EXT][CAPTURE] CRITICAL: Failed to store result in chrome.storage:', storageError.message);

        // If storage fails due to quota, try storing without video data
        if (response?.streamData?.videoData && (storageError.message.includes('quota') || storageError.message.includes('QUOTA'))) {
          console.log('[EXT][CAPTURE] Storage quota exceeded, trying to store without video data...');
          try {
            const lightResponse = {
              ...response,
              streamData: {
                ...response.streamData,
                videoData: null,
                videoDataTooLarge: true,
                originalVideoSize: response.streamData.videoSize
              }
            };
            await chrome.storage.local.set({
              [`bridge_result_${bridgeRequestId}`]: {
                response: lightResponse,
                timestamp: Date.now()
              }
            });
            console.log(`[EXT][CAPTURE] Light result stored (without video data)`);
            return;
          } catch (lightError) {
            console.error('[EXT][CAPTURE] Even light storage failed:', lightError.message);
          }
        }

        // Try one more time after a short delay
        try {
          await new Promise(resolve => setTimeout(resolve, 500));
          await chrome.storage.local.set({
            [`bridge_result_${bridgeRequestId}`]: {
              response: response,
              timestamp: Date.now()
            }
          });
          console.log(`[EXT][CAPTURE] Result stored on retry`);
        } catch (retryError) {
          console.error('[EXT][CAPTURE] Storage retry also failed:', retryError.message);
        }
      }
    } else {
      console.warn('[EXT][CAPTURE] No bridgeRequestId - result will be lost!');
    }
  };

  // Helper: Promise with timeout
  const withTimeout = (promise, ms, errorMsg) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms))
    ]);
  };

  // Validate video ID
  if (!videoId || !isValidVideoId(videoId)) {
    console.error('[EXT][CAPTURE] FAIL: Invalid video ID');
    await storeResult({ success: false, error: 'Invalid video ID', code: 'INVALID_VIDEO_ID' });
    return;
  }

  // If autoCapture is false, only return video metadata
  if (autoCapture === false) {
    console.log(`[EXT][CAPTURE] autoCapture=false - returning metadata only`);
    try {
      const videoInfo = await getBasicVideoInfo(videoId, youtubeUrl);
      await storeResult({
        success: true,
        videoInfo: videoInfo,
        streamData: null,
        message: 'Video info retrieved (capture skipped - autoCapture=false)'
      });
    } catch (infoError) {
      console.error(`[EXT][CAPTURE] Failed to get video info: ${infoError.message}`);
      await storeResult({
        success: false,
        error: `Failed to get video info: ${infoError.message}`,
        code: 'VIDEO_INFO_FAILED'
      });
    }
    return;
  }

  try {
    // STEP 1: Find YouTube tab with this video
    console.log(`[EXT][CAPTURE] Looking for YouTube tab with video ${videoId}...`);
    const tabs = await chrome.tabs.query({
      url: ['*://www.youtube.com/*', '*://youtube.com/*']
    });

    let youtubeTab = tabs.find(tab => {
      try {
        const url = new URL(tab.url);
        return url.searchParams.get('v') === videoId ||
               tab.url.includes(`/shorts/${videoId}`) ||
               tab.url.includes(`/embed/${videoId}`);
      } catch {
        return false;
      }
    });

    // Track if we auto-opened a tab (so we can close it after capture)
    let autoOpenedTabId = null;
    // Track the original tab (Video Wizard) to switch back to it
    let originalTabId = null;

    if (!youtubeTab) {
      console.log(`[EXT][CAPTURE] No YouTube tab found with video ${videoId}`);

      if (autoOpenTab) {
        // AUTO-OPEN: Create a new tab with the video
        console.log(`[EXT][CAPTURE] autoOpenTab=true, opening new YouTube tab in background...`);
        const videoUrl = youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`;

        try {
          // Save current tab so we can switch back to it
          const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          originalTabId = currentTab?.id;
          const currentTabIndex = currentTab?.index ?? 0;
          console.log(`[EXT][CAPTURE] Saved original tab ${originalTabId} at index ${currentTabIndex} (will switch back after video loads)`);

          // Create tab - needs to be active briefly for Chrome autoplay policy
          // But we'll switch back to Video Wizard immediately after video loads
          // Create it right next to the Video Wizard tab for better UX
          const newTab = await chrome.tabs.create({
            url: videoUrl,
            active: true,  // Briefly active for autoplay to work
            index: currentTabIndex + 1  // Open right next to Video Wizard
          });
          autoOpenedTabId = newTab.id;
          youtubeTab = newTab;

          console.log(`[EXT][CAPTURE] Created new tab ${newTab.id}, waiting for video to load...`);

          // Wait for the page to load and video to initialize
          // We need to wait longer for YouTube to fully load its player
          await new Promise(resolve => setTimeout(resolve, 5000));

          // Inject content script into the new tab
          try {
            await chrome.scripting.executeScript({
              target: { tabId: newTab.id },
              files: ['src/content.js']
            });
            console.log(`[EXT][CAPTURE] Content script injected into new tab`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (injectError) {
            console.warn(`[EXT][CAPTURE] Content script injection into new tab failed: ${injectError.message}`);
          }

          // Verify the tab has the video loaded
          let videoReady = false;
          for (let attempt = 1; attempt <= 5; attempt++) {
            console.log(`[EXT][CAPTURE] Checking video readiness (attempt ${attempt}/5)...`);
            try {
              const checkResult = await withTimeout(
                chrome.tabs.sendMessage(newTab.id, { action: 'getVideoInfo' }),
                3000,
                'Video check timeout'
              );
              if (checkResult?.success && checkResult?.videoInfo?.readyState >= 2) {
                videoReady = true;
                console.log(`[EXT][CAPTURE] Video is ready! readyState=${checkResult.videoInfo.readyState}`);
                break;
              }
              console.log(`[EXT][CAPTURE] Video not ready yet: readyState=${checkResult?.videoInfo?.readyState || 0}`);
            } catch (e) {
              console.log(`[EXT][CAPTURE] Video check failed: ${e.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
          }

          if (!videoReady) {
            console.warn(`[EXT][CAPTURE] Video may not be fully loaded, proceeding anyway...`);
          }

          // IMMEDIATELY switch back to Video Wizard tab so user isn't disrupted
          // The capture will continue in the background
          if (originalTabId) {
            try {
              await chrome.tabs.update(originalTabId, { active: true });
              console.log(`[EXT][CAPTURE] Switched back to Video Wizard tab ${originalTabId}`);
            } catch (switchError) {
              console.warn(`[EXT][CAPTURE] Could not switch back to original tab: ${switchError.message}`);
            }
          }

        } catch (tabError) {
          console.error(`[EXT][CAPTURE] Failed to create YouTube tab: ${tabError.message}`);
          await storeResult({
            success: false,
            error: 'Failed to open YouTube video tab: ' + tabError.message,
            code: 'TAB_OPEN_FAILED',
            videoInfo: await getBasicVideoInfo(videoId, youtubeUrl)
          });
          return;
        }
      } else {
        // No autoOpenTab, return error asking user to open the video
        await storeResult({
          success: false,
          error: 'Please open this video on YouTube first, then try exporting again.',
          code: 'NO_YOUTUBE_TAB',
          videoInfo: await getBasicVideoInfo(videoId, youtubeUrl),
          details: {
            message: 'The extension needs the video to be open in a YouTube tab to capture it.',
            youtubeUrl: youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`,
            canAutoOpen: true  // Tell frontend it can retry with autoOpenTab=true
          }
        });
        return;
      }
    }

    console.log(`[EXT][CAPTURE] Using YouTube tab ${youtubeTab.id} (autoOpened=${!!autoOpenedTabId})`);

    // STEP 2: Ensure content script is loaded (with timeout)
    console.log(`[EXT][CAPTURE] Ensuring content script is loaded...`);
    let contentScriptReady = false;

    try {
      // Try to ping the content script
      const pingResult = await withTimeout(
        chrome.tabs.sendMessage(youtubeTab.id, { action: 'getVideoInfo' }),
        3000,
        'Content script ping timeout'
      );
      contentScriptReady = pingResult?.success === true;
      console.log(`[EXT][CAPTURE] Content script ping: ${contentScriptReady ? 'OK' : 'FAILED'}`);
    } catch (pingError) {
      console.log(`[EXT][CAPTURE] Content script not responding: ${pingError.message}`);
    }

    if (!contentScriptReady) {
      // Inject content script
      console.log(`[EXT][CAPTURE] Injecting content script...`);
      try {
        await chrome.scripting.executeScript({
          target: { tabId: youtubeTab.id },
          files: ['src/content.js']
        });
        console.log(`[EXT][CAPTURE] Content script injected, waiting for init...`);
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Verify injection worked
        const verifyResult = await withTimeout(
          chrome.tabs.sendMessage(youtubeTab.id, { action: 'getVideoInfo' }),
          3000,
          'Content script verification timeout'
        );
        contentScriptReady = verifyResult?.success === true;
        console.log(`[EXT][CAPTURE] Content script verification: ${contentScriptReady ? 'OK' : 'FAILED'}`);
      } catch (injectError) {
        console.error(`[EXT][CAPTURE] Content script injection failed: ${injectError.message}`);
      }
    }

    // STEP 3: Skip directly to MediaRecorder capture
    // Don't bother with stream interception or triggerPlayback - they're unreliable
    console.log(`[EXT][CAPTURE] === STARTING MEDIARECORDER CAPTURE ===`);

    let captureResult;
    try {
      captureResult = await captureAndUploadWithMediaRecorder(videoId, youtubeUrl, startTime, endTime, bridgeRequestId);
      console.log(`[EXT][CAPTURE] MediaRecorder result: success=${captureResult?.success} error=${captureResult?.error || 'none'}`);
    } catch (captureError) {
      console.error(`[EXT][CAPTURE] MediaRecorder exception: ${captureError.message}`);
      captureResult = { success: false, error: captureError.message };
    }

    // STEP 4: Process result
    console.log(`[EXT][CAPTURE] Processing result: success=${captureResult?.success}, hasVideoUrl=${!!captureResult?.videoStorageUrl}, hasVideoData=${!!captureResult?.videoData}`);

    if (captureResult?.success) {
      const videoInfo = await getBasicVideoInfo(videoId, youtubeUrl);
      const capturedSegment = captureResult.capturedSegment || {};
      const hasLocalVideoData = !captureResult.uploadedToStorage && !!captureResult.videoData;

      // CRITICAL: Don't include large videoData in chrome.storage response
      // Instead, store it in-memory (storedVideoData) and let wizard retrieve via getStoredVideoData
      // This avoids chrome.storage quota issues with large video files (>5MB)
      const response = {
        success: true,
        videoInfo: videoInfo,
        streamData: {
          videoUrl: captureResult.videoStorageUrl || null,
          // Don't include videoData here - it goes in storedVideoData for separate retrieval
          videoData: null,
          videoDataAvailable: hasLocalVideoData,  // Flag to tell wizard to fetch via getStoredVideoData
          videoSize: captureResult.videoSize || null,
          storagePath: captureResult.storagePath || null,
          quality: 'captured',
          mimeType: captureResult.mimeType || 'video/webm',
          capturedAt: Date.now(),
          source: 'mediarecorder_capture',
          uploadedToStorage: captureResult.uploadedToStorage || false,
          uploadError: captureResult.uploadError || null,
          capturedSegment: capturedSegment,
          captureStartTime: capturedSegment.startTime,
          captureEndTime: capturedSegment.endTime,
          captureDuration: capturedSegment.duration
        },
        message: captureResult.uploadedToStorage
          ? 'Video captured and uploaded successfully.'
          : hasLocalVideoData
            ? 'Video captured. Use getStoredVideoData to retrieve the video data.'
            : 'Video captured locally. Frontend will upload to storage.'
      };

      // Store full video data for later retrieval via getStoredVideoData message
      // This keeps large video data out of chrome.storage
      const videoDataSize = captureResult.videoData ? captureResult.videoData.length : 0;
      storedVideoData = {
        videoInfo: videoInfo,
        streamData: {
          ...response.streamData,
          videoData: captureResult.videoData || null  // Include actual data here for message retrieval
        },
        capturedAt: Date.now()
      };
      console.log(`[EXT][CAPTURE] Video data stored in-memory (base64 size: ${(videoDataSize / 1024 / 1024).toFixed(2)}MB), available via getStoredVideoData`);

      // Close auto-opened tab after successful capture
      if (autoOpenedTabId) {
        console.log(`[EXT][CAPTURE] Closing auto-opened tab ${autoOpenedTabId}...`);
        try {
          await chrome.tabs.remove(autoOpenedTabId);
          console.log(`[EXT][CAPTURE] Auto-opened tab closed`);
        } catch (closeError) {
          console.warn(`[EXT][CAPTURE] Failed to close auto-opened tab: ${closeError.message}`);
        }
      }

      await storeResult(response);
      console.log(`[EXT][CAPTURE] === COMPLETE === Result stored, wizard should receive it`);
    } else {
      // Capture failed
      const errorMsg = captureResult?.error || 'Video capture failed';

      // Close auto-opened tab even on failure
      if (autoOpenedTabId) {
        console.log(`[EXT][CAPTURE] Closing auto-opened tab ${autoOpenedTabId} after failure...`);
        try {
          await chrome.tabs.remove(autoOpenedTabId);
        } catch (closeError) {
          console.warn(`[EXT][CAPTURE] Failed to close auto-opened tab: ${closeError.message}`);
        }
      }

      await storeResult({
        success: false,
        error: errorMsg,
        code: captureResult?.code || 'CAPTURE_FAILED',
        videoInfo: await getBasicVideoInfo(videoId, youtubeUrl),
        details: {
          message: 'Please ensure the YouTube video is loaded and playing, then try again.'
        }
      });
      console.log(`[EXT][CAPTURE] === COMPLETE (FAILURE) === Error stored, wizard should receive it`);
    }

  } catch (error) {
    console.error(`[EXT][CAPTURE] Unexpected error: ${error.message}`);

    // Close auto-opened tab on unexpected error
    if (autoOpenedTabId) {
      try {
        await chrome.tabs.remove(autoOpenedTabId);
      } catch (closeError) {
        // Ignore
      }
    }

    await storeResult({
      success: false,
      error: error.message || 'Unexpected error during capture',
      code: 'UNEXPECTED_ERROR'
    });
    console.log(`[EXT][CAPTURE] === COMPLETE (EXCEPTION) === Error stored, wizard should receive it`);
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
 *
 * NOTE: Captured stream URLs are IP-restricted and may not work from servers.
 * This is primarily useful for client-side downloads or when the server
 * can access YouTube through a similar network path.
 */
async function openAndCaptureStreams(videoId, youtubeUrl) {
  // Use regular watch URL - embed often fails with "Error 153" when embedding is disabled
  let url = youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`;

  // Add autoplay parameter
  try {
    const urlObj = new URL(url);
    urlObj.searchParams.set('autoplay', '1');
    url = urlObj.toString();
  } catch (e) {
    url += (url.includes('?') ? '&' : '?') + 'autoplay=1';
  }

  console.log(`[EXT][BG] Opening YouTube tab for stream capture: ${videoId}`);
  console.log(`[EXT][BG] URL: ${url}`);

  return new Promise(async (resolve) => {
    let captureTab = null;
    let checkInterval = null;
    let timeoutId = null;

    const cleanup = () => {
      if (checkInterval) clearInterval(checkInterval);
      if (timeoutId) clearTimeout(timeoutId);
    };

    try {
      // Get the current active tab so we can switch back to it
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const originalTabId = currentTab?.id;
      const currentTabIndex = currentTab?.index ?? 0;

      // Open the YouTube video - must be ACTIVE briefly for autoplay to work
      // Chrome's autoplay policy requires the tab to have "user activation"
      // Create it right next to the current tab for better UX
      captureTab = await chrome.tabs.create({
        url: url,
        active: true,  // Must be active for autoplay to trigger
        index: currentTabIndex + 1  // Open right next to current tab
      });

      console.log(`[EXT][BG] Opened capture tab ${captureTab.id} (active for autoplay)`);

      // Wait 2 seconds before switching back - YouTube needs time to:
      // 1. Load the page
      // 2. Initialize the video player
      // 3. Start autoplay (only works while tab is active/focused)
      if (originalTabId) {
        setTimeout(async () => {
          try {
            await chrome.tabs.update(originalTabId, { active: true });
            console.log(`[EXT][BG] Switched back to original tab ${originalTabId}`);
          } catch (e) {
            // Original tab might have been closed
          }
        }, 2000);  // 2 seconds delay for autoplay to trigger
      }

      // Track this tab for the video ID
      tabVideoMap.set(captureTab.id, videoId);

      // Wait for tab to load and start playing
      let attempts = 0;
      const maxAttempts = 30; // 30 attempts * 500ms = 15 seconds max
      let playbackTriggered = false;

      checkInterval = setInterval(async () => {
        attempts++;

        // Check if we got intercepted streams
        const intercepted = getInterceptedStreams(videoId);

        if (intercepted && intercepted.videoUrl) {
          cleanup();
          console.log(`[EXT][BG] Streams captured after ${attempts} checks (${attempts * 0.5}s)`);
          console.log(`[EXT][BG] Video URLs: ${intercepted.allVideoUrls?.length || 1}`);
          console.log(`[EXT][BG] Audio URLs: ${intercepted.allAudioUrls?.length || 1}`);

          // Try to get video info from the tab
          let videoInfo = null;
          try {
            const infoResponse = await chrome.tabs.sendMessage(captureTab.id, {
              action: 'getVideoInfo'
            });
            if (infoResponse?.success) {
              videoInfo = infoResponse.videoInfo;
              console.log(`[EXT][BG] Got video info: ${videoInfo.title}`);
            }
          } catch (e) {
            console.warn('[EXT][BG] Could not get video info from tab:', e.message);
          }

          // DON'T close the tab yet - caller will close it after download/upload
          // Return the tab ID so caller can close it when done
          resolve({
            success: true,
            captureTabId: captureTab.id,  // Return tab ID for caller to close later
            videoInfo: videoInfo || {
              videoId: videoId,
              url: url,
              thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
            },
            streamData: {
              videoUrl: intercepted.videoUrl,
              audioUrl: intercepted.audioUrl,
              allVideoUrls: intercepted.allVideoUrls,
              allAudioUrls: intercepted.allAudioUrls,
              quality: 'intercepted',
              mimeType: 'video/mp4',
              capturedAt: intercepted.capturedAt,
              source: 'network_intercept_auto',
              note: 'URLs may be IP-restricted - server download may fail'
            },
            message: 'Streams captured. Note: URLs may be IP-restricted.'
          });
          return;
        }

        // Log progress for debugging
        if (attempts % 5 === 0) {
          console.log(`[EXT][BG] Still waiting for streams... attempt ${attempts}/${maxAttempts}`);
        }

        // Try to trigger playback via content script (works on watch pages)
        // Start at attempt 6 (3 seconds) to give page time to load
        if (attempts >= 6 && attempts <= 20 && attempts % 3 === 0) {
          console.log(`[EXT][BG] Triggering playback via content script at attempt ${attempts}`);
          try {
            const result = await chrome.tabs.sendMessage(captureTab.id, { action: 'triggerPlayback' });
            if (result?.isPlaying) {
              console.log(`[EXT][BG] Video now playing! Waiting for streams...`);
              playbackTriggered = true;
            } else {
              console.log(`[EXT][BG] triggerPlayback returned: isPlaying=${result?.isPlaying}`);
            }
          } catch (e) {
            console.log(`[EXT][BG] Content script not ready: ${e.message}`);
            // Fallback: direct script injection
            if (attempts >= 10 && !playbackTriggered) {
              try {
                await chrome.scripting.executeScript({
                  target: { tabId: captureTab.id },
                  func: () => {
                    const video = document.querySelector('video');
                    if (video) {
                      video.muted = true;
                      video.play().catch(() => {});
                    }
                  }
                });
                playbackTriggered = true;
              } catch (scriptError) {
                // Ignore
              }
            }
          }
        }

        // Check if we've exceeded max attempts
        if (attempts >= maxAttempts) {
          cleanup();
          console.warn(`[EXT][BG] Stream capture timeout after ${maxAttempts * 0.5}s`);

          // Close the capture tab
          try {
            chrome.tabs.remove(captureTab.id).catch(() => {});
          } catch (e) {}

          resolve({
            success: false,
            error: 'Stream capture timeout. The video may require manual playback or has playback restrictions.'
          });
        }
      }, 500);

      // Set absolute timeout (20 seconds)
      timeoutId = setTimeout(() => {
        cleanup();
        console.warn('[EXT][BG] Absolute timeout reached for stream capture');
        try {
          if (captureTab) chrome.tabs.remove(captureTab.id).catch(() => {});
        } catch (e) {}
        resolve({
          success: false,
          error: 'Stream capture timeout - video may have restrictions'
        });
      }, 20000);

    } catch (error) {
      cleanup();
      console.error('[EXT][BG] Failed to open capture tab:', error);
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
 * Function to be injected into YouTube page for video download
 * This runs in the page's MAIN world with full cookie/session access
 * IMPORTANT: This function is serialized and injected, so it must be self-contained
 *
 * YouTube stream URLs are IP-restricted and session-bound. This function works because:
 * 1. It runs in the page's main world (same origin as youtube.com)
 * 2. It has access to the page's cookies and session
 * 3. It uses the same browser IP that generated the stream URLs
 */
async function downloadVideoInPage(videoUrl, audioUrl) {
  console.log('[YVO Injected] Starting in-page download (MAIN world with cookie access)');
  console.log('[YVO Injected] Video URL:', videoUrl?.substring(0, 100) + '...');

  // Helper function to convert blob to base64
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Helper function to download with proper headers and retry logic
  async function downloadStream(url, type, maxRetries = 3) {
    console.log(`[YVO Injected] Downloading ${type} stream...`);

    // Retry with exponential backoff
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const blob = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.responseType = 'blob';

          // Set headers that YouTube's player uses
          xhr.setRequestHeader('Accept', '*/*');
          xhr.setRequestHeader('Accept-Language', 'en-US,en;q=0.9');
          // Note: Origin and Referer are automatically set by the browser

          xhr.onload = function() {
            if (xhr.status >= 200 && xhr.status < 300) {
              console.log(`[YVO Injected] ${type} downloaded: ${(xhr.response.size / 1024 / 1024).toFixed(2)}MB`);
              resolve(xhr.response);
            } else {
              reject(new Error(`${type} download failed: ${xhr.status} ${xhr.statusText}`));
            }
          };

          xhr.onerror = function() {
            reject(new Error(`${type} download network error`));
          };

          xhr.onprogress = function(e) {
            if (e.lengthComputable) {
              const percent = Math.round((e.loaded / e.total) * 100);
              if (percent % 25 === 0) {  // Log less frequently
                console.log(`[YVO Injected] ${type} progress: ${percent}%`);
              }
            }
          };

          xhr.withCredentials = true;  // Include cookies
          xhr.send();
        });

        return blob;  // Success - return immediately
      } catch (error) {
        console.warn(`[YVO Injected] ${type} download attempt ${attempt}/${maxRetries} failed:`, error.message);

        if (attempt < maxRetries) {
          // Wait with exponential backoff: 1s, 2s, 4s
          const waitTime = Math.pow(2, attempt - 1) * 1000;
          console.log(`[YVO Injected] Retrying in ${waitTime/1000}s...`);
          await new Promise(r => setTimeout(r, waitTime));
        } else {
          throw error;  // Final attempt failed
        }
      }
    }
  }

  try {
    if (!videoUrl) {
      return { success: false, error: 'No video URL provided' };
    }

    // Download video stream
    let videoBlob;
    try {
      videoBlob = await downloadStream(videoUrl, 'Video');
    } catch (xhrError) {
      console.warn('[YVO Injected] XHR download failed, trying fetch fallback:', xhrError.message);

      // Fallback to fetch
      const videoResponse = await fetch(videoUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });

      if (!videoResponse.ok) {
        return { success: false, error: `Video download failed: ${videoResponse.status}` };
      }

      videoBlob = await videoResponse.blob();
      console.log(`[YVO Injected] Video downloaded via fetch: ${(videoBlob.size / 1024 / 1024).toFixed(2)}MB`);
    }

    // Convert to base64 for transfer back to service worker
    const videoBase64 = await blobToBase64(videoBlob);

    let audioBase64 = null;
    if (audioUrl && audioUrl !== videoUrl) {
      try {
        const audioBlob = await downloadStream(audioUrl, 'Audio');
        audioBase64 = await blobToBase64(audioBlob);
      } catch (audioError) {
        console.warn('[YVO Injected] Audio download failed:', audioError.message);
        // Audio is optional, continue without it
      }
    }

    console.log('[YVO Injected] Download complete, returning to background');
    return {
      success: true,
      videoData: videoBase64,
      videoSize: videoBlob.size,
      audioData: audioBase64
    };

  } catch (error) {
    console.error('[YVO Injected] Download failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * EXTENSION-ONLY: Capture video using MediaRecorder with MESSAGE PASSING
 *
 * This version uses window.postMessage() to send results back to the extension
 * instead of returning a Promise. This works around a Chrome limitation where
 * executeScript with world: 'MAIN' doesn't properly wait for Promises that
 * resolve via async callbacks (like FileReader or setTimeout).
 *
 * v2.7.0 MAJOR REWRITE:
 * - Better ad detection
 * - Improved video state validation
 * - More robust error handling
 * - Direct upload from page context
 *
 * The video is sped up to 4x to minimize capture time.
 * For a 60-second clip, this takes only ~15 seconds.
 *
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 * @param {string} videoId - YouTube video ID
 * @param {string} captureId - Unique ID to correlate the result message
 * @param {string} uploadUrl - Server URL for direct upload (optional)
 */
function captureVideoWithMessage(startTime, endTime, videoId, captureId, uploadUrl) {
  // OUTERMOST TRY-CATCH - catches ANY error in the function
  // This ensures we always send a result back even if something breaks
  try {
    // IMMEDIATE LOG - if this doesn't appear, function isn't running at all
    console.log(`[EXT][CAPTURE-PAGE] ====== CAPTURE FUNCTION STARTED v2.7.7 ======`);
    console.log(`[EXT][CAPTURE-PAGE] captureId=${captureId}`);
    console.log(`[EXT][CAPTURE-PAGE] startTime=${startTime}s, endTime=${endTime}s`);
    console.log(`[EXT][CAPTURE-PAGE] uploadUrl=${uploadUrl ? 'provided' : 'none'}`);
    console.log(`[EXT][CAPTURE-PAGE] window.postMessage available:`, typeof window.postMessage);
  } catch (initError) {
    // Even console.log failed - try to send error via postMessage
    try {
      window.postMessage({
        type: 'YVO_CAPTURE_RESULT',
        captureId: captureId,
        result: null,
        error: 'Function initialization failed: ' + (initError.message || 'unknown'),
        errorCode: 'INIT_FAILED'
      }, '*');
    } catch (e) {}
    return;
  }

  const duration = endTime - startTime;
  // Use 1x playback for reliable audio capture
  // 4x caused audio issues (distortion, wrong speed, no audio)
  const PLAYBACK_SPEED = 1;
  const captureTime = (duration / PLAYBACK_SPEED) * 1000;

  // CRITICAL: Track if we've sent a result to prevent duplicate sends
  let resultSent = false;

  // Helper to send result back via postMessage (with duplicate prevention)
  function sendResult(result, error = null) {
    if (resultSent) {
      console.log(`[EXT][CAPTURE-PAGE] Result already sent, ignoring duplicate`);
      return;
    }
    resultSent = true;

    const errorCode = error ? (
      error.includes('DRM') ? 'DRM_PROTECTED' :
      error.includes('ad') || error.includes('Ad') ? 'AD_PLAYING' :
      error.includes('not playing') ? 'VIDEO_NOT_PLAYING' :
      error.includes('not found') ? 'VIDEO_NOT_FOUND' :
      'CAPTURE_FAILED'
    ) : null;

    console.log(`[EXT][CAPTURE-PAGE] Posting result via postMessage (error=${error || 'none'}, code=${errorCode})...`);
    try {
      window.postMessage({
        type: 'YVO_CAPTURE_RESULT',
        captureId: captureId,
        result: result,
        error: error,
        errorCode: errorCode
      }, '*');
      console.log(`[EXT][CAPTURE-PAGE] Result posted (success=${!error})`);
    } catch (postError) {
      console.error(`[EXT][CAPTURE-PAGE] Failed to post result: ${postError.message}`);
      // Fallback: try storing in localStorage for the relay to pick up
      try {
        localStorage.setItem(`yvo_capture_result_${captureId}`, JSON.stringify({
          result: result,
          error: error,
          errorCode: errorCode
        }));
        console.log(`[EXT][CAPTURE-PAGE] Result stored in localStorage as fallback`);
      } catch (e) {
        console.error(`[EXT][CAPTURE-PAGE] LocalStorage fallback also failed`);
      }
    }
  }

  // CRITICAL: Hard timeout to GUARANTEE we always send a response
  // This prevents the frontend from hanging forever
  // v2.7.4: Added seek time estimate for clips deep into long videos
  // Seek time increases with start position: ~1s per minute of video position
  const seekTimeEstimate = Math.max(10000, Math.min(startTime / 60, 90) * 1000);
  const HARD_TIMEOUT_MS = captureTime + seekTimeEstimate + 60000; // capture time + seek time + 60s buffer
  console.log(`[EXT][CAPTURE-PAGE] Hard timeout: ${Math.round(HARD_TIMEOUT_MS / 1000)}s (capture: ${Math.round(captureTime / 1000)}s, seek: ${Math.round(seekTimeEstimate / 1000)}s, buffer: 60s)`);
  const hardTimeoutId = setTimeout(() => {
    if (!resultSent) {
      console.error(`[EXT][CAPTURE-PAGE] HARD TIMEOUT after ${HARD_TIMEOUT_MS / 1000}s - forcing error response`);
      sendResult(null, `Capture timed out after ${Math.round(HARD_TIMEOUT_MS / 1000)} seconds. The video may not be playing or buffering properly at this position.`);
    }
  }, HARD_TIMEOUT_MS);

  // Send immediate "started" notification so we know the function is running
  try {
    window.postMessage({
      type: 'YVO_CAPTURE_STARTED',
      captureId: captureId
    }, '*');
    console.log(`[EXT][CAPTURE-PAGE] Start notification sent`);
  } catch (e) {
    console.error(`[EXT][CAPTURE-PAGE] Failed to send start notification: ${e.message}`);
  }

  console.log(`[EXT][CAPTURE-PAGE] Will capture ${duration}s at ${PLAYBACK_SPEED}x (timeout=${Math.round(HARD_TIMEOUT_MS / 1000)}s)`);

  // Helper to wait with timeout
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // Check if an ad is currently playing
  function isAdPlaying() {
    // v2.7.2: Improved ad detection to reduce false positives
    // Only check for ACTIVE ad indicators, not residual UI elements

    // Primary check: Video container has ad-showing class (most reliable)
    const videoContainer = document.querySelector('.html5-video-player');
    const hasAdClass = videoContainer?.classList.contains('ad-showing') ||
                       videoContainer?.classList.contains('ad-interrupting');

    // Secondary check: YouTube Player API (very reliable when available)
    const ytPlayer = document.querySelector('#movie_player');
    let isAdFromPlayer = false;
    if (ytPlayer && typeof ytPlayer.getAdState === 'function') {
      try {
        // getAdState returns 1 if ad is playing
        isAdFromPlayer = ytPlayer.getAdState() === 1;
      } catch (e) {}
    }

    // Tertiary check: Active ad UI elements (visible and interactable)
    // Only check for elements that are VISIBLE and indicate an ACTIVE ad
    const activeAdIndicators = [
      // Ad countdown/skip container (only visible during ads)
      document.querySelector('.ytp-ad-preview-container:not([style*="display: none"])'),
      // Ad text overlay (only shown during ads)
      document.querySelector('.ytp-ad-text:not([style*="display: none"])'),
      // Ad player overlay (only shown during video ads)
      document.querySelector('.ytp-ad-player-overlay-instream-info'),
      // Ad skip button container (indicates skippable ad is playing)
      document.querySelector('.ytp-ad-skip-button-container:not([style*="display: none"])')
    ];
    const hasActiveAdIndicator = activeAdIndicators.some(el => el !== null && el.offsetParent !== null);

    // v2.7.2: Require at least 2 indicators OR player API confirmation for ad detection
    // This reduces false positives from residual UI elements
    let indicatorCount = 0;
    if (hasAdClass) indicatorCount++;
    if (isAdFromPlayer) indicatorCount++;
    if (hasActiveAdIndicator) indicatorCount++;

    // Consider it an ad if: player API says so, OR container has ad class, OR 2+ indicators
    const isAd = isAdFromPlayer || hasAdClass || (hasActiveAdIndicator && indicatorCount >= 2);

    if (isAd) {
      console.log(`[EXT][CAPTURE] Ad detected! hasAdClass=${hasAdClass}, isAdFromPlayer=${isAdFromPlayer}, hasActiveAdIndicator=${hasActiveAdIndicator}`);
    }
    return isAd;
  }

  // Wait for ad to finish
  async function waitForAdToFinish(maxWaitMs = 60000) {
    const startWait = Date.now();
    let adDetected = false;
    let skipAttempts = 0;

    // v2.7.2: Extended list of skip button selectors (YouTube changes these frequently)
    const skipButtonSelectors = [
      '.ytp-skip-ad-button',                    // New 2024+ skip button
      '.ytp-ad-skip-button',                    // Standard skip button
      '.ytp-ad-skip-button-modern',             // Modern skip button variant
      '.ytp-ad-skip-button-container button',   // Button inside container
      'button.ytp-ad-skip-button',              // Explicit button element
      '[class*="skip-button"]',                 // Wildcard for skip buttons
      '.ytp-ad-skip-button-slot button',        // Slot-based skip button
      '.videoAdUiSkipButton',                   // Alternative skip button class
      '[data-skip-button]',                     // Data attribute based
      '.ytp-ad-skip'                            // Short class name
    ];

    // Helper to try all skip button selectors
    const tryClickSkipButton = () => {
      for (const selector of skipButtonSelectors) {
        const btn = document.querySelector(selector);
        if (btn && btn.offsetParent !== null) {
          console.log(`[EXT][CAPTURE] Skip button found (${selector}), clicking...`);
          // Try multiple click methods
          btn.click();
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          // Also try focusing and pressing Enter
          try {
            btn.focus();
            btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          } catch (e) {}
          return true;
        }
      }
      return false;
    };

    while (Date.now() - startWait < maxWaitMs) {
      if (!isAdPlaying()) {
        if (adDetected) {
          console.log(`[EXT][CAPTURE] Ad finished after ${Date.now() - startWait}ms`);
          // Wait a bit for main video to resume
          await sleep(2000);
        }
        return true;
      }

      if (!adDetected) {
        adDetected = true;
        console.log(`[EXT][CAPTURE] Ad is playing, waiting for it to finish...`);
      }

      // Try to skip ad every 500ms for more aggressive skipping
      skipAttempts++;
      if (tryClickSkipButton()) {
        await sleep(500);
        // Check immediately after clicking
        if (!isAdPlaying()) {
          console.log(`[EXT][CAPTURE] Ad skipped successfully after ${Date.now() - startWait}ms`);
          await sleep(2000);
          return true;
        }
      }

      // Log progress every 10 seconds
      if (skipAttempts % 20 === 0) {
        console.log(`[EXT][CAPTURE] Still waiting for ad... (${Math.round((Date.now() - startWait) / 1000)}s elapsed)`);
      }

      await sleep(500); // Check every 500ms instead of 1000ms for faster response
    }

    // v2.7.2: Return true anyway after timeout - ad likely ended or we should try capturing anyway
    console.warn(`[EXT][CAPTURE] Ad wait timeout (${maxWaitMs}ms) - proceeding with capture anyway`);
    await sleep(1000);
    return true; // Return true to proceed instead of blocking
  }

  // Check if video is actually playing and has data
  function isVideoActuallyPlaying(videoEl) {
    // Must have valid dimensions
    if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
      console.log(`[EXT][CAPTURE] Video has no dimensions: ${videoEl.videoWidth}x${videoEl.videoHeight}`);
      return false;
    }

    // Must not be paused
    if (videoEl.paused) {
      console.log(`[EXT][CAPTURE] Video is paused`);
      return false;
    }

    // Must have enough data
    if (videoEl.readyState < 2) {
      console.log(`[EXT][CAPTURE] Video readyState too low: ${videoEl.readyState}`);
      return false;
    }

    // Must have valid duration
    if (!isFinite(videoEl.duration) || videoEl.duration === 0) {
      console.log(`[EXT][CAPTURE] Video has invalid duration: ${videoEl.duration}`);
      return false;
    }

    // Should have buffered data
    if (videoEl.buffered.length === 0) {
      console.log(`[EXT][CAPTURE] Video has no buffered data`);
      return false;
    }

    return true;
  }

  // Wait for video to be ready and actually playing
  async function waitForVideoReady(videoEl, maxWaitMs = 20000) {
    const startWait = Date.now();
    const ytPlayer = document.querySelector('#movie_player');

    console.log(`[EXT][CAPTURE] Waiting for video to be ready (max ${maxWaitMs / 1000}s)...`);
    console.log(`[EXT][CAPTURE] Initial state: ${videoEl.videoWidth}x${videoEl.videoHeight}, paused=${videoEl.paused}, readyState=${videoEl.readyState}`);

    while (Date.now() - startWait < maxWaitMs) {
      // First check for ads
      if (isAdPlaying()) {
        console.log(`[EXT][CAPTURE] Ad detected while waiting for video`);
        // v2.7.2: waitForAdToFinish now always returns true to proceed anyway after timeout
        await waitForAdToFinish(45000);
        // Reset the video element reference after ad
        videoEl = document.querySelector('video.html5-main-video') || document.querySelector('video');
        if (!videoEl) {
          throw new Error('Video element lost after ad finished');
        }
        // Give extra time for main video to start after ad
        await sleep(1000);
      }

      // Check if video is ready
      if (isVideoActuallyPlaying(videoEl)) {
        console.log(`[EXT][CAPTURE] Video is ready and playing!`);
        console.log(`[EXT][CAPTURE] Final state: ${videoEl.videoWidth}x${videoEl.videoHeight}, currentTime=${videoEl.currentTime}, duration=${videoEl.duration}`);
        return videoEl;
      }

      // Try to start playback if not playing
      if (videoEl.paused || videoEl.readyState < 2) {
        console.log(`[EXT][CAPTURE] Video not playing, attempting to start...`);

        // Mute for autoplay
        videoEl.muted = true;

        // Try YouTube player API first
        if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
          try {
            if (typeof ytPlayer.mute === 'function') ytPlayer.mute();
            ytPlayer.playVideo();
          } catch (e) {}
        }

        // Then try direct play
        try {
          await videoEl.play();
        } catch (e) {
          console.log(`[EXT][CAPTURE] Direct play failed: ${e.message}`);
        }

        // Try clicking play button
        const playBtn = document.querySelector('.ytp-play-button');
        if (playBtn) {
          const playState = playBtn.getAttribute('data-title-no-tooltip');
          if (playState === 'Play' || playState === 'נגן') {
            playBtn.click();
          }
        }
      }

      await sleep(500);
    }

    // Timeout - provide detailed error
    const state = {
      dimensions: `${videoEl.videoWidth}x${videoEl.videoHeight}`,
      paused: videoEl.paused,
      readyState: videoEl.readyState,
      duration: videoEl.duration,
      currentTime: videoEl.currentTime,
      networkState: videoEl.networkState,
      hasError: !!videoEl.error
    };
    console.error(`[EXT][CAPTURE] Video not ready after ${maxWaitMs / 1000}s:`, state);
    throw new Error(`Video not playing after ${maxWaitMs / 1000}s. Please click play on the YouTube video and try again.`);
  }

  // Main async capture function
  async function doCapture() {
    console.log(`[EXT][CAPTURE] === doCapture() started ===`);

    // FIRST: Check for ads before anything else
    if (isAdPlaying()) {
      console.log(`[EXT][CAPTURE] Ad detected at start, waiting for it to finish...`);
      // v2.7.2: waitForAdToFinish now always returns true to proceed anyway after timeout
      await waitForAdToFinish(45000);
      // Double-check ad status after waiting
      if (isAdPlaying()) {
        console.warn(`[EXT][CAPTURE] Ad may still be playing, but proceeding with capture anyway`);
      }
    }

    // Get YouTube player API
    const ytPlayer = document.querySelector('#movie_player');
    console.log(`[EXT][CAPTURE] YouTube player element: ${ytPlayer ? 'found' : 'not found'}`);

    // Get player state info
    if (ytPlayer) {
      try {
        const hasPlayVideo = typeof ytPlayer.playVideo === 'function';
        const hasGetPlayerState = typeof ytPlayer.getPlayerState === 'function';
        const playerState = hasGetPlayerState ? ytPlayer.getPlayerState() : -1;

        console.log(`[EXT][CAPTURE] Player API available: playVideo=${hasPlayVideo}, state=${playerState}`);

        // Ensure player is ready
        if (hasPlayVideo && (playerState === -1 || playerState === 0 || playerState === 2 || playerState === 5)) {
          console.log(`[EXT][CAPTURE] Player not in playing state, starting...`);
          if (typeof ytPlayer.mute === 'function') ytPlayer.mute();
          ytPlayer.playVideo();
          await sleep(1000);
        }
      } catch (ytError) {
        console.warn('[EXT][CAPTURE] YouTube player API error:', ytError.message);
      }
    }

    // Find the video element
    let videoElement = document.querySelector('video.html5-main-video');
    if (!videoElement) {
      videoElement = document.querySelector('video');
    }

    if (!videoElement) {
      throw new Error('No video element found on page. Please ensure the YouTube video is loaded.');
    }

    console.log(`[EXT][CAPTURE] Video element found: ${videoElement.videoWidth}x${videoElement.videoHeight}`);
    console.log(`[EXT][CAPTURE] Video state: paused=${videoElement.paused}, readyState=${videoElement.readyState}, duration=${videoElement.duration}`);

    // Check for video errors
    if (videoElement.error) {
      throw new Error(`Video has error: ${videoElement.error.message || 'Error code ' + videoElement.error.code}`);
    }

    // Check for DRM (mediaKeys indicates EME/DRM is active)
    if (videoElement.mediaKeys) {
      console.warn(`[EXT][CAPTURE] WARNING: Video has DRM (mediaKeys present) - capture may fail`);
    }

    // Wait for video to be ready and playing
    videoElement = await waitForVideoReady(videoElement, 25000);

    // Seek to start position
    console.log(`[EXT][CAPTURE] Seeking to ${startTime}s...`);

    // Use YouTube API for seeking if available (more reliable)
    if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
      ytPlayer.seekTo(startTime, true);
    } else {
      videoElement.currentTime = startTime;
    }

    // Wait for seek to complete
    await new Promise((resolve) => {
      const startSeekTime = Date.now();
      const checkSeek = () => {
        if (Math.abs(videoElement.currentTime - startTime) < 3) {
          resolve();
        } else if (Date.now() - startSeekTime > 5000) {
          console.warn(`[EXT][CAPTURE] Seek timeout, proceeding anyway at ${videoElement.currentTime}s`);
          resolve();
        } else {
          setTimeout(checkSeek, 100);
        }
      };
      videoElement.addEventListener('seeked', () => resolve(), { once: true });
      checkSeek();
    });

    console.log(`[EXT][CAPTURE] Seek complete, currentTime=${videoElement.currentTime.toFixed(1)}s`);

    // Wait a moment for buffer after seek
    await sleep(500);

    // CRITICAL: Ensure video is PLAYING before captureStream
    // Seeking can pause the video, and captureStream() on a paused video captures frozen frames
    console.log(`[EXT][CAPTURE] Pre-capture state: paused=${videoElement.paused}, readyState=${videoElement.readyState}`);
    if (videoElement.paused) {
      console.log('[EXT][CAPTURE] Video is paused after seek, resuming playback...');
      try {
        // CRITICAL FIX v2.7.10: Must set muted=true for Chrome autoplay policy!
        // Without this, play() fails silently and captureStream() gets frozen frames
        videoElement.muted = true;
        await videoElement.play();
        await sleep(300); // Brief wait for playback to stabilize
        console.log(`[EXT][CAPTURE] Video resumed, paused=${videoElement.paused}`);
      } catch (playErr) {
        console.warn(`[EXT][CAPTURE] Play failed: ${playErr.message}, trying YouTube API...`);
        // Try YouTube player API as fallback
        const ytPlayer = document.querySelector('#movie_player');
        if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
          ytPlayer.playVideo();
          await sleep(500);
        }
      }
    }

    // Final verification before capture
    if (videoElement.paused) {
      console.error('[EXT][CAPTURE] WARNING: Video still paused before capture - output may be frozen!');
    }

    // Capture the video stream
    console.log('[EXT][CAPTURE] Calling captureStream()...');
    let originalStream;
    try {
      originalStream = videoElement.captureStream();
    } catch (e) {
      // DRM-protected videos throw here
      if (e.message.includes('protected') || e.message.includes('DRM') || e.message.includes('not allowed')) {
        throw new Error('This video is DRM-protected and cannot be captured. Please try a different video.');
      }
      throw new Error(`Could not capture video stream: ${e.message}`);
    }

    if (!originalStream || originalStream.getVideoTracks().length === 0) {
      // Check if DRM
      if (videoElement.mediaKeys) {
        throw new Error('This video is DRM-protected and cannot be captured. Please try a different video.');
      }
      throw new Error('No video tracks available - please ensure the video is playing');
    }

    // Check if video track is actually active
    const videoTracks = originalStream.getVideoTracks();
    const firstVideoTrack = videoTracks[0];
    if (firstVideoTrack.muted || !firstVideoTrack.enabled) {
      console.warn(`[EXT][CAPTURE] Video track is muted=${firstVideoTrack.muted}, enabled=${firstVideoTrack.enabled}`);
    }

    // Clone tracks to prevent "Tracks in MediaStream were added" error
    console.log('[EXT][CAPTURE] Creating stable stream with cloned tracks...');
    const stableStream = new MediaStream();

    originalStream.getVideoTracks().forEach(track => {
      const clonedTrack = track.clone();
      stableStream.addTrack(clonedTrack);
      console.log(`[EXT][CAPTURE] Cloned video track: ${track.label || 'unnamed'}, enabled=${track.enabled}`);
    });

    // Use audio tracks from captureStream directly
    originalStream.getAudioTracks().forEach(track => {
      const clonedTrack = track.clone();
      stableStream.addTrack(clonedTrack);
      console.log(`[EXT][CAPTURE] Cloned audio track: ${track.label || 'unnamed'}`);
    });

    console.log(`[EXT][CAPTURE] Stable stream: ${stableStream.getVideoTracks().length} video, ${stableStream.getAudioTracks().length} audio tracks`);

    // Determine MIME type
    let mimeType = 'video/webm;codecs=vp9,opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'video/webm;codecs=vp8,opus';
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'video/webm';
    }

    console.log(`[EXT][CAPTURE] Starting MediaRecorder with ${mimeType}`);

    // Wrap MediaRecorder in a Promise for proper async handling
    const captureResult = await new Promise((resolve, reject) => {
      const chunks = [];
      let recorderStopped = false;
      let dataReceived = false;
      let lastDataTime = Date.now();

      const recorder = new MediaRecorder(stableStream, {
        mimeType: mimeType,
        // Reduced from 8Mbps to 4Mbps - server re-encodes anyway
        // This speeds up upload time by ~50% with minimal quality loss
        videoBitsPerSecond: 4000000
      });

      const cleanupTracks = () => {
        stableStream.getTracks().forEach(track => track.stop());
      };

      const stopRecording = (reason) => {
        if (!recorderStopped && recorder.state === 'recording') {
          recorderStopped = true;
          console.log(`[EXT][CAPTURE] Stopping recorder (reason: ${reason})`);
          try {
            recorder.stop();
          } catch (e) {
            console.warn('[EXT][CAPTURE] Error stopping recorder:', e.message);
          }
        }
      };

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
          dataReceived = true;
          lastDataTime = Date.now();
        }
      };

      recorder.onstop = async () => {
        videoElement.playbackRate = 1;
        videoElement.pause();
        cleanupTracks();

        console.log(`[EXT][CAPTURE] Recording stopped, chunks=${chunks.length}, dataReceived=${dataReceived}`);

        if (chunks.length === 0 || !dataReceived) {
          reject(new Error('No video data captured. The video may be DRM-protected or not playing properly.'));
          return;
        }

        const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
        const blobSize = blob.size;
        console.log(`[EXT][CAPTURE] Blob size=${(blobSize / 1024 / 1024).toFixed(2)}MB`);

        if (blobSize < 10000) {
          reject(new Error('Captured video too small - the video may not be playing correctly'));
          return;
        }

        // NEW v2.7.0: Upload directly from page context if uploadUrl is provided
        if (uploadUrl) {
          console.log(`[EXT][CAPTURE] Uploading directly to server from page context...`);
          try {
            const formData = new FormData();
            formData.append('video', blob, `captured_${videoId}.webm`);
            formData.append('videoId', videoId);
            formData.append('type', 'video');
            formData.append('captureStart', String(startTime));
            formData.append('captureEnd', String(endTime));
            formData.append('capturedDuration', String(duration));

            const uploadResponse = await fetch(uploadUrl, {
              method: 'POST',
              body: formData
            });

            if (!uploadResponse.ok) {
              const errorText = await uploadResponse.text();
              throw new Error(`Upload failed: ${uploadResponse.status} - ${errorText.substring(0, 100)}`);
            }

            const uploadResult = await uploadResponse.json();
            console.log(`[EXT][CAPTURE] Direct upload success! url=${uploadResult.url}`);

            resolve({
              success: true,
              uploadedDirectly: true,
              videoStorageUrl: uploadResult.url,
              videoSize: blobSize,
              mimeType: mimeType.split(';')[0],
              duration: duration,
              captureMethod: 'mediarecorder_direct'
            });
            return;
          } catch (uploadError) {
            console.error(`[EXT][CAPTURE] Direct upload failed: ${uploadError.message}`);
            // Fall through to base64 fallback
            console.log(`[EXT][CAPTURE] Falling back to base64 return...`);
          }
        }

        // FALLBACK: Convert to Base64 if no uploadUrl or upload failed
        console.log('[EXT][CAPTURE] Converting to Base64...');
        try {
          const base64Data = await new Promise((res, rej) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              if (!reader.result) {
                rej(new Error('FileReader result is null'));
                return;
              }
              const parts = reader.result.split(',');
              if (parts.length < 2) {
                rej(new Error('Invalid base64 format'));
                return;
              }
              res(parts[1]);
            };
            reader.onerror = () => rej(new Error('FileReader failed'));
            reader.readAsDataURL(blob);
          });

          resolve({
            success: true,
            uploadedDirectly: false,
            videoData: base64Data,
            videoSize: blobSize,
            mimeType: mimeType.split(';')[0],
            duration: duration,
            captureMethod: 'mediarecorder'
          });
        } catch (base64Error) {
          reject(new Error('Base64 conversion error: ' + base64Error.message));
        }
      };

      recorder.onerror = (e) => {
        videoElement.playbackRate = 1;
        cleanupTracks();
        const errorMsg = e.error?.message || e.error?.name || 'unknown';
        console.error(`[EXT][CAPTURE] MediaRecorder error: ${errorMsg}`);

        // Try to salvage what we have
        if (chunks.length > 0 && !recorderStopped) {
          console.log(`[EXT][CAPTURE] Error occurred but have ${chunks.length} chunks, salvaging...`);
          stopRecording('error_salvage');
        } else {
          reject(new Error(`MediaRecorder error: ${errorMsg}`));
        }
      };

      // Set playback speed
      videoElement.playbackRate = PLAYBACK_SPEED;

      // CRITICAL FIX: Start MUTED for autoplay to work (Chrome policy)
      // Chrome blocks autoplay of unmuted videos. We must start muted,
      // then unmute AFTER playback begins for audio capture.
      videoElement.muted = true;
      videoElement.volume = 1; // Pre-set volume for when we unmute

      // Start recording
      const startRecording = () => {
        try {
          recorder.start(500);
          console.log('[EXT][CAPTURE] Recording started');

          // NOW unmute to capture audio (after playback confirmed)
          // Small delay to ensure playback is stable
          setTimeout(() => {
            videoElement.muted = false;
            console.log('[EXT][CAPTURE] Video unmuted for audio capture');
          }, 100);
        } catch (startErr) {
          reject(new Error(`Failed to start recording: ${startErr.message}`));
        }
      };

      // Ensure video is playing before starting (muted autoplay should work)
      if (videoElement.paused) {
        videoElement.play().then(startRecording).catch((e) => {
          console.warn('[EXT][CAPTURE] Play failed, trying anyway:', e.message);
          startRecording();
        });
      } else {
        startRecording();
      }

      // Monitor for data - detect if no data is being received
      const dataMonitor = setInterval(() => {
        if (recorderStopped) {
          clearInterval(dataMonitor);
          return;
        }

        const timeSinceData = Date.now() - lastDataTime;
        if (timeSinceData > 10000 && !dataReceived) {
          console.error(`[EXT][CAPTURE] No data received in ${timeSinceData}ms - video may be DRM protected`);
          clearInterval(dataMonitor);
          stopRecording('no_data');
        }
      }, 5000);

      // Monitor progress
      const progressInterval = setInterval(() => {
        if (recorderStopped) {
          clearInterval(progressInterval);
          return;
        }
        const progress = ((videoElement.currentTime - startTime) / duration * 100).toFixed(1);
        const capturedSeconds = Math.round(videoElement.currentTime - startTime);
        console.log(`[EXT][CAPTURE] Progress: ${progress}% (at ${videoElement.currentTime.toFixed(1)}s, chunks=${chunks.length})`);
        // Post progress to content script for overlay update
        try {
          window.postMessage({
            type: 'YVO_CAPTURE_PROGRESS',
            progress: parseFloat(progress),
            capturedSeconds: capturedSeconds,
            totalSeconds: Math.round(duration),
            phase: 'capturing'
          }, '*');
        } catch (e) {}
      }, 3000);

      // Stop when we reach end time
      const checkEnd = setInterval(() => {
        if (videoElement.currentTime >= endTime || videoElement.ended) {
          clearInterval(checkEnd);
          clearInterval(progressInterval);
          clearInterval(dataMonitor);
          console.log('[EXT][CAPTURE] Reached end, stopping recorder...');
          stopRecording('reached_end');
        }
      }, 100);

      // Safety timeout for recording
      const recordingTimeout = setTimeout(() => {
        clearInterval(checkEnd);
        clearInterval(progressInterval);
        clearInterval(dataMonitor);
        if (!recorderStopped) {
          console.log('[EXT][CAPTURE] Recording timeout, stopping...');
          stopRecording('timeout');
        }
      }, captureTime * 1.5 + 10000);

      // Cleanup timeout on completion
      recorder.addEventListener('stop', () => {
        clearTimeout(recordingTimeout);
        clearInterval(checkEnd);
        clearInterval(progressInterval);
        clearInterval(dataMonitor);
      }, { once: true });
    });

    return captureResult;
  }

  // Execute capture and handle all errors
  doCapture()
    .then((result) => {
      clearTimeout(hardTimeoutId);
      console.log('[EXT][CAPTURE] SUCCESS - Sending result');
      sendResult(result);
    })
    .catch((error) => {
      clearTimeout(hardTimeoutId);
      console.error(`[EXT][CAPTURE] FAIL: ${error.message}`);
      sendResult(null, error.message);
    });
}

/**
 * LEGACY: Capture video using MediaRecorder (returns Promise)
 * Kept for compatibility but no longer used by captureAndUploadWithMediaRecorder
 *
 * @deprecated Use captureVideoWithMessage instead
 */
async function captureVideoSegmentWithMediaRecorder(startTime, endTime, videoId, uploadUrl) {
  console.log(`[EXT][CAPTURE] MediaRecorder start=${startTime}s end=${endTime}s videoId=${videoId}`);

  const duration = endTime - startTime;
  // Use 1x playback for reliable audio capture (4x caused audio issues)
  const PLAYBACK_SPEED = 1;
  const captureTime = (duration / PLAYBACK_SPEED) * 1000; // in milliseconds

  // Maximum size for Base64 transfer (40MB to stay under 64MB limit after encoding)
  const MAX_BASE64_SIZE = 40 * 1024 * 1024;

  console.log(`[EXT][CAPTURE] Will capture ${duration}s at ${PLAYBACK_SPEED}x (${(captureTime/1000).toFixed(1)}s real time)`);

  return new Promise((resolve, reject) => {
    // Hard timeout to prevent hanging forever
    // Expected time: (duration / 4x speed) + 20s buffer for seek/upload
    const HARD_TIMEOUT = ((duration / 4) * 1000) + 20000;
    let timeoutId = null;
    let captureCompleted = false;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
    };

    timeoutId = setTimeout(() => {
      if (!captureCompleted) {
        console.error(`[EXT][CAPTURE] FAIL: Hard timeout after ${HARD_TIMEOUT / 1000}s`);
        reject(new Error('Capture timed out. Please ensure the video is playing and try again.'));
      }
    }, HARD_TIMEOUT);

    try {
      // Find the video element - try multiple selectors
      let videoElement = document.querySelector('video.html5-main-video');
      if (!videoElement) {
        videoElement = document.querySelector('video');
      }

      if (!videoElement) {
        cleanup();
        console.error('[EXT][CAPTURE] FAIL: No video element found');
        reject(new Error('No video element found on page. Please ensure the YouTube video is loaded.'));
        return;
      }

      // Check if video has valid dimensions (indicates it's actually loaded)
      if (videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
        console.warn('[EXT][CAPTURE] Video dimensions are 0 - video may not be fully loaded');
      }

      console.log(`[EXT][CAPTURE] Video element found: ${videoElement.videoWidth}x${videoElement.videoHeight}, duration=${videoElement.duration}s, paused=${videoElement.paused}, readyState=${videoElement.readyState}`);

      // Ensure video is not paused
      if (videoElement.paused) {
        console.log('[EXT][CAPTURE] Video is paused, attempting to play...');
        videoElement.play().catch(e => console.warn('[EXT][CAPTURE] Play failed:', e.message));
      }

      // Wait for video to be ready (have enough data)
      const waitForReady = () => {
        return new Promise((res) => {
          if (videoElement.readyState >= 3) {
            res();
          } else {
            console.log(`[EXT][CAPTURE] Waiting for video data (readyState=${videoElement.readyState})...`);
            const onCanPlay = () => {
              videoElement.removeEventListener('canplay', onCanPlay);
              res();
            };
            videoElement.addEventListener('canplay', onCanPlay);
            // Timeout after 10 seconds
            setTimeout(() => {
              videoElement.removeEventListener('canplay', onCanPlay);
              res();
            }, 10000);
          }
        });
      };

      waitForReady().then(() => {
        // Seek to start position
        console.log(`[EXT][CAPTURE] Seeking to ${startTime}s...`);
        videoElement.currentTime = startTime;

        // Wait for seek to complete
        const onSeeked = () => {
          videoElement.removeEventListener('seeked', onSeeked);
          console.log(`[EXT][CAPTURE] Seek complete, currentTime=${videoElement.currentTime.toFixed(1)}s`);
          startCapture();
        };

      const startCapture = () => {
        try {
          // Capture the video stream from the element
          console.log('[EXT][CAPTURE] stream acquired - calling captureStream()');
          let stream;
          try {
            stream = videoElement.captureStream();
          } catch (captureStreamError) {
            console.error(`[EXT][CAPTURE] FAIL: captureStream() error: ${captureStreamError.message}`);
            cleanup();
            reject(new Error(`Could not capture video stream: ${captureStreamError.message}. The video may be DRM protected or unavailable.`));
            return;
          }

          if (!stream) {
            console.error('[EXT][CAPTURE] FAIL: captureStream() returned null');
            cleanup();
            reject(new Error('captureStream() returned null - video may be DRM protected'));
            return;
          }

          const videoTracks = stream.getVideoTracks();
          const audioTracks = stream.getAudioTracks();
          console.log(`[EXT][CAPTURE] Stream tracks: video=${videoTracks.length}, audio=${audioTracks.length}`);

          if (videoTracks.length === 0) {
            console.error('[EXT][CAPTURE] FAIL: No video tracks in stream');
            cleanup();
            reject(new Error('No video tracks available - video may be DRM protected or not playing'));
            return;
          }

          const chunks = [];

          // Try different codecs for best compatibility
          let mimeType = 'video/webm;codecs=vp9,opus';
          if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = 'video/webm;codecs=vp8,opus';
          }
          if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = 'video/webm';
          }

          console.log(`[EXT][CAPTURE] MediaRecorder started mimeType=${mimeType}`);

          const recorder = new MediaRecorder(stream, {
            mimeType: mimeType,
            videoBitsPerSecond: 8000000  // 8 Mbps for good quality
          });

          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              chunks.push(e.data);
            }
          };

          recorder.onstop = () => {
            // Restore normal speed
            videoElement.playbackRate = 1;
            videoElement.pause();

            console.log(`[EXT][CAPTURE] Recording stopped, chunks=${chunks.length}`);
            const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
            const blobSize = blob.size;
            console.log(`[EXT][CAPTURE] blob size=${(blobSize / 1024 / 1024).toFixed(2)}MB`);

            if (blobSize < 10000) {
              console.error('[EXT][CAPTURE] FAIL: Blob too small');
              cleanup();
              reject(new Error('Captured video too small - capture may have failed'));
              return;
            }

            // For ALL files: Use FileReader to convert to Base64
            // This ensures the Promise resolves synchronously relative to executeScript
            console.log(`[EXT][CAPTURE] Converting to Base64 (${(blobSize / 1024 / 1024).toFixed(2)}MB)`);

            if (blobSize > MAX_BASE64_SIZE) {
              console.warn(`[EXT][CAPTURE] WARNING: Large file ${(blobSize / 1024 / 1024).toFixed(2)}MB - may exceed Chrome 64MB message limit`);
            }

            const reader = new FileReader();

            reader.onloadend = () => {
              try {
                if (!reader.result) {
                  console.error('[EXT][CAPTURE] FAIL: FileReader result is null');
                  cleanup();
                  reject(new Error('FileReader result is null'));
                  return;
                }

                const base64Parts = reader.result.split(',');
                if (base64Parts.length < 2) {
                  console.error('[EXT][CAPTURE] FAIL: Invalid base64 format');
                  cleanup();
                  reject(new Error('Invalid base64 data format'));
                  return;
                }

                console.log('[EXT][CAPTURE] SUCCESS - Base64 conversion complete');
                captureCompleted = true;
                cleanup();
                resolve({
                  success: true,
                  uploadedDirectly: false,
                  videoData: base64Parts[1],
                  videoSize: blobSize,
                  mimeType: mimeType.split(';')[0],
                  duration: duration,
                  captureMethod: 'mediarecorder'
                });
              } catch (err) {
                console.error('[EXT][CAPTURE] FAIL: Error in onloadend:', err.message);
                cleanup();
                reject(new Error('Base64 processing error: ' + err.message));
              }
            };

            reader.onerror = () => {
              console.error('[EXT][CAPTURE] FAIL: FileReader error');
              cleanup();
              reject(new Error('FileReader failed to read blob'));
            };

            // Start reading - this triggers onloadend when complete
            reader.readAsDataURL(blob);
          };

          recorder.onerror = (e) => {
            videoElement.playbackRate = 1;
            console.error(`[EXT][CAPTURE] FAIL: MediaRecorder error: ${e.error?.message || 'unknown'}`);
            cleanup();
            reject(new Error(`MediaRecorder error: ${e.error?.message || 'unknown'}`));
          };

          // Set playback speed and start
          videoElement.playbackRate = PLAYBACK_SPEED;
          videoElement.muted = true; // Mute to avoid audio issues

          // Start recording
          recorder.start(500); // Capture in 500ms chunks
          console.log('[EXT][CAPTURE] Recording started');

          // Start playing
          videoElement.play().then(() => {
            console.log(`[EXT][CAPTURE] Playback started at ${PLAYBACK_SPEED}x speed`);
          }).catch(e => {
            console.warn(`[EXT][CAPTURE] Autoplay blocked: ${e.message} - continuing anyway`);
          });

          // Monitor progress
          const progressInterval = setInterval(() => {
            const progress = ((videoElement.currentTime - startTime) / duration * 100).toFixed(1);
            console.log(`[EXT][CAPTURE] Progress: ${progress}% (at ${videoElement.currentTime.toFixed(1)}s)`);
          }, 2000);

          // Stop when we reach end time or after calculated capture time
          const checkEnd = setInterval(() => {
            if (videoElement.currentTime >= endTime || videoElement.ended) {
              clearInterval(checkEnd);
              clearInterval(progressInterval);
              if (recorder.state === 'recording') {
                console.log('[EXT][CAPTURE] Reached end, stopping recorder...');
                recorder.stop();
              }
            }
          }, 100);

          // Safety timeout (add 50% buffer)
          setTimeout(() => {
            clearInterval(checkEnd);
            clearInterval(progressInterval);
            if (recorder.state === 'recording') {
              console.log('[EXT][CAPTURE] Timeout reached, stopping recorder...');
              recorder.stop();
            }
          }, captureTime * 1.5 + 5000);

        } catch (captureError) {
          console.error(`[EXT][CAPTURE] FAIL: Exception in startCapture: ${captureError.message}`);
          reject(captureError);
        }
      };

        // Start the process
        if (Math.abs(videoElement.currentTime - startTime) < 1) {
          startCapture();
        } else {
          videoElement.addEventListener('seeked', onSeeked);
          videoElement.currentTime = startTime;

          // Fallback if seeked event doesn't fire
          setTimeout(() => {
            if (videoElement.currentTime >= startTime - 1) {
              videoElement.removeEventListener('seeked', onSeeked);
              startCapture();
            }
          }, 3000);
        }
      }); // end waitForReady().then()

    } catch (error) {
      console.error(`[EXT][CAPTURE] FAIL: Top-level exception: ${error.message}`);
      reject(error);
    }
  });
}

/**
 * EXTENSION-ONLY: Capture and upload video using MediaRecorder
 * This is the main entry point for the capture process
 *
 * @param {string} videoId - YouTube video ID
 * @param {string} youtubeUrl - Full YouTube URL
 * @param {number} [requestedStartTime] - Optional segment start time in seconds
 * @param {number} [requestedEndTime] - Optional segment end time in seconds
 * @param {string} [bridgeRequestId] - Optional bridge request ID for wizard-bridge storage key
 */
async function captureAndUploadWithMediaRecorder(videoId, youtubeUrl, requestedStartTime, requestedEndTime, bridgeRequestId) {
  const hasSegmentRequest = requestedStartTime !== undefined && requestedEndTime !== undefined;
  const segmentInfo = hasSegmentRequest
    ? `segment ${requestedStartTime}s-${requestedEndTime}s`
    : 'auto-detect';
  console.log(`[EXT][CAPTURE] captureAndUploadWithMediaRecorder videoId=${videoId} ${segmentInfo}`);

  try {
    // Find or open YouTube tab with this video
    const tabs = await chrome.tabs.query({
      url: ['*://www.youtube.com/*', '*://youtube.com/*']
    });

    let youtubeTab = tabs.find(tab => {
      try {
        const url = new URL(tab.url);
        return url.searchParams.get('v') === videoId;
      } catch {
        return false;
      }
    });

    // USER-INITIATED CAPTURE: Don't auto-open tabs - require user to have video open
    if (!youtubeTab) {
      console.log(`[EXT][CAPTURE] No YouTube tab found with video ${videoId}`);
      return {
        success: false,
        error: 'Please open this video on YouTube first, then try exporting again.',
        code: 'NO_YOUTUBE_TAB'
      };
    }

    console.log(`[EXT][CAPTURE] Using existing YouTube tab ${youtubeTab.id}`)

    // Show capture progress overlay on YouTube tab
    await showCaptureOverlay(youtubeTab.id, requestedStartTime, requestedEndTime);
    await sendCaptureProgress(youtubeTab.id, {
      phase: 'initializing',
      percent: 0,
      message: 'Preparing video capture...',
      label: 'Initializing',
      startTime: requestedStartTime,
      endTime: requestedEndTime
    });

    // Save current tab (Video Wizard) so we can switch back after focusing YouTube
    let savedOriginalTabId = null;
    try {
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      savedOriginalTabId = currentTab?.id;
    } catch (e) {
      // Ignore
    }

    // CRITICAL: Focus the tab BRIEFLY to prevent Chrome from suspending media loading
    // Background tabs may have their video loading throttled or suspended
    console.log(`[EXT][CAPTURE] Focusing YouTube tab briefly to ensure video loads...`);
    try {
      await chrome.tabs.update(youtubeTab.id, { active: true });
      // Also focus the window containing the tab
      if (youtubeTab.windowId) {
        await chrome.windows.update(youtubeTab.windowId, { focused: true });
      }
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s for focus to take effect
    } catch (focusErr) {
      console.warn(`[EXT][CAPTURE] Could not focus tab: ${focusErr.message}`);
    }

    // CRITICAL FIX v2.7.11: Do NOT switch back to Video Wizard tab yet!
    // The YouTube tab MUST stay in foreground during capture.
    // Chrome throttles background tabs, which causes captureStream() to capture frozen frames.
    // See: https://bugs.chromium.org/p/chromium/issues/detail?id=639105
    // We will switch back AFTER capture completes.
    console.log(`[EXT][CAPTURE] Keeping YouTube tab in foreground for capture (savedOriginalTabId=${savedOriginalTabId})`);

    // v2.7.2: Check for ads FIRST before attempting video loading
    // Improved ad detection to reduce false positives
    console.log(`[EXT][CAPTURE] Checking for ads before video loading...`);
    try {
      const adCheckResult = await chrome.scripting.executeScript({
        target: { tabId: youtubeTab.id },
        world: 'MAIN',
        func: () => {
          // v2.7.2: Improved ad detection - only check for ACTIVE ad indicators
          const videoContainer = document.querySelector('.html5-video-player');
          const hasAdClass = videoContainer?.classList.contains('ad-showing') ||
                             videoContainer?.classList.contains('ad-interrupting');

          const ytPlayer = document.querySelector('#movie_player');
          let isAdFromPlayer = false;
          if (ytPlayer && typeof ytPlayer.getAdState === 'function') {
            try {
              isAdFromPlayer = ytPlayer.getAdState() === 1;
            } catch (e) {}
          }

          // Only check for VISIBLE ad elements
          const activeAdIndicators = [
            document.querySelector('.ytp-ad-preview-container:not([style*="display: none"])'),
            document.querySelector('.ytp-ad-text:not([style*="display: none"])'),
            document.querySelector('.ytp-ad-player-overlay-instream-info'),
            document.querySelector('.ytp-ad-skip-button-container:not([style*="display: none"])')
          ];
          const hasActiveAdIndicator = activeAdIndicators.some(el => el !== null && el.offsetParent !== null);

          // v2.7.2: Require player API OR container class for reliable detection
          const isAdPlaying = isAdFromPlayer || hasAdClass || (hasActiveAdIndicator);

          return {
            isAdPlaying,
            hasAdClass,
            isAdFromPlayer,
            hasActiveAdIndicator
          };
        }
      });

      const adStatus = adCheckResult[0]?.result;
      if (adStatus?.isAdPlaying) {
        console.log(`[EXT][CAPTURE] Ad detected (hasAdClass=${adStatus.hasAdClass}, isAdFromPlayer=${adStatus.isAdFromPlayer}), waiting...`);

        // Wait for ad to finish (up to 90 seconds for longer unskippable ads)
        let adWaitAttempts = 0;
        const MAX_AD_WAIT = 90; // Increased from 60s
        const CHECK_INTERVAL = 500; // Check every 500ms for faster response

        while (adWaitAttempts < MAX_AD_WAIT * 2) { // Double iterations since we check every 500ms
          adWaitAttempts++;

          // v2.7.2: Try multiple skip button selectors more aggressively
          await chrome.scripting.executeScript({
            target: { tabId: youtubeTab.id },
            world: 'MAIN',
            func: () => {
              const skipButtonSelectors = [
                '.ytp-skip-ad-button',
                '.ytp-ad-skip-button',
                '.ytp-ad-skip-button-modern',
                '.ytp-ad-skip-button-container button',
                'button.ytp-ad-skip-button',
                '[class*="skip-button"]',
                '.ytp-ad-skip-button-slot button',
                '.videoAdUiSkipButton',
                '.ytp-ad-skip'
              ];
              for (const selector of skipButtonSelectors) {
                const btn = document.querySelector(selector);
                if (btn && btn.offsetParent !== null) {
                  console.log(`[YVO] Clicking skip button (${selector})`);
                  btn.click();
                  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                  break;
                }
              }
            }
          });

          await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));

          // Check if ad is still playing using reliable indicators
          const adRecheck = await chrome.scripting.executeScript({
            target: { tabId: youtubeTab.id },
            world: 'MAIN',
            func: () => {
              const videoContainer = document.querySelector('.html5-video-player');
              const hasAdClass = videoContainer?.classList.contains('ad-showing') ||
                                 videoContainer?.classList.contains('ad-interrupting');

              const ytPlayer = document.querySelector('#movie_player');
              let isAdFromPlayer = false;
              if (ytPlayer && typeof ytPlayer.getAdState === 'function') {
                try { isAdFromPlayer = ytPlayer.getAdState() === 1; } catch (e) {}
              }

              return hasAdClass || isAdFromPlayer;
            }
          });

          if (!adRecheck[0]?.result) {
            console.log(`[EXT][CAPTURE] Ad finished after ${Math.round(adWaitAttempts * CHECK_INTERVAL / 1000)}s`);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for video to resume
            break;
          }

          // Log progress every 10 seconds
          if (adWaitAttempts % 20 === 0) {
            console.log(`[EXT][CAPTURE] Still waiting for ad to finish (${Math.round(adWaitAttempts * CHECK_INTERVAL / 1000)}s)...`);
          }
        }

        if (adWaitAttempts >= MAX_AD_WAIT * 2) {
          console.warn(`[EXT][CAPTURE] Ad wait timeout (${MAX_AD_WAIT}s), proceeding with capture anyway`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } else {
        console.log(`[EXT][CAPTURE] No ad detected, proceeding with video loading`);
      }
    } catch (adCheckError) {
      console.warn(`[EXT][CAPTURE] Ad check failed: ${adCheckError.message}, continuing anyway`);
    }

    // AGGRESSIVE VIDEO LOADING: Keep trying until video loads or we give up
    console.log(`[EXT][CAPTURE] Starting aggressive video loading sequence...`);
    let videoLoaded = false;
    let lastReadyState = 0;
    let lastIsPlaying = false;
    const MAX_LOAD_ATTEMPTS = 12; // Increased from 10
    const LOAD_WAIT_MS = 2000;

    for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS && !videoLoaded; attempt++) {
      console.log(`[EXT][CAPTURE] Video load attempt ${attempt}/${MAX_LOAD_ATTEMPTS}...`);

      try {
        // Trigger playback each attempt
        const playbackResult = await chrome.tabs.sendMessage(youtubeTab.id, { action: 'triggerPlayback' });
        lastReadyState = playbackResult?.readyState || 0;
        lastIsPlaying = playbackResult?.isPlaying || false;
        console.log(`[EXT][CAPTURE] Playback result: isPlaying=${lastIsPlaying}, readyState=${lastReadyState}, muted=${playbackResult?.muted}`);

        // v2.7.0: Require BOTH readyState >= 2 AND video not paused for better reliability
        if (lastReadyState >= 2 && lastIsPlaying) {
          videoLoaded = true;
          console.log(`[EXT][CAPTURE] Video loaded and playing! readyState=${lastReadyState}`);
          break;
        }

        // If readyState is good but not playing, just need to start playback
        if (lastReadyState >= 2 && !lastIsPlaying) {
          console.log(`[EXT][CAPTURE] Video loaded but not playing, forcing play...`);
        }

        // If still readyState=0 or 1, try clicking play button directly
        if (lastReadyState <= 1 || !lastIsPlaying) {
          console.log(`[EXT][CAPTURE] Video not ready/playing, injecting click handler...`);
          try {
            await chrome.scripting.executeScript({
              target: { tabId: youtubeTab.id },
              world: 'MAIN',
              func: () => {
                // Click YouTube's big play button if visible
                const bigPlayBtn = document.querySelector('.ytp-large-play-button');
                if (bigPlayBtn && bigPlayBtn.offsetParent !== null) {
                  console.log('[YVO] Clicking big play button');
                  bigPlayBtn.click();
                }

                // Click regular play button - check both English and Hebrew
                const playBtn = document.querySelector('.ytp-play-button');
                if (playBtn) {
                  const state = playBtn.getAttribute('data-title-no-tooltip');
                  if (state === 'Play' || state === 'נגן' || !state) {
                    console.log('[YVO] Clicking play button');
                    playBtn.click();
                  }
                }

                // Try YouTube player API
                const ytPlayer = document.querySelector('#movie_player');
                if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
                  console.log('[YVO] Calling ytPlayer.playVideo()');
                  try { ytPlayer.mute && ytPlayer.mute(); } catch(e) {}
                  ytPlayer.playVideo();
                }

                // Direct video element play
                const video = document.querySelector('video.html5-main-video');
                if (video) {
                  video.muted = true;
                  video.play().catch(() => {});
                }
              }
            });
          } catch (clickErr) {
            console.warn(`[EXT][CAPTURE] Click inject failed: ${clickErr.message}`);
          }
        }
      } catch (e) {
        console.log(`[EXT][CAPTURE] Playback trigger failed: ${e.message}`);
      }

      // Wait before next attempt
      if (attempt < MAX_LOAD_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, LOAD_WAIT_MS));
      }
    }

    // If video still not loaded after all attempts, return error early
    if (!videoLoaded) {
      console.error(`[EXT][CAPTURE] FAIL: Video never loaded after ${MAX_LOAD_ATTEMPTS} attempts (readyState=${lastReadyState}, isPlaying=${lastIsPlaying})`);
      return {
        success: false,
        error: 'Could not load video. Please manually play the video on YouTube and try again.',
        code: 'VIDEO_NOT_LOADED',
        details: {
          readyState: lastReadyState,
          isPlaying: lastIsPlaying,
          attempts: MAX_LOAD_ATTEMPTS,
          message: 'The video element did not load. This can happen if: (1) An ad is playing, (2) The video requires sign-in, (3) The video is region-restricted, (4) DRM protection.'
        }
      };
    }

    // CRITICAL: If capturing from a specific position (not 0), pre-seek and WAIT FOR BUFFER
    // v2.7.5: Smart pre-buffering - wait for sufficient buffer before starting capture
    if (hasSegmentRequest && requestedStartTime > 5) {
      const clipDuration = requestedEndTime - requestedStartTime;
      const requiredBuffer = Math.min(clipDuration + 30, 120); // Need clip duration + 30s safety, max 120s

      console.log(`[EXT][CAPTURE] === SMART PRE-BUFFERING ===`);
      console.log(`[EXT][CAPTURE] Clip position: ${requestedStartTime}s to ${requestedEndTime}s (${clipDuration}s)`);
      console.log(`[EXT][CAPTURE] Required buffer: ${requiredBuffer}s ahead of start position`);

      // Step 1: Seek to start position
      console.log(`[EXT][CAPTURE] Step 1: Seeking to ${requestedStartTime}s...`);
      try {
        await chrome.scripting.executeScript({
          target: { tabId: youtubeTab.id },
          world: 'MAIN',
          func: (seekTime) => {
            const ytPlayer = document.querySelector('#movie_player');
            if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
              console.log(`[YVO] Seeking to ${seekTime}s via YouTube API`);
              ytPlayer.seekTo(seekTime, true);
            } else {
              const video = document.querySelector('video.html5-main-video');
              if (video) {
                console.log(`[YVO] Seeking to ${seekTime}s via video element`);
                video.currentTime = seekTime;
              }
            }
          },
          args: [requestedStartTime]
        });

        // Brief wait for seek to initiate
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (seekErr) {
        console.warn(`[EXT][CAPTURE] Seek failed: ${seekErr.message}`);
      }

      // Step 2: Wait for buffer with progress updates
      console.log(`[EXT][CAPTURE] Step 2: Waiting for buffer (need ${requiredBuffer}s buffered)...`);

      // Calculate max wait time based on clip position
      // Deep clips need more time to buffer
      const baseWaitTime = 30000; // 30s base
      const positionFactor = Math.min(requestedStartTime / 60, 5); // Up to 5x for clips 5+ min in
      const maxBufferWait = baseWaitTime + (positionFactor * 30000); // 30s + up to 150s = max 180s (3 min)

      console.log(`[EXT][CAPTURE] Max buffer wait: ${(maxBufferWait / 1000).toFixed(0)}s (position factor: ${positionFactor.toFixed(1)}x)`);

      let bufferReady = false;
      let lastBufferStatus = null;
      const bufferStartTime = Date.now();
      const BUFFER_CHECK_INTERVAL = 2000; // Check every 2 seconds

      while (!bufferReady && (Date.now() - bufferStartTime) < maxBufferWait) {
        try {
          // Check buffer status
          const bufferCheck = await chrome.scripting.executeScript({
            target: { tabId: youtubeTab.id },
            world: 'MAIN',
            func: (startPos, needed) => {
              const video = document.querySelector('video.html5-main-video');
              if (!video) return { error: 'No video element' };

              const currentTime = video.currentTime;
              const buffered = video.buffered;
              let bufferedAhead = 0;

              // Find the buffer range that contains our start position
              for (let i = 0; i < buffered.length; i++) {
                const start = buffered.start(i);
                const end = buffered.end(i);

                // If this range contains our position, calculate how much is buffered ahead
                if (start <= startPos && end > startPos) {
                  bufferedAhead = end - startPos;
                  break;
                }
                // If this range is ahead of our position but close, also count it
                if (start > startPos && start < startPos + 5) {
                  bufferedAhead = end - startPos;
                  break;
                }
              }

              const percentReady = Math.min(100, (bufferedAhead / needed) * 100);

              return {
                currentTime: currentTime.toFixed(1),
                bufferedAhead: bufferedAhead.toFixed(1),
                needed: needed,
                percentReady: percentReady.toFixed(0),
                readyState: video.readyState,
                paused: video.paused,
                isReady: bufferedAhead >= needed
              };
            },
            args: [requestedStartTime, requiredBuffer]
          });

          const status = bufferCheck[0]?.result;

          if (status && !status.error) {
            lastBufferStatus = status;
            const elapsedSec = ((Date.now() - bufferStartTime) / 1000).toFixed(0);

            console.log(`[EXT][CAPTURE] Buffer: ${status.bufferedAhead}s / ${status.needed}s (${status.percentReady}%) - elapsed ${elapsedSec}s`);

            // Store progress for wizard-bridge to poll
            if (bridgeRequestId) {
              await chrome.storage.local.set({
                [`bridge_progress_${bridgeRequestId}`]: {
                  phase: 'buffering',
                  bufferedAhead: parseFloat(status.bufferedAhead),
                  needed: status.needed,
                  percentReady: parseInt(status.percentReady),
                  elapsedSeconds: parseInt(elapsedSec),
                  message: `Buffering at ${Math.floor(requestedStartTime / 60)}:${(requestedStartTime % 60).toString().padStart(2, '0')}... ${status.percentReady}% ready`
                }
              });
            }

            // Update capture progress overlay with buffering status
            await sendCaptureProgress(youtubeTab.id, {
              phase: 'buffering',
              percent: parseInt(status.percentReady),
              message: `Buffering video at position...`,
              label: `${status.bufferedAhead}s / ${status.needed}s buffered`,
              details: {
                segment: `${formatTimeForOverlay(requestedStartTime)} → ${formatTimeForOverlay(requestedEndTime)}`,
                duration: `${Math.round(requestedEndTime - requestedStartTime)}s`
              }
            });

            if (status.isReady) {
              bufferReady = true;
              console.log(`[EXT][CAPTURE] ✓ Buffer ready! ${status.bufferedAhead}s buffered ahead`);
              break;
            }

            // Ensure video is playing to encourage buffering
            if (status.paused) {
              console.log(`[EXT][CAPTURE] Video paused, resuming playback to encourage buffering...`);
              await chrome.scripting.executeScript({
                target: { tabId: youtubeTab.id },
                world: 'MAIN',
                func: () => {
                  const video = document.querySelector('video.html5-main-video');
                  if (video && video.paused) {
                    video.muted = true;  // CRITICAL: Required for Chrome autoplay policy
                    video.play().catch(() => {});
                  }
                }
              });
            }
          } else {
            console.log(`[EXT][CAPTURE] Buffer check failed: ${status?.error || 'unknown'}`);
          }
        } catch (bufferErr) {
          console.warn(`[EXT][CAPTURE] Buffer check error: ${bufferErr.message}`);
        }

        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, BUFFER_CHECK_INTERVAL));
      }

      // Step 3: Handle buffer wait result
      const totalWaitTime = ((Date.now() - bufferStartTime) / 1000).toFixed(1);

      if (!bufferReady) {
        // Buffer didn't reach required level, but we might still have enough to try
        const gotBuffer = parseFloat(lastBufferStatus?.bufferedAhead || 0);
        const minViableBuffer = Math.min(clipDuration * 0.7, 30); // At least 70% of clip or 30s

        if (gotBuffer >= minViableBuffer) {
          console.log(`[EXT][CAPTURE] Buffer incomplete (${gotBuffer}s/${requiredBuffer}s) but sufficient to attempt capture`);
        } else {
          console.warn(`[EXT][CAPTURE] ⚠ Buffer insufficient after ${totalWaitTime}s wait (got ${gotBuffer}s, need ${requiredBuffer}s)`);
          console.warn(`[EXT][CAPTURE] Proceeding anyway - capture may fail or be incomplete`);

          // Store warning for wizard-bridge
          if (bridgeRequestId) {
            await chrome.storage.local.set({
              [`bridge_progress_${bridgeRequestId}`]: {
                phase: 'buffering_warning',
                message: `Buffer incomplete (${Math.round(gotBuffer)}s of ${requiredBuffer}s). Attempting capture anyway...`,
                warning: true
              }
            });
          }
        }
      } else {
        console.log(`[EXT][CAPTURE] ✓ Pre-buffering complete in ${totalWaitTime}s`);
      }

      // Clear progress now that buffering is done
      if (bridgeRequestId) {
        await chrome.storage.local.set({
          [`bridge_progress_${bridgeRequestId}`]: {
            phase: 'capturing',
            message: 'Starting video capture...'
          }
        });
      }

      // Final position verification
      try {
        const seekCheck = await chrome.tabs.sendMessage(youtubeTab.id, { action: 'getVideoInfo' });
        console.log(`[EXT][CAPTURE] Final position: currentTime=${seekCheck?.videoInfo?.currentTime || 'unknown'}s`);
      } catch (e) {
        // Ignore
      }

      console.log(`[EXT][CAPTURE] === PRE-BUFFERING COMPLETE ===`);
    }

    // Get video duration from content script
    let videoInfo;
    try {
      videoInfo = await chrome.tabs.sendMessage(youtubeTab.id, { action: 'getVideoInfo' });
      if (videoInfo?.success && videoInfo?.videoInfo?.duration > 0) {
        console.log(`[EXT][CAPTURE] Got video info: duration=${videoInfo.videoInfo.duration}s`);
      } else {
        console.log(`[EXT][CAPTURE] Video info incomplete, using fallback`);
        videoInfo = { success: true, videoInfo: { duration: 300 } };
      }
    } catch (e) {
      console.log(`[EXT][CAPTURE] Could not get video info: ${e.message}, using fallback`);
      videoInfo = { success: true, videoInfo: { duration: 300 } };
    }

    const videoDuration = videoInfo?.videoInfo?.duration || 300;

    // Determine capture range:
    // - If segment times provided: use those (from Video Wizard clip selection)
    // - Otherwise: capture from start, up to 5 minutes max
    const MAX_CAPTURE_DURATION = 300; // 5 minutes max to keep capture time reasonable

    let captureStart, captureEnd;

    if (hasSegmentRequest) {
      // Use requested segment times from Video Wizard
      captureStart = Math.max(0, requestedStartTime);
      captureEnd = Math.min(requestedEndTime, videoDuration);

      // Validate segment duration
      const segmentDuration = captureEnd - captureStart;
      if (segmentDuration > MAX_CAPTURE_DURATION) {
        console.warn(`[EXT][CAPTURE] Segment ${segmentDuration}s exceeds max ${MAX_CAPTURE_DURATION}s, limiting`);
        captureEnd = captureStart + MAX_CAPTURE_DURATION;
      }

      console.log(`[EXT][CAPTURE] Segment: ${captureStart}s to ${captureEnd}s (${captureEnd - captureStart}s)`);
    } else {
      // No segment specified - capture from start, up to max duration
      captureStart = 0;
      captureEnd = Math.min(MAX_CAPTURE_DURATION, videoDuration);
      console.log(`[EXT][CAPTURE] No segment, capturing first ${captureEnd}s`);
    }

    console.log(`[EXT][CAPTURE] Injecting MediaRecorder (${captureStart}s to ${captureEnd}s)...`);

    // Prepare upload URL for direct upload from page context (for large files)
    const uploadStreamUrl = `${VIDEO_PROCESSOR_URL}/upload-stream`;

    // Calculate expected capture time and set timeout
    // v2.7.5: Updated timeout calculation to account for smart pre-buffering
    // Timeout = capture time + buffer wait time + processing time
    const captureDuration = captureEnd - captureStart;
    const PLAYBACK_SPEED = 1; // Must match the value in captureVideoWithMessage
    const expectedCaptureTime = (captureDuration / PLAYBACK_SPEED) * 1000;

    // Calculate buffer wait time based on start position
    // v2.7.5: Matches the maxBufferWait calculation in pre-buffering logic
    // Deep clips (15+ min) can take up to 3 minutes to buffer
    const baseBufferWait = 30000; // 30s base
    const positionFactor = Math.min(captureStart / 60, 5); // Up to 5x for clips 5+ min in
    const maxBufferWait = baseBufferWait + (positionFactor * 30000); // 30s + up to 150s = max 180s

    // Processing time: video loading (30s) + upload/conversion (60s)
    const processingBuffer = 90000;

    // Total timeout: capture time + buffer wait + processing
    const captureTimeout = expectedCaptureTime + maxBufferWait + processingBuffer;

    console.log(`[EXT][CAPTURE] Timeout calculation: capture=${(expectedCaptureTime / 1000).toFixed(0)}s + buffer=${(maxBufferWait / 1000).toFixed(0)}s + processing=${processingBuffer / 1000}s = ${(captureTimeout / 1000).toFixed(0)}s total`);

    // Inject and run the capture function with videoId and uploadUrl for direct upload
    // SOLUTION: Use message passing instead of relying on executeScript return value
    // executeScript with world: 'MAIN' doesn't properly wait for Promises that resolve via callbacks

    // Generate a unique capture ID for this request
    // If bridgeRequestId is provided, use it as the storage key so wizard-bridge can find the result
    const captureId = `capture_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    // CRITICAL: Use bridgeRequestId for storage if provided - this is the key wizard-bridge polls for
    const storageKey = bridgeRequestId || captureId;

    console.log(`[EXT][CAPTURE] captureId=${captureId}, storageKey=${storageKey}`);

    // Clear any previous result for this storage key
    await chrome.storage.local.remove([`bridge_result_${storageKey}`, `capture_result_${captureId}`]);

    // Set up a Promise that resolves when we receive the capture result
    // Uses BOTH message passing AND chrome.storage polling for reliability
    const captureResultPromise = new Promise((resolveCapture, rejectCapture) => {
      let resolved = false;

      // Timeout handler
      const messageTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.runtime.onMessage.removeListener(messageHandler);
          rejectCapture(new Error(`Capture timed out after ${(captureTimeout / 1000).toFixed(0)} seconds`));
        }
      }, captureTimeout);

      // Poll chrome.storage as fallback (in case message passing fails)
      // CRITICAL: Poll for bridge_result_${storageKey} which is what the relay stores
      const storagePoller = setInterval(async () => {
        if (resolved) {
          clearInterval(storagePoller);
          return;
        }
        try {
          // Check for result stored by relay with the storageKey (bridgeRequestId if provided)
          const stored = await chrome.storage.local.get([`bridge_result_${storageKey}`]);
          const result = stored[`bridge_result_${storageKey}`];
          if (result) {
            console.log(`[EXT][CAPTURE] Retrieved result from storage (key=bridge_result_${storageKey})`);
            resolved = true;
            clearTimeout(messageTimeout);
            clearInterval(storagePoller);
            chrome.runtime.onMessage.removeListener(messageHandler);
            // Clean up storage
            chrome.storage.local.remove([`bridge_result_${storageKey}`]);
            if (result.error) {
              rejectCapture(new Error(result.error));
            } else {
              resolveCapture(result.result);
            }
          }
        } catch (e) {
          // Ignore storage errors
        }
      }, 1000); // Check every second

      // Message handler (primary method)
      // NOTE: Return false after sendResponse to properly close the message channel
      // Returning true after sendResponse causes "message channel closed" errors
      function messageHandler(message, sender, sendResponse) {
        if (message.captureId === captureId) {
          if (message.type === 'CAPTURE_STARTED') {
            console.log(`[EXT][CAPTURE] Received CAPTURE_STARTED - function is running!`);
            sendResponse({ received: true });
            return false; // Channel can close - response already sent
          }

          if (message.type === 'CAPTURE_RESULT') {
            if (resolved) {
              sendResponse({ received: true, alreadyHandled: true });
              return false; // Channel can close - response already sent
            }
            console.log(`[EXT][CAPTURE] Received CAPTURE_RESULT via message`);
            resolved = true;
            clearTimeout(messageTimeout);
            clearInterval(storagePoller);
            chrome.runtime.onMessage.removeListener(messageHandler);

            sendResponse({ received: true });

            // Clean up storage (in case relay also stored it)
            chrome.storage.local.remove([`bridge_result_${storageKey}`]);

            if (message.error) {
              rejectCapture(new Error(message.error));
            } else {
              resolveCapture(message.result);
            }
            return false; // Channel can close - response already sent
          }
        }
        return false;
      }

      chrome.runtime.onMessage.addListener(messageHandler);
    });

    // First, inject a message relay script into the content script context
    // This listens for postMessage from the MAIN world and forwards to service worker
    // ALSO stores result in chrome.storage as a reliable backup
    // v2.7.1: Added localStorage polling as additional fallback + better logging
    console.log(`[EXT][CAPTURE] Injecting relay script (ISOLATED world)...`);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: youtubeTab.id },
        world: 'ISOLATED',
        func: (cid, bridgeStorageKey) => {
          console.log(`[EXT][RELAY] ====== RELAY SCRIPT STARTING v2.7.3 ======`);
          console.log(`[EXT][RELAY] captureId=${cid}, bridgeStorageKey=${bridgeStorageKey}`);

          // Remove any existing listener to avoid duplicates
          if (window.__captureMessageHandler) {
            console.log(`[EXT][RELAY] Removing existing message handler`);
            window.removeEventListener('message', window.__captureMessageHandler);
          }
          if (window.__captureLocalStoragePoller) {
            console.log(`[EXT][RELAY] Clearing existing localStorage poller`);
            clearInterval(window.__captureLocalStoragePoller);
          }

          let resultHandled = false;

        // Function to store and forward result
        const handleResult = (result, error, source) => {
          if (resultHandled) {
            console.log(`[EXT][RELAY] Result already handled, ignoring from ${source}`);
            return;
          }
          resultHandled = true;

          // Stop the localStorage poller
          if (window.__captureLocalStoragePoller) {
            clearInterval(window.__captureLocalStoragePoller);
          }

          // CRITICAL: Store result in chrome.storage with bridgeStorageKey so wizard-bridge can find it
          // This is the key that wizard-bridge polls for: bridge_result_${bridgeRequestId}
          const chromeStorageKey = `bridge_result_${bridgeStorageKey}`;
          const resultData = {
            result: result,
            error: error,
            timestamp: Date.now()
          };

          console.log(`[EXT][RELAY] Handling result from ${source}, storing in chrome.storage (key=${chromeStorageKey})`);
          chrome.storage.local.set({ [chromeStorageKey]: resultData }).then(() => {
            console.log(`[EXT][RELAY] Result stored in chrome.storage (key=${chromeStorageKey})`);
          }).catch(e => {
            console.error(`[EXT][RELAY] Failed to store in chrome.storage:`, e.message);
          });

          // Also send via message (may fail, but storage is backup)
          console.log(`[EXT][RELAY] Forwarding result to service worker (success=${!!result?.success}, error=${error || 'none'})`);
          chrome.runtime.sendMessage({
            type: 'CAPTURE_RESULT',
            captureId: cid,
            result: result,
            error: error
          }).then(response => {
            console.log(`[EXT][RELAY] Result forwarded via message`);
          }).catch(e => {
            console.warn('[EXT][RELAY] Message failed, but result is in storage:', e.message);
          });

          // Clean up
          window.removeEventListener('message', window.__captureMessageHandler);
        };

        // Listen for postMessage from MAIN world
        window.__captureMessageHandler = (event) => {
          // Only process messages from same origin with our captureId
          if (!event.data || typeof event.data !== 'object') return;
          if (event.data.captureId !== cid) return;

          try {
            if (event.data.type === 'YVO_CAPTURE_STARTED') {
              // Forward start notification
              console.log(`[EXT][RELAY] Capture function started!`);
              chrome.runtime.sendMessage({
                type: 'CAPTURE_STARTED',
                captureId: cid
              }).then(response => {
                console.log(`[EXT][RELAY] Start notification acknowledged`);
              }).catch(e => console.warn('[EXT][RELAY] Start notification error (non-fatal):', e.message));

            } else if (event.data.type === 'YVO_CAPTURE_RESULT') {
              handleResult(event.data.result, event.data.error, 'postMessage');
            }
          } catch (relayError) {
            console.error('[EXT][RELAY] Error in message handler:', relayError);
          }
        };

        window.addEventListener('message', window.__captureMessageHandler);

        // FALLBACK: Also poll localStorage in case postMessage fails
        // The capture function stores result in localStorage as a fallback
        window.__captureLocalStoragePoller = setInterval(() => {
          if (resultHandled) {
            clearInterval(window.__captureLocalStoragePoller);
            return;
          }

          try {
            const lsKey = `yvo_capture_result_${cid}`;
            const lsData = localStorage.getItem(lsKey);
            if (lsData) {
              console.log(`[EXT][RELAY] Found result in localStorage!`);
              localStorage.removeItem(lsKey);
              const parsed = JSON.parse(lsData);
              handleResult(parsed.result, parsed.error, 'localStorage');
            }
          } catch (e) {
            // Ignore localStorage errors
          }
        }, 500);

        console.log(`[EXT][RELAY] Message relay installed for capture ${cid} (with storage + localStorage backup)`);
        return 'relay_installed';
      },
      args: [captureId, storageKey]
    });
      console.log(`[EXT][CAPTURE] Relay script injection successful (storageKey=${storageKey})`);
    } catch (relayInjectionError) {
      console.error(`[EXT][CAPTURE] Relay script injection failed: ${relayInjectionError.message}`);
      throw new Error(`Failed to inject relay script: ${relayInjectionError.message}`);
    }

    // Small delay to ensure relay is fully set up
    await new Promise(resolve => setTimeout(resolve, 100));

    // CRITICAL FIX v2.7.11: Ensure video is playing RIGHT BEFORE capture injection
    // For long videos with deep clips, the video might have paused during the gap
    // between pre-buffering completion and capture injection
    console.log(`[EXT][CAPTURE] Ensuring video is playing before capture injection...`);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: youtubeTab.id },
        world: 'MAIN',
        func: () => {
          const video = document.querySelector('video.html5-main-video');
          if (video) {
            console.log(`[YVO] Pre-injection check: paused=${video.paused}, readyState=${video.readyState}`);
            if (video.paused) {
              console.log('[YVO] Video paused before capture injection, resuming with muted=true...');
              video.muted = true;
              video.play().catch(e => console.warn('[YVO] Pre-injection play failed:', e.message));
            }
          }
        }
      });
      // Brief wait for play to take effect
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (prePlayErr) {
      console.warn(`[EXT][CAPTURE] Pre-injection play check failed: ${prePlayErr.message}`);
    }

    // Now inject the capture function into MAIN world
    // NEW v2.6.8: Pass upload URL so capture can upload directly from page context
    // This avoids message passing issues with large video data
    const directUploadUrl = `${VIDEO_PROCESSOR_URL}/upload-stream`;
    console.log(`[EXT][CAPTURE] Injecting capture function (captureId=${captureId}, directUpload=true)`);

    // Update overlay to show capturing phase
    const clipDurationForDisplay = captureEnd - captureStart;
    await sendCaptureProgress(youtubeTab.id, {
      phase: 'capturing',
      percent: 0,
      message: 'Recording video segment...',
      label: `0s / ${Math.round(clipDurationForDisplay)}s captured`,
      details: {
        segment: `${formatTimeForOverlay(captureStart)} → ${formatTimeForOverlay(captureEnd)}`,
        duration: `${Math.round(clipDurationForDisplay)}s`
      }
    });

    try {
      const injectionResult = await chrome.scripting.executeScript({
        target: { tabId: youtubeTab.id },
        world: 'MAIN',
        func: captureVideoWithMessage,
        args: [captureStart, captureEnd, videoId, captureId, directUploadUrl]
      });
      console.log(`[EXT][CAPTURE] Injection result:`, injectionResult);
    } catch (injectionError) {
      console.error(`[EXT][CAPTURE] FAIL: Script injection error: ${injectionError.message}`);
      throw new Error(`Failed to inject capture script: ${injectionError.message}`);
    }

    // Wait for the result via message passing
    const captureResult = await captureResultPromise;

    // CRITICAL FIX v2.7.11: Now that capture is complete, switch back to Video Wizard tab
    // The YouTube tab was kept in foreground during capture to prevent Chrome throttling
    if (savedOriginalTabId && savedOriginalTabId !== youtubeTab.id) {
      try {
        await chrome.tabs.update(savedOriginalTabId, { active: true });
        console.log(`[EXT][CAPTURE] Capture complete - switched back to Video Wizard tab ${savedOriginalTabId}`);
      } catch (switchErr) {
        console.warn(`[EXT][CAPTURE] Could not switch back to original tab: ${switchErr.message}`);
      }
    }

    if (!captureResult.success) {
      console.error(`[EXT][CAPTURE] FAIL: ${captureResult.error}`);
      throw new Error(captureResult.error || 'Capture failed');
    }

    const capturedDuration = captureEnd - captureStart;
    console.log(`[EXT][CAPTURE] blob size=${(captureResult.videoSize / 1024 / 1024).toFixed(2)}MB duration=${capturedDuration}s`);

    // CHECK: Did the capture function upload directly (for large files)?
    if (captureResult.uploadedDirectly && captureResult.videoStorageUrl) {
      console.log(`[EXT][CAPTURE] Direct upload completed in page context`);
      // Show completion on overlay
      await showCaptureComplete(youtubeTab.id, 'Capture & upload complete!');
      return {
        success: true,
        videoStorageUrl: captureResult.videoStorageUrl,
        storagePath: null,
        mimeType: captureResult.mimeType,
        captureMethod: captureResult.captureMethod || 'mediarecorder_direct_upload',
        uploadedToStorage: true,
        capturedSegment: {
          startTime: captureStart,
          endTime: captureEnd,
          duration: capturedDuration
        }
      };
    }

    // SMALL FILE PATH: Capture returned Base64 data, upload from service worker
    if (!captureResult.videoData) {
      throw new Error('No video data returned from capture');
    }

    const videoBlob = base64ToBlob(captureResult.videoData, captureResult.mimeType);

    const formData = new FormData();
    formData.append('video', videoBlob, `captured_${videoId}.webm`);
    formData.append('videoId', videoId);
    formData.append('type', 'video');
    // Include segment info so server knows what was captured
    formData.append('captureStart', String(captureStart));
    formData.append('captureEnd', String(captureEnd));
    formData.append('capturedDuration', String(capturedDuration));

    console.log(`[EXT][UPLOAD] Uploading to server (${captureStart}s-${captureEnd}s)...`);

    // Update overlay to show uploading phase
    await sendCaptureProgress(youtubeTab.id, {
      phase: 'uploading',
      percent: 50,
      message: 'Uploading captured video...',
      label: `${(videoBlob.size / 1024 / 1024).toFixed(1)}MB`,
      details: {
        segment: `${formatTimeForOverlay(captureStart)} → ${formatTimeForOverlay(captureEnd)}`,
        duration: `${Math.round(capturedDuration)}s`
      }
    });

    // Try uploading to server - if it fails, return local data for frontend upload
    let uploadResult = null;
    let uploadError = null;

    // Upload with retry logic - Cloud Run can have cold starts
    const UPLOAD_TIMEOUT_MS = 90000; // 90 seconds per attempt
    const MAX_RETRIES = 2;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(`[EXT][UPLOAD] Attempt ${attempt}/${MAX_RETRIES}...`);

      const abortController = new AbortController();
      const uploadTimeoutId = setTimeout(() => {
        console.log(`[EXT][UPLOAD] Aborting upload after ${UPLOAD_TIMEOUT_MS / 1000}s timeout`);
        abortController.abort();
      }, UPLOAD_TIMEOUT_MS);

      try {
        const uploadResponse = await fetch(`${VIDEO_PROCESSOR_URL}/upload-stream`, {
          method: 'POST',
          body: formData,
          signal: abortController.signal
        });

        clearTimeout(uploadTimeoutId);

        if (!uploadResponse.ok) {
          const errorText = await uploadResponse.text();
          uploadError = `Server ${uploadResponse.status}: ${errorText.substring(0, 100)}`;
          console.error(`[EXT][UPLOAD] FAIL: ${uploadError}`);
        } else {
          uploadResult = await uploadResponse.json();
          console.log(`[EXT][UPLOAD] success url=${uploadResult.url}`);
          break; // Success - exit retry loop
        }
      } catch (serverError) {
        clearTimeout(uploadTimeoutId);
        if (serverError.name === 'AbortError') {
          uploadError = `Upload timed out after ${UPLOAD_TIMEOUT_MS / 1000} seconds`;
        } else {
          uploadError = `Connection failed: ${serverError.message}`;
        }
        console.error(`[EXT][UPLOAD] FAIL attempt ${attempt}: ${uploadError}`);
      }

      // If not last attempt and failed, wait before retry
      if (attempt < MAX_RETRIES && !uploadResult) {
        const waitTime = attempt * 2000; // 2s, 4s, etc.
        console.log(`[EXT][UPLOAD] Waiting ${waitTime / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    // If server upload succeeded, return the storage URL
    if (uploadResult && uploadResult.url) {
      // Show completion on overlay
      await showCaptureComplete(youtubeTab.id, 'Capture & upload complete!');
      return {
        success: true,
        videoStorageUrl: uploadResult.url,
        storagePath: uploadResult.storagePath || null,
        mimeType: captureResult.mimeType,
        captureMethod: 'mediarecorder',
        uploadedToStorage: true,
        capturedSegment: {
          startTime: captureStart,
          endTime: captureEnd,
          duration: capturedDuration
        }
      };
    }

    // Server upload failed - return local data for frontend to upload
    console.log(`[EXT][UPLOAD] Server unavailable, returning local data for frontend upload`);

    // Show completion on overlay (frontend will handle upload)
    await showCaptureComplete(youtubeTab.id, 'Capture complete! Finishing upload...');

    // NOTE: URL.createObjectURL is NOT available in Service Workers (Manifest V3)
    // Return base64 data directly for frontend to upload to Firebase Storage
    return {
      success: true,
      videoStorageUrl: null,
      videoData: captureResult.videoData,  // Base64 encoded for frontend upload
      videoSize: captureResult.videoSize,
      mimeType: captureResult.mimeType,
      captureMethod: 'mediarecorder_local',
      uploadedToStorage: false,
      uploadError: uploadError,
      capturedSegment: {
        startTime: captureStart,
        endTime: captureEnd,
        duration: capturedDuration
      }
    };

  } catch (error) {
    console.error(`[EXT][CAPTURE] FAIL: ${error.message}`);
    // Try to show error on overlay (youtubeTab might not be defined if error occurred early)
    try {
      const tabs = await chrome.tabs.query({ url: ['*://www.youtube.com/*', '*://youtube.com/*'] });
      if (tabs.length > 0) {
        await showCaptureError(tabs[0].id, `Capture failed: ${error.message.substring(0, 50)}`);
      }
    } catch (e) {
      // Ignore overlay errors
    }
    return {
      success: false,
      error: error.message,
      code: 'CAPTURE_EXCEPTION'
    };
  }
}

/**
 * Download video stream from YouTube and upload to our server
 * This bypasses IP-restriction by downloading in the user's browser (same IP as YouTube)
 * and uploading to our server which stores it in Firebase Storage
 *
 * @param {string} videoId - YouTube video ID
 * @param {string} videoUrl - The IP-restricted video stream URL
 * @param {string} audioUrl - Optional audio stream URL (for DASH streams)
 * @returns {Promise<{success: boolean, videoStorageUrl?: string, audioStorageUrl?: string, error?: string}>}
 */
async function downloadAndUploadStream(videoId, videoUrl, audioUrl) {
  console.log(`[EXT][BG] Starting browser-side download for ${videoId}`);
  console.log(`[EXT][BG] Will use content script for download (has page cookie access)`);

  if (!videoUrl) {
    return { success: false, error: 'No video URL provided' };
  }

  // Validate URLs
  if (!isValidGoogleVideoUrl(videoUrl)) {
    return { success: false, error: 'Invalid video URL' };
  }
  if (audioUrl && !isValidGoogleVideoUrl(audioUrl)) {
    audioUrl = null; // Skip invalid audio URL
  }

  try {
    // Find the best YouTube tab for downloading
    // Prefer the tab that's playing this specific video (has the stream URLs bound to it)
    console.log(`[EXT][BG] Finding YouTube tab for in-page download...`);
    const tabs = await chrome.tabs.query({
      url: ['*://www.youtube.com/*', '*://youtube.com/*']
    });

    if (tabs.length === 0) {
      throw new Error('No YouTube tab found. Please have YouTube open in a tab.');
    }

    // Find the tab with this specific video (REQUIRED - URLs are IP-bound to specific sessions)
    let youtubeTab = tabs.find(tab => {
      try {
        const url = new URL(tab.url);
        return url.searchParams.get('v') === videoId ||
               tab.url.includes(`/shorts/${videoId}`) ||
               tab.url.includes(`/embed/${videoId}`);
      } catch {
        return false;
      }
    });

    // STRICT: Require exact video tab match - URLs are session-bound
    if (!youtubeTab) {
      // Don't fall back to wrong tab - this would download wrong video or get 403
      console.error(`[EXT][BG] No tab found with video ${videoId}. Available tabs:`, tabs.map(t => t.url));
      throw new Error(`YouTube tab with video ${videoId} not found. Please ensure the video is open in a YouTube tab.`);
    }

    console.log(`[EXT][BG] Found video-specific tab ${youtubeTab.id} for ${videoId}`);

    // Use chrome.scripting.executeScript to run download code directly in the page's MAIN world
    // CRITICAL: world: 'MAIN' is required to access page cookies for cross-origin requests
    console.log(`[EXT][BG] Injecting download code into YouTube tab (MAIN world)...`);

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: youtubeTab.id },
      world: 'MAIN',  // Execute in page's main world for cookie/session access
      func: downloadVideoInPage,
      args: [videoUrl, audioUrl]
    });

    if (!injectionResults || injectionResults.length === 0 || !injectionResults[0].result) {
      throw new Error('Script injection failed');
    }

    const downloadResult = injectionResults[0].result;

    if (!downloadResult.success) {
      throw new Error(downloadResult.error || 'In-page download failed');
    }

    console.log(`[EXT][BG] In-page download successful: ${(downloadResult.videoSize / 1024 / 1024).toFixed(2)}MB`);

    // Convert base64 back to Blob for upload
    const videoBlob = base64ToBlob(downloadResult.videoData, 'video/mp4');
    console.log(`[EXT][BG] Converted to blob: ${(videoBlob.size / 1024 / 1024).toFixed(2)}MB`);

    // Step 2: Upload video to our server
    console.log(`[EXT][BG] Uploading video to server...`);
    const videoFormData = new FormData();
    videoFormData.append('video', videoBlob, 'video.mp4');
    videoFormData.append('videoId', videoId);
    videoFormData.append('type', 'video');

    // Add timeout to prevent hanging
    const UPLOAD_TIMEOUT_MS = 60000;
    const videoAbortController = new AbortController();
    const videoUploadTimeoutId = setTimeout(() => {
      console.log(`[EXT][BG] Aborting video upload after ${UPLOAD_TIMEOUT_MS / 1000}s timeout`);
      videoAbortController.abort();
    }, UPLOAD_TIMEOUT_MS);

    let videoUploadResponse;
    try {
      videoUploadResponse = await fetch(`${VIDEO_PROCESSOR_URL}/upload-stream`, {
        method: 'POST',
        body: videoFormData,
        signal: videoAbortController.signal
      });
      clearTimeout(videoUploadTimeoutId);
    } catch (fetchError) {
      clearTimeout(videoUploadTimeoutId);
      if (fetchError.name === 'AbortError') {
        throw new Error(`Video upload timed out after ${UPLOAD_TIMEOUT_MS / 1000} seconds`);
      }
      throw fetchError;
    }

    if (!videoUploadResponse.ok) {
      const errorText = await videoUploadResponse.text();
      throw new Error(`Video upload failed: ${videoUploadResponse.status} - ${errorText}`);
    }

    const videoUploadResult = await videoUploadResponse.json();
    console.log(`[EXT][BG] Video uploaded successfully: ${videoUploadResult.url}`);

    let audioStorageUrl = null;

    // Step 3: Upload audio if content script downloaded it
    if (downloadResult.audioData) {
      try {
        console.log(`[EXT][BG] Content script also downloaded audio, uploading...`);
        const audioBlob = base64ToBlob(downloadResult.audioData, 'audio/mp4');

        const audioFormData = new FormData();
        audioFormData.append('video', audioBlob, 'audio.mp4');
        audioFormData.append('videoId', videoId);
        audioFormData.append('type', 'audio');

        // Add timeout for audio upload
        const audioAbortController = new AbortController();
        const audioUploadTimeoutId = setTimeout(() => {
          console.log(`[EXT][BG] Aborting audio upload after 60s timeout`);
          audioAbortController.abort();
        }, 60000);

        const audioUploadResponse = await fetch(`${VIDEO_PROCESSOR_URL}/upload-stream`, {
          method: 'POST',
          body: audioFormData,
          signal: audioAbortController.signal
        });
        clearTimeout(audioUploadTimeoutId);

        if (audioUploadResponse.ok) {
          const audioUploadResult = await audioUploadResponse.json();
          audioStorageUrl = audioUploadResult.url;
          console.log(`[EXT][BG] Audio uploaded successfully: ${audioStorageUrl}`);
        }
      } catch (audioError) {
        console.warn(`[EXT][BG] Audio upload failed (non-fatal):`, audioError.message);
      }
    }

    return {
      success: true,
      videoStorageUrl: videoUploadResult.url,
      audioStorageUrl: audioStorageUrl
    };

  } catch (error) {
    console.error(`[EXT][BG] Download/upload failed:`, error);

    // Provide a helpful error message based on the failure type
    let userFriendlyError = error.message;

    if (error.message.includes('403')) {
      userFriendlyError = 'YouTube blocked the download request (403). The video may have additional restrictions or the session expired. Try playing the video first, then export again.';
    } else if (error.message.includes('Script injection failed')) {
      userFriendlyError = 'Could not access the YouTube page. Please make sure a YouTube tab is open and try again.';
    } else if (error.message.includes('No YouTube tab found')) {
      userFriendlyError = 'No YouTube tab found. Please open the video on YouTube first, then try exporting.';
    }

    return {
      success: false,
      error: userFriendlyError,
      originalError: error.message
    };
  }
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
 * Convert base64 string to Blob
 * Used to reconstruct video data received from content script
 */
function base64ToBlob(base64, mimeType = 'video/mp4') {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
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
