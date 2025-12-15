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
const VIDEO_PROCESSOR_URL = 'https://video-processor-867328435695.us-central1.run.app';

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
 * Message handler for extension communication
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Log EVERY message for debugging
  console.log('[EXT][BG] === MESSAGE RECEIVED ===');
  console.log('[EXT][BG] Action:', message?.action);
  console.log('[EXT][BG] From:', sender?.url || sender?.origin || 'unknown');

  try {
    switch (message.action) {
      // Video Wizard integration
      case 'captureVideoForWizard':
        console.log('[EXT][BG] Handling captureVideoForWizard...');
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
 *
 * NOW SUPPORTS: Segment capture with startTime/endTime parameters
 */
async function handleCaptureForWizard(message, sendResponse) {
  const { videoId, youtubeUrl, autoCapture = true, startTime, endTime, quality, autoOpenTab = false } = message;

  console.log(`[EXT][CAPTURE] === START === videoId=${videoId} autoCapture=${autoCapture} autoOpenTab=${autoOpenTab}`);

  // CRITICAL: Ensure sendResponse is ALWAYS called
  let responseSent = false;
  const safeResponse = (response) => {
    if (responseSent) {
      console.log('[EXT][CAPTURE] Response already sent, ignoring duplicate');
      return;
    }
    responseSent = true;
    console.log(`[EXT][CAPTURE] === RESPONSE === success=${response?.success} error=${response?.error || 'none'}`);
    try {
      sendResponse(response);
    } catch (e) {
      console.error('[EXT][CAPTURE] Failed to send response:', e.message);
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
    safeResponse({ success: false, error: 'Invalid video ID', code: 'INVALID_VIDEO_ID' });
    return;
  }

  // If autoCapture is false, only return video metadata
  if (autoCapture === false) {
    console.log(`[EXT][CAPTURE] autoCapture=false - returning metadata only`);
    try {
      const videoInfo = await getBasicVideoInfo(videoId, youtubeUrl);
      safeResponse({
        success: true,
        videoInfo: videoInfo,
        streamData: null,
        message: 'Video info retrieved (capture skipped - autoCapture=false)'
      });
    } catch (infoError) {
      console.error(`[EXT][CAPTURE] Failed to get video info: ${infoError.message}`);
      safeResponse({
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

    if (!youtubeTab) {
      console.log(`[EXT][CAPTURE] No YouTube tab found with video ${videoId}`);

      if (autoOpenTab) {
        // AUTO-OPEN: Create a new tab with the video
        console.log(`[EXT][CAPTURE] autoOpenTab=true, opening new YouTube tab...`);
        const videoUrl = youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`;

        try {
          // Create tab (active: true to ensure video loads properly)
          const newTab = await chrome.tabs.create({
            url: videoUrl,
            active: true
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

        } catch (tabError) {
          console.error(`[EXT][CAPTURE] Failed to create YouTube tab: ${tabError.message}`);
          safeResponse({
            success: false,
            error: 'Failed to open YouTube video tab: ' + tabError.message,
            code: 'TAB_OPEN_FAILED',
            videoInfo: await getBasicVideoInfo(videoId, youtubeUrl)
          });
          return;
        }
      } else {
        // No autoOpenTab, return error asking user to open the video
        safeResponse({
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
      captureResult = await captureAndUploadWithMediaRecorder(videoId, youtubeUrl, startTime, endTime);
      console.log(`[EXT][CAPTURE] MediaRecorder result: success=${captureResult?.success} error=${captureResult?.error || 'none'}`);
    } catch (captureError) {
      console.error(`[EXT][CAPTURE] MediaRecorder exception: ${captureError.message}`);
      captureResult = { success: false, error: captureError.message };
    }

    // STEP 4: Process result
    if (captureResult?.success) {
      const videoInfo = await getBasicVideoInfo(videoId, youtubeUrl);
      const capturedSegment = captureResult.capturedSegment || {};

      const response = {
        success: true,
        videoInfo: videoInfo,
        streamData: {
          videoUrl: captureResult.videoStorageUrl || null,
          videoData: captureResult.videoData || null,
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
          : 'Video captured locally. Frontend will upload to storage.'
      };

      // Store for later retrieval
      storedVideoData = {
        videoInfo: videoInfo,
        streamData: response.streamData,
        capturedAt: Date.now()
      };

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

      safeResponse(response);
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

      safeResponse({
        success: false,
        error: errorMsg,
        code: captureResult?.code || 'CAPTURE_FAILED',
        videoInfo: await getBasicVideoInfo(videoId, youtubeUrl),
        details: {
          message: 'Please ensure the YouTube video is loaded and playing, then try again.'
        }
      });
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

    safeResponse({
      success: false,
      error: error.message || 'Unexpected error during capture',
      code: 'UNEXPECTED_ERROR'
    });
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

      // Open the YouTube video - must be ACTIVE briefly for autoplay to work
      // Chrome's autoplay policy requires the tab to have "user activation"
      captureTab = await chrome.tabs.create({
        url: url,
        active: true  // Must be active for autoplay to trigger
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
 * The video is sped up to 4x to minimize capture time.
 * For a 60-second clip, this takes only ~15 seconds.
 *
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 * @param {string} videoId - YouTube video ID
 * @param {string} captureId - Unique ID to correlate the result message
 */
function captureVideoWithMessage(startTime, endTime, videoId, captureId) {
  // IMMEDIATE LOG - if this doesn't appear, function isn't running at all
  console.log(`[EXT][CAPTURE-PAGE] Function started! captureId=${captureId}`);

  const duration = endTime - startTime;
  const PLAYBACK_SPEED = 4;
  const captureTime = (duration / PLAYBACK_SPEED) * 1000;
  const MAX_BASE64_SIZE = 40 * 1024 * 1024;

  // CRITICAL: Track if we've sent a result to prevent duplicate sends
  let resultSent = false;

  // Helper to send result back via postMessage (with duplicate prevention)
  function sendResult(result, error = null) {
    if (resultSent) {
      console.log(`[EXT][CAPTURE-PAGE] Result already sent, ignoring duplicate`);
      return;
    }
    resultSent = true;
    console.log(`[EXT][CAPTURE-PAGE] Posting result via postMessage (error=${error || 'none'})...`);
    try {
      window.postMessage({
        type: 'YVO_CAPTURE_RESULT',
        captureId: captureId,
        result: result,
        error: error
      }, '*');
      console.log(`[EXT][CAPTURE-PAGE] Result posted (success=${!error})`);
    } catch (postError) {
      console.error(`[EXT][CAPTURE-PAGE] Failed to post result: ${postError.message}`);
    }
  }

  // CRITICAL: Hard timeout to GUARANTEE we always send a response
  // This prevents the frontend from hanging forever
  const HARD_TIMEOUT_MS = captureTime + 60000; // capture time + 60s buffer
  const hardTimeoutId = setTimeout(() => {
    if (!resultSent) {
      console.error(`[EXT][CAPTURE-PAGE] HARD TIMEOUT after ${HARD_TIMEOUT_MS / 1000}s - forcing error response`);
      sendResult(null, `Capture timed out after ${Math.round(HARD_TIMEOUT_MS / 1000)} seconds. Please try again.`);
    }
  }, HARD_TIMEOUT_MS);

  // Send immediate "started" notification so we know the function is running
  try {
    window.postMessage({
      type: 'YVO_CAPTURE_STARTED',
      captureId: captureId
    }, '*');
  } catch (e) {
    console.error(`[EXT][CAPTURE-PAGE] Failed to send start notification: ${e.message}`);
  }

  console.log(`[EXT][CAPTURE-PAGE] Will capture ${duration}s at ${PLAYBACK_SPEED}x start=${startTime}s end=${endTime}s (timeout=${Math.round(HARD_TIMEOUT_MS / 1000)}s)`);

  // Helper to wait with timeout
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // Helper to wait for video to be ready (has valid dimensions and duration)
  async function waitForVideoReady(videoEl, maxWaitMs = 15000) {
    const startWait = Date.now();

    function isVideoReady() {
      return (
        videoEl.videoWidth > 0 &&
        videoEl.videoHeight > 0 &&
        isFinite(videoEl.duration) &&
        videoEl.duration > 0 &&
        videoEl.readyState >= 2  // HAVE_CURRENT_DATA - relaxed from 3 to be more forgiving
      );
    }

    // Check immediately
    if (isVideoReady()) {
      console.log(`[EXT][CAPTURE] Video already ready: ${videoEl.videoWidth}x${videoEl.videoHeight}, duration=${videoEl.duration}s, readyState=${videoEl.readyState}`);
      return videoEl;
    }

    console.log(`[EXT][CAPTURE] Video not ready yet: ${videoEl.videoWidth}x${videoEl.videoHeight}, duration=${videoEl.duration}s, readyState=${videoEl.readyState}. Waiting...`);

    // Poll until ready or timeout
    while (Date.now() - startWait < maxWaitMs) {
      await sleep(200);
      if (isVideoReady()) {
        console.log(`[EXT][CAPTURE] Video became ready: ${videoEl.videoWidth}x${videoEl.videoHeight}, duration=${videoEl.duration}s, readyState=${videoEl.readyState}`);
        return videoEl;
      }
    }

    // Timeout - throw error with detailed diagnostics
    throw new Error(`Video not ready after ${maxWaitMs / 1000}s: dimensions=${videoEl.videoWidth}x${videoEl.videoHeight}, duration=${videoEl.duration}, readyState=${videoEl.readyState}`);
  }

  // Main async capture function
  async function doCapture() {
    // CRITICAL: Use YouTube's player API to ensure video is loaded and playing
    const ytPlayer = document.querySelector('#movie_player');
    console.log(`[EXT][CAPTURE] YouTube player element: ${ytPlayer ? 'found' : 'not found'}`);

    // Try to use YouTube's player API to load and play the video
    if (ytPlayer) {
      try {
        const hasPlayVideo = typeof ytPlayer.playVideo === 'function';
        const hasGetPlayerState = typeof ytPlayer.getPlayerState === 'function';
        const hasMute = typeof ytPlayer.mute === 'function';
        const hasSeekTo = typeof ytPlayer.seekTo === 'function';

        console.log(`[EXT][CAPTURE] YouTube API: playVideo=${hasPlayVideo}, getPlayerState=${hasGetPlayerState}, mute=${hasMute}, seekTo=${hasSeekTo}`);

        if (hasPlayVideo) {
          // Mute first to avoid autoplay policy issues
          if (hasMute) {
            ytPlayer.mute();
            console.log('[EXT][CAPTURE] Muted YouTube player');
          }

          // Get current state (-1=unstarted, 0=ended, 1=playing, 2=paused, 3=buffering, 5=cued)
          let playerState = hasGetPlayerState ? ytPlayer.getPlayerState() : -1;
          console.log(`[EXT][CAPTURE] YouTube player state: ${playerState}`);

          // If video is unstarted, ended, paused or cued - play it
          if (playerState === -1 || playerState === 0 || playerState === 2 || playerState === 5) {
            console.log('[EXT][CAPTURE] Starting YouTube player via API...');
            ytPlayer.playVideo();
            await sleep(1500);
            playerState = hasGetPlayerState ? ytPlayer.getPlayerState() : -1;
            console.log(`[EXT][CAPTURE] YouTube player state after play: ${playerState}`);
          }

          // If still not playing (state 1) or buffering (state 3), wait longer
          if (hasGetPlayerState && (ytPlayer.getPlayerState() !== 1 && ytPlayer.getPlayerState() !== 3)) {
            console.log('[EXT][CAPTURE] Player not playing, waiting for buffer...');
            await sleep(2000);
          }
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

    // Log comprehensive video element diagnostics
    console.log(`[EXT][CAPTURE] Video element found: ${videoElement.videoWidth}x${videoElement.videoHeight}, duration=${videoElement.duration}s, readyState=${videoElement.readyState}`);
    console.log(`[EXT][CAPTURE] Video state: paused=${videoElement.paused}, ended=${videoElement.ended}, networkState=${videoElement.networkState}, currentTime=${videoElement.currentTime}`);

    // Check for video errors
    if (videoElement.error) {
      throw new Error(`Video has error: ${videoElement.error.message || 'Unknown error (code ' + videoElement.error.code + ')'}`);
    }

    // If video has readyState=0, try aggressive loading
    let loadAttempts = 0;
    const MAX_LOAD_ATTEMPTS = 8;
    while (videoElement.readyState === 0 && loadAttempts < MAX_LOAD_ATTEMPTS) {
      loadAttempts++;
      console.log(`[EXT][CAPTURE] Video readyState=0, trying to force load... (attempt ${loadAttempts}/${MAX_LOAD_ATTEMPTS})`);

      // Method 1: Use YouTube player API
      if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
        try {
          ytPlayer.playVideo();
        } catch (e) {}
      }

      // Method 2: Click video element
      videoElement.click();
      await sleep(200);

      // Method 3: Force muted play
      videoElement.muted = true;
      try {
        await videoElement.play();
        console.log('[EXT][CAPTURE] Force video.play() succeeded');
      } catch (e) {
        console.warn('[EXT][CAPTURE] Force video.play() failed:', e.message);
      }

      // Method 4: Click YouTube's play button
      const playBtn = document.querySelector('.ytp-play-button');
      if (playBtn) {
        playBtn.click();
      }

      // Method 5: Click big play button if visible
      const bigPlayBtn = document.querySelector('.ytp-large-play-button');
      if (bigPlayBtn && getComputedStyle(bigPlayBtn).display !== 'none') {
        bigPlayBtn.click();
      }

      await sleep(1500);
      console.log(`[EXT][CAPTURE] After attempt ${loadAttempts}: readyState=${videoElement.readyState}, paused=${videoElement.paused}`);

      if (videoElement.readyState > 0) {
        console.log(`[EXT][CAPTURE] Video started loading! readyState=${videoElement.readyState}`);
        break;
      }
    }

    if (videoElement.readyState === 0) {
      throw new Error('Video failed to load after multiple attempts. This may be due to: an ad playing, video requires sign-in, video is region-restricted, or DRM protection.');
    }

    // Ensure video is playing
    if (videoElement.paused) {
      videoElement.muted = true;
      try {
        await videoElement.play();
      } catch (e) {
        console.warn('[EXT][CAPTURE] Play failed:', e.message);
      }
    }

    // Wait for video to be fully ready
    const readyVideoElement = await waitForVideoReady(videoElement, 15000);

    // Seek to start position
    console.log(`[EXT][CAPTURE] Seeking to ${startTime}s...`);
    readyVideoElement.currentTime = startTime;

    // Wait for seek to complete
    await new Promise((resolve) => {
      const checkSeek = () => {
        if (Math.abs(readyVideoElement.currentTime - startTime) < 2) {
          resolve();
        }
      };
      readyVideoElement.addEventListener('seeked', checkSeek, { once: true });
      setTimeout(() => {
        readyVideoElement.removeEventListener('seeked', checkSeek);
        resolve(); // Resolve anyway after timeout
      }, 3000);
    });
    console.log(`[EXT][CAPTURE] Seek complete, currentTime=${readyVideoElement.currentTime}s`);

    // Capture the video stream
    console.log('[EXT][CAPTURE] Calling captureStream()...');
    let originalStream;
    try {
      originalStream = readyVideoElement.captureStream();
    } catch (e) {
      throw new Error(`Could not capture video stream: ${e.message}. This video may be DRM-protected.`);
    }

    if (!originalStream || originalStream.getVideoTracks().length === 0) {
      const errorMsg = readyVideoElement.mediaKeys
        ? 'No video tracks available - this video is DRM-protected and cannot be captured'
        : 'No video tracks available - please ensure the video is playing and not blocked';
      throw new Error(errorMsg);
    }

    // Clone tracks to prevent "Tracks in MediaStream were added" error
    console.log('[EXT][CAPTURE] Creating stable stream with cloned tracks...');
    const stableStream = new MediaStream();

    originalStream.getVideoTracks().forEach(track => {
      const clonedTrack = track.clone();
      stableStream.addTrack(clonedTrack);
      console.log(`[EXT][CAPTURE] Cloned video track: ${track.label || 'unnamed'}`);
    });

    originalStream.getAudioTracks().forEach(track => {
      const clonedTrack = track.clone();
      stableStream.addTrack(clonedTrack);
      console.log(`[EXT][CAPTURE] Cloned audio track: ${track.label || 'unnamed'}`);
    });

    console.log(`[EXT][CAPTURE] Stable stream created: ${stableStream.getVideoTracks().length} video, ${stableStream.getAudioTracks().length} audio tracks`);

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

      const recorder = new MediaRecorder(stableStream, {
        mimeType: mimeType,
        videoBitsPerSecond: 8000000
      });

      const cleanupTracks = () => {
        stableStream.getTracks().forEach(track => track.stop());
      };

      const stopRecording = () => {
        if (!recorderStopped && recorder.state === 'recording') {
          recorderStopped = true;
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
        }
      };

      recorder.onstop = async () => {
        readyVideoElement.playbackRate = 1;
        readyVideoElement.pause();
        cleanupTracks();

        console.log(`[EXT][CAPTURE] Recording stopped, chunks=${chunks.length}`);

        if (chunks.length === 0) {
          reject(new Error('No video data captured - recording produced empty result'));
          return;
        }

        const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
        const blobSize = blob.size;
        console.log(`[EXT][CAPTURE] Blob size=${(blobSize / 1024 / 1024).toFixed(2)}MB`);

        if (blobSize < 10000) {
          reject(new Error('Captured video too small - may indicate playback issue'));
          return;
        }

        // Convert to Base64
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
        readyVideoElement.playbackRate = 1;
        cleanupTracks();
        const errorMsg = e.error?.message || e.error?.name || 'unknown';
        console.error(`[EXT][CAPTURE] MediaRecorder error: ${errorMsg}`);

        // Try to salvage what we have
        if (chunks.length > 0 && !recorderStopped) {
          console.log(`[EXT][CAPTURE] Error occurred but have ${chunks.length} chunks, attempting to salvage...`);
          stopRecording();
        } else {
          reject(new Error(`MediaRecorder error: ${errorMsg}`));
        }
      };

      // Set playback speed and start
      readyVideoElement.playbackRate = PLAYBACK_SPEED;
      readyVideoElement.muted = true;

      // Start recording
      const startRecording = () => {
        try {
          recorder.start(500);
          console.log('[EXT][CAPTURE] Recording started');
        } catch (startErr) {
          reject(new Error(`Failed to start recording: ${startErr.message}`));
        }
      };

      // Ensure video is playing
      const playPromise = readyVideoElement.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(startRecording).catch((e) => {
          console.warn('[EXT][CAPTURE] Play failed, trying to record anyway:', e.message);
          startRecording();
        });
      } else {
        startRecording();
      }

      // Monitor progress
      const progressInterval = setInterval(() => {
        if (recorderStopped) {
          clearInterval(progressInterval);
          return;
        }
        const progress = ((readyVideoElement.currentTime - startTime) / duration * 100).toFixed(1);
        console.log(`[EXT][CAPTURE] Progress: ${progress}% (at ${readyVideoElement.currentTime.toFixed(1)}s)`);
      }, 3000);

      // Stop when we reach end time
      const checkEnd = setInterval(() => {
        if (readyVideoElement.currentTime >= endTime || readyVideoElement.ended) {
          clearInterval(checkEnd);
          clearInterval(progressInterval);
          console.log('[EXT][CAPTURE] Reached end, stopping recorder...');
          stopRecording();
        }
      }, 100);

      // Safety timeout for recording
      const recordingTimeout = setTimeout(() => {
        clearInterval(checkEnd);
        clearInterval(progressInterval);
        if (!recorderStopped) {
          console.log('[EXT][CAPTURE] Recording timeout, stopping...');
          stopRecording();
        }
      }, captureTime * 1.5 + 10000);

      // Cleanup timeout on completion
      recorder.addEventListener('stop', () => {
        clearTimeout(recordingTimeout);
        clearInterval(checkEnd);
        clearInterval(progressInterval);
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
  const PLAYBACK_SPEED = 4; // 4x speed for faster capture
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
 */
async function captureAndUploadWithMediaRecorder(videoId, youtubeUrl, requestedStartTime, requestedEndTime) {
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

    // CRITICAL: Focus the tab to prevent Chrome from suspending media loading
    // Background tabs may have their video loading throttled or suspended
    console.log(`[EXT][CAPTURE] Focusing YouTube tab to ensure video loads...`);
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

    // AGGRESSIVE VIDEO LOADING: Keep trying until video loads or we give up
    console.log(`[EXT][CAPTURE] Starting aggressive video loading sequence...`);
    let videoLoaded = false;
    let lastReadyState = 0;
    const MAX_LOAD_ATTEMPTS = 10;
    const LOAD_WAIT_MS = 2000;

    for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS && !videoLoaded; attempt++) {
      console.log(`[EXT][CAPTURE] Video load attempt ${attempt}/${MAX_LOAD_ATTEMPTS}...`);

      try {
        // Trigger playback each attempt
        const playbackResult = await chrome.tabs.sendMessage(youtubeTab.id, { action: 'triggerPlayback' });
        lastReadyState = playbackResult?.readyState || 0;
        console.log(`[EXT][CAPTURE] Playback result: isPlaying=${playbackResult?.isPlaying}, readyState=${lastReadyState}, muted=${playbackResult?.muted}`);

        // readyState >= 2 means we have current data, >= 3 means we have future data
        if (lastReadyState >= 2) {
          videoLoaded = true;
          console.log(`[EXT][CAPTURE] Video loaded! readyState=${lastReadyState}`);
          break;
        }

        // If still readyState=0 or 1, try clicking play button directly
        if (lastReadyState <= 1) {
          console.log(`[EXT][CAPTURE] Video not ready, injecting click handler...`);
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

                // Click regular play button
                const playBtn = document.querySelector('.ytp-play-button');
                if (playBtn) {
                  const state = playBtn.getAttribute('data-title-no-tooltip');
                  if (state === 'Play') {
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
      console.error(`[EXT][CAPTURE] FAIL: Video never loaded after ${MAX_LOAD_ATTEMPTS} attempts (readyState=${lastReadyState})`);
      return {
        success: false,
        error: 'Could not load video. Please manually play the video on YouTube and try again.',
        code: 'VIDEO_NOT_LOADED',
        details: {
          readyState: lastReadyState,
          attempts: MAX_LOAD_ATTEMPTS,
          message: 'The video element did not load. This can happen if: (1) An ad is playing, (2) The video requires sign-in, (3) The video is region-restricted.'
        }
      };
    }

    // CRITICAL: If capturing from a specific position (not 0), pre-seek BEFORE capture
    if (hasSegmentRequest && requestedStartTime > 5) {
      console.log(`[EXT][CAPTURE] Pre-seeking to ${requestedStartTime}s before capture...`);
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

        // Wait for seek and buffering
        console.log(`[EXT][CAPTURE] Waiting for seek and buffering...`);
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Verify we're at the right position
        const seekCheck = await chrome.tabs.sendMessage(youtubeTab.id, { action: 'getVideoInfo' });
        console.log(`[EXT][CAPTURE] After seek: currentTime=${seekCheck?.videoInfo?.currentTime || 'unknown'}s, readyState=${seekCheck?.videoInfo?.readyState || 'unknown'}`);
      } catch (seekErr) {
        console.warn(`[EXT][CAPTURE] Pre-seek failed: ${seekErr.message}, continuing anyway`);
      }
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
    // Capture time = (segment duration / playback speed) + generous buffer for:
    // - Video loading (up to 20s)
    // - Pre-seek and buffering (up to 10s)
    // - Base64 conversion and upload (up to 30s)
    // - Safety margin
    const captureDuration = captureEnd - captureStart;
    const PLAYBACK_SPEED = 4; // Must match the value in captureVideoWithMessage
    const expectedCaptureTime = (captureDuration / PLAYBACK_SPEED) * 1000;
    const captureTimeout = expectedCaptureTime + 90000; // Add 90 second buffer for setup/load/upload

    console.log(`[EXT][CAPTURE] Expected capture time: ${(expectedCaptureTime / 1000).toFixed(1)}s, timeout: ${(captureTimeout / 1000).toFixed(1)}s`);

    // Inject and run the capture function with videoId and uploadUrl for direct upload
    // SOLUTION: Use message passing instead of relying on executeScript return value
    // executeScript with world: 'MAIN' doesn't properly wait for Promises that resolve via callbacks

    // Generate a unique capture ID for this request
    const captureId = `capture_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Set up a Promise that resolves when we receive the capture result via message
    const captureResultPromise = new Promise((resolveCapture, rejectCapture) => {
      const messageTimeout = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(messageHandler);
        rejectCapture(new Error(`Capture timed out after ${(captureTimeout / 1000).toFixed(0)} seconds`));
      }, captureTimeout);

      function messageHandler(message, sender, sendResponse) {
        if (message.captureId === captureId) {
          if (message.type === 'CAPTURE_STARTED') {
            console.log(`[EXT][CAPTURE] Received CAPTURE_STARTED - function is running!`);
            return true;
          }

          if (message.type === 'CAPTURE_RESULT') {
            console.log(`[EXT][CAPTURE] Received CAPTURE_RESULT`);
            clearTimeout(messageTimeout);
            chrome.runtime.onMessage.removeListener(messageHandler);

            if (message.error) {
              rejectCapture(new Error(message.error));
            } else {
              resolveCapture(message.result);
            }
            return true;
          }
        }
      }

      chrome.runtime.onMessage.addListener(messageHandler);
    });

    // First, inject a message relay script into the content script context
    // This listens for postMessage from the MAIN world and forwards to service worker
    await chrome.scripting.executeScript({
      target: { tabId: youtubeTab.id },
      world: 'ISOLATED',
      func: (cid) => {
        // Remove any existing listener to avoid duplicates
        if (window.__captureMessageHandler) {
          window.removeEventListener('message', window.__captureMessageHandler);
        }

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
              }).catch(e => console.error('[EXT][RELAY] Failed to forward start:', e.message));
            } else if (event.data.type === 'YVO_CAPTURE_RESULT') {
              // Forward result to service worker
              console.log(`[EXT][RELAY] Forwarding result to service worker (success=${!!event.data.result?.success}, error=${event.data.error || 'none'})`);
              chrome.runtime.sendMessage({
                type: 'CAPTURE_RESULT',
                captureId: cid,
                result: event.data.result,
                error: event.data.error
              }).catch(e => console.error('[EXT][RELAY] Failed to forward result:', e.message));
              // Clean up
              window.removeEventListener('message', window.__captureMessageHandler);
            }
          } catch (relayError) {
            console.error('[EXT][RELAY] Error in message handler:', relayError);
          }
        };

        window.addEventListener('message', window.__captureMessageHandler);
        console.log(`[EXT][RELAY] Message relay installed for capture ${cid}`);
      },
      args: [captureId]
    });

    // Small delay to ensure relay is fully set up
    await new Promise(resolve => setTimeout(resolve, 100));

    // Now inject the capture function into MAIN world
    // Modified to use postMessage instead of returning a Promise
    console.log(`[EXT][CAPTURE] Injecting capture function (captureId=${captureId})`);

    try {
      const injectionResult = await chrome.scripting.executeScript({
        target: { tabId: youtubeTab.id },
        world: 'MAIN',
        func: captureVideoWithMessage,
        args: [captureStart, captureEnd, videoId, captureId]
      });
      console.log(`[EXT][CAPTURE] Injection result:`, injectionResult);
    } catch (injectionError) {
      console.error(`[EXT][CAPTURE] FAIL: Script injection error: ${injectionError.message}`);
      throw new Error(`Failed to inject capture script: ${injectionError.message}`);
    }

    // Wait for the result via message passing
    const captureResult = await captureResultPromise;

    if (!captureResult.success) {
      console.error(`[EXT][CAPTURE] FAIL: ${captureResult.error}`);
      throw new Error(captureResult.error || 'Capture failed');
    }

    const capturedDuration = captureEnd - captureStart;
    console.log(`[EXT][CAPTURE] blob size=${(captureResult.videoSize / 1024 / 1024).toFixed(2)}MB duration=${capturedDuration}s`);

    // CHECK: Did the capture function upload directly (for large files)?
    if (captureResult.uploadedDirectly && captureResult.videoStorageUrl) {
      console.log(`[EXT][CAPTURE] Direct upload completed in page context`);
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

    // Try uploading to server - if it fails, return local data for frontend upload
    let uploadResult = null;
    let uploadError = null;

    try {
      const uploadResponse = await fetch(`${VIDEO_PROCESSOR_URL}/upload-stream`, {
        method: 'POST',
        body: formData
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        uploadError = `Server ${uploadResponse.status}: ${errorText.substring(0, 100)}`;
        console.error(`[EXT][UPLOAD] FAIL: ${uploadError}`);
      } else {
        uploadResult = await uploadResponse.json();
        console.log(`[EXT][UPLOAD] success url=${uploadResult.url}`);
      }
    } catch (serverError) {
      uploadError = `Connection failed: ${serverError.message}`;
      console.error(`[EXT][UPLOAD] FAIL: ${uploadError}`);
    }

    // If server upload succeeded, return the storage URL
    if (uploadResult && uploadResult.url) {
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

    const videoUploadResponse = await fetch(`${VIDEO_PROCESSOR_URL}/upload-stream`, {
      method: 'POST',
      body: videoFormData
    });

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

        const audioUploadResponse = await fetch(`${VIDEO_PROCESSOR_URL}/upload-stream`, {
          method: 'POST',
          body: audioFormData
        });

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
