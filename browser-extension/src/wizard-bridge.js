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
        version: '2.3.1',
        extensionId: EXTENSION_ID,
        features: ['mediarecorder_primary', 'user_initiated_capture', 'browser_upload', 'auto_inject', 'capture_timeout', 'skip_capture_analysis', 'message_passing_capture', 'track_cloning', 'relay_error_handling']
      }
    }));

    // Also set a marker on window for synchronous checks
    window.__YVO_EXTENSION_INSTALLED__ = true;
    window.__YVO_EXTENSION_VERSION__ = '2.3.1';
    window.__YVO_EXTENSION_FEATURES__ = ['mediarecorder_primary', 'user_initiated_capture', 'browser_upload', 'auto_inject', 'capture_timeout', 'skip_capture_analysis', 'message_passing_capture', 'track_cloning', 'relay_error_handling', 'tab_focus', 'aggressive_load_retry'];

    console.log('[EXT] Bridge ready - v2.3.1 with tab focus and aggressive video loading retry');
  }

  /**
   * Handle requests from Video Wizard
   */
  function handleWizardRequest(event) {
    const { action, data, requestId } = event.detail || {};

    if (!action || !requestId) return;

    console.log('[EXT][BRIDGE] Received request:', action);

    switch (action) {
      case 'getVideoFromYouTube':
      case 'captureVideoForWizard':  // Support both action names for compatibility
        handleGetVideoRequest(data, requestId);
        break;

      case 'checkExtension':
        sendResponse(requestId, {
          installed: true,
          version: '2.3.1',
          features: ['mediarecorder_primary', 'user_initiated_capture', 'browser_upload', 'auto_inject', 'capture_timeout', 'skip_capture_analysis', 'message_passing_capture', 'track_cloning', 'relay_error_handling'],
          maxBase64Size: 40 * 1024 * 1024 // 40MB - files larger than this upload directly
        });
        break;

      case 'getStoredVideo':
        handleGetStoredVideo(requestId);
        break;

      default:
        console.warn('[EXT][BRIDGE] Unknown action:', action);
        sendResponse(requestId, { error: 'Unknown action: ' + action });
    }
  }

  /**
   * Handle request to capture video from YouTube
   * EXTENSION-ONLY CAPTURE - No fallbacks
   * Supports segment capture with startTime/endTime parameters (clipStart/clipEnd from frontend)
   */
  async function handleGetVideoRequest(data, requestId) {
    const { youtubeUrl, autoCapture = true, startTime, endTime, clipStart, clipEnd, videoId: providedVideoId, quality } = data || {};

    // Support both startTime/endTime and clipStart/clipEnd parameter names
    const captureStart = startTime !== undefined ? startTime : clipStart;
    const captureEnd = endTime !== undefined ? endTime : clipEnd;

    console.log(`[EXT][CAPTURE] start videoId=${providedVideoId} url=${youtubeUrl?.substring(0, 50)}...`);

    if (!youtubeUrl && !providedVideoId) {
      console.error('[EXT][CAPTURE] FAIL: No YouTube URL or video ID provided');
      sendResponse(requestId, {
        success: false,
        error: 'No YouTube URL or video ID provided',
        code: 'MISSING_VIDEO_ID'
      });
      return;
    }

    try {
      // Use provided video ID or extract from URL
      const videoId = providedVideoId || extractVideoId(youtubeUrl);

      if (!videoId) {
        console.error('[EXT][CAPTURE] FAIL: Invalid YouTube URL or video ID');
        sendResponse(requestId, {
          success: false,
          error: 'Invalid YouTube URL or video ID',
          code: 'INVALID_VIDEO_ID'
        });
        return;
      }

      // Log segment info if provided
      const segmentInfo = (captureStart !== undefined && captureEnd !== undefined)
        ? `segment ${captureStart}s-${captureEnd}s`
        : 'full video (up to 5 min)';
      console.log(`[EXT][CAPTURE] Capturing video: ${videoId}, ${segmentInfo}, autoCapture: ${autoCapture}, quality: ${quality || 'default'}`);

      // Send message to background script to capture video
      // Pass segment times if provided for precise capture
      const response = await chrome.runtime.sendMessage({
        action: 'captureVideoForWizard',
        videoId: videoId,
        youtubeUrl: youtubeUrl,
        autoCapture: autoCapture,
        startTime: captureStart,    // Segment start time in seconds
        endTime: captureEnd,        // Segment end time in seconds
        quality: quality
      });

      if (response?.success) {
        // Log the capture source for debugging
        const source = response.streamData?.source || 'none';
        const uploadedToStorage = response.streamData?.uploadedToStorage || false;
        const videoUrl = response.streamData?.videoUrl || null;
        const videoSize = response.streamData?.videoSize || 0;
        const hasVideoData = !!response.streamData?.videoData;

        console.log(`[EXT][CAPTURE] SUCCESS source=${source} uploadedToStorage=${uploadedToStorage}`);

        if (uploadedToStorage && videoUrl) {
          console.log(`[EXT][UPLOAD] success url=${videoUrl}`);
        } else if (hasVideoData) {
          console.log(`[EXT][CAPTURE] Local capture success, size=${(videoSize / 1024 / 1024).toFixed(2)}MB`);
        }

        sendResponse(requestId, {
          success: true,
          videoInfo: response.videoInfo,
          streamData: response.streamData,
          message: response.message,
          captureSource: source
        });
      } else {
        const errorMsg = response?.error || 'Failed to capture video';
        console.error(`[EXT][CAPTURE] FAIL: ${errorMsg}`);
        sendResponse(requestId, {
          success: false,
          error: errorMsg,
          code: response?.code || 'CAPTURE_FAILED',
          details: response?.details || null
        });
      }

    } catch (error) {
      console.error(`[EXT][CAPTURE] EXCEPTION: ${error.message}`);
      sendResponse(requestId, {
        success: false,
        error: error.message,
        code: 'EXCEPTION',
        details: error.stack
      });
    }
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
