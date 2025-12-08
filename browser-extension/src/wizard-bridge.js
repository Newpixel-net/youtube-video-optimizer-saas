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
        version: '1.0.0',
        extensionId: EXTENSION_ID
      }
    }));

    // Also set a marker on window for synchronous checks
    window.__YVO_EXTENSION_INSTALLED__ = true;
    window.__YVO_EXTENSION_VERSION__ = '1.0.0';

    console.log('[YVO Extension] Bridge ready - Video Wizard integration active');
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
   */
  async function handleGetVideoRequest(data, requestId) {
    const { youtubeUrl } = data || {};

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

      // Send message to background script to capture video
      const response = await chrome.runtime.sendMessage({
        action: 'captureVideoForWizard',
        videoId: videoId,
        youtubeUrl: youtubeUrl
      });

      if (response?.success) {
        sendResponse(requestId, {
          success: true,
          videoInfo: response.videoInfo,
          streamData: response.streamData
        });
      } else {
        sendResponse(requestId, {
          error: response?.error || 'Failed to capture video'
        });
      }

    } catch (error) {
      console.error('[YVO Extension] Capture error:', error);
      sendResponse(requestId, { error: error.message });
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

    // Re-announce periodically for SPA navigation
    setInterval(announceExtension, 5000);
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
