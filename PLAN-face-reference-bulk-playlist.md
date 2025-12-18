# Plan: Face Reference Feature for Bulk & Playlist Modes

## Problem Statement
When using Bulk or Playlist mode to upgrade thumbnails, the AI generates completely different faces/characters instead of preserving the person's identity from the original thumbnails. This is a critical issue for:
- YouTubers who appear in their own thumbnails
- Channels with a consistent character/mascot
- Brand consistency across video series

## Current Architecture Analysis

### How Face Preservation Works (Single URL Mode)
1. User uploads a reference image with `referenceType: 'face'`
2. Backend sends the image to Gemini with specific face preservation prompts
3. The AI uses the face as a character reference

### Gap in Bulk/Playlist Mode
- Currently sends `originalThumbnailUrl` for each video
- Uses `referenceType: 'upgrade'` which transforms everything including faces
- No mechanism to provide a consistent face reference across all generations

## Proposed Solution: "Lock Face Reference"

### User Experience Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Bulk Mode / Playlist Mode                                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 🔒 Face Lock (Keep Same Person)              [Toggle]   │   │
│  │                                                         │   │
│  │ When enabled, all thumbnails will use the same face    │   │
│  │ from your reference image.                              │   │
│  │                                                         │   │
│  │ ┌─────────────┐  ┌─────────────────────────────────┐   │   │
│  │ │             │  │ Choose Reference:                │   │   │
│  │ │   [Face]    │  │ ○ From first video thumbnail    │   │   │
│  │ │  Preview    │  │ ○ Upload custom face image      │   │   │
│  │ │             │  │ ○ Select from batch (click one) │   │   │
│  │ └─────────────┘  └─────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  [Video 1] [Video 2] [Video 3] ...                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation Plan

## Phase 1: State & UI Updates (Frontend)

### 1.1 New State Variables
```javascript
// Add to state object
bulkFaceReferenceEnabled: false,      // Toggle for face lock feature
bulkFaceReferenceSource: 'first',     // 'first' | 'upload' | 'select'
bulkFaceReferenceImage: null,         // { dataUrl, base64, mimeType }
bulkFaceReferenceVideoIndex: 0,       // Which video to use as face source
playlistFaceReferenceEnabled: false,
playlistFaceReferenceSource: 'first',
playlistFaceReferenceImage: null,
playlistFaceReferenceVideoIndex: 0,
```

### 1.2 UI Component: Face Lock Settings
Add to Bulk Mode settings section (after style/category):

```html
<!-- Face Lock Section -->
<div class="mt-4 p-4 bg-amber-50 border border-amber-200 rounded-lg">
  <div class="flex items-center justify-between mb-3">
    <div class="flex items-center gap-2">
      <span class="text-lg">🔒</span>
      <span class="font-semibold text-amber-800">Face Lock</span>
      <span class="text-xs bg-amber-200 text-amber-800 px-2 py-0.5 rounded">Keep Same Person</span>
    </div>
    <button onclick="app.toggleBulkFaceReference()" class="toggle-btn">
      [ON/OFF Toggle]
    </button>
  </div>

  <!-- When enabled, show options -->
  <div class="face-reference-options">
    <p class="text-sm text-amber-700 mb-3">
      All generated thumbnails will feature the same person from your reference.
    </p>

    <!-- Source Selection -->
    <div class="grid grid-cols-3 gap-2 mb-3">
      <button onclick="app.setBulkFaceSource('first')" class="source-btn">
        📹 First Video
      </button>
      <button onclick="app.setBulkFaceSource('upload')" class="source-btn">
        📤 Upload Face
      </button>
      <button onclick="app.setBulkFaceSource('select')" class="source-btn">
        👆 Select from List
      </button>
    </div>

    <!-- Preview -->
    <div class="face-preview">
      <img src="[face reference thumbnail]" class="w-20 h-20 rounded-full object-cover border-2 border-amber-400" />
      <span class="text-xs text-amber-600">Face will be preserved across all thumbnails</span>
    </div>
  </div>
</div>
```

### 1.3 New Functions

```javascript
// Toggle face reference on/off
toggleBulkFaceReference: function() {
  state.bulkFaceReferenceEnabled = !state.bulkFaceReferenceEnabled;

  // If enabling and no face set yet, use first video
  if (state.bulkFaceReferenceEnabled && !state.bulkFaceReferenceImage) {
    app.setBulkFaceFromVideo(0);
  }
  render();
},

// Set face reference source type
setBulkFaceSource: function(source) {
  state.bulkFaceReferenceSource = source;

  if (source === 'first') {
    app.setBulkFaceFromVideo(0);
  } else if (source === 'upload') {
    // Trigger file upload
    app.uploadBulkFaceReference();
  }
  // 'select' mode - user clicks on a video thumbnail
  render();
},

// Extract face from a video in the batch
setBulkFaceFromVideo: async function(videoIndex) {
  var item = state.bulkUrls[videoIndex];
  if (!item || !item.youtubeData?.thumbnailUrl) return;

  state.bulkFaceReferenceVideoIndex = videoIndex;

  // Fetch the thumbnail and convert to base64
  try {
    var response = await fetch(item.youtubeData.thumbnailUrl);
    var blob = await response.blob();
    var reader = new FileReader();
    reader.onload = function() {
      state.bulkFaceReferenceImage = {
        dataUrl: reader.result,
        base64: reader.result.split(',')[1],
        mimeType: blob.type || 'image/jpeg'
      };
      render();
    };
    reader.readAsDataURL(blob);
  } catch (error) {
    console.error('Failed to load face reference:', error);
  }
},

// Upload custom face reference
uploadBulkFaceReference: function() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = function(e) {
    var file = e.target.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function() {
      state.bulkFaceReferenceImage = {
        dataUrl: reader.result,
        base64: reader.result.split(',')[1],
        mimeType: file.type
      };
      render();
    };
    reader.readAsDataURL(file);
  };
  input.click();
}
```

## Phase 2: Backend Changes

### 2.1 Update generateThumbnailPro Parameters
Add new parameter:
```javascript
faceReferenceImage = null  // { base64, mimeType } - separate from originalThumbnailUrl
```

### 2.2 New Mode: "upgrade-with-face"
When both `originalThumbnailUrl` AND `faceReferenceImage` are provided:

```javascript
// In generateThumbnailPro function
if (mode === 'upgrade' && faceReferenceImage?.base64) {
  // This is upgrade-with-face mode
  // Send TWO images to Gemini:
  // 1. Face reference image (for identity preservation)
  // 2. Original thumbnail (for content/composition reference)

  const contentParts = [];

  // Add face reference FIRST (primary reference)
  contentParts.push({
    inlineData: {
      mimeType: faceReferenceImage.mimeType || 'image/jpeg',
      data: faceReferenceImage.base64
    }
  });

  // Add original thumbnail SECOND (for content context)
  contentParts.push({
    inlineData: {
      mimeType: effectiveReferenceImage.mimeType || 'image/jpeg',
      data: effectiveReferenceImage.base64
    }
  });

  // Special prompt for upgrade-with-face
  finalPrompt = `[SPECIAL PROMPT - see below]`;

  contentParts.push({ text: finalPrompt });
}
```

### 2.3 Special Prompt for Upgrade-with-Face

```javascript
const upgradeWithFacePrompt = `You are creating a PROFESSIONAL YouTube thumbnail with STRICT FACE PRESERVATION.

═══════════════════════════════════════════════════════════════
⚠️ TWO IMAGES PROVIDED - READ CAREFULLY ⚠️
═══════════════════════════════════════════════════════════════
IMAGE 1 (FACE REFERENCE): This is the FACE you MUST preserve exactly.
- Same person, same facial features, same identity
- Bone structure, eyes, nose, mouth, skin tone - ALL must match
- Hair style/color should match unless context requires change

IMAGE 2 (CONTENT REFERENCE): This is the CONTENT/STYLE to upgrade.
- Use this for the scene, composition, theme
- Upgrade the quality dramatically
- But put the FACE from Image 1 into this context
═══════════════════════════════════════════════════════════════
${youtubeCtx}

REQUIREMENTS:
1. FACE IDENTITY: The person in the output MUST be recognizably the SAME person as Image 1
   - This is NON-NEGOTIABLE
   - If the face looks like a different person, you have FAILED

2. CONTENT UPGRADE: Take the concept from Image 2 and make it STUNNING
   - Professional lighting, cinematic quality
   - 4K clarity, vibrant colors
   - But with Image 1's face

3. COMPOSITION:
   - Position face on right side (golden ratio)
   - Leave space on left for text

MANDATORY TEXT CAPTION:
Add bold text "${shortCaption}" in thick sans-serif font with high contrast.

OUTPUT: 16:9 YouTube thumbnail, broadcast quality, with EXACT face from Image 1.`;
```

## Phase 3: Processing Flow Updates

### 3.1 Bulk Processing with Face Lock

```javascript
processBulkUpgrade: async function() {
  // ... existing setup ...

  // If face lock is enabled, prepare the face reference
  var faceReference = null;
  if (state.bulkFaceReferenceEnabled && state.bulkFaceReferenceImage) {
    faceReference = {
      base64: state.bulkFaceReferenceImage.base64,
      mimeType: state.bulkFaceReferenceImage.mimeType
    };
  }

  for (var i = 0; i < readyItems.length; i++) {
    var item = readyItems[i];

    var payload = {
      prompt: item.youtubeData.title,
      mode: 'upgrade',
      referenceType: 'upgrade',
      originalThumbnailUrl: item.youtubeData.thumbnailUrl,
      // NEW: Add face reference if enabled
      faceReferenceImage: faceReference,
      // ... other params
    };

    // Generate...
  }
}
```

### 3.2 Playlist Processing with Face Lock
Same approach - pass `faceReferenceImage` in each payload.

## Phase 4: Visual Feedback

### 4.1 Face Lock Indicator on Items
When face lock is enabled, show an indicator on each item:
```html
<div class="absolute top-1 right-1 bg-amber-500 text-white text-xs px-1.5 py-0.5 rounded flex items-center gap-1">
  🔒 Face Locked
</div>
```

### 4.2 Preview Before Generation
Show a small preview of the face reference that will be used:
```html
<div class="flex items-center gap-2 p-2 bg-amber-50 rounded-lg mb-3">
  <img src="[face-preview]" class="w-10 h-10 rounded-full object-cover" />
  <div>
    <p class="text-sm font-medium text-amber-800">Face Lock Active</p>
    <p class="text-xs text-amber-600">All thumbnails will feature this person</p>
  </div>
</div>
```

## Implementation Order

1. **Frontend State & UI** (main-dashboard.html)
   - Add state variables
   - Add Face Lock toggle UI in settings
   - Add source selection (first/upload/select)
   - Add face preview component
   - Add indicator functions

2. **Frontend Processing** (main-dashboard.html)
   - Update `processBulkUpgrade()` to include face reference
   - Update `processPlaylistUpgrade()` to include face reference
   - Update regenerate functions to preserve face reference

3. **Backend Support** (functions/index.js)
   - Add `faceReferenceImage` parameter handling
   - Create dual-image processing logic
   - Create upgrade-with-face prompt
   - Handle both images in content parts

4. **Testing & Polish**
   - Test with various face types
   - Ensure face consistency across batch
   - Add error handling for face extraction failures

## Success Criteria

- [ ] User can enable "Face Lock" in bulk/playlist settings
- [ ] User can choose face source (first video, upload, or select)
- [ ] Face preview shows selected reference
- [ ] All generated thumbnails show the SAME person
- [ ] Face identity is preserved even with dramatic style upgrades
- [ ] Works with both human faces and illustrated characters

## Estimated Complexity
- Frontend: ~200 lines of code
- Backend: ~50 lines of code
- Total: Medium complexity, high impact feature
