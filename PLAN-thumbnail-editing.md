# AI-Powered Thumbnail Editing Feature - Implementation Plan

## Executive Summary

Add an "Edit with AI" feature that allows users to make targeted modifications to generated thumbnails using inpainting technology. Users can paint/select areas to modify and provide text prompts for changes (e.g., "change 'dreams' to 'dream'" or "remove the person on the left").

---

## Current Architecture Analysis

### Frontend (main-dashboard.html)
| Component | Location | Purpose |
|-----------|----------|---------|
| `renderThumbnail()` | Line 9818 | Main thumbnail generator UI |
| Single thumbnail results | Lines 9939-9992 | Display selected thumbnail + variations grid |
| Playlist results grid | Lines 10612-10705 | Display batch-generated thumbnails |
| State object | Line 3356+ | Manages `generatedThumbnails[]`, `playlistResults[]` |

### Backend (functions/index.js)
| Function | Location | Purpose |
|----------|----------|---------|
| `generateThumbnailPro()` | Line 5630 | Main thumbnail generation |
| `upscaleThumbnail()` | Line 6839 | HD upscaling with fal.ai AuraSR |
| `generateCreativeImage()` | Line 10561 | Creative studio image generation |

### Available APIs
| API | Package | Current Use |
|-----|---------|-------------|
| Google Gemini | `@google/genai` v1.30.0 | Image generation with references |
| fal.ai | `@fal-ai/client` v1.2.0 | HD upscaling (AuraSR) |

### Token System
- Stored in Firestore: `creativeTokens` collection
- Current costs: Quick=2, Reference/Upgrade=4 tokens per image
- Upscale: 1 token per image

---

## Technical Implementation Plan

### Phase 1: Backend - Edit Thumbnail API (Priority: HIGH)

#### 1.1 Create `editThumbnailWithAI` Cloud Function

**File**: `functions/index.js`
**Location**: After `upscaleThumbnail` function (~line 6950)

```javascript
/**
 * editThumbnailWithAI - Edit a thumbnail using AI inpainting
 *
 * @param {string} imageUrl - URL of the original thumbnail
 * @param {string} maskBase64 - Base64 PNG of the mask (white = edit area)
 * @param {string} editPrompt - What to change in the masked area
 * @returns {object} { success, editedUrl, originalUrl }
 */
exports.editThumbnailWithAI = functions
  .runWith({ timeoutSeconds: 120, memory: '1GB' })
  .https.onCall(async (data, context) => {
    // Implementation details in Phase 1
  });
```

**Parameters**:
- `imageUrl`: URL of the original thumbnail to edit
- `maskBase64`: Base64-encoded PNG where white pixels indicate areas to modify
- `editPrompt`: Text description of what to change
- `editStrength`: 0.5-1.0 (how much to modify the masked area)

**Token Cost**: 2 tokens per edit (configurable)

#### 1.2 Inpainting Implementation Strategy

**Primary Method: Google Gemini Image Editing**
- Gemini 2.0+ models support native image editing
- Pass original image + mask + prompt
- Use `gemini-3-pro-image-preview` model (same as thumbnail generation)

**Fallback Method: fal.ai Inpainting**
- Model: `fal-ai/flux/inpaint` or `fal-ai/inpaint`
- Already have fal.ai client configured
- High-quality inpainting results

```javascript
// Gemini approach (preferred)
const result = await ai.models.generateContent({
  model: 'gemini-3-pro-image-preview',
  contents: [{
    role: 'user',
    parts: [
      { inlineData: { mimeType: 'image/png', data: imageBase64 } },
      { inlineData: { mimeType: 'image/png', data: maskBase64 } },
      { text: `Edit the masked area of this image: ${editPrompt}. Keep the unmasked areas exactly the same.` }
    ]
  }],
  config: { responseModalities: ['image', 'text'] }
});

// fal.ai fallback
const result = await fal.subscribe('fal-ai/flux/inpaint', {
  input: {
    image_url: imageUrl,
    mask_url: maskUrl, // Need to upload mask first
    prompt: editPrompt,
    strength: 0.85
  }
});
```

---

### Phase 2: Frontend - Edit Button Overlay (Priority: HIGH)

#### 2.1 Add State Variables

**File**: `frontend/main-dashboard.html`
**Location**: State object (~line 3380)

```javascript
// Thumbnail Editing State
thumbnailEditMode: false,           // Is editing modal open
thumbnailEditingImage: null,        // { url, index, mode } - image being edited
thumbnailEditMask: null,            // Canvas mask data URL
thumbnailEditPrompt: '',            // Edit prompt text
thumbnailEditLoading: false,        // Processing state
thumbnailEditError: null,           // Error message
thumbnailEditResult: null,          // { originalUrl, editedUrl } - result for comparison
thumbnailEditBrushSize: 30,         // Brush size in pixels
thumbnailEditHistory: [],           // For undo functionality
```

#### 2.2 Add Edit Button to Single Thumbnail Results

**Location**: Lines 9975-9991 (action buttons section)

```javascript
// Add after Download button, before Upscale HD
html += '<button onclick="app.openThumbnailEditor(\'' + utils.escapeHtml(selectedImg.url) + '\', ' + state.selectedThumbnailIndex + ', \'single\')" class="btn-secondary inline-flex items-center justify-center gap-2">';
html += '<span>✨</span> Edit with AI';
html += '</button>';
```

#### 2.3 Add Edit Button to Playlist Results Grid

**Location**: Lines 10635-10646 (hover overlay on playlist thumbnails)

```javascript
// Add after Preview button in the hover overlay
html += '<button onclick="event.stopPropagation(); app.openThumbnailEditor(\'' + item.thumbnailUrl + '\', ' + idx + ', \'playlist\')" class="bg-purple-500 text-white px-2 py-1 rounded text-xs font-medium hover:bg-purple-600">✨ Edit</button>';
```

---

### Phase 3: Frontend - Editing Modal (Priority: HIGH)

#### 3.1 Modal Structure

**Location**: Add after renderThumbnail() function or in modal section

```javascript
function renderThumbnailEditModal() {
  if (!state.thumbnailEditMode) return '';

  var html = '<div class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">';
  html += '<div class="bg-white rounded-2xl shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col">';

  // Header
  html += '<div class="p-4 border-b flex items-center justify-between">';
  html += '<h3 class="text-xl font-bold text-gray-800">✨ Edit Thumbnail with AI</h3>';
  html += '<button onclick="app.closeThumbnailEditor()" class="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>';
  html += '</div>';

  // Main content area
  html += '<div class="flex-1 overflow-y-auto p-6">';

  // Canvas area with image and mask overlay
  html += '<div class="relative mb-6">';
  html += '<canvas id="thumbnail-edit-canvas" class="w-full max-w-3xl mx-auto rounded-xl shadow-lg cursor-crosshair"></canvas>';
  html += '</div>';

  // Brush controls
  html += '<div class="flex items-center justify-center gap-4 mb-4">';
  html += '<label class="text-sm text-gray-600">Brush Size:</label>';
  html += '<input type="range" min="10" max="100" value="' + state.thumbnailEditBrushSize + '" onchange="app.setEditBrushSize(this.value)" class="w-32" />';
  html += '<span class="text-sm text-gray-500">' + state.thumbnailEditBrushSize + 'px</span>';
  html += '<button onclick="app.clearEditMask()" class="btn-secondary text-sm">Clear Mask</button>';
  html += '<button onclick="app.undoEditMask()" class="btn-secondary text-sm">↩️ Undo</button>';
  html += '</div>';

  // Edit prompt input
  html += '<div class="mb-6">';
  html += '<label class="block text-gray-700 font-semibold mb-2">What should AI change?</label>';
  html += '<input type="text" placeholder="e.g., Change \'dreams\' to \'dream\', remove the arrow, make text bigger..." value="' + utils.escapeHtml(state.thumbnailEditPrompt) + '" onchange="app.setEditPrompt(this.value)" class="w-full p-3 border border-gray-200 rounded-xl focus:border-pink-500 focus:ring-2 focus:ring-pink-200" />';
  html += '<p class="text-xs text-gray-400 mt-1">Paint over the area you want to change, then describe what you want</p>';
  html += '</div>';

  // Error display
  if (state.thumbnailEditError) {
    html += '<div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">' + utils.escapeHtml(state.thumbnailEditError) + '</div>';
  }

  // Result comparison (if available)
  if (state.thumbnailEditResult) {
    html += renderEditComparison();
  }

  html += '</div>';

  // Footer with action buttons
  html += '<div class="p-4 border-t flex items-center justify-between bg-gray-50">';
  html += '<div class="text-sm text-gray-500">Cost: <span class="font-semibold text-pink-600">2 tokens</span></div>';
  html += '<div class="flex gap-3">';
  html += '<button onclick="app.closeThumbnailEditor()" class="btn-secondary">Cancel</button>';

  if (state.thumbnailEditResult) {
    html += '<button onclick="app.revertEdit()" class="btn-secondary">↩️ Revert</button>';
    html += '<button onclick="app.acceptEdit()" class="btn-primary bg-gradient-to-r from-green-500 to-emerald-600">✓ Accept Edit</button>';
  } else {
    html += '<button onclick="app.applyThumbnailEdit()" ' + (state.thumbnailEditLoading ? 'disabled' : '') + ' class="btn-primary bg-gradient-to-r from-purple-500 to-pink-600 ' + (state.thumbnailEditLoading ? 'opacity-50 cursor-not-allowed' : '') + '">';
    html += state.thumbnailEditLoading ? '⏳ Processing...' : '✨ Apply Edit';
    html += '</button>';
  }

  html += '</div></div>';
  html += '</div></div>';

  return html;
}
```

#### 3.2 Canvas-Based Brush Tool

**Location**: Add to app object methods

```javascript
// Initialize canvas when modal opens
initThumbnailEditCanvas: function() {
  var canvas = document.getElementById('thumbnail-edit-canvas');
  if (!canvas) return;

  var ctx = canvas.getContext('2d');
  var img = new Image();
  img.crossOrigin = 'anonymous';

  img.onload = function() {
    // Set canvas size to match image aspect ratio
    var maxWidth = 800;
    var scale = Math.min(1, maxWidth / img.width);
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;

    // Draw image
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Store original image data for reference
    state.thumbnailEditOriginalData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Create mask canvas (overlay)
    var maskCanvas = document.createElement('canvas');
    maskCanvas.width = canvas.width;
    maskCanvas.height = canvas.height;
    state.thumbnailEditMaskCanvas = maskCanvas;
    state.thumbnailEditMaskCtx = maskCanvas.getContext('2d');
    state.thumbnailEditMaskCtx.fillStyle = 'rgba(0, 0, 0, 0)';
    state.thumbnailEditMaskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
  };

  img.src = state.thumbnailEditingImage.url;

  // Add mouse/touch event listeners for painting
  var isDrawing = false;
  var lastX, lastY;

  canvas.addEventListener('mousedown', function(e) {
    isDrawing = true;
    var rect = canvas.getBoundingClientRect();
    lastX = (e.clientX - rect.left) * (canvas.width / rect.width);
    lastY = (e.clientY - rect.top) * (canvas.height / rect.height);
    app.paintMask(lastX, lastY);
  });

  canvas.addEventListener('mousemove', function(e) {
    if (!isDrawing) return;
    var rect = canvas.getBoundingClientRect();
    var x = (e.clientX - rect.left) * (canvas.width / rect.width);
    var y = (e.clientY - rect.top) * (canvas.height / rect.height);
    app.paintMaskLine(lastX, lastY, x, y);
    lastX = x;
    lastY = y;
  });

  canvas.addEventListener('mouseup', function() { isDrawing = false; });
  canvas.addEventListener('mouseleave', function() { isDrawing = false; });

  // Touch support
  canvas.addEventListener('touchstart', function(e) {
    e.preventDefault();
    isDrawing = true;
    var rect = canvas.getBoundingClientRect();
    var touch = e.touches[0];
    lastX = (touch.clientX - rect.left) * (canvas.width / rect.width);
    lastY = (touch.clientY - rect.top) * (canvas.height / rect.height);
    app.paintMask(lastX, lastY);
  });

  canvas.addEventListener('touchmove', function(e) {
    e.preventDefault();
    if (!isDrawing) return;
    var rect = canvas.getBoundingClientRect();
    var touch = e.touches[0];
    var x = (touch.clientX - rect.left) * (canvas.width / rect.width);
    var y = (touch.clientY - rect.top) * (canvas.height / rect.height);
    app.paintMaskLine(lastX, lastY, x, y);
    lastX = x;
    lastY = y;
  });

  canvas.addEventListener('touchend', function() { isDrawing = false; });
},

paintMask: function(x, y) {
  var maskCtx = state.thumbnailEditMaskCtx;
  var mainCtx = document.getElementById('thumbnail-edit-canvas').getContext('2d');

  // Paint on mask canvas (white for inpainting)
  maskCtx.fillStyle = 'white';
  maskCtx.beginPath();
  maskCtx.arc(x, y, state.thumbnailEditBrushSize / 2, 0, Math.PI * 2);
  maskCtx.fill();

  // Show overlay on main canvas (semi-transparent red to show selection)
  mainCtx.putImageData(state.thumbnailEditOriginalData, 0, 0);
  mainCtx.globalAlpha = 0.5;
  mainCtx.fillStyle = 'rgba(236, 72, 153, 0.5)'; // Pink overlay
  mainCtx.drawImage(state.thumbnailEditMaskCanvas, 0, 0);
  mainCtx.globalAlpha = 1.0;
},

paintMaskLine: function(x1, y1, x2, y2) {
  var maskCtx = state.thumbnailEditMaskCtx;
  var mainCtx = document.getElementById('thumbnail-edit-canvas').getContext('2d');

  // Draw line on mask
  maskCtx.strokeStyle = 'white';
  maskCtx.lineWidth = state.thumbnailEditBrushSize;
  maskCtx.lineCap = 'round';
  maskCtx.beginPath();
  maskCtx.moveTo(x1, y1);
  maskCtx.lineTo(x2, y2);
  maskCtx.stroke();

  // Update overlay
  mainCtx.putImageData(state.thumbnailEditOriginalData, 0, 0);
  mainCtx.globalAlpha = 0.5;
  mainCtx.drawImage(state.thumbnailEditMaskCanvas, 0, 0);
  mainCtx.globalAlpha = 1.0;
},

getMaskAsBase64: function() {
  // Convert mask canvas to base64 PNG
  // Need to create proper black/white mask for API
  var maskCanvas = state.thumbnailEditMaskCanvas;
  var exportCanvas = document.createElement('canvas');
  exportCanvas.width = 1280; // Standard thumbnail width
  exportCanvas.height = 720; // Standard thumbnail height
  var ctx = exportCanvas.getContext('2d');

  // Fill black background
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

  // Draw white mask areas (scaled up)
  ctx.drawImage(maskCanvas, 0, 0, exportCanvas.width, exportCanvas.height);

  return exportCanvas.toDataURL('image/png').split(',')[1]; // Return base64 without prefix
}
```

#### 3.3 Apply Edit Function

```javascript
applyThumbnailEdit: async function() {
  if (!state.thumbnailEditingImage || !state.thumbnailEditPrompt.trim()) {
    state.thumbnailEditError = 'Please paint an area and enter an edit prompt';
    render();
    return;
  }

  // Check if mask has any content
  var maskBase64 = app.getMaskAsBase64();
  if (!maskBase64) {
    state.thumbnailEditError = 'Please paint the area you want to edit';
    render();
    return;
  }

  state.thumbnailEditLoading = true;
  state.thumbnailEditError = null;
  render();

  try {
    var editThumbnail = firebase.functions().httpsCallable('editThumbnailWithAI');
    var result = await editThumbnail({
      imageUrl: state.thumbnailEditingImage.url,
      maskBase64: maskBase64,
      editPrompt: state.thumbnailEditPrompt.trim()
    });

    if (result.data.success) {
      state.thumbnailEditResult = {
        originalUrl: state.thumbnailEditingImage.url,
        editedUrl: result.data.editedUrl
      };

      // Update token balance
      if (result.data.remainingBalance !== undefined) {
        state.thumbnailTokenBalance = result.data.remainingBalance;
      }

      showToast('Edit applied! Review the result.', 'success');
    } else {
      throw new Error(result.data.error || 'Edit failed');
    }
  } catch (error) {
    console.error('Thumbnail edit error:', error);
    state.thumbnailEditError = error.message || 'Failed to edit thumbnail. Please try again.';
  }

  state.thumbnailEditLoading = false;
  render();
},

acceptEdit: function() {
  if (!state.thumbnailEditResult) return;

  // Update the thumbnail in the appropriate array
  var editedUrl = state.thumbnailEditResult.editedUrl;
  var editingInfo = state.thumbnailEditingImage;

  if (editingInfo.mode === 'single') {
    state.generatedThumbnails[editingInfo.index].url = editedUrl;
    // Clear HD URL since the image changed
    state.generatedThumbnails[editingInfo.index].hdUrl = null;
  } else if (editingInfo.mode === 'playlist') {
    state.playlistResults[editingInfo.index].thumbnailUrl = editedUrl;
    state.playlistResults[editingInfo.index].hdUrl = null;
  } else if (editingInfo.mode === 'bulk') {
    // Handle bulk mode if applicable
    if (state.bulkUrls && state.bulkUrls[editingInfo.index]) {
      state.bulkUrls[editingInfo.index].generatedThumbnailUrl = editedUrl;
      state.bulkUrls[editingInfo.index].hdUrl = null;
    }
  }

  app.closeThumbnailEditor();
  showToast('Thumbnail updated successfully!', 'success');
},

revertEdit: function() {
  state.thumbnailEditResult = null;
  render();
}
```

---

### Phase 4: Backend Implementation Details

#### 4.1 Complete editThumbnailWithAI Function

```javascript
// =============================================
// THUMBNAIL EDITING - AI Inpainting/Generative Fill
// Uses Gemini or fal.ai for targeted modifications
// =============================================

exports.editThumbnailWithAI = functions
  .runWith({ timeoutSeconds: 120, memory: '1GB' })
  .https.onCall(async (data, context) => {
    const uid = await verifyAuth(context);
    checkRateLimit(uid, 'editThumbnail', 10); // 10 per minute

    const { imageUrl, maskBase64, editPrompt, editStrength = 0.85 } = data;
    const TOKEN_COST = 2; // Edit cost

    // Validation
    if (!imageUrl) {
      throw new functions.https.HttpsError('invalid-argument', 'Image URL is required');
    }
    if (!maskBase64) {
      throw new functions.https.HttpsError('invalid-argument', 'Mask is required');
    }
    if (!editPrompt || editPrompt.trim().length < 3) {
      throw new functions.https.HttpsError('invalid-argument', 'Edit prompt is required (min 3 characters)');
    }

    // Check token balance
    const tokenDoc = await db.collection('creativeTokens').doc(uid).get();
    if (!tokenDoc.exists) {
      throw new functions.https.HttpsError('failed-precondition', 'Token balance not found');
    }

    const balance = tokenDoc.data().balance || 0;
    if (balance < TOKEN_COST) {
      throw new functions.https.HttpsError('resource-exhausted',
        `Insufficient tokens. Need ${TOKEN_COST}, have ${balance}`);
    }

    try {
      // Fetch original image
      console.log(`Fetching original image for edit: ${imageUrl}`);
      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000
      });
      const imageBase64 = Buffer.from(imageResponse.data).toString('base64');
      const imageMimeType = imageResponse.headers['content-type'] || 'image/png';

      let editedImageUrl;
      let usedModel;

      // Try Gemini first (preferred)
      const geminiApiKey = functions.config().gemini?.key;
      if (geminiApiKey) {
        try {
          const ai = new GoogleGenAI({ apiKey: geminiApiKey });

          // Build edit prompt with clear instructions
          const fullPrompt = `You are editing an image. The user has painted/masked specific areas they want to change.

MASKED AREAS (shown in white in the mask image): These are the ONLY areas you should modify.
UNMASKED AREAS (black in mask): These must remain EXACTLY the same - pixel perfect preservation.

USER'S EDIT REQUEST: "${editPrompt}"

CRITICAL INSTRUCTIONS:
1. ONLY modify the white/masked areas
2. Keep all unmasked areas pixel-perfect identical to the original
3. Make the edit blend seamlessly with the surrounding unchanged areas
4. Match the lighting, style, and quality of the original image
5. Output a complete 16:9 image (1280x720)

Apply the requested edit to the masked area while preserving everything else.`;

          const result = await ai.models.generateContent({
            model: 'gemini-3-pro-image-preview',
            contents: [{
              role: 'user',
              parts: [
                { inlineData: { mimeType: imageMimeType, data: imageBase64 } },
                { inlineData: { mimeType: 'image/png', data: maskBase64 } },
                { text: fullPrompt }
              ]
            }],
            config: {
              responseModalities: ['image', 'text']
            }
          });

          // Extract image from response
          const candidates = result.candidates || (result.response && result.response.candidates);
          if (candidates && candidates.length > 0) {
            const parts = candidates[0].content?.parts || candidates[0].parts || [];
            for (const part of parts) {
              const inlineData = part.inlineData || part.inline_data;
              if (inlineData && (inlineData.data || inlineData.bytesBase64Encoded)) {
                const imageBytes = inlineData.data || inlineData.bytesBase64Encoded;
                const mimeType = inlineData.mimeType || 'image/png';
                const extension = mimeType.includes('jpeg') ? 'jpg' : 'png';

                // Save to Storage
                const storage = admin.storage().bucket();
                const timestamp = Date.now();
                const fileName = `thumbnails-edited/${uid}/${timestamp}-edited.${extension}`;
                const file = storage.file(fileName);

                const buffer = Buffer.from(imageBytes, 'base64');
                await file.save(buffer, {
                  metadata: {
                    contentType: mimeType,
                    metadata: {
                      originalUrl: imageUrl,
                      editPrompt: editPrompt.substring(0, 200),
                      editedAt: new Date().toISOString()
                    }
                  }
                });

                await file.makePublic();
                editedImageUrl = `https://storage.googleapis.com/${storage.name}/${fileName}`;
                usedModel = 'gemini-3-pro';
                break;
              }
            }
          }
        } catch (geminiError) {
          console.error('Gemini edit failed, trying fal.ai fallback:', geminiError.message);
        }
      }

      // Fallback to fal.ai if Gemini didn't work
      if (!editedImageUrl) {
        console.log('Using fal.ai inpainting fallback');

        // Upload mask to temporary storage for fal.ai
        const storage = admin.storage().bucket();
        const maskFileName = `temp-masks/${uid}/${Date.now()}-mask.png`;
        const maskFile = storage.file(maskFileName);
        await maskFile.save(Buffer.from(maskBase64, 'base64'), {
          metadata: { contentType: 'image/png' }
        });
        await maskFile.makePublic();
        const maskUrl = `https://storage.googleapis.com/${storage.name}/${maskFileName}`;

        // Configure fal.ai
        fal.config({
          credentials: process.env.FAL_KEY || functions.config().fal?.key
        });

        // Call fal.ai inpainting
        const falResult = await fal.subscribe('fal-ai/flux/inpaint', {
          input: {
            image_url: imageUrl,
            mask_url: maskUrl,
            prompt: editPrompt,
            strength: editStrength,
            num_inference_steps: 50
          }
        });

        if (falResult.data?.images?.[0]?.url) {
          // Download and save the result
          const editedResponse = await axios.get(falResult.data.images[0].url, {
            responseType: 'arraybuffer'
          });

          const timestamp = Date.now();
          const fileName = `thumbnails-edited/${uid}/${timestamp}-edited.png`;
          const file = storage.file(fileName);

          await file.save(editedResponse.data, {
            metadata: {
              contentType: 'image/png',
              metadata: {
                originalUrl: imageUrl,
                editPrompt: editPrompt.substring(0, 200),
                model: 'fal-flux-inpaint'
              }
            }
          });

          await file.makePublic();
          editedImageUrl = `https://storage.googleapis.com/${storage.name}/${fileName}`;
          usedModel = 'fal-flux-inpaint';
        }

        // Clean up temp mask
        await maskFile.delete().catch(() => {});
      }

      if (!editedImageUrl) {
        throw new Error('Failed to generate edited image');
      }

      // Deduct tokens
      await db.collection('creativeTokens').doc(uid).update({
        balance: admin.firestore.FieldValue.increment(-TOKEN_COST),
        lastUsed: admin.firestore.FieldValue.serverTimestamp()
      });

      const newBalance = balance - TOKEN_COST;

      // Save to history
      await db.collection('thumbnailEditHistory').add({
        userId: uid,
        originalUrl: imageUrl,
        editedUrl: editedImageUrl,
        editPrompt: editPrompt,
        model: usedModel,
        tokenCost: TOKEN_COST,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`Thumbnail edit complete for ${uid}: ${editedImageUrl}`);

      return {
        success: true,
        editedUrl: editedImageUrl,
        originalUrl: imageUrl,
        model: usedModel,
        tokenCost: TOKEN_COST,
        remainingBalance: newBalance
      };

    } catch (error) {
      console.error('Thumbnail edit error:', error);
      throw new functions.https.HttpsError('internal',
        error.message || 'Failed to edit thumbnail');
    }
  });
```

---

## Implementation Order

### Step 1: Backend API (Est. implementation)
- [ ] Add `editThumbnailWithAI` Cloud Function to `functions/index.js`
- [ ] Test Gemini image editing capability
- [ ] Implement fal.ai inpainting fallback
- [ ] Add token deduction logic
- [ ] Deploy and test endpoint

### Step 2: Frontend State & Methods
- [ ] Add thumbnail editing state variables
- [ ] Add `openThumbnailEditor()` method
- [ ] Add `closeThumbnailEditor()` method
- [ ] Add `setEditBrushSize()`, `setEditPrompt()` methods
- [ ] Add canvas initialization and paint methods
- [ ] Add `applyThumbnailEdit()`, `acceptEdit()`, `revertEdit()` methods

### Step 3: Frontend UI - Edit Buttons
- [ ] Add "Edit with AI" button to single thumbnail results (line ~9978)
- [ ] Add "Edit" button to playlist results grid (line ~10645)
- [ ] Add "Edit" button to bulk results (if applicable)

### Step 4: Frontend UI - Edit Modal
- [ ] Create `renderThumbnailEditModal()` function
- [ ] Add modal HTML with canvas, controls, and buttons
- [ ] Add CSS styles for modal and canvas
- [ ] Implement before/after comparison view

### Step 5: Integration & Testing
- [ ] Test single thumbnail editing flow
- [ ] Test playlist thumbnail editing flow
- [ ] Test token deduction
- [ ] Test error handling
- [ ] Test mobile/touch support

---

## File Changes Summary

| File | Changes |
|------|---------|
| `functions/index.js` | Add `editThumbnailWithAI` function (~100 lines) |
| `frontend/main-dashboard.html` | Add state variables, edit methods, modal, buttons (~400 lines) |

## Token Economics

| Action | Cost |
|--------|------|
| Quick Mode Generation | 2 tokens/image |
| Reference/Upgrade Mode | 4 tokens/image |
| **Edit with AI** | **2 tokens/edit** |
| HD Upscale | 1 token/image |

## User Benefits

1. **Save Tokens**: Edit costs 2 tokens vs 4+ tokens for regeneration
2. **Save Time**: Targeted edits are faster than full regeneration
3. **Precision**: Fix specific issues without affecting the rest of the thumbnail
4. **Multiple Rounds**: Can make multiple edits to perfect the thumbnail
5. **Works Everywhere**: Available for single thumbnails, playlists, and batch generation

---

## Technical Considerations

### Canvas Scaling
- Edit canvas displays at responsive size but exports at 1280x720
- Mask scaling handled in `getMaskAsBase64()` function
- Need to account for devicePixelRatio on high-DPI displays

### Mobile Support
- Touch events for painting on mobile devices
- Larger default brush size on mobile
- Consider pinch-to-zoom for precision editing

### Performance
- Lazy load edit modal only when needed
- Use requestAnimationFrame for smooth painting
- Compress mask PNG before upload

### Error Handling
- Handle network failures gracefully
- Show clear error messages
- Allow retry on failure

### Security
- Validate imageUrl is from our Storage domain
- Sanitize editPrompt input
- Rate limit API calls
