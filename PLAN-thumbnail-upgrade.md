# Thumbnail Upgrade Feature - Implementation Plan

## Overview

Replace "Premium Mode" (DALL-E 3, 6 tokens) with a new "Thumbnail Upgrade" mode that allows users to:
1. Upload an existing thumbnail to get an upgraded/enhanced version
2. OR paste a YouTube video URL to auto-fetch the thumbnail + video metadata for context-aware upgrading

## Current State Analysis

### Existing Modes
| Mode | Model | Cost | Features |
|------|-------|------|----------|
| Quick Mode | Imagen 4 | 2 tokens | Fast, no reference |
| Reference Mode | Gemini 3 Pro | 4 tokens | Upload reference image (face/product/style) |
| Premium Mode | DALL-E 3 | 6 tokens | Max detail (TO BE REPLACED) |

### Reference Mode Flow (to duplicate)
1. User uploads image → FileReader converts to base64
2. Stored in `state.thumbnailReference = { dataUrl, file, mimeType, name }`
3. Backend analyzes reference with Gemini Vision (detects face/product/style)
4. Gemini 3 Pro generates new image using reference + prompt

## New "Thumbnail Upgrade" Mode Design

### Mode Configuration
- **Icon**: 🔄 or ⬆️
- **Name**: Thumbnail Upgrade
- **Model**: Gemini 3 Pro Image Preview (same as Reference Mode)
- **Token Cost**: 4 tokens (same as Reference Mode)
- **Features**:
  - Upload existing thumbnail
  - OR paste YouTube URL
  - Enhanced prompts for "upgrade" context

### User Flow Options

#### Option A: Direct Upload
1. User clicks "Thumbnail Upgrade"
2. Uploads existing thumbnail
3. System analyzes what can be improved
4. Generates upgraded version

#### Option B: YouTube URL
1. User clicks "Thumbnail Upgrade"
2. Pastes YouTube video URL
3. System fetches: thumbnail, title, description, channel name
4. Shows preview of current thumbnail
5. User clicks "Upgrade"
6. System generates improved thumbnail with video context

---

## Implementation Details

### Phase 1: Frontend Changes (main-dashboard.html)

#### 1.1 Replace Premium Mode Definition
**Location**: Line ~8845

```javascript
// BEFORE
{ key: 'premium', name: 'Premium Mode', icon: '💎', model: 'DALL-E 3 - Max detail', time: '~8 seconds', features: ['Exceptional detail'], cost: 6, badge: 'Best Quality' }

// AFTER
{ key: 'upgrade', name: 'Thumbnail Upgrade', icon: '⬆️', model: 'AI Enhancement', time: '~10 seconds', features: ['Upload or paste URL', 'Context-aware upgrade'], cost: 4, badge: 'NEW' }
```

#### 1.2 Add State Variables
**Location**: State object (~line 5280)

```javascript
// Add to state object
thumbnailUpgradeMode: 'upload',      // 'upload' or 'youtube'
thumbnailYoutubeUrl: '',
thumbnailYoutubeData: null,          // { videoId, title, description, channelName, thumbnailUrl }
thumbnailYoutubeLoading: false,
thumbnailYoutubeError: null
```

#### 1.3 Add YouTube URL Fetch Function
**Location**: After handleReferenceUpload (~line 5530)

```javascript
fetchYoutubeThumbnailData: async function(url) {
    state.thumbnailYoutubeLoading = true;
    state.thumbnailYoutubeError = null;
    render();

    try {
        // Extract video ID from URL
        var videoId = extractYoutubeVideoId(url);
        if (!videoId) {
            throw new Error('Invalid YouTube URL');
        }

        // Call backend function to fetch video data
        var fetchYoutubeData = firebase.functions().httpsCallable('fetchYoutubeVideoData');
        var result = await fetchYoutubeData({ videoId: videoId });

        state.thumbnailYoutubeData = {
            videoId: videoId,
            title: result.data.title,
            description: result.data.description,
            channelName: result.data.channelName,
            thumbnailUrl: result.data.thumbnailUrl  // High-res thumbnail
        };

        // Auto-load thumbnail as reference
        state.thumbnailReference = {
            dataUrl: result.data.thumbnailUrl,
            mimeType: 'image/jpeg',
            name: 'youtube-thumbnail.jpg',
            isYoutubeThumbnail: true
        };

        state.thumbnailMode = 'upgrade';
        state.thumbnailYoutubeLoading = false;
        render();
    } catch (error) {
        state.thumbnailYoutubeError = error.message;
        state.thumbnailYoutubeLoading = false;
        render();
    }
}
```

#### 1.4 Helper: Extract YouTube Video ID
```javascript
function extractYoutubeVideoId(url) {
    var patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\s?]+)/,
        /youtube\.com\/shorts\/([^&\s?]+)/
    ];
    for (var i = 0; i < patterns.length; i++) {
        var match = url.match(patterns[i]);
        if (match) return match[1];
    }
    return null;
}
```

#### 1.5 Update renderThumbnail() - Mode Card
**Location**: ~line 8843-8850

Replace Premium Mode card rendering with:
```javascript
// Upgrade Mode card
{
    key: 'upgrade',
    name: 'Thumbnail Upgrade',
    icon: '⬆️',
    description: 'Upgrade existing thumbnail',
    time: '~10 seconds',
    features: ['Upload or paste URL'],
    cost: 4,
    badge: 'NEW',
    badgeColor: 'green'
}
```

#### 1.6 New UI: Upgrade Mode Input Section
**Location**: After mode cards, add conditional section for upgrade mode

```javascript
// When upgrade mode is selected, show input options
if (state.thumbnailMode === 'upgrade') {
    html += '<div class="upgrade-input-section">';

    // Tab selector: Upload vs YouTube URL
    html += '<div class="upgrade-tabs">';
    html += '<button class="upgrade-tab' + (state.thumbnailUpgradeMode === 'upload' ? ' active' : '') + '" onclick="app.setUpgradeMode(\'upload\')">';
    html += '📤 Upload Thumbnail</button>';
    html += '<button class="upgrade-tab' + (state.thumbnailUpgradeMode === 'youtube' ? ' active' : '') + '" onclick="app.setUpgradeMode(\'youtube\')">';
    html += '🔗 YouTube URL</button>';
    html += '</div>';

    if (state.thumbnailUpgradeMode === 'upload') {
        // Existing upload UI (similar to Reference Mode)
        html += renderUploadZone();
    } else {
        // YouTube URL input
        html += '<div class="youtube-url-input">';
        html += '<input type="text" placeholder="Paste YouTube video URL..." value="' + state.thumbnailYoutubeUrl + '" onchange="app.setYoutubeUrl(this.value)" />';
        html += '<button onclick="app.fetchYoutubeThumbnail()" ' + (state.thumbnailYoutubeLoading ? 'disabled' : '') + '>';
        html += state.thumbnailYoutubeLoading ? 'Loading...' : 'Fetch Thumbnail';
        html += '</button>';
        html += '</div>';

        // Show fetched data preview
        if (state.thumbnailYoutubeData) {
            html += '<div class="youtube-preview">';
            html += '<img src="' + state.thumbnailYoutubeData.thumbnailUrl + '" alt="Current Thumbnail" />';
            html += '<div class="youtube-info">';
            html += '<h4>' + escapeHtml(state.thumbnailYoutubeData.title) + '</h4>';
            html += '<p>by ' + escapeHtml(state.thumbnailYoutubeData.channelName) + '</p>';
            html += '</div>';
            html += '</div>';
        }

        if (state.thumbnailYoutubeError) {
            html += '<div class="error-message">' + state.thumbnailYoutubeError + '</div>';
        }
    }

    html += '</div>';
}
```

#### 1.7 Update Cost Calculation
**Location**: calculateThumbnailCost function (~line 5424)

```javascript
calculateThumbnailCost: function() {
    var modeCosts = {
        quick: 2,
        reference: 4,
        upgrade: 4  // Same as reference (replaces premium: 6)
    };
    var baseCost = modeCosts[state.thumbnailMode] || 2;
    state.thumbnailTokenCost = baseCost * state.thumbnailVariations;
    return state.thumbnailTokenCost;
}
```

#### 1.8 Update Generation Payload
**Location**: handleThumbnailGenerate (~line 5600)

```javascript
// Add upgrade mode handling
if (state.thumbnailMode === 'upgrade') {
    payload.mode = 'upgrade';

    if (state.thumbnailYoutubeData) {
        payload.youtubeContext = {
            videoId: state.thumbnailYoutubeData.videoId,
            title: state.thumbnailYoutubeData.title,
            description: state.thumbnailYoutubeData.description,
            channelName: state.thumbnailYoutubeData.channelName
        };
    }

    // Include reference image (either uploaded or fetched from YouTube)
    if (state.thumbnailReference) {
        var dataUrl = state.thumbnailReference.dataUrl;
        var base64 = dataUrl.startsWith('data:') ? dataUrl.split(',')[1] : null;

        if (base64) {
            payload.referenceImage = {
                base64: base64,
                mimeType: state.thumbnailReference.mimeType
            };
        } else {
            // YouTube thumbnail URL - backend will fetch
            payload.originalThumbnailUrl = dataUrl;
        }
    }

    payload.upgradeIntent = 'improve';  // Signal this is an upgrade request
}
```

---

### Phase 2: Backend Changes (functions/index.js)

#### 2.1 Add Mode Config
**Location**: modeConfig object (~line 5052)

```javascript
const modeConfig = {
    quick: { model: 'imagen-4', tokenCost: 2, supportsReference: false },
    reference: { model: 'nano-banana-pro', tokenCost: 4, supportsReference: true },
    // REMOVED: premium: { model: 'dall-e-3', tokenCost: 6, supportsReference: false },
    upgrade: { model: 'nano-banana-pro', tokenCost: 4, supportsReference: true, isUpgrade: true },
    // Keep specialized modes
    faceHero: { model: 'nano-banana-pro', tokenCost: 5, supportsReference: true, specialization: 'face' },
    styleClone: { model: 'nano-banana-pro', tokenCost: 4, supportsReference: true, specialization: 'style' },
    productPro: { model: 'dall-e-3', tokenCost: 6, supportsReference: false, specialization: 'product' }
};
```

#### 2.2 New Function: fetchYoutubeVideoData
**Create new Cloud Function**

```javascript
exports.fetchYoutubeVideoData = functions.https.onCall(async (data, context) => {
    // Check authentication
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }

    const { videoId } = data;
    if (!videoId) {
        throw new functions.https.HttpsError('invalid-argument', 'Video ID required');
    }

    // Rate limit
    checkRateLimit(context.auth.uid, 'fetchYoutubeData', 10);

    try {
        // Option 1: Use YouTube Data API (if we have API key)
        const youtubeApiKey = functions.config().youtube?.api_key;

        if (youtubeApiKey) {
            const response = await axios.get(
                `https://www.googleapis.com/youtube/v3/videos?` +
                `part=snippet&id=${videoId}&key=${youtubeApiKey}`
            );

            const video = response.data.items[0];
            if (!video) {
                throw new Error('Video not found');
            }

            const snippet = video.snippet;

            // Get highest quality thumbnail
            const thumbnails = snippet.thumbnails;
            const thumbnailUrl = thumbnails.maxres?.url ||
                                thumbnails.standard?.url ||
                                thumbnails.high?.url ||
                                thumbnails.medium?.url;

            return {
                videoId,
                title: snippet.title,
                description: snippet.description,
                channelName: snippet.channelTitle,
                thumbnailUrl,
                publishedAt: snippet.publishedAt,
                tags: snippet.tags || []
            };
        }

        // Option 2: Fallback - construct thumbnail URL directly
        // YouTube thumbnails follow predictable URL patterns
        return {
            videoId,
            title: null,  // Can't get without API
            description: null,
            channelName: null,
            thumbnailUrl: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            fallbackMode: true
        };

    } catch (error) {
        console.error('YouTube fetch error:', error);
        throw new functions.https.HttpsError('internal', 'Failed to fetch video data');
    }
});
```

#### 2.3 Enhanced Prompt for Upgrade Mode
**Location**: Add to prompt generation section (~line 5150)

```javascript
// Upgrade mode prompt enhancement
function buildUpgradePrompt(basePrompt, youtubeContext, analysisResult) {
    let upgradeInstructions = `
THUMBNAIL UPGRADE REQUEST - CRITICAL INSTRUCTIONS:

You are upgrading an EXISTING YouTube thumbnail. The goal is to create a SIGNIFICANTLY IMPROVED version while maintaining the core concept.

UPGRADE OBJECTIVES:
1. PROFESSIONAL QUALITY: Transform to broadcast/magazine quality
2. VISUAL IMPACT: Maximize click-through appeal
3. CLARITY: Ensure subject is crystal clear at small sizes
4. COLOR VIBRANCY: Enhance colors for better YouTube feed presence
5. COMPOSITION: Apply golden ratio / rule of thirds

ANALYZE THE ORIGINAL AND IMPROVE:
- If face visible: Sharpen features, improve lighting, add rim light
- If text visible: Make it cleaner, more readable, better contrast
- If product: Hero lighting, better angles, professional showcase
- Background: More dynamic, gradient or depth blur

MAINTAIN CONSISTENCY:
- Keep the same core subject/concept
- Preserve brand colors if present
- Keep the same general layout/composition style
`;

    if (youtubeContext) {
        upgradeInstructions += `
VIDEO CONTEXT (use this for better relevance):
- Title: "${youtubeContext.title}"
- Channel: "${youtubeContext.channelName}"
- Description preview: "${(youtubeContext.description || '').substring(0, 200)}"

Generate a thumbnail that perfectly matches this video's topic and tone.
`;
    }

    if (analysisResult) {
        upgradeInstructions += `
ORIGINAL THUMBNAIL ANALYSIS:
- Primary subject: ${analysisResult.primarySubject}
- Has face: ${analysisResult.hasFace}
- Dominant colors: ${analysisResult.dominantColors?.join(', ')}
- Current mood: ${analysisResult.mood}
- Lighting: ${analysisResult.lightingStyle}

UPGRADE RECOMMENDATIONS based on analysis:
- ${getUpgradeRecommendations(analysisResult)}
`;
    }

    return upgradeInstructions + '\n\n' + basePrompt;
}

function getUpgradeRecommendations(analysis) {
    const recommendations = [];

    if (analysis.hasFace) {
        recommendations.push('Enhance face with professional portrait lighting');
        recommendations.push('Add subtle catch lights in eyes');
    }

    if (analysis.lightingStyle === 'natural') {
        recommendations.push('Upgrade to dramatic studio lighting for more impact');
    }

    if (!analysis.dominantColors || analysis.dominantColors.length < 2) {
        recommendations.push('Add vibrant accent colors for better YouTube feed visibility');
    }

    if (analysis.mood === 'calm') {
        recommendations.push('Consider adding more energy/dynamism for better CTR');
    }

    return recommendations.join('\n- ');
}
```

#### 2.4 Handle Upgrade Mode in Generation
**Location**: Inside generateThumbnailPro function (~line 5400)

```javascript
// Handle upgrade mode
if (mode === 'upgrade') {
    // Fetch thumbnail from URL if not provided as base64
    if (originalThumbnailUrl && !referenceImage?.base64) {
        const thumbnailResponse = await axios.get(originalThumbnailUrl, {
            responseType: 'arraybuffer'
        });
        referenceImage = {
            base64: Buffer.from(thumbnailResponse.data).toString('base64'),
            mimeType: 'image/jpeg'
        };
    }

    // Run analysis on original thumbnail
    const analysisResult = await analyzeReferenceImage(referenceImage, aiClient);

    // Build enhanced upgrade prompt
    const upgradePrompt = buildUpgradePrompt(
        imagePrompt,
        youtubeContext,
        analysisResult
    );

    // Force reference type to 'upgrade' for special handling
    effectiveReferenceType = 'upgrade';

    // Use Gemini for generation (same as reference mode)
    // ... continue with existing Gemini generation logic
}
```

---

### Phase 3: CSS Styling

#### 3.1 Upgrade Tab Styles
```css
.upgrade-tabs {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
}

.upgrade-tab {
    flex: 1;
    padding: 0.75rem 1rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.5rem;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    transition: all 0.2s ease;
}

.upgrade-tab.active {
    background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(16, 185, 129, 0.1));
    border-color: rgba(34, 197, 94, 0.5);
    color: #22c55e;
}

.youtube-url-input {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
}

.youtube-url-input input {
    flex: 1;
    padding: 0.75rem 1rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.5rem;
    color: white;
}

.youtube-url-input button {
    padding: 0.75rem 1.5rem;
    background: linear-gradient(135deg, #ef4444, #dc2626);
    border: none;
    border-radius: 0.5rem;
    color: white;
    font-weight: 600;
    cursor: pointer;
}

.youtube-preview {
    display: flex;
    gap: 1rem;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 0.75rem;
    margin-top: 1rem;
}

.youtube-preview img {
    width: 200px;
    border-radius: 0.5rem;
}

.youtube-info h4 {
    font-weight: 600;
    margin-bottom: 0.25rem;
    color: white;
}

.youtube-info p {
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.875rem;
}
```

---

## Implementation Order

### Step 1: Backend - YouTube Data Fetch (30 min)
- [ ] Create `fetchYoutubeVideoData` Cloud Function
- [ ] Handle YouTube API integration or fallback
- [ ] Deploy and test

### Step 2: Frontend - Mode Replacement (20 min)
- [ ] Replace Premium Mode with Upgrade Mode in config
- [ ] Add state variables
- [ ] Update cost calculation

### Step 3: Frontend - Upload UI (20 min)
- [ ] Duplicate Reference Mode upload UI for Upgrade mode
- [ ] Add tab selector (Upload vs YouTube)
- [ ] Style the new components

### Step 4: Frontend - YouTube URL Feature (30 min)
- [ ] Add YouTube URL input field
- [ ] Implement `extractYoutubeVideoId()` helper
- [ ] Implement `fetchYoutubeThumbnailData()` function
- [ ] Add preview display for fetched video data

### Step 5: Backend - Upgrade Mode Logic (40 min)
- [ ] Add 'upgrade' to modeConfig
- [ ] Implement `buildUpgradePrompt()` function
- [ ] Handle YouTube context in generation
- [ ] Test upgrade quality

### Step 6: Testing & Polish (20 min)
- [ ] Test upload flow
- [ ] Test YouTube URL flow
- [ ] Test generation quality
- [ ] Verify token deduction

---

## File Changes Summary

| File | Changes |
|------|---------|
| `frontend/main-dashboard.html` | Replace Premium Mode, add YouTube URL input, update cost calc |
| `functions/index.js` | Add fetchYoutubeVideoData function, update modeConfig, add upgrade prompts |

## Token Impact
- **Before**: Premium Mode = 6 tokens
- **After**: Thumbnail Upgrade = 4 tokens (2 tokens cheaper, same model quality)

## User Benefit
1. **Clearer purpose**: "Upgrade" makes it obvious what the tool does
2. **YouTube integration**: Paste URL instead of downloading/uploading thumbnail
3. **Context-aware**: System uses video title/description for better results
4. **Lower cost**: 4 tokens instead of 6 for similar quality
