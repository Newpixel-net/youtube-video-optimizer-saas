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
 * NOW SUPPORTS: Segment capture with startTime/endTime parameters
 */
async function handleCaptureForWizard(message, sendResponse) {
  const { videoId, youtubeUrl, autoCapture = true, startTime, endTime } = message;

  if (!videoId || !isValidVideoId(videoId)) {
    sendResponse({ success: false, error: 'Invalid video ID' });
    return;
  }

  console.log(`[YVO Background] Capture request for video: ${videoId}`);

  // Helper function to process captured streams - NOW USES MEDIARECORDER CAPTURE
  async function processAndUploadStreams(intercepted, source) {
    console.log(`[YVO Background] processAndUploadStreams called with source: ${source}`);

    const videoInfo = await getBasicVideoInfo(videoId, youtubeUrl);

    // NEW APPROACH: Use MediaRecorder to capture video as it plays
    // This bypasses ALL URL restrictions because we capture from the video element directly
    // Now supports segment capture with startTime/endTime from Video Wizard
    const segmentInfo = (startTime !== undefined && endTime !== undefined)
      ? `segment ${startTime}s-${endTime}s`
      : 'auto (up to 5 min)';
    console.log(`[YVO Background] Using MediaRecorder capture (bypasses all URL restrictions) - ${segmentInfo}`);

    let uploadResult;
    try {
      // Pass segment times to capture function (uses closure from outer handleCaptureForWizard)
      uploadResult = await captureAndUploadWithMediaRecorder(videoId, youtubeUrl, startTime, endTime);
      console.log(`[YVO Background] MediaRecorder capture returned:`, uploadResult.success, uploadResult.error || 'no error');
    } catch (captureError) {
      console.error(`[YVO Background] MediaRecorder capture threw exception:`, captureError);
      uploadResult = { success: false, error: captureError.message };
    }

    if (uploadResult.success) {
      console.log(`[YVO Background] MediaRecorder capture and upload successful!`);
      const capturedSegment = uploadResult.capturedSegment || {};
      return {
        success: true,
        videoInfo: videoInfo,
        streamData: {
          videoUrl: uploadResult.videoStorageUrl,
          quality: 'captured',
          mimeType: uploadResult.mimeType || 'video/webm',
          capturedAt: Date.now(),
          source: 'mediarecorder_capture',
          uploadedToStorage: true,
          // Include captured segment info for server processing
          capturedSegment: capturedSegment,
          captureStartTime: capturedSegment.startTime,
          captureEndTime: capturedSegment.endTime,
          captureDuration: capturedSegment.duration
        },
        message: `Video segment (${capturedSegment.startTime || 0}s-${capturedSegment.endTime || '?'}s) captured and uploaded.`
      };
    } else {
      // MediaRecorder failed - return stream URLs as last resort (will likely fail on server)
      console.warn(`[YVO Background] MediaRecorder capture failed: ${uploadResult.error}`);
      return {
        success: true,
        videoInfo: videoInfo,
        streamData: {
          videoUrl: intercepted?.videoUrl || null,
          audioUrl: intercepted?.audioUrl || null,
          quality: 'intercepted',
          mimeType: 'video/mp4',
          capturedAt: intercepted?.capturedAt || Date.now(),
          source: source,
          uploadedToStorage: false,  // Explicitly mark as NOT uploaded
          uploadFailed: true,        // Flag for wizard-bridge.js to detect
          uploadError: uploadResult.error,
          captureMethod: 'fallback_urls',
          captureError: uploadResult.error
        },
        message: 'Capture failed. Server will attempt direct download (may fail due to restrictions).'
      };
    }
  }

  try {
    // PRIORITY 1: Check if we already have intercepted streams (from previous playback)
    let intercepted = getInterceptedStreams(videoId);
    if (intercepted && intercepted.videoUrl) {
      console.log(`[YVO Background] Using cached intercepted streams for ${videoId}`);
      const result = await processAndUploadStreams(intercepted, 'network_intercept_cached');
      sendResponse(result);
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
          // Process the captured streams - download and upload to server
          const interceptedData = {
            videoUrl: captureResult.streamData.videoUrl,
            audioUrl: captureResult.streamData.audioUrl,
            capturedAt: captureResult.streamData.capturedAt
          };
          const result = await processAndUploadStreams(interceptedData, 'network_intercept_auto');
          // Merge video info from capture result
          result.videoInfo = captureResult.videoInfo || result.videoInfo;
          sendResponse(result);
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
        const result = await processAndUploadStreams(intercepted, 'network_intercept_auto');
        sendResponse(result);
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

        // CRITICAL: Process and upload the streams to bypass IP-restriction
        const interceptedData = {
          videoUrl: streamData.videoUrl,
          audioUrl: streamData.audioUrl,
          capturedAt: streamData.capturedAt || Date.now()
        };
        const result = await processAndUploadStreams(interceptedData, streamData.source);
        result.videoInfo = videoInfo.videoInfo || result.videoInfo;

        // Store for later retrieval
        storedVideoData = {
          videoInfo: videoInfo.videoInfo,
          streamData: result.streamData,
          capturedAt: Date.now()
        };

        sendResponse(result);
        return;
      } else {
        console.warn(`[YVO Background] No stream URLs captured for ${videoId}`);
      }

      // Store for later retrieval (without streams)
      storedVideoData = {
        videoInfo: videoInfo.videoInfo,
        streamData: null,
        capturedAt: Date.now()
      };

      sendResponse({
        success: true,
        videoInfo: videoInfo.videoInfo,
        streamData: null,
        message: 'Could not capture streams from existing tab.'
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
 *
 * NOTE: Captured stream URLs are IP-restricted and may not work from servers.
 * This is primarily useful for client-side downloads or when the server
 * can access YouTube through a similar network path.
 */
async function openAndCaptureStreams(videoId, youtubeUrl) {
  const url = youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`;

  console.log(`[YVO Background] Opening YouTube tab for stream capture: ${videoId}`);
  console.log(`[YVO Background] Note: Captured URLs may be IP-restricted`);

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
      const maxAttempts = 30; // 30 attempts * 500ms = 15 seconds max
      let playbackTriggered = false;

      checkInterval = setInterval(async () => {
        attempts++;

        // Check if we got intercepted streams
        const intercepted = getInterceptedStreams(videoId);

        if (intercepted && intercepted.videoUrl) {
          cleanup();
          console.log(`[YVO Background] Streams captured after ${attempts} checks (${attempts * 0.5}s)`);
          console.log(`[YVO Background] Video URLs: ${intercepted.allVideoUrls?.length || 1}`);
          console.log(`[YVO Background] Audio URLs: ${intercepted.allAudioUrls?.length || 1}`);

          // Try to get video info from the tab
          let videoInfo = null;
          try {
            const infoResponse = await chrome.tabs.sendMessage(captureTab.id, {
              action: 'getVideoInfo'
            });
            if (infoResponse?.success) {
              videoInfo = infoResponse.videoInfo;
              console.log(`[YVO Background] Got video info: ${videoInfo.title}`);
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

        // Try to trigger playback more aggressively
        if (!playbackTriggered && attempts >= 3) {
          try {
            await chrome.tabs.sendMessage(captureTab.id, { action: 'triggerPlayback' });
            console.log(`[YVO Background] Triggered playback at attempt ${attempts}`);
            playbackTriggered = true;
          } catch (e) {
            // Tab might not be ready yet - this is expected
            if (attempts === 3 || attempts === 6 || attempts === 10) {
              console.log(`[YVO Background] Playback trigger failed (attempt ${attempts}), tab may not be ready`);
            }
          }
        }

        // Re-try playback trigger periodically
        if (playbackTriggered && (attempts === 12 || attempts === 18 || attempts === 24)) {
          try {
            await chrome.tabs.sendMessage(captureTab.id, { action: 'triggerPlayback' });
            console.log(`[YVO Background] Re-triggered playback at attempt ${attempts}`);
          } catch (e) {
            // Ignore
          }
        }

        // Check if we've exceeded max attempts
        if (attempts >= maxAttempts) {
          cleanup();
          console.warn(`[YVO Background] Stream capture timeout after ${maxAttempts * 0.5}s`);

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
        console.warn('[YVO Background] Absolute timeout reached for stream capture');
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

  // Helper function to download with proper headers
  async function downloadStream(url, type) {
    console.log(`[YVO Injected] Downloading ${type} stream...`);

    // Use XMLHttpRequest for better control over headers and progress
    return new Promise((resolve, reject) => {
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
          console.log(`[YVO Injected] ${type} progress: ${percent}%`);
        }
      };

      xhr.withCredentials = true;  // Include cookies
      xhr.send();
    });
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
 * INGENIOUS SOLUTION: Capture video using MediaRecorder as it plays
 *
 * This function is injected into the YouTube page and captures the video element's
 * output directly. This bypasses ALL URL restrictions because:
 * - We're capturing what the player is already displaying
 * - No new network requests are made
 * - No CORS or IP-restriction issues
 *
 * The video is sped up to 4x to minimize capture time.
 * For a 60-second clip, this takes only ~15 seconds.
 *
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds (captures duration = endTime - startTime)
 */
async function captureVideoSegmentWithMediaRecorder(startTime, endTime) {
  console.log(`[YVO Capture] Starting MediaRecorder capture from ${startTime}s to ${endTime}s`);

  const duration = endTime - startTime;
  const PLAYBACK_SPEED = 4; // 4x speed for faster capture
  const captureTime = (duration / PLAYBACK_SPEED) * 1000; // in milliseconds

  console.log(`[YVO Capture] Will capture ${duration}s of video at ${PLAYBACK_SPEED}x speed (${captureTime/1000}s real time)`);

  return new Promise((resolve, reject) => {
    try {
      const videoElement = document.querySelector('video.html5-main-video');
      if (!videoElement) {
        reject(new Error('No video element found on page'));
        return;
      }

      // Seek to start position
      videoElement.currentTime = startTime;

      // Wait for seek to complete
      const onSeeked = () => {
        videoElement.removeEventListener('seeked', onSeeked);
        startCapture();
      };

      const startCapture = () => {
        try {
          // Capture the video stream from the element
          const stream = videoElement.captureStream();

          if (!stream || stream.getVideoTracks().length === 0) {
            reject(new Error('Could not capture video stream - video may be DRM protected'));
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

          console.log(`[YVO Capture] Using MIME type: ${mimeType}`);

          const recorder = new MediaRecorder(stream, {
            mimeType: mimeType,
            videoBitsPerSecond: 8000000  // 8 Mbps for good quality
          });

          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              chunks.push(e.data);
            }
          };

          recorder.onstop = async () => {
            // Restore normal speed
            videoElement.playbackRate = 1;
            videoElement.pause();

            console.log(`[YVO Capture] Recording stopped, processing ${chunks.length} chunks...`);
            const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
            console.log(`[YVO Capture] Created blob: ${(blob.size / 1024 / 1024).toFixed(2)}MB`);

            if (blob.size < 10000) {
              reject(new Error('Captured video too small - capture may have failed'));
              return;
            }

            // Convert to base64 for transfer
            const reader = new FileReader();
            reader.onloadend = () => {
              resolve({
                success: true,
                videoData: reader.result.split(',')[1],
                videoSize: blob.size,
                mimeType: mimeType.split(';')[0],
                duration: duration,
                captureMethod: 'mediarecorder'
              });
            };
            reader.onerror = () => reject(new Error('Failed to convert video to base64'));
            reader.readAsDataURL(blob);
          };

          recorder.onerror = (e) => {
            videoElement.playbackRate = 1;
            reject(new Error(`MediaRecorder error: ${e.error?.message || 'unknown'}`));
          };

          // Set playback speed and start
          videoElement.playbackRate = PLAYBACK_SPEED;
          videoElement.muted = true; // Mute to avoid audio issues

          // Start recording
          recorder.start(500); // Capture in 500ms chunks

          // Start playing
          videoElement.play().then(() => {
            console.log(`[YVO Capture] Playback started at ${PLAYBACK_SPEED}x speed`);
          }).catch(e => {
            console.warn('[YVO Capture] Autoplay failed, user interaction may be needed:', e.message);
          });

          // Monitor progress
          const progressInterval = setInterval(() => {
            const progress = ((videoElement.currentTime - startTime) / duration * 100).toFixed(1);
            console.log(`[YVO Capture] Progress: ${progress}% (at ${videoElement.currentTime.toFixed(1)}s)`);
          }, 2000);

          // Stop when we reach end time or after calculated capture time
          const checkEnd = setInterval(() => {
            if (videoElement.currentTime >= endTime || videoElement.ended) {
              clearInterval(checkEnd);
              clearInterval(progressInterval);
              if (recorder.state === 'recording') {
                console.log('[YVO Capture] Reached end, stopping recorder...');
                recorder.stop();
              }
            }
          }, 100);

          // Safety timeout (add 50% buffer)
          setTimeout(() => {
            clearInterval(checkEnd);
            clearInterval(progressInterval);
            if (recorder.state === 'recording') {
              console.log('[YVO Capture] Timeout reached, stopping recorder...');
              recorder.stop();
            }
          }, captureTime * 1.5 + 5000);

        } catch (captureError) {
          reject(captureError);
        }
      };

      // Start the process
      if (Math.abs(videoElement.currentTime - startTime) < 1) {
        startCapture();
      } else {
        videoElement.addEventListener('seeked', onSeeked);
        videoElement.currentTime = startTime;
      }

    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Capture and upload video using MediaRecorder
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
  console.log(`[YVO Background] Starting MediaRecorder capture for ${videoId} (${segmentInfo})`);

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

    // If no tab with this video, open one
    if (!youtubeTab) {
      console.log(`[YVO Background] Opening YouTube tab for capture...`);
      const url = youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`;
      youtubeTab = await chrome.tabs.create({ url, active: true });

      // Wait for page to load
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Get video duration from content script
    let videoInfo;
    try {
      videoInfo = await chrome.tabs.sendMessage(youtubeTab.id, { action: 'getVideoInfo' });
    } catch (e) {
      console.log('[YVO Background] Could not get video info, using defaults');
      videoInfo = { success: true, videoInfo: { duration: 60 } };
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
        console.warn(`[YVO Background] Requested segment (${segmentDuration}s) exceeds max (${MAX_CAPTURE_DURATION}s), limiting...`);
        captureEnd = captureStart + MAX_CAPTURE_DURATION;
      }

      console.log(`[YVO Background] Using requested segment: ${captureStart}s to ${captureEnd}s (${captureEnd - captureStart}s duration)`);
    } else {
      // No segment specified - capture from start, up to max duration
      captureStart = 0;
      captureEnd = Math.min(MAX_CAPTURE_DURATION, videoDuration);
      console.log(`[YVO Background] No segment specified, capturing first ${captureEnd}s of video`);
    }

    console.log(`[YVO Background] Injecting MediaRecorder capture (${captureStart}s to ${captureEnd}s)...`);
    console.log(`[YVO Background] Target tab: ${youtubeTab.id}, URL: ${youtubeTab.url}`);

    // Inject and run the capture function
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: youtubeTab.id },
        world: 'MAIN',
        func: captureVideoSegmentWithMediaRecorder,
        args: [captureStart, captureEnd]
      });
    } catch (scriptError) {
      console.error(`[YVO Background] Script injection failed:`, scriptError);
      throw new Error(`Script injection failed: ${scriptError.message}. Tab may not be fully loaded or accessible.`);
    }

    console.log(`[YVO Background] Script execution returned:`, results ? `${results.length} result(s)` : 'null');

    if (!results || results.length === 0) {
      throw new Error('MediaRecorder capture script returned no results - tab may be restricted');
    }

    if (!results[0].result) {
      // Check if there was an error in the injected script
      const errorMsg = results[0].error ? `Script error: ${results[0].error}` : 'Script returned null/undefined result';
      console.error(`[YVO Background] Script result issue:`, results[0]);
      throw new Error(`MediaRecorder capture script failed: ${errorMsg}`);
    }

    const captureResult = results[0].result;

    if (!captureResult.success) {
      throw new Error(captureResult.error || 'Capture failed');
    }

    const capturedDuration = captureEnd - captureStart;
    console.log(`[YVO Background] Capture successful: ${(captureResult.videoSize / 1024 / 1024).toFixed(2)}MB (${capturedDuration}s)`);

    // Upload to server with segment metadata
    const videoBlob = base64ToBlob(captureResult.videoData, captureResult.mimeType);

    const formData = new FormData();
    formData.append('video', videoBlob, `captured_${videoId}.webm`);
    formData.append('videoId', videoId);
    formData.append('type', 'video');
    // Include segment info so server knows what was captured
    formData.append('captureStart', String(captureStart));
    formData.append('captureEnd', String(captureEnd));
    formData.append('capturedDuration', String(capturedDuration));

    console.log(`[YVO Background] Uploading captured video to server (${captureStart}s-${captureEnd}s)...`);

    const uploadResponse = await fetch(`${VIDEO_PROCESSOR_URL}/upload-stream`, {
      method: 'POST',
      body: formData
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Upload failed: ${uploadResponse.status} - ${errorText}`);
    }

    const uploadResult = await uploadResponse.json();
    console.log(`[YVO Background] Upload successful: ${uploadResult.url}`);

    return {
      success: true,
      videoStorageUrl: uploadResult.url,
      mimeType: captureResult.mimeType,
      captureMethod: 'mediarecorder',
      // Include segment info in response for server processing
      capturedSegment: {
        startTime: captureStart,
        endTime: captureEnd,
        duration: capturedDuration
      }
    };

  } catch (error) {
    console.error(`[YVO Background] MediaRecorder capture failed:`, error);
    return {
      success: false,
      error: error.message
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
  console.log(`[YVO Background] Starting browser-side download for ${videoId}`);
  console.log(`[YVO Background] Will use content script for download (has page cookie access)`);

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
    console.log(`[YVO Background] Finding YouTube tab for in-page download...`);
    const tabs = await chrome.tabs.query({
      url: ['*://www.youtube.com/*', '*://youtube.com/*']
    });

    if (tabs.length === 0) {
      throw new Error('No YouTube tab found. Please have YouTube open in a tab.');
    }

    // Try to find the tab with the specific video (best match for IP-bound URLs)
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

    // Fall back to any YouTube tab if specific video tab not found
    if (!youtubeTab) {
      youtubeTab = tabs[0];
      console.log(`[YVO Background] Video-specific tab not found, using tab ${youtubeTab.id}`);
    } else {
      console.log(`[YVO Background] Found video-specific tab ${youtubeTab.id} for ${videoId}`);
    }

    // Use chrome.scripting.executeScript to run download code directly in the page's MAIN world
    // CRITICAL: world: 'MAIN' is required to access page cookies for cross-origin requests
    console.log(`[YVO Background] Injecting download code into YouTube tab (MAIN world)...`);

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

    console.log(`[YVO Background] In-page download successful: ${(downloadResult.videoSize / 1024 / 1024).toFixed(2)}MB`);

    // Convert base64 back to Blob for upload
    const videoBlob = base64ToBlob(downloadResult.videoData, 'video/mp4');
    console.log(`[YVO Background] Converted to blob: ${(videoBlob.size / 1024 / 1024).toFixed(2)}MB`);

    // Step 2: Upload video to our server
    console.log(`[YVO Background] Uploading video to server...`);
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
    console.log(`[YVO Background] Video uploaded successfully: ${videoUploadResult.url}`);

    let audioStorageUrl = null;

    // Step 3: Upload audio if content script downloaded it
    if (downloadResult.audioData) {
      try {
        console.log(`[YVO Background] Content script also downloaded audio, uploading...`);
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
          console.log(`[YVO Background] Audio uploaded successfully: ${audioStorageUrl}`);
        }
      } catch (audioError) {
        console.warn(`[YVO Background] Audio upload failed (non-fatal):`, audioError.message);
      }
    }

    return {
      success: true,
      videoStorageUrl: videoUploadResult.url,
      audioStorageUrl: audioStorageUrl
    };

  } catch (error) {
    console.error(`[YVO Background] Download/upload failed:`, error);

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
