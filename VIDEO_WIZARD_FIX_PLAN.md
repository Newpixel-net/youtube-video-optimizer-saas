# Video Wizard & Browser Extension - Comprehensive Fix Plan

## Executive Summary

After a comprehensive review of the video wizard and browser extension, I've identified **4 critical issues** causing the failures shown in the screenshots. This plan provides detailed solutions for each problem.

---

## Issues Identified

### Issue 1: Firebase Storage Permission Denied (403 Forbidden) - CRITICAL

**Error Message:**
```
Firebase Storage: User does not have permission to access 'captured-videos/G_-0hqD7x3A/export_1765756497070.webm'. (storage/unauthorized)
```

**Root Cause:**
The frontend code uploads to `captured-videos/{videoId}/...` but the Firebase Storage rules only allow these paths:
- `/uploads/{userId}/{fileName}`
- `/thumbnails/{userId}/{fileName}`
- `/creative-studio/{userId}/{fileName}`
- `/campaign-reports/{reportId}/{fileName}`

**The `captured-videos/` path is NOT defined in storage.rules!**

**Affected Files:**
- `frontend/video-wizard.html` - Lines 9420 and 11417

**Current Code (BROKEN):**
```javascript
// Line 9420
storagePath = 'captured-videos/' + videoId + '/source_' + timestamp + '.' + extension;

// Line 11417
storagePath = 'captured-videos/' + videoId + '/export_' + timestamp + '.' + ext;
```

---

### Issue 2: MediaRecorder 64MB Message Limit Exceeded - CRITICAL

**Error Message:**
```
MediaRecorder exception: Message length exceeded maximum allowed length of 64MB
```

**Root Cause:**
- Chrome has a hard limit of ~64MB on `postMessage` and `chrome.runtime.sendMessage`
- The captured video is converted to Base64 (increases size by ~33%)
- Videos larger than ~48MB original size will fail
- This happens in `captureVideoSegmentWithMediaRecorder()` when returning video data

**Affected Files:**
- `browser-extension/src/background.js` - Lines 1130-1359

---

### Issue 3: Video Stream URL Retrieval Failures - MEDIUM

**Error Message:**
```
Error getting stream: Error: Could not get video stream URL
```

**Root Cause:**
Network interception fails when:
- Video hasn't started playing
- Video uses adaptive streaming formats not caught by itag filters
- Tab is not active/focused (autoplay blocked)
- Content scripts not properly injected
- DRM-protected content

**Affected Files:**
- `browser-extension/src/background.js` - Network interception code (Lines 47-133)
- `browser-extension/src/content.js` - Video element access

---

### Issue 4: Server 404 Errors - MEDIUM

**Error Message:**
```
FAIL: Server 404: <html><head>... 404 Page not [UPLOAD][EXT]
```

**Root Cause:**
- Possible endpoint routing misconfiguration
- Cloud Functions or Cloud Run service not properly deployed
- API path mismatch between frontend and backend

---

## Solution Plan

### Phase 1: Fix Firebase Storage Permissions (CRITICAL - Day 1)

#### Option A: Update Storage Rules (Recommended)
Add `captured-videos` path to `storage.rules`:

```javascript
// Add to storage.rules before the catch-all deny rule
// Captured videos folder (for Video Wizard captured content)
match /captured-videos/{videoId}/{fileName} {
  // Allow authenticated users to read their captured videos
  // Note: Can't verify ownership without userId in path
  allow read: if request.auth != null;

  // Allow authenticated users to write
  // Limit file size to 500MB and only allow video types
  allow write: if request.auth != null
               && request.resource.size < 500 * 1024 * 1024
               && request.resource.contentType.matches('video/.*');
}
```

#### Option B: Change Upload Path (More Secure)
Modify frontend to use the existing `/uploads/{userId}/` path:

**Files to modify:** `frontend/video-wizard.html`

```javascript
// Line 9420 - Change from:
storagePath = 'captured-videos/' + videoId + '/source_' + timestamp + '.' + extension;
// To:
storagePath = 'uploads/' + auth.currentUser.uid + '/captured_' + videoId + '_source_' + timestamp + '.' + extension;

// Line 11417 - Change from:
storagePath = 'captured-videos/' + videoId + '/export_' + timestamp + '.' + ext;
// To:
storagePath = 'uploads/' + auth.currentUser.uid + '/captured_' + videoId + '_export_' + timestamp + '.' + ext;
```

**Recommendation:** Use Option B as it leverages existing security rules and ties uploads to user ownership.

---

### Phase 2: Fix MediaRecorder 64MB Limit (CRITICAL - Day 1-2)

#### Solution: Chunked Upload with Streaming

Instead of converting the entire video to Base64 and sending via message, implement chunked upload directly from the content script:

**Approach A: Direct-to-Server Chunked Upload**

1. **Modify `captureVideoSegmentWithMediaRecorder()` in background.js:**
   - Instead of returning Base64 data via message, stream chunks directly to server
   - Use `ReadableStream` or chunked FormData uploads

```javascript
// In background.js - Replace Base64 return with streaming upload
async function captureVideoSegmentWithMediaRecorder(startTime, endTime, uploadUrl) {
  // ... existing capture code ...

  recorder.ondataavailable = async (e) => {
    if (e.data.size > 0) {
      // Stream chunks directly to server instead of accumulating
      await uploadChunk(e.data, chunkIndex++, uploadUrl);
    }
  };

  // ... rest of capture code ...
}
```

**Approach B: IndexedDB Temporary Storage**

1. Store captured video in IndexedDB
2. Read and upload in chunks from the frontend
3. Clean up after successful upload

```javascript
// Store in IndexedDB instead of returning via message
async function storeVideoInIndexedDB(videoBlob, videoId) {
  const db = await openDB('VideoCapture', 1);
  await db.put('videos', { id: videoId, blob: videoBlob, timestamp: Date.now() });
  return videoId;
}
```

**Approach C: Blob URL with Limited Lifetime (Simpler)**

For smaller videos that fit in memory:
1. Create Blob URL in content script (not service worker)
2. Pass URL reference instead of data
3. Frontend fetches from Blob URL

**Recommendation:** Implement Approach A (Direct streaming) for best reliability with large files.

---

### Phase 3: Improve Video Stream Detection (MEDIUM - Day 2-3)

#### Enhancements:

1. **Expand itag filter list** in background.js network interception:

```javascript
// Line 89 - Add more video itags
const isVideo = mime?.startsWith('video/') ||
  ['18', '22', '37', '38', '82', '83', '84', '85',
   '133', '134', '135', '136', '137', '138', // 240p-4320p
   '160', '242', '243', '244', '247', '248', // VP9
   '264', '266', '271', '278', '298', '299',
   '302', '303', '308', '313', '315', '330', '331', '332', '333', '334', '335', '336', '337' // More formats
  ].includes(itag);
```

2. **Add fallback capture methods:**
   - If network interception fails, try content script `getVideoStream()`
   - If that fails, force tab to foreground briefly for autoplay

3. **Improve error messages** with specific guidance:

```javascript
// Better error handling
if (!intercepted && !streamData) {
  throw new Error('Video stream not detected. Please: 1) Ensure the video is playing, 2) Try refreshing the YouTube page, 3) Check if the video has playback restrictions.');
}
```

---

### Phase 4: Fix Server 404 Errors (MEDIUM - Day 3)

#### Diagnostics:

1. **Verify Cloud Run deployment:**
```bash
gcloud run services describe video-processor --region=us-central1
```

2. **Check Cloud Functions deployment:**
```bash
firebase functions:list
```

3. **Verify API routing in firebase.json:**
```json
{
  "hosting": {
    "rewrites": [
      {"source": "/api/**", "function": "api"}
    ]
  }
}
```

#### Fixes:

1. **Add health check endpoint verification** in frontend before upload attempts
2. **Implement retry logic with exponential backoff** for transient failures
3. **Add fallback endpoints** if primary fails

---

### Phase 5: Additional Improvements (Day 3-4)

#### 1. Add File Size Validation Before Upload

```javascript
// In video-wizard.html before upload
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500MB
if (videoBlob.size > MAX_UPLOAD_SIZE) {
  throw new Error(`Video too large (${(videoBlob.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 500MB.`);
}
```

#### 2. Better Error UI in Download Dialog

```javascript
// Show specific guidance based on error code
function getErrorMessage(error) {
  if (error.code === 'storage/unauthorized') {
    return 'Upload permission denied. Please ensure you are logged in and try again.';
  }
  if (error.message.includes('64MB')) {
    return 'Video too large for browser capture. Please try a shorter segment.';
  }
  // ... more specific messages
}
```

#### 3. Add Progress Indicators for Large Uploads

```javascript
// Show upload progress
uploadTask.on('state_changed',
  (snapshot) => {
    const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
    updateProgressUI(progress);
  }
);
```

---

## Implementation Priority

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| P0 | Firebase Storage Path Fix | 1 hour | Fixes 403 errors immediately |
| P0 | MediaRecorder 64MB Limit | 4-6 hours | Fixes large video capture failures |
| P1 | Video Stream Detection | 2-3 hours | Reduces capture failures |
| P1 | Server 404 Investigation | 1-2 hours | Ensures upload endpoint works |
| P2 | Better Error Messages | 2 hours | Improves user experience |
| P2 | Progress Indicators | 1 hour | Improves user experience |

---

## Quick Win (5-Minute Fix)

The fastest fix for the Firebase 403 error is to update `storage.rules`:

```javascript
// Add after line 46 in storage.rules:

// Captured videos folder (for Video Wizard)
match /captured-videos/{videoId}/{fileName} {
  allow read: if request.auth != null;
  allow write: if request.auth != null
               && request.resource.size < 500 * 1024 * 1024
               && request.resource.contentType.matches('video/.*');
}
```

Then deploy:
```bash
firebase deploy --only storage
```

---

## Testing Plan

### After Firebase Fix:
1. Open Video Wizard
2. Load a YouTube video
3. Select a clip and export
4. Verify upload completes without 403 error

### After MediaRecorder Fix:
1. Test with short video (< 1 minute) - should work
2. Test with medium video (2-3 minutes) - verify chunking works
3. Test with long video (5 minutes) - verify no 64MB error

### After Stream Detection Fix:
1. Test with different video types (regular, premiere, live)
2. Test with video that hasn't started playing
3. Test after page refresh

---

## Files to Modify Summary

| File | Changes |
|------|---------|
| `storage.rules` | Add `captured-videos` path OR |
| `frontend/video-wizard.html` | Change upload path to `/uploads/{userId}/` |
| `browser-extension/src/background.js` | Implement chunked upload for large videos |
| `browser-extension/src/background.js` | Expand itag list for better detection |
| `browser-extension/src/wizard-bridge.js` | Add better error handling |

---

## Conclusion

The primary issue causing the "Video Capture Failed" error is a **Firebase Storage rules mismatch** - the frontend uploads to `captured-videos/` but the rules don't allow this path. This is a 5-minute fix.

The secondary issue with "MediaRecorder exception: Message length exceeded 64MB" requires implementing chunked uploads to handle larger videos.

Both issues are fixable and the plan above provides a clear path to resolution.
