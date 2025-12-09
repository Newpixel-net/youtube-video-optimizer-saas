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
        version: '1.3.0',
        extensionId: EXTENSION_ID,
        features: ['auto_capture', 'network_intercept', 'stream_cache', 'server_fallback']
      }
    }));

    // Also set a marker on window for synchronous checks
    window.__YVO_EXTENSION_INSTALLED__ = true;
    window.__YVO_EXTENSION_VERSION__ = '1.3.0';
    window.__YVO_EXTENSION_FEATURES__ = ['auto_capture', 'network_intercept', 'stream_cache', 'server_fallback'];

    console.log('[YVO Extension] Bridge ready - Video Wizard integration active (v1.3.0 with improved diagnostics)');
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
        sendResponse(requestId, { installed: true, version: '1.0.0' });
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
   * Enhanced to support auto-capture when no streams are immediately available
   */
  async function handleGetVideoRequest(data, requestId) {
    const { youtubeUrl, autoCapture = true } = data || {};

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

      console.log(`[YVO Extension] Capturing video: ${videoId}, autoCapture: ${autoCapture}`);

      // Send message to background script to capture video
      // This may take a few seconds if auto-capture needs to open a new tab
      const response = await chrome.runtime.sendMessage({
        action: 'captureVideoForWizard',
        videoId: videoId,
        youtubeUrl: youtubeUrl,
        autoCapture: autoCapture
      });

      if (response?.success) {
        // Log the capture source for debugging
        const source = response.streamData?.source || 'none';
        console.log(`[YVO Extension] Capture successful, source: ${source}`);

        sendResponse(requestId, {
          success: true,
          videoInfo: response.videoInfo,
          streamData: response.streamData,
          message: response.message,
          captureSource: source
        });
      } else {
        console.warn('[YVO Extension] Capture failed:', response?.error);
        sendResponse(requestId, {
          success: false,
          error: response?.error || 'Failed to capture video'
        });
      }

    } catch (error) {
      console.error('[YVO Extension] Capture error:', error);
      sendResponse(requestId, { success: false, error: error.message });
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
