# Plan: Complete Bulk Mode & Add Playlist Feature

## Problem Analysis

### Current Issues with Bulk Mode:
1. **Missing configuration options** - Style, Category, Composition Template, and Background Style are hidden in bulk mode
2. **Incomplete payload** - The `processBulkUpgrade` function doesn't send style/category/composition/background to backend
3. **No shared settings UI** - Users can't configure how ALL bulk thumbnails should look
4. **Advanced Options visible but unused** - Composition and Background are shown but not passed to generation

### What's Working:
- Dynamic URL fields with + button ✓
- YouTube data fetching for each URL ✓
- Sequential processing ✓
- Results grid with download/preview ✓
- ZIP download ✓

---

## Part 1: Fix Bulk Mode (Missing Configurations)

### 1.1 Add Shared Configuration UI for Bulk Mode

**Location:** After the URL list, before the "Upgrade All" button

```
┌─────────────────────────────────────────────────────────┐
│ ⬆️ Upgrade Existing Thumbnail                           │
│                                                         │
│ [Upload] [Single URL] [Bulk (1-10)] [🎬 Playlist]       │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ [📝] https://youtube.com/watch?v=abc ✓ Ready  [×]   │ │
│ │     🖼️ "Video Title" - Channel Name                 │ │
│ └─────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ [📝] https://youtube.com/watch?v=def ✓ Ready  [×]   │ │
│ │     🖼️ "Another Video" - Channel Name               │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ [+ Add YouTube Video (2/10)]                            │
│                                                         │
│ ─────────── Bulk Settings (Apply to All) ───────────── │
│                                                         │
│ Visual Style:                                           │
│ [Professional] [Dramatic] [Minimal] [Bold]              │
│                                                         │
│ Content Category:                                       │
│ [General] [Gaming] [Tutorial] [Vlog] [Review] ...       │
│                                                         │
│ ▶ Advanced Options                                      │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 2 videos ready • Cost: 8 tokens    Balance: 50 ✓    │ │
│ │ [⬆️ Upgrade All Thumbnails (8 tokens)]              │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 1.2 Update processBulkUpgrade Payload

**Current payload (incomplete):**
```javascript
var payload = {
    prompt: item.youtubeData.title,
    mode: 'upgrade',
    referenceType: 'upgrade',
    reference: {...},
    variations: 1,
    title: item.youtubeData.title,
    youtubeContext: {...}
};
```

**Fixed payload (complete):**
```javascript
var payload = {
    prompt: item.youtubeData.title,
    mode: 'upgrade',
    referenceType: 'upgrade',
    reference: {...},
    variations: 1,
    title: item.youtubeData.title,
    youtubeContext: {...},
    // ADD THESE:
    style: state.thumbnailStyle,           // 'professional', 'dramatic', etc.
    category: state.thumbnailCategory,     // 'gaming', 'tutorial', etc.
    composition: state.thumbnailComposition, // 'auto', 'faceRight', etc.
    background: state.thumbnailBackground,   // 'auto', 'studio', etc.
    faceStrength: state.thumbnailFaceStrength,
    styleStrength: state.thumbnailStyleStrength,
    expression: state.thumbnailExpression
};
```

### 1.3 UI Changes Required

**File:** `frontend/main-dashboard.html`

1. **Move the bulk mode check** - Don't hide ALL form elements, only hide the single-item specific ones:
   - Hide: Title input (bulk uses video titles automatically)
   - Hide: Variations selector (bulk is always 1 per video)
   - Show: Style selection
   - Show: Category selection
   - Show: Advanced Options

2. **Add "Bulk Settings" section** in the bulk mode area with:
   - Style buttons (same as regular mode)
   - Category buttons (same as regular mode)
   - Note: "These settings apply to all thumbnails"

---

## Part 2: New Playlist Feature

### 2.1 Overview

Allow users to paste a YouTube playlist URL and automatically fetch all videos, then generate thumbnails for all of them.

**User Flow:**
1. User selects "🎬 Playlist" tab
2. Pastes playlist URL (e.g., `youtube.com/playlist?list=PLxxxxxxx`)
3. Clicks "Fetch Playlist"
4. System fetches all videos (with pagination if > 50)
5. Shows list of videos with checkboxes (all selected by default)
6. User can deselect videos they don't want
7. User configures shared style/category
8. Clicks "Generate All"
9. Sequential processing with progress
10. Results grid + ZIP download

### 2.2 Backend: fetchYoutubePlaylist Cloud Function

**New function in `functions/index.js`:**

```javascript
exports.fetchYoutubePlaylist = functions.https.onCall(async (data, context) => {
    // Require authentication
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }

    const { playlistUrl } = data;

    // Extract playlist ID from various URL formats:
    // - youtube.com/playlist?list=PLxxxxx
    // - youtube.com/watch?v=xxx&list=PLxxxxx
    const playlistId = extractPlaylistId(playlistUrl);

    if (!playlistId) {
        throw new functions.https.HttpsError('invalid-argument', 'Invalid playlist URL');
    }

    const apiKey = functions.config().youtube?.key;
    if (!apiKey) {
        throw new functions.https.HttpsError('failed-precondition', 'YouTube API not configured');
    }

    try {
        const videos = [];
        let nextPageToken = null;

        // Fetch all pages (YouTube returns max 50 per page)
        do {
            const params = new URLSearchParams({
                part: 'snippet',
                playlistId: playlistId,
                maxResults: 50,
                key: apiKey
            });
            if (nextPageToken) params.append('pageToken', nextPageToken);

            const response = await fetch(
                `https://www.googleapis.com/youtube/v3/playlistItems?${params}`
            );
            const data = await response.json();

            if (data.error) {
                throw new Error(data.error.message);
            }

            for (const item of data.items) {
                // Skip deleted/private videos
                if (item.snippet.title === 'Deleted video' ||
                    item.snippet.title === 'Private video') {
                    continue;
                }

                videos.push({
                    videoId: item.snippet.resourceId.videoId,
                    title: item.snippet.title,
                    description: item.snippet.description,
                    channelName: item.snippet.channelTitle,
                    thumbnailUrl: item.snippet.thumbnails?.maxres?.url ||
                                  item.snippet.thumbnails?.high?.url ||
                                  item.snippet.thumbnails?.medium?.url ||
                                  `https://img.youtube.com/vi/${item.snippet.resourceId.videoId}/maxresdefault.jpg`,
                    position: item.snippet.position
                });
            }

            nextPageToken = data.nextPageToken;
        } while (nextPageToken && videos.length < 100); // Cap at 100 videos

        // Get playlist metadata
        const playlistResponse = await fetch(
            `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${playlistId}&key=${apiKey}`
        );
        const playlistData = await playlistResponse.json();
        const playlistInfo = playlistData.items?.[0]?.snippet || {};

        return {
            success: true,
            playlistId: playlistId,
            playlistTitle: playlistInfo.title || 'Unknown Playlist',
            channelName: playlistInfo.channelTitle || 'Unknown Channel',
            videoCount: videos.length,
            videos: videos
        };

    } catch (error) {
        console.error('fetchYoutubePlaylist error:', error);
        throw new functions.https.HttpsError('internal', error.message);
    }
});

function extractPlaylistId(url) {
    // Handle: youtube.com/playlist?list=PLxxxxx
    // Handle: youtube.com/watch?v=xxx&list=PLxxxxx
    // Handle: youtu.be/xxx?list=PLxxxxx
    const patterns = [
        /[?&]list=([a-zA-Z0-9_-]+)/,
        /\/playlist\/([a-zA-Z0-9_-]+)/
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}
```

### 2.3 Frontend State Variables

**Add to state object:**
```javascript
// Playlist Mode State
playlistUrl: '',
playlistData: null, // { playlistId, playlistTitle, channelName, videos: [] }
playlistLoading: false,
playlistError: null,
playlistSelectedVideos: [], // Array of videoIds that are selected
playlistProcessing: false,
playlistResults: [] // Array of { videoId, status, thumbnailUrl, error }
```

### 2.4 Frontend Functions

```javascript
// Set playlist URL
setPlaylistUrl: function(url) {
    state.playlistUrl = url;
    state.playlistError = null;
},

// Fetch playlist data
fetchPlaylist: async function() {
    if (!state.playlistUrl.trim()) {
        state.playlistError = 'Please enter a playlist URL';
        render();
        return;
    }

    state.playlistLoading = true;
    state.playlistError = null;
    render();

    try {
        const fetchPlaylist = firebase.functions().httpsCallable('fetchYoutubePlaylist');
        const result = await fetchPlaylist({ playlistUrl: state.playlistUrl });

        if (result.data.success) {
            state.playlistData = result.data;
            // Select all videos by default
            state.playlistSelectedVideos = result.data.videos.map(v => v.videoId);
        }
    } catch (error) {
        state.playlistError = error.message || 'Failed to fetch playlist';
    }

    state.playlistLoading = false;
    render();
},

// Toggle video selection
togglePlaylistVideo: function(videoId) {
    const idx = state.playlistSelectedVideos.indexOf(videoId);
    if (idx === -1) {
        state.playlistSelectedVideos.push(videoId);
    } else {
        state.playlistSelectedVideos.splice(idx, 1);
    }
    render();
},

// Select/deselect all
toggleAllPlaylistVideos: function() {
    if (state.playlistSelectedVideos.length === state.playlistData.videos.length) {
        state.playlistSelectedVideos = [];
    } else {
        state.playlistSelectedVideos = state.playlistData.videos.map(v => v.videoId);
    }
    render();
},

// Calculate playlist cost
calculatePlaylistCost: function() {
    return state.playlistSelectedVideos.length * 4; // 4 tokens per upgrade
},

// Process playlist
processPlaylist: async function() {
    // Similar to processBulkUpgrade but using playlistData
    // ... implementation
},

// Clear playlist
clearPlaylist: function() {
    state.playlistUrl = '';
    state.playlistData = null;
    state.playlistError = null;
    state.playlistSelectedVideos = [];
    state.playlistResults = [];
    render();
}
```

### 2.5 Frontend UI for Playlist Tab

```
┌─────────────────────────────────────────────────────────┐
│ ⬆️ Upgrade Existing Thumbnail                           │
│                                                         │
│ [Upload] [Single URL] [Bulk (1-10)] [🎬 Playlist]       │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 🎬 Upgrade Entire Playlist                          │ │
│ │                                                     │ │
│ │ [Paste playlist URL...              ] [🔍 Fetch]    │ │
│ │                                                     │ │
│ │ Supports: youtube.com/playlist?list=...             │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ (After fetching:)                                       │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 📋 "My Playlist Name" • 24 videos                   │ │
│ │ by Channel Name                                      │ │
│ │                                                     │ │
│ │ [☑ Select All]                    [Clear Playlist]  │ │
│ │                                                     │ │
│ │ ┌───────────────────────────────────────────────┐  │ │
│ │ │ [✓] 🖼️ Video Title 1              Channel    │  │ │
│ │ │ [✓] 🖼️ Video Title 2              Channel    │  │ │
│ │ │ [✓] 🖼️ Video Title 3              Channel    │  │ │
│ │ │ [ ] 🖼️ Video Title 4 (deselected) Channel    │  │ │
│ │ │ [✓] 🖼️ Video Title 5              Channel    │  │ │
│ │ │ ... (scrollable, max 100)                     │  │ │
│ │ └───────────────────────────────────────────────┘  │ │
│ │                                                     │ │
│ │ 23 of 24 selected                                   │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ─────────── Settings (Apply to All) ─────────────────  │
│                                                         │
│ [Professional] [Dramatic] [Minimal] [Bold]              │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 23 videos selected • Cost: 92 tokens   Balance: 100 │ │
│ │ [⬆️ Generate All Thumbnails (92 tokens)]            │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Order

### Phase 1: Fix Bulk Mode (Priority: HIGH)
1. Update `processBulkUpgrade` to include all parameters
2. Show Style/Category in bulk mode UI
3. Show Advanced Options work for bulk mode
4. Test bulk generation with full parameters

### Phase 2: Playlist Feature (Priority: MEDIUM)
1. Create `fetchYoutubePlaylist` Cloud Function
2. Deploy backend
3. Add playlist state variables
4. Add playlist functions
5. Add "Playlist" tab in UI
6. Add playlist URL input and fetch
7. Add video selection list with checkboxes
8. Add shared settings (style/category)
9. Add playlist processing
10. Add results grid and ZIP download
11. Test end-to-end

---

## Files to Modify

1. **`functions/index.js`**
   - Add `fetchYoutubePlaylist` function
   - Add `extractPlaylistId` helper

2. **`frontend/main-dashboard.html`**
   - Add playlist state variables
   - Add playlist functions
   - Update tab selector (4 tabs now)
   - Add playlist mode UI
   - Fix bulk mode to show style/category
   - Update `processBulkUpgrade` payload

---

## Token Cost Considerations

- Single upload/URL: 4 tokens
- Bulk mode: 4 tokens × number of videos
- Playlist mode: 4 tokens × selected videos

**Safety limits:**
- Bulk: Max 10 videos (40 tokens max)
- Playlist: Max 100 videos shown, but recommend warning for > 25 videos
- Show "This will cost X tokens" prominently before processing

---

## Edge Cases to Handle

1. **Playlist with private/deleted videos** - Skip them silently
2. **Very long playlists (100+ videos)** - Cap at 100, show warning
3. **Empty playlist** - Show error message
4. **User has insufficient tokens** - Disable button, show message
5. **Network errors during batch processing** - Continue with next, mark failed
6. **Mixed success/failure** - Show results for successful ones
