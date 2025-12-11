/**
 * YouTube Video Optimizer - Wizard Bridge
 * Runs on Video Wizard pages to enable communication with the extension
 *
 * This script:
 * 1. Notifies Video Wizard that the extension is installed
 * 2. Handles requests from Video Wizard to capture YouTube videos
 * 3. Provides video data back to Video Wizard
 */

(function() {
  'use strict';

  // Extension ID marker
  const EXTENSION_ID = 'youtube-video-optimizer-extension';

  /**
   * Notify the page that extension is installed
   */
  function announceExtension() {
    // Dispatch custom event to let Video Wizard know extension is available
    window.dispatchEvent(new CustomEvent('yvo-extension-ready', {
      detail: {
        version: '1.6.0',
        extensionId: EXTENSION_ID,
        features: ['auto_capture', 'network_intercept', 'stream_cache', 'server_fallback', 'browser_upload']
      }
    }));

    // Also set a marker on window for synchronous checks
    window.__YVO_EXTENSION_INSTALLED__ = true;
    window.__YVO_EXTENSION_VERSION__ = '1.6.0';
    window.__YVO_EXTENSION_FEATURES__ = ['auto_capture', 'network_intercept', 'stream_cache', 'server_fallback', 'browser_upload'];

    console.log('[YVO Extension] Bridge ready - Video Wizard integration active (v1.6.0 with segment capture)');
  }

  /**
   * Handle requests from Video Wizard
   */
  function handleWizardRequest(event) {
    const { action, data, requestId } = event.detail || {};

    if (!action || !requestId) return;

    console.log('[YVO Extension] Received request:', action);

    switch (action) {
      case 'getVideoFromYouTube':
        handleGetVideoRequest(data, requestId);
        break;

      case 'checkExtension':
        sendResponse(requestId, { installed: true, version: '1.6.0' });
        break;

      case 'getStoredVideo':
        handleGetStoredVideo(requestId);
        break;

      default:
        sendResponse(requestId, { error: 'Unknown action' });
    }
  }

  /**
   * Handle request to capture video from YouTube
   * Uses polling approach to avoid Chrome message channel timeouts
   */
  async function handleGetVideoRequest(data, requestId) {
    const { youtubeUrl, autoCapture = true, startTime, endTime } = data || {};

    if (!youtubeUrl) {
      sendResponse(requestId, { error: 'No YouTube URL provided' });
      return;
    }

    try {
      // Extract video ID from URL
      const videoId = extractVideoId(youtubeUrl);

      if (!videoId) {
        sendResponse(requestId, { error: 'Invalid YouTube URL' });
        return;
      }

      // Log segment info if provided
      const segmentInfo = (startTime !== undefined && endTime !== undefined)
        ? `segment ${startTime}s-${endTime}s`
        : 'full video (up to 5 min)';
      console.log(`[YVO Extension] Starting capture: ${videoId}, ${segmentInfo}`);

      // Start capture - this returns immediately with a captureId
      const startResponse = await chrome.runtime.sendMessage({
        action: 'captureVideoForWizard',
        videoId: videoId,
        youtubeUrl: youtubeUrl,
        autoCapture: autoCapture,
        startTime: startTime,
        endTime: endTime
      });

      if (!startResponse?.success) {
        sendResponse(requestId, {
          success: false,
          error: startResponse?.error || 'Failed to start capture'
        });
        return;
      }

      console.log(`[YVO Extension] Capture started, polling for completion...`);

      // Poll for capture status (max 3 minutes = 180 seconds)
      const maxWaitMs = 180000;
      const pollIntervalMs = 2000;
      const startTime_ = Date.now();

      while (Date.now() - startTime_ < maxWaitMs) {
        await sleep(pollIntervalMs);

        try {
          const status = await chrome.runtime.sendMessage({
            action: 'getCaptureStatus',
            videoId: videoId
          });

          console.log(`[YVO Extension] Capture status: ${status?.status}, progress: ${status?.progress || 0}%`);

          if (status?.status === 'completed' && status?.result) {
            // Clear the status from storage
            chrome.runtime.sendMessage({ action: 'clearCaptureStatus', videoId });

            const result = status.result;
            console.log(`[YVO Extension] ✓ Capture completed successfully`);

            if (result.streamData?.uploadedToStorage) {
              console.log(`[YVO Extension] ✓ Video uploaded to Firebase Storage`);
              console.log(`[YVO Extension] Storage URL: ${result.streamData?.videoUrl}`);
            }

            sendResponse(requestId, {
              success: true,
              videoInfo: result.videoInfo,
              streamData: result.streamData,
              message: result.message,
              captureSource: result.streamData?.source || 'mediarecorder_capture'
            });
            return;
          }

          if (status?.status === 'failed' && status?.result) {
            // Clear the status from storage
            chrome.runtime.sendMessage({ action: 'clearCaptureStatus', videoId });

            console.warn('[YVO Extension] Capture failed:', status.result.error);
            sendResponse(requestId, {
              success: false,
              error: status.result.error || 'Capture failed'
            });
            return;
          }

          // Still in progress - continue polling
        } catch (pollError) {
          console.warn('[YVO Extension] Poll error (will retry):', pollError.message);
        }
      }

      // Timeout reached
      console.error('[YVO Extension] Capture timeout after 3 minutes');
      sendResponse(requestId, {
        success: false,
        error: 'Capture timeout - please ensure the YouTube video is playing and try again'
      });

    } catch (error) {
      console.error('[YVO Extension] Capture error:', error);
      sendResponse(requestId, { success: false, error: error.message });
    }
  }

  /**
   * Sleep helper function
   */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get stored video data (if user captured from YouTube tab)
   */
  async function handleGetStoredVideo(requestId) {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'getStoredVideoData'
      });

      if (response?.videoData) {
        sendResponse(requestId, {
          success: true,
          videoData: response.videoData
        });
      } else {
        sendResponse(requestId, { videoData: null });
      }
    } catch (error) {
      sendResponse(requestId, { error: error.message });
    }
  }

  /**
   * Send response back to Video Wizard
   */
  function sendResponse(requestId, data) {
    window.dispatchEvent(new CustomEvent('yvo-extension-response', {
      detail: {
        requestId: requestId,
        ...data
      }
    }));
  }

  /**
   * Extract video ID from YouTube URL
   */
  function extractVideoId(url) {
    try {
      const urlObj = new URL(url);

      // youtube.com/watch?v=ID
      if (urlObj.hostname.includes('youtube.com') && urlObj.pathname === '/watch') {
        return urlObj.searchParams.get('v');
      }

      // youtu.be/ID
      if (urlObj.hostname === 'youtu.be') {
        return urlObj.pathname.slice(1).split('/')[0];
      }

      // youtube.com/shorts/ID
      if (urlObj.pathname.startsWith('/shorts/')) {
        return urlObj.pathname.split('/shorts/')[1]?.split('/')[0];
      }

      // youtube.com/embed/ID
      if (urlObj.pathname.startsWith('/embed/')) {
        return urlObj.pathname.split('/embed/')[1]?.split('/')[0];
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Initialize bridge
   */
  function init() {
    // Listen for requests from Video Wizard
    window.addEventListener('yvo-extension-request', handleWizardRequest);

    // Announce extension presence
    announceExtension();

    // Re-announce on page visibility change (for SPA navigation)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        announceExtension();
      }
    });

    // Listen for explicit check requests from Video Wizard
    // This replaces the aggressive polling that caused page flashing
    window.addEventListener('yvo-check-extension', () => {
      announceExtension();
    });
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
