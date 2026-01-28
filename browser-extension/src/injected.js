/**
 * YouTube Video Optimizer - Injected Script
 * Runs in page context to access YouTube player API
 *
 * This script has access to window.ytInitialPlayerResponse and
 * the YouTube player object for getting stream URLs
 */

(function() {
  'use strict';

  let lastVideoId = null;
  let sendInterval = null;

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
   * Get current video ID from URL
   */
  function getVideoId() {
    const url = new URL(window.location.href);
    if (url.pathname === '/watch') {
      return url.searchParams.get('v');
    }
    if (url.pathname.startsWith('/shorts/')) {
      return url.pathname.split('/shorts/')[1]?.split('/')[0];
    }
    return null;
  }

  /**
   * Get player data from multiple sources
   */
  function getPlayerData() {
    // Primary: window.ytInitialPlayerResponse
    if (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails) {
      return window.ytInitialPlayerResponse;
    }

    // Secondary: ytInitialData may contain playerResponse
    if (window.ytInitialData?.playerResponse?.videoDetails) {
      return window.ytInitialData.playerResponse;
    }

    // Tertiary: Try to get from player API
    try {
      const player = document.querySelector('#movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        const response = player.getPlayerResponse();
        if (response && response.videoDetails) {
          return response;
        }
      }
    } catch (e) {
      // Player not ready
    }

    return null;
  }

  /**
   * Get player data and send to content script
   */
  function sendPlayerData() {
    const playerData = getPlayerData();
    if (playerData) {
      sendToContentScript('YVO_PLAYER_DATA', playerData);
      return true;
    }
    return false;
  }

  /**
   * Try to get stream URL from player
   */
  function getStreamFromPlayer() {
    try {
      const player = document.querySelector('#movie_player');

      if (player && typeof player.getVideoData === 'function') {
        const videoData = player.getVideoData();

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
   * Start continuous sending of player data
   */
  function startDataSending() {
    // Clear any existing interval
    if (sendInterval) {
      clearInterval(sendInterval);
    }

    let attempts = 0;
    const maxAttempts = 30; // 15 seconds at 500ms intervals

    // Try to send immediately
    if (sendPlayerData()) {
      console.log('[YVO Injected] Player data sent successfully');
    }

    // Keep checking until we successfully send data multiple times
    sendInterval = setInterval(() => {
      attempts++;
      const success = sendPlayerData();

      if (success && attempts > 3) {
        // After a few successful sends, reduce frequency
        clearInterval(sendInterval);
        // Continue sending every 2 seconds for navigation changes
        sendInterval = setInterval(() => {
          const currentVideoId = getVideoId();
          if (currentVideoId !== lastVideoId) {
            lastVideoId = currentVideoId;
            sendPlayerData();
          }
        }, 2000);
      }

      if (attempts >= maxAttempts) {
        clearInterval(sendInterval);
        // Continue low-frequency checks
        sendInterval = setInterval(() => {
          const currentVideoId = getVideoId();
          if (currentVideoId !== lastVideoId) {
            lastVideoId = currentVideoId;
            sendPlayerData();
          }
        }, 2000);
      }
    }, 500);
  }

  /**
   * Initialize
   */
  function init() {
    lastVideoId = getVideoId();

    // Start sending player data
    startDataSending();

    // Watch for navigation (YouTube is a SPA)
    let lastUrl = location.href;

    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastVideoId = getVideoId();
        // Reset and restart data sending for new video
        setTimeout(() => startDataSending(), 500);
      }
    }).observe(document, { subtree: true, childList: true });

    // Also listen for player ready events
    document.addEventListener('yt-player-updated', () => {
      sendPlayerData();
    });

    // Listen for yt-navigate-finish (YouTube's custom event for SPA navigation)
    document.addEventListener('yt-navigate-finish', () => {
      lastVideoId = getVideoId();
      setTimeout(() => startDataSending(), 500);
    });
  }

  // Run when ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
