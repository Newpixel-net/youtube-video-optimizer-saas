# Split Screen Mode - Complete Analysis & Implementation Plan

## Executive Summary

The Split Screen reframe mode in Video Wizard has multiple critical bugs that cause the preview to not match the exported output, prevent users from adjusting individual speaker positions, and use hardcoded crop values that ignore user settings.

---

## Part 1: Current Implementation Analysis

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           USER INTERFACE                                │
│  frontend/video-wizard.html                                             │
│  ┌─────────────────┐    ┌──────────────────┐    ┌───────────────────┐  │
│  │ Reframe Section │    │  Source Preview  │    │   Phone Preview   │  │
│  │ - Auto-center   │    │  - Drag crop zone│    │   - Split view    │  │
│  │ - Split ◄────── │    │  - Crop slider   │    │   - Speaker 1/2   │  │
│  │ - Three Person  │    │  - AI Smart Crop │    │   - Labels        │  │
│  └─────────────────┘    └──────────────────┘    └───────────────────┘  │
│                                                                          │
│  State: clipSettings[clipId].reframeMode = 'split_screen'               │
│         clipSettings[clipId].cropPosition = 50 (0-100) ◄── NOT USED!   │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           BACKEND                                        │
│  functions/index.js - wizardProcessClip()                               │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Creates processing job with:                                     │   │
│  │   - reframeMode: 'split_screen'                                  │   │
│  │   - cropPosition: 50  ◄── Passed but IGNORED by processor!      │   │
│  │   - secondarySource: { position: 'top'|'bottom', ... }          │   │
│  │   - audioMix: { primaryVolume, secondaryVolume, ... }           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        VIDEO PROCESSOR                                   │
│  services/video-processor/src/processor.js                              │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ SINGLE SOURCE (no secondary video):                              │  │
│  │   buildFilterChain() → case 'split_screen':                      │  │
│  │   ┌────────────────────────────────────────────────────────────┐ │  │
│  │   │ HARDCODED LOGIC:                                           │ │  │
│  │   │   splitCropW = width / 3  (always 1/3 of source)           │ │  │
│  │   │   Left crop:  crop=640:1080:0:0       (left edge)          │ │  │
│  │   │   Right crop: crop=640:1080:1280:0   (right edge)          │ │  │
│  │   │   → vstack vertically                                       │ │  │
│  │   │                                                             │ │  │
│  │   │   cropPosition IS NOT USED AT ALL!                         │ │  │
│  │   └────────────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ MULTI SOURCE (has secondary video):                              │  │
│  │   processMultiSourceVideo()                                      │  │
│  │   ┌────────────────────────────────────────────────────────────┐ │  │
│  │   │ Current filter:                                             │ │  │
│  │   │   [0:v] scale to half height, crop to center               │ │  │
│  │   │   [1:v] scale to half height, crop to center               │ │  │
│  │   │   → vstack based on position (top/bottom)                  │ │  │
│  │   │                                                             │ │  │
│  │   │   cropPosition IS NOT USED AT ALL!                         │ │  │
│  │   │   No individual position control for each source!          │ │  │
│  │   └────────────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Files & Line Numbers

| File | Function/Section | Lines | Purpose |
|------|------------------|-------|---------|
| `frontend/video-wizard.html` | CSS for split preview | 2156-2222 | Split screen CSS styling |
| `frontend/video-wizard.html` | Preview rendering | 8588-8611 | Generates split preview HTML |
| `frontend/video-wizard.html` | Reframe UI | 8922-8971 | Reframe mode selection cards |
| `frontend/video-wizard.html` | setReframeMode() | 11300-11310 | Sets reframe mode in state |
| `frontend/video-wizard.html` | setCropPosition() | 11329-11393 | Sets crop position (NOT USED in split) |
| `frontend/video-wizard.html` | getDefaultSettings() | 9779-9855 | Default clip settings |
| `functions/index.js` | wizardProcessClip() | ~20000-20137 | Creates processing job |
| `processor.js` | buildFilterChain() | 2782-2791 | Single-source split FFmpeg |
| `processor.js` | processMultiSourceVideo() | 464-612 | Multi-source split processing |

---

## Part 2: Identified Bugs & Issues

### CRITICAL BUGS

#### Bug #1: cropPosition Completely Ignored for Split Screen
**Location:** `processor.js:2782-2791`
**Severity:** Critical

```javascript
case 'split_screen':
  // Take left 1/3 and right 1/3 of the video, stack them
  const splitCropW = Math.floor(validWidth / 3);  // ← HARDCODED!
  filters.push(`split[left][right]`);
  filters.push(`[left]crop=${splitCropW}:${validHeight}:0:0,...`);  // ← ALWAYS LEFT EDGE
  filters.push(`[right]crop=${splitCropW}:${validHeight}:${validWidth - splitCropW}:0,...`);  // ← ALWAYS RIGHT EDGE
```

**Problem:** The crop position slider (0-100%) that users interact with has ZERO effect on the split screen output. The processor always crops the leftmost 1/3 for Speaker 1 and rightmost 1/3 for Speaker 2.

**User Impact:** Users adjust the slider expecting to change where speakers are cropped from, but export is always the same.

---

#### Bug #2: Preview Doesn't Match Output
**Location:** `video-wizard.html:2169-2192`
**Severity:** Critical

```css
/* CSS Preview for split screen */
.phone-video-area.reframe-split_screen .split-preview-top iframe {
    width: 300%;
    height: 200%;
    transform-origin: left center;  /* ← Shows LEFT portion */
}

.phone-video-area.reframe-split_screen .split-preview-bottom iframe {
    width: 300%;
    height: 200%;
    transform-origin: right center;  /* ← Shows RIGHT portion */
}
```

**Problem:** The CSS preview does attempt to show left/right thirds, BUT:
1. The preview uses `transform-origin` which doesn't accurately represent FFmpeg's `crop` filter
2. The preview shows the same video twice with different origins, not actually cropped
3. When cropPosition changes, the preview updates but the FFmpeg output doesn't

**User Impact:** What users see in the preview is fundamentally different from what gets exported.

---

#### Bug #3: No Separate Controls for Speaker 1 and Speaker 2 Positions
**Location:** `video-wizard.html` (missing entirely)
**Severity:** Critical

**Problem:** The UI provides only ONE crop position control that applies to auto_center mode. There are NO controls to:
- Adjust where Speaker 1's crop zone is positioned horizontally
- Adjust where Speaker 2's crop zone is positioned horizontally
- Fine-tune each speaker independently

**Current state structure:**
```javascript
clipSettings: {
    reframeMode: 'split_screen',
    cropPosition: 50,  // ← Only ONE position, and it's ignored anyway
    // Missing: speaker1CropPosition, speaker2CropPosition
}
```

**User Impact:** Users cannot adjust individual speaker positions at all.

---

#### Bug #4: Single-Source Preview Shows Same Video Twice
**Location:** `video-wizard.html:8603-8609`
**Severity:** Medium

```javascript
} else {
    // No secondary - split primary video
    topMedia = mediaElement;   // ← Same element
    bottomMedia = mediaElement; // ← Same element!
    topLabel = 'Speaker 1';
    bottomLabel = 'Speaker 2';
}
```

**Problem:** Without a secondary video, the preview shows the full primary video in both halves with just labels. Users don't see that the backend will actually crop left/right portions.

**User Impact:** Confusing preview that doesn't represent actual output.

---

### MEDIUM BUGS

#### Bug #5: Multi-Source Split Ignores Crop Position
**Location:** `processor.js:517-530`
**Severity:** Medium

```javascript
// processMultiSourceVideo
filterComplex = `
  [0:v]scale=${targetWidth}:${halfHeight}:force_original_aspect_ratio=increase,
      crop=${targetWidth}:${halfHeight},setsar=1[primary];  // ← Center crop only!
  [1:v]scale=${targetWidth}:${halfHeight}:force_original_aspect_ratio=increase,
      crop=${targetWidth}:${halfHeight},setsar=1[secondary];
  [primary][secondary]vstack=inputs=2[vout]
`;
```

**Problem:** Multi-source mode always center-crops both videos. No way to adjust horizontal position of either source.

---

#### Bug #6: timeOffset Not Implemented
**Location:** `video-wizard.html:9825`, `processor.js` (missing)
**Severity:** Medium

```javascript
// Default settings include timeOffset
secondarySource: {
    timeOffset: 0  // ← UI allows -10 to +10, but backend ignores it
}
```

**Problem:** Users can set a time offset for the secondary video in the UI, but the processor never applies it. Both videos always start at time 0.

---

### LOW BUGS / MISSING FEATURES

#### Missing #1: No Crop Position Presets for Split Mode
When split_screen is selected, the crop slider should show context-aware presets like:
- "Both Center" - crop center portions for both speakers
- "Interview Left-Right" - left 1/3 + right 1/3 (current hardcoded behavior)
- "Custom" - allow independent positioning

#### Missing #2: No Visual Guide for Crop Zones in Source Preview
The source preview shows one draggable crop zone for auto_center mode, but doesn't show two zones for split_screen mode where users could see/adjust Speaker 1 and Speaker 2 regions.

#### Missing #3: No Validation of Input Aspect Ratio
The hardcoded 1/3 crop width assumes a 16:9 source. Non-standard aspect ratios will produce unexpected results.

---

## Part 3: Implementation Plan

### Phase 1: Data Model Updates

#### Step 1.1: Add Split-Specific Settings to Default State
**File:** `frontend/video-wizard.html` - `getDefaultSettings()` (~line 9779)

Add new properties:
```javascript
// Split screen specific settings
splitScreenSettings: {
    speaker1: {
        cropPosition: 17,  // Default: left 1/3 center (0-100)
        cropWidth: 33,     // Percentage of source width to crop
    },
    speaker2: {
        cropPosition: 83,  // Default: right 1/3 center (0-100)
        cropWidth: 33,
    },
    layout: 'vertical',    // 'vertical' (stacked) or 'horizontal' (side-by-side)
    preset: 'interview',   // 'interview', 'center-both', 'custom'
}
```

#### Step 1.2: Update Backend Job Creation
**File:** `functions/index.js` - `wizardProcessClip()` (~line 20000)

Pass split screen settings to processor:
```javascript
settings: {
    // ... existing settings ...
    splitScreenSettings: clipSettings.splitScreenSettings || null,
}
```

---

### Phase 2: Backend FFmpeg Fixes

#### Step 2.1: Fix Single-Source Split Screen
**File:** `services/video-processor/src/processor.js` - `buildFilterChain()` (~line 2782)

Replace hardcoded logic with position-aware cropping:
```javascript
case 'split_screen': {
    const splitSettings = settings?.splitScreenSettings;
    const speaker1Pos = splitSettings?.speaker1?.cropPosition ?? 17;
    const speaker2Pos = splitSettings?.speaker2?.cropPosition ?? 83;
    const cropWidthPercent = splitSettings?.speaker1?.cropWidth ?? 33;

    // Calculate crop dimensions
    const cropW = Math.floor(validWidth * (cropWidthPercent / 100));
    const halfH = Math.floor(targetHeight / 2);

    // Calculate X positions based on percentages
    const maxX = validWidth - cropW;
    const speaker1X = Math.floor((speaker1Pos / 100) * maxX);
    const speaker2X = Math.floor((speaker2Pos / 100) * maxX);

    filters.push(`split[s1][s2]`);
    filters.push(`[s1]crop=${cropW}:${validHeight}:${speaker1X}:0,scale=${targetWidth}:${halfH}:force_original_aspect_ratio=increase,crop=${targetWidth}:${halfH}[top]`);
    filters.push(`[s2]crop=${cropW}:${validHeight}:${speaker2X}:0,scale=${targetWidth}:${halfH}:force_original_aspect_ratio=increase,crop=${targetWidth}:${halfH}[bottom]`);
    filters.push(`[top][bottom]vstack`);
    break;
}
```

#### Step 2.2: Fix Multi-Source Split Screen
**File:** `services/video-processor/src/processor.js` - `processMultiSourceVideo()` (~line 464)

Add crop position support:
```javascript
const splitSettings = safeSettings.splitScreenSettings || {};
const primaryPos = splitSettings.speaker1?.cropPosition ?? 50;
const secondaryPos = splitSettings.speaker2?.cropPosition ?? 50;

// Calculate crop X for each video based on its own dimensions
const primaryCropW = Math.floor(primaryInfo.height * targetAspect);
const primaryMaxX = primaryInfo.width - primaryCropW;
const primaryCropX = Math.floor((primaryPos / 100) * primaryMaxX);

const secondaryCropW = Math.floor(secondaryInfo.height * targetAspect);
const secondaryMaxX = secondaryInfo.width - secondaryCropW;
const secondaryCropX = Math.floor((secondaryPos / 100) * secondaryMaxX);

filterComplex = `
  [0:v]crop=${primaryCropW}:${primaryInfo.height}:${primaryCropX}:0,scale=${targetWidth}:${halfHeight},setsar=1[primary];
  [1:v]crop=${secondaryCropW}:${secondaryInfo.height}:${secondaryCropX}:0,scale=${targetWidth}:${halfHeight},setsar=1[secondary];
  ${position === 'top' ? '[secondary][primary]' : '[primary][secondary]'}vstack=inputs=2[vout]
`;
```

#### Step 2.3: Implement Time Offset for Secondary Source
**File:** `services/video-processor/src/processor.js` - `processMultiSourceVideo()`

Add time offset using `-ss` or `setpts` filter:
```javascript
const timeOffset = safeSettings.secondarySource?.timeOffset || 0;

// If offset is negative, delay primary; if positive, delay secondary
let primaryDelay = 0;
let secondaryDelay = 0;
if (timeOffset < 0) {
    primaryDelay = Math.abs(timeOffset);
} else if (timeOffset > 0) {
    secondaryDelay = timeOffset;
}

// Apply delays in filter
filterComplex = `
  [0:v]setpts=PTS+${primaryDelay}/TB,crop=...[primary];
  [1:v]setpts=PTS+${secondaryDelay}/TB,crop=...[secondary];
  ...
`;
```

---

### Phase 3: Frontend UI Updates

#### Step 3.1: Add Split-Specific Controls Section
**File:** `frontend/video-wizard.html` - render function (~line 8922)

When split_screen mode is selected, show additional controls:
```javascript
// After reframe mode selection grid
if (settings.reframeMode === 'split_screen') {
    html += '<div class="split-screen-controls">';
    html += '<h4>Speaker Positions</h4>';

    // Preset buttons
    html += '<div class="split-presets">';
    html += '<button class="preset-btn" onclick="app.setSplitPreset(\'interview\')">Interview (L+R)</button>';
    html += '<button class="preset-btn" onclick="app.setSplitPreset(\'center\')">Both Center</button>';
    html += '<button class="preset-btn" onclick="app.setSplitPreset(\'custom\')">Custom</button>';
    html += '</div>';

    // Individual speaker controls
    var splitSettings = settings.splitScreenSettings || {};

    html += '<div class="speaker-control">';
    html += '<label>Speaker 1 (Top)</label>';
    html += '<input type="range" min="0" max="100" value="' + (splitSettings.speaker1?.cropPosition || 17) + '" onchange="app.setSpeakerPosition(1, this.value)">';
    html += '<span>' + (splitSettings.speaker1?.cropPosition || 17) + '%</span>';
    html += '</div>';

    html += '<div class="speaker-control">';
    html += '<label>Speaker 2 (Bottom)</label>';
    html += '<input type="range" min="0" max="100" value="' + (splitSettings.speaker2?.cropPosition || 83) + '" onchange="app.setSpeakerPosition(2, this.value)">';
    html += '<span>' + (splitSettings.speaker2?.cropPosition || 83) + '%</span>';
    html += '</div>';

    html += '</div>';
}
```

#### Step 3.2: Add New App Functions
**File:** `frontend/video-wizard.html` - app object (~line 11300)

```javascript
setSplitPreset: function(preset) {
    var selectedClips = state.clips.filter(c => state.selectedClipIds.includes(c.id));
    var activeClip = selectedClips[state.customization.activeClipIndex];
    if (!state.clipSettings[activeClip.id]) {
        state.clipSettings[activeClip.id] = getDefaultSettings();
    }

    var settings;
    switch(preset) {
        case 'interview':
            settings = { speaker1: { cropPosition: 17 }, speaker2: { cropPosition: 83 } };
            break;
        case 'center':
            settings = { speaker1: { cropPosition: 50 }, speaker2: { cropPosition: 50 } };
            break;
        case 'custom':
            settings = state.clipSettings[activeClip.id].splitScreenSettings ||
                       { speaker1: { cropPosition: 50 }, speaker2: { cropPosition: 50 } };
            break;
    }
    settings.preset = preset;
    state.clipSettings[activeClip.id].splitScreenSettings = settings;
    render();
},

setSpeakerPosition: function(speaker, position) {
    var selectedClips = state.clips.filter(c => state.selectedClipIds.includes(c.id));
    var activeClip = selectedClips[state.customization.activeClipIndex];
    if (!state.clipSettings[activeClip.id]) {
        state.clipSettings[activeClip.id] = getDefaultSettings();
    }
    if (!state.clipSettings[activeClip.id].splitScreenSettings) {
        state.clipSettings[activeClip.id].splitScreenSettings = {
            speaker1: { cropPosition: 17 },
            speaker2: { cropPosition: 83 },
            preset: 'custom'
        };
    }

    var key = 'speaker' + speaker;
    state.clipSettings[activeClip.id].splitScreenSettings[key].cropPosition = parseInt(position, 10);
    state.clipSettings[activeClip.id].splitScreenSettings.preset = 'custom';
    render();
},
```

#### Step 3.3: Fix Preview to Match Output
**File:** `frontend/video-wizard.html` - preview rendering (~line 8588)

Update split preview to actually crop to the correct positions:
```javascript
if (reframeMode === 'split_screen') {
    var splitSettings = settings.splitScreenSettings || {
        speaker1: { cropPosition: 17 },
        speaker2: { cropPosition: 83 }
    };

    // Calculate CSS transforms to match FFmpeg crop
    // For 16:9 source, crop width is ~33% (1/3)
    var cropWidthPercent = 33.33;
    var scaleX = 100 / cropWidthPercent;  // 300% to show 1/3

    // Speaker 1: top half
    var s1Pos = splitSettings.speaker1?.cropPosition || 17;
    var s1TranslateX = -(s1Pos / 100) * (scaleX - 1) * 100;

    // Speaker 2: bottom half
    var s2Pos = splitSettings.speaker2?.cropPosition || 83;
    var s2TranslateX = -(s2Pos / 100) * (scaleX - 1) * 100;

    html += '<div class="split-preview-top" style="--speaker-translate:' + s1TranslateX + '%">' + topMedia + '<span class="split-label">' + topLabel + '</span></div>';
    html += '<div class="split-preview-bottom" style="--speaker-translate:' + s2TranslateX + '%">' + bottomMedia + '<span class="split-label">' + bottomLabel + '</span></div>';
}
```

Update CSS:
```css
.phone-video-area.reframe-split_screen .split-preview-top iframe,
.phone-video-area.reframe-split_screen .split-preview-top video {
    width: 300%;
    height: 200%;
    transform: translateX(var(--speaker-translate, 0));
}
```

#### Step 3.4: Add Source Preview with Two Crop Zones
**File:** `frontend/video-wizard.html` - source preview section (~line 8417)

When split_screen mode is active, show two draggable crop zones:
```javascript
if (reframeMode === 'split_screen') {
    var splitSettings = settings.splitScreenSettings || {};
    var s1Pos = splitSettings.speaker1?.cropPosition || 17;
    var s2Pos = splitSettings.speaker2?.cropPosition || 83;

    // Crop zone width: 31.64% (same as auto_center)
    var zoneWidth = 31.640625;
    var s1Left = (s1Pos / 100) * (100 - zoneWidth);
    var s2Left = (s2Pos / 100) * (100 - zoneWidth);

    html += '<div class="crop-guide-overlay split-mode">';
    html += '<div class="crop-guide-zone speaker1" style="left:' + s1Left + '%;" data-speaker="1">';
    html += '<div class="crop-guide-label">Speaker 1 (Top)</div>';
    html += '</div>';
    html += '<div class="crop-guide-zone speaker2" style="left:' + s2Left + '%;" data-speaker="2">';
    html += '<div class="crop-guide-label">Speaker 2 (Bottom)</div>';
    html += '</div>';
    html += '</div>';
}
```

---

### Phase 4: Testing & Validation

#### Step 4.1: Create Test Cases

1. **Single-source interview video:**
   - Load 16:9 video with speakers on left and right
   - Select split_screen mode
   - Verify default shows left 1/3 + right 1/3
   - Adjust Speaker 1 to center (50%)
   - Export and verify output matches preview

2. **Multi-source split:**
   - Load primary video
   - Add secondary video
   - Select split_screen mode
   - Adjust positions for both
   - Export and verify output

3. **Time offset:**
   - Add secondary source
   - Set time offset to +3 seconds
   - Export and verify sync

4. **Non-16:9 source:**
   - Load 4:3 or 21:9 video
   - Verify crop calculations work correctly

---

## Part 4: Priority Order

### P0 - Critical (Fix immediately)
1. **Fix backend cropPosition for split_screen** - Step 2.1
2. **Fix preview to match output** - Step 3.3
3. **Add speaker position controls** - Step 3.1, 3.2

### P1 - Important (Next iteration)
4. **Fix multi-source crop positions** - Step 2.2
5. **Add source preview crop zones** - Step 3.4
6. **Implement time offset** - Step 2.3

### P2 - Nice to have (Future)
7. Horizontal split layout option
8. Variable crop width per speaker
9. AI speaker detection for auto-positioning

---

## Part 5: Risks & Considerations

1. **Backward Compatibility:** Existing projects with split_screen mode will need migration. Consider:
   - If `splitScreenSettings` is undefined, use current hardcoded defaults
   - Log warning for legacy projects

2. **Performance:** Adding two crop zones to source preview may impact drag performance. Consider:
   - Debouncing position updates
   - Only updating active zone

3. **Mobile UI:** Split controls add complexity. Consider:
   - Collapsible "Advanced" section
   - Simplified preset-only mode on mobile

---

## Appendix: Code Reference Quick Guide

| What | Where | Line |
|------|-------|------|
| Default settings | video-wizard.html | 9779-9855 |
| setReframeMode() | video-wizard.html | 11300-11310 |
| setCropPosition() | video-wizard.html | 11329-11393 |
| Preview rendering | video-wizard.html | 8588-8611 |
| Reframe UI cards | video-wizard.html | 8922-8971 |
| Split preview CSS | video-wizard.html | 2156-2222 |
| Job creation | functions/index.js | ~20000-20137 |
| Single-source FFmpeg | processor.js | 2782-2791 |
| Multi-source FFmpeg | processor.js | 464-612 |
| Auto-center crop calc | processor.js | 2844-2923 |
