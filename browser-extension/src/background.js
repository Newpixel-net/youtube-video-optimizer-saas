/**
 * YouTube Video Optimizer - Background Service Worker
 * Handles video capture and Video Wizard integration
 *
 * SIMPLIFIED ARCHITECTURE (v2.0):
 * - Single MediaRecorder-based capture flow
 * - No complex network interception mixing
 * - Robust tab and video readiness handling
 */

// State
let currentCapture = null;
let isCapturing = false;
let storedVideoData = null;

// Constants
const VIDEO_PROCESSOR_URL = 'https://video-processor-867328435695.us-central1.run.app';
const CLOUD_FUNCTION_UPLOAD_URL = 'https://us-central1-ytseo-6d1b0.cloudfunctions.net/extensionUploadVideo';
const MAX_CAPTURE_DURATION = 300; // 5 minutes max

/**
 * Message handler for extension communication
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[YVO Background] Message:', message.action, 'from:', sender?.url || 'unknown');

  switch (message.action) {
    case 'captureVideoForWizard':
      handleCaptureForWizard(message, sendResponse);
      return true;

    case 'getStoredVideoData':
      sendResponse({ videoData: storedVideoData });
      return false;

    case 'reportVideoId':
      if (message.videoId && sender.tab?.id) {
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
 * Main entry point for Video Wizard capture requests
 * SIMPLIFIED: Goes directly to MediaRecorder capture
 */
async function handleCaptureForWizard(message, sendResponse) {
  const { videoId, youtubeUrl, startTime, endTime } = message;

  if (!videoId || !isValidVideoId(videoId)) {
    sendResponse({ success: false, error: 'Invalid video ID' });
    return;
  }

  console.log(`[YVO Background] Capture request for video: ${videoId}`);

  try {
    // Get basic video info
    const videoInfo = {
      videoId: videoId,
      url: youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
    };

    // Capture using MediaRecorder
    const captureResult = await captureVideo(videoId, youtubeUrl, startTime, endTime);

    if (captureResult.success) {
      console.log(`[YVO Background] Capture successful!`);
      sendResponse({
        success: true,
        videoInfo: videoInfo,
        streamData: {
          videoUrl: captureResult.videoStorageUrl,
          quality: 'captured',
          mimeType: captureResult.mimeType || 'video/webm',
          capturedAt: Date.now(),
          source: 'mediarecorder_capture',
          uploadedToStorage: true,
          capturedSegment: captureResult.capturedSegment
        },
        message: 'Video captured and uploaded successfully.'
      });
    } else {
      console.error(`[YVO Background] Capture failed:`, captureResult.error);
      sendResponse({
        success: false,
        error: captureResult.error
      });
    }
  } catch (error) {
    console.error('[YVO Background] Capture error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * SIMPLIFIED: Single function to capture and upload video
 * Handles everything: tab management, video readiness, capture, upload
 */
async function captureVideo(videoId, youtubeUrl, startTime, endTime) {
  console.log(`[YVO Background] Starting capture for ${videoId}`);

  try {
    // Step 1: Get or create a YouTube tab with the video
    const tab = await ensureYouTubeTab(videoId, youtubeUrl);
    console.log(`[YVO Background] Using tab ${tab.id}`);

    // Step 2: Wait for tab to be fully loaded
    await waitForTabComplete(tab.id);
    console.log(`[YVO Background] Tab ${tab.id} is complete`);

    // Step 3: Make sure the tab is focused (helps with autoplay)
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(1000);

    // Step 4: Try to get video info and start playback
    let videoDuration = 300;
    try {
      const info = await chrome.tabs.sendMessage(tab.id, { action: 'getVideoInfo' });
      if (info?.success && info.videoInfo?.duration) {
        videoDuration = info.videoInfo.duration;
      }
      // Trigger playback
      await chrome.tabs.sendMessage(tab.id, { action: 'triggerPlayback' });
      await sleep(2000);
    } catch (e) {
      console.log(`[YVO Background] Content script not ready, will retry in injection`);
    }

    // Step 5: Calculate capture range
    const captureStart = startTime !== undefined ? Math.max(0, startTime) : 0;
    const captureEnd = endTime !== undefined
      ? Math.min(endTime, videoDuration, captureStart + MAX_CAPTURE_DURATION)
      : Math.min(MAX_CAPTURE_DURATION, videoDuration);

    console.log(`[YVO Background] Capture range: ${captureStart}s to ${captureEnd}s`);

    // Step 6: Inject and run the capture script
    const result = await injectAndCapture(tab.id, captureStart, captureEnd);

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Step 7: Upload to server (try Cloud Run first, then Cloud Function as fallback)
    console.log(`[YVO Background] Uploading ${(result.videoSize / 1024 / 1024).toFixed(2)}MB...`);

    const videoBlob = base64ToBlob(result.videoData, result.mimeType);

    // Try Cloud Run first
    let uploadResult = null;
    let uploadSuccess = false;

    const uploadUrls = [
      `${VIDEO_PROCESSOR_URL}/upload-stream`,
      CLOUD_FUNCTION_UPLOAD_URL
    ];

    for (const uploadUrl of uploadUrls) {
      try {
        console.log(`[YVO Background] Trying upload to: ${uploadUrl}`);

        const formData = new FormData();
        formData.append('video', videoBlob, `captured_${videoId}.webm`);
        formData.append('videoId', videoId);
        formData.append('type', 'video');
        formData.append('captureStart', String(captureStart));
        formData.append('captureEnd', String(captureEnd));

        const uploadResponse = await fetch(uploadUrl, {
          method: 'POST',
          body: formData
        });

        if (uploadResponse.ok) {
          uploadResult = await uploadResponse.json();
          uploadSuccess = true;
          console.log(`[YVO Background] Upload successful: ${uploadResult.url}`);
          break;
        } else {
          const errorText = await uploadResponse.text();
          console.warn(`[YVO Background] Upload to ${uploadUrl} failed: ${uploadResponse.status}`);
        }
      } catch (uploadError) {
        console.warn(`[YVO Background] Upload to ${uploadUrl} error:`, uploadError.message);
      }
    }

    if (!uploadSuccess || !uploadResult) {
      return { success: false, error: 'Upload failed to all endpoints. Please try again.' };
    }

    return {
      success: true,
      videoStorageUrl: uploadResult.url,
      mimeType: result.mimeType,
      capturedSegment: {
        startTime: captureStart,
        endTime: captureEnd,
        duration: captureEnd - captureStart
      }
    };

  } catch (error) {
    console.error(`[YVO Background] Capture failed:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * Find an existing YouTube tab with the video, or create a new one
 */
async function ensureYouTubeTab(videoId, youtubeUrl) {
  // Look for existing tab
  const tabs = await chrome.tabs.query({
    url: ['*://www.youtube.com/*', '*://youtube.com/*']
  });

  const existingTab = tabs.find(tab => {
    try {
      const url = new URL(tab.url);
      return url.searchParams.get('v') === videoId;
    } catch {
      return false;
    }
  });

  if (existingTab) {
    console.log(`[YVO Background] Found existing tab ${existingTab.id}`);
    return existingTab;
  }

  // Create new tab
  const url = youtubeUrl || `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`[YVO Background] Creating new tab for ${url}`);

  const newTab = await chrome.tabs.create({ url, active: true });
  return newTab;
}

/**
 * Wait for a tab to finish loading
 */
function waitForTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const checkTab = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);

        if (tab.status === 'complete') {
          resolve();
          return;
        }

        if (Date.now() - startTime > timeout) {
          resolve(); // Proceed anyway after timeout
          return;
        }

        setTimeout(checkTab, 500);
      } catch (error) {
        reject(new Error(`Tab ${tabId} no longer exists`));
      }
    };

    checkTab();
  });
}

/**
 * Inject the capture script and wait for result
 */
async function injectAndCapture(tabId, startTime, endTime) {
  console.log(`[YVO Background] Injecting capture script into tab ${tabId}`);

  // The capture function to inject
  const captureFunction = function(startTime, endTime) {
    return new Promise((resolve) => {
      console.log(`[YVO Capture] Starting capture from ${startTime}s to ${endTime}s`);

      const duration = endTime - startTime;
      const PLAYBACK_SPEED = 4;

      // Find video element
      let video = document.querySelector('video.html5-main-video') || document.querySelector('video');

      if (!video) {
        resolve({ success: false, error: 'No video element found on page' });
        return;
      }

      console.log(`[YVO Capture] Video found: ${video.videoWidth}x${video.videoHeight}, readyState: ${video.readyState}`);

      // Function to start the actual recording
      const startCapture = () => {
        console.log(`[YVO Capture] Video ready, starting MediaRecorder...`);

        // Capture stream from video
        let stream;
        try {
          stream = video.captureStream();
        } catch (e) {
          resolve({ success: false, error: `Cannot capture stream: ${e.message}` });
          return;
        }

        if (!stream || stream.getVideoTracks().length === 0) {
          resolve({ success: false, error: 'Failed to capture video stream' });
          return;
        }

        // Find supported mime type
        let mimeType = 'video/webm;codecs=vp9,opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'video/webm;codecs=vp8,opus';
        }
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'video/webm';
        }

        const chunks = [];
        let recorder;

        try {
          recorder = new MediaRecorder(stream, {
            mimeType: mimeType,
            videoBitsPerSecond: 8000000
          });
        } catch (e) {
          resolve({ success: false, error: `Failed to create MediaRecorder: ${e.message}` });
          return;
        }

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = () => {
          console.log(`[YVO Capture] Recording stopped, processing...`);
          video.playbackRate = 1;
          video.pause();

          if (chunks.length === 0) {
            resolve({ success: false, error: 'No data captured' });
            return;
          }

          const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
          console.log(`[YVO Capture] Blob size: ${(blob.size / 1024 / 1024).toFixed(2)}MB`);

          if (blob.size < 10000) {
            resolve({ success: false, error: 'Captured video too small' });
            return;
          }

          // Convert to base64
          const reader = new FileReader();
          reader.onloadend = () => {
            resolve({
              success: true,
              videoData: reader.result.split(',')[1],
              videoSize: blob.size,
              mimeType: mimeType.split(';')[0]
            });
          };
          reader.onerror = () => {
            resolve({ success: false, error: 'Failed to read video data' });
          };
          reader.readAsDataURL(blob);
        };

        recorder.onerror = (e) => {
          video.playbackRate = 1;
          resolve({ success: false, error: `Recorder error: ${e.error?.message}` });
        };

        // Seek to start position
        video.currentTime = startTime;
        video.muted = true;
        video.playbackRate = PLAYBACK_SPEED;

        // Wait a bit for seek, then start
        setTimeout(() => {
          try {
            recorder.start(500);
            video.play().catch(() => {});
            console.log(`[YVO Capture] Recording started at ${PLAYBACK_SPEED}x speed`);
          } catch (e) {
            resolve({ success: false, error: `Failed to start: ${e.message}` });
            return;
          }

          // Stop when we reach end
          const checkEnd = setInterval(() => {
            if (video.currentTime >= endTime || video.ended) {
              clearInterval(checkEnd);
              if (recorder.state === 'recording') {
                recorder.stop();
              }
            }
          }, 100);

          // Safety timeout
          const captureTimeMs = (duration / PLAYBACK_SPEED) * 1000;
          setTimeout(() => {
            clearInterval(checkEnd);
            if (recorder.state === 'recording') {
              recorder.stop();
            }
          }, captureTimeMs + 10000);
        }, 1000);
      };

      // Force video to play
      const forcePlay = () => {
        // Click play buttons
        document.querySelector('.ytp-large-play-button')?.click();
        document.querySelector('.ytp-play-button')?.click();

        // Skip ads
        document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern')?.click();

        // Direct play
        video.muted = true;
        video.play().catch(() => {});
      };

      // Wait for video to be ready
      if (video.readyState >= 2 && !video.paused) {
        startCapture();
      } else {
        console.log(`[YVO Capture] Waiting for video readiness...`);
        forcePlay();

        let attempts = 0;
        const maxAttempts = 40; // 20 seconds

        const checkReady = () => {
          attempts++;
          console.log(`[YVO Capture] Check ${attempts}: readyState=${video.readyState}, paused=${video.paused}, time=${video.currentTime.toFixed(1)}`);

          if (video.readyState >= 2 && (video.currentTime > 0 || !video.paused)) {
            startCapture();
            return;
          }

          if (attempts >= maxAttempts) {
            if (video.readyState >= 1) {
              console.log(`[YVO Capture] Timeout, but attempting anyway...`);
              startCapture();
            } else {
              resolve({ success: false, error: `Video not ready after ${maxAttempts * 0.5}s (readyState: ${video.readyState})` });
            }
            return;
          }

          // Retry playback every 2 seconds
          if (attempts % 4 === 0) {
            forcePlay();
          }

          setTimeout(checkReady, 500);
        };

        setTimeout(checkReady, 500);
      }
    });
  };

  // Execute the script
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: captureFunction,
      args: [startTime, endTime]
    });

    if (!results || results.length === 0) {
      return { success: false, error: 'Script injection returned no results' };
    }

    const result = results[0];

    if (result.error) {
      return { success: false, error: `Script error: ${result.error}` };
    }

    return result.result || { success: false, error: 'No result from capture script' };

  } catch (error) {
    console.error(`[YVO Background] Script injection failed:`, error);
    return { success: false, error: `Injection failed: ${error.message}` };
  }
}

/**
 * Helper: Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Validate video ID format
 */
function isValidVideoId(videoId) {
  return /^[a-zA-Z0-9_-]{11}$/.test(videoId);
}

/**
 * Convert base64 string to Blob
 */
function base64ToBlob(base64, mimeType = 'video/webm') {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * Get settings from storage
 */
async function getSettings() {
  try {
    const result = await chrome.storage.sync.get(['settings']);
    return result.settings || { defaultQuality: '720', defaultDuration: 30, autoDownload: true };
  } catch {
    return { defaultQuality: '720', defaultDuration: 30, autoDownload: true };
  }
}

/**
 * Save settings to storage
 */
async function saveSettings(settings) {
  try {
    await chrome.storage.sync.set({ settings });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Installation handler
 */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[YVO Extension] Installed successfully');
  } else if (details.reason === 'update') {
    console.log('[YVO Extension] Updated to version', chrome.runtime.getManifest().version);
  }
});

console.log('[YVO Extension] Background service worker loaded (v2.0 - Simplified)');
