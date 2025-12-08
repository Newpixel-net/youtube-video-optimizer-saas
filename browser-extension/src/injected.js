/**
 * YouTube Video Optimizer - Injected Script
 * Runs in page context to access YouTube player API
 *
 * This script has access to window.ytInitialPlayerResponse and
 * the YouTube player object for getting stream URLs
 */

(function() {
  'use strict';

  /**
   * Send data to content script
   */
  function sendToContentScript(type, data) {
    window.postMessage({
      type: type,
      data: data
    }, window.location.origin);
  }

  /**
   * Get player data and send to content script
   */
  function sendPlayerData() {
    if (window.ytInitialPlayerResponse) {
      sendToContentScript('YVO_PLAYER_DATA', window.ytInitialPlayerResponse);
    }
  }

  /**
   * Try to get stream URL from player
   */
  function getStreamFromPlayer() {
    try {
      // Try to find the YouTube player
      const player = document.querySelector('#movie_player');

      if (player && typeof player.getVideoData === 'function') {
        const videoData = player.getVideoData();

        // Try to get URL from player
        if (typeof player.getVideoUrl === 'function') {
          const videoUrl = player.getVideoUrl();
          sendToContentScript('YVO_STREAM_URL', { videoUrl });
        }
      }
    } catch (error) {
      console.error('YVO: Error getting stream from player:', error);
    }
  }

  /**
   * Initialize
   */
  function init() {
    // Send initial player data
    sendPlayerData();

    // Watch for navigation (YouTube is a SPA)
    let lastUrl = location.href;

    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        // Wait for new player data to load
        setTimeout(sendPlayerData, 1000);
      }
    }).observe(document, { subtree: true, childList: true });

    // Also listen for player ready events
    document.addEventListener('yt-player-updated', sendPlayerData);

    // Periodic check for player data
    const checkInterval = setInterval(() => {
      if (window.ytInitialPlayerResponse) {
        sendPlayerData();
        clearInterval(checkInterval);
      }
    }, 500);

    // Stop checking after 10 seconds
    setTimeout(() => clearInterval(checkInterval), 10000);
  }

  // Run when ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
