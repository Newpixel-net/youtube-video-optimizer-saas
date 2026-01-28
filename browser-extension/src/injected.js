/**
 * YouTube Video Optimizer - Injected Script
 * Runs in page context to access YouTube player API
 *
 * This script has access to window.ytInitialPlayerResponse and
 * the YouTube player object for getting stream URLs
 */

(function() {
  'use strict';

  // Guard against duplicate injection
  if (window.__YVO_INJECTED_LOADED__) return;
  window.__YVO_INJECTED_LOADED__ = true;

  let lastVideoId = null;
  let sendInterval = null;
  let navigationObserver = null;

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
   * Start sending player data with proper interval management
   */
  function startDataSending() {
    // Clear any existing interval
    if (sendInterval) {
      clearInterval(sendInterval);
      sendInterval = null;
    }

    // Try to send immediately
    sendPlayerData();

    let attempts = 0;
    const maxAttempts = 20; // 10 seconds at 500ms intervals

    // Poll until data is available
    sendInterval = setInterval(() => {
      attempts++;
      const success = sendPlayerData();

      // Stop polling once we've successfully sent data a few times or hit max attempts
      if ((success && attempts > 3) || attempts >= maxAttempts) {
        clearInterval(sendInterval);
        sendInterval = null;
      }
    }, 500);
  }

  /**
   * Handle navigation changes
   */
  function handleNavigation() {
    const currentVideoId = getVideoId();
    if (currentVideoId !== lastVideoId) {
      lastVideoId = currentVideoId;
      if (currentVideoId) {
        // Delay to let YouTube load new video data
        setTimeout(() => startDataSending(), 800);
      }
    }
  }

  /**
   * Initialize
   */
  function init() {
    lastVideoId = getVideoId();

    // Start sending player data
    if (lastVideoId) {
      startDataSending();
    }

    // Listen for YouTube's custom navigation event (most reliable)
    document.addEventListener('yt-navigate-finish', handleNavigation);

    // Listen for player ready events
    document.addEventListener('yt-player-updated', () => {
      sendPlayerData();
    });

    // Fallback: Check URL periodically (less expensive than MutationObserver)
    setInterval(() => {
      handleNavigation();
    }, 2000);
  }

  // Run when ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
