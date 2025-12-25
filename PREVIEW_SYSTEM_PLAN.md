# Video Preview & Timeline Editor System

## Executive Summary

Implement a professional-grade video preview and timeline editing system that allows users to:
1. **Preview their video in real-time** during Assembly
2. **Make precise edits** on a multi-track timeline before Export
3. **See exactly what they'll get** before committing to render

---

## Phase 1: Video Preview Engine (Core Foundation)

### 1.1 Create `VideoPreviewEngine` Class

A JavaScript class that composes scenes into a playable preview.

```javascript
class VideoPreviewEngine {
    constructor(canvasElement, options) {
        this.canvas = canvasElement;
        this.ctx = canvasElement.getContext('2d');
        this.scenes = [];           // Scene data
        this.currentTime = 0;       // Playhead position in seconds
        this.isPlaying = false;
        this.audioContext = new AudioContext();
    }

    // Core methods
    loadScenes(scenes)              // Load scene data
    play()                          // Start playback
    pause()                         // Pause playback
    seek(timeInSeconds)             // Jump to specific time
    getCurrentScene()               // Get scene at current time

    // Rendering
    renderFrame()                   // Render current frame to canvas
    applyTransition(fromScene, toScene, progress)  // Render transition
    renderCaptions(text, style)     // Overlay captions

    // Audio
    syncAudio()                     // Synchronize voiceovers
    setVolume(track, level)         // Adjust volume per track
}
```

### 1.2 Scene Data Structure

```javascript
{
    id: 1,
    type: 'image' | 'video' | 'animated',

    // Visual
    imageUrl: 'https://...',
    videoUrl: 'https://...',        // For animated/stock video

    // Timing
    startTime: 0,                   // When this scene starts (seconds)
    visualDuration: 15,             // How long it displays (seconds)

    // Audio
    voiceoverUrl: 'https://...',
    voiceoverDuration: 10,          // Actual voiceover length
    voiceoverOffset: 0,             // Delay before voiceover starts

    // Effects
    transition: 'fade' | 'cut' | 'slide' | 'zoom',
    transitionDuration: 0.5,
    kenBurns: { startZoom: 1.0, endZoom: 1.2, panX: 0, panY: 0 },

    // Caption
    caption: 'Big Pharma earns...',
    captionStyle: 'karaoke' | 'subtitle' | 'dynamic'
}
```

### 1.3 Technical Approach

**Rendering Pipeline:**
1. Calculate which scene is active at `currentTime`
2. If in transition zone, blend two scenes
3. Draw current frame to canvas:
   - Apply Ken Burns effect (scale/translate)
   - Apply transition effect
   - Overlay captions
4. Sync audio playback with video

**Audio Handling:**
- Use Web Audio API for precise sync
- Create AudioBufferSourceNode for each voiceover
- Schedule playback based on scene timing
- Background music as separate track with volume control

---

## Phase 2: Assembly Step Preview (Right Panel)

### 2.1 Layout Change

Split the Assembly step into two columns:
- **Left (60%)**: Scene Timeline (existing)
- **Right (40%)**: Live Preview Panel (NEW)

### 2.2 Preview Panel Components

```
┌─────────────────────────────────┐
│  ┌───────────────────────────┐  │
│  │                           │  │
│  │     CANVAS PREVIEW        │  │
│  │     (16:9 aspect ratio)   │  │
│  │                           │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌───────────────────────────┐  │
│  │ ▶  ❚❚  ■   ●━━━━━━━━━━━━  │  │
│  │ Play Pause Stop  Scrubber │  │
│  │                           │  │
│  │ 1:23 / 3:02      🔊 ━━●━━ │  │
│  │ Current  Total    Volume  │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌───────────────────────────┐  │
│  │ Currently Playing:        │  │
│  │ Scene 5: "The industry..." │  │
│  │ ◀ Prev     Jump    Next ▶ │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

### 2.3 Interactions

- **Click scene in timeline** → Preview jumps to that scene
- **Play button** → Plays from current position
- **Scrubber drag** → Seek through video
- **Scene cards highlight** → Show which scene is playing
- **Prev/Next buttons** → Jump between scenes

---

## Phase 3: Export Step Timeline Editor

### 3.1 Full Timeline Interface

Replace current Export step with professional timeline editor.

```
┌─────────────────────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                                                             │    │
│  │                  MAIN VIDEO PREVIEW                         │    │
│  │                  (Large, 16:9)                               │    │
│  │                                                             │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ▶ ❚❚  ◀◀ ▶▶  │  ━━━━━━━━━━━━●━━━━━━━━━━━━  │  2:15 / 3:02       │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  TIMELINE                                    [−] 100% [+]  │ Snap ☑ │
├─────────────────────────────────────────────────────────────────────┤
│  │    0:00    │    0:30    │    1:00    │    1:30    │    2:00    │ │
│  ├────────────┴────────────┴────────────┴────────────┴────────────┤ │
│  │                                                                 │ │
│  │ 🎬 VIDEO  ┌────┐┌────────┐┌──────┐┌────────────┐┌────┐┌─────┐  │ │
│  │          │ S1 ││   S2   ││  S3  ││     S4     ││ S5 ││ S6  │  │ │
│  │          └────┘└────────┘└──────┘└────────────┘└────┘└─────┘  │ │
│  │                                                                 │ │
│  │ 🎙️ VOICE  ▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓ ▓▓▓▓▓▓   │ │
│  │          (waveform visualization)                               │ │
│  │                                                                 │ │
│  │ 🎵 MUSIC  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │ │
│  │          (continuous background)                                │ │
│  │                                                                 │ │
│  │ 💬 CAPS   │Text1│ │Text 2│ │ Text 3 │ │  Text 4  │ │T5│ │T6│   │ │
│  │                                                                 │ │
│  │          ▼ (Playhead)                                           │ │
│  ├─────────────────────────────────────────────────────────────────┤ │
│  │ ◀━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━▶ │ │
│  │ (Horizontal scroll for long videos)                             │ │
│  └─────────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│  CLIP INSPECTOR (when clip selected)                                │
│  ┌──────────────────────┐  ┌──────────────────────┐                 │
│  │ Scene 4              │  │ Timing               │                 │
│  │ ┌────────────────┐   │  │ Start: 1:15.00  [↕]  │                 │
│  │ │   Thumbnail    │   │  │ Duration: 12s   [↕]  │                 │
│  │ └────────────────┘   │  │ Transition: Fade ▼   │                 │
│  │ Type: Static Image   │  │ Trans Duration: 0.5s │                 │
│  └──────────────────────┘  └──────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Timeline Features

#### A. Multi-Track Display
- **Video Track**: Scene clips with thumbnails
- **Voice Track**: Waveform visualization of voiceovers
- **Music Track**: Background music (if enabled)
- **Caption Track**: Text overlays with timing

#### B. Clip Operations
- **Drag to reorder**: Move scenes on video track
- **Trim handles**: Drag left/right edge to trim clip
- **Split clip**: Cut a clip at playhead position
- **Delete clip**: Remove scene from timeline
- **Duplicate clip**: Copy a scene

#### C. Timeline Controls
- **Zoom**: [−] [+] buttons or scroll wheel
- **Scroll**: Horizontal scroll for long videos
- **Snap to grid**: Align clips to seconds/frames
- **Playhead**: Draggable vertical line

#### D. Keyboard Shortcuts
- `Space` - Play/Pause
- `←` `→` - Frame step
- `J` `K` `L` - Playback speed control
- `S` - Split at playhead
- `Delete` - Remove selected clip
- `Ctrl+Z` - Undo
- `Ctrl+S` - Save project

### 3.3 Waveform Generation

For voiceover waveforms, we'll use Web Audio API:

```javascript
async function generateWaveform(audioUrl, width, height) {
    const response = await fetch(audioUrl);
    const arrayBuffer = await response.arrayBuffer();
    const audioContext = new AudioContext();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const channelData = audioBuffer.getChannelData(0);
    const samples = width;
    const blockSize = Math.floor(channelData.length / samples);

    const waveform = [];
    for (let i = 0; i < samples; i++) {
        const start = i * blockSize;
        let sum = 0;
        for (let j = 0; j < blockSize; j++) {
            sum += Math.abs(channelData[start + j]);
        }
        waveform.push(sum / blockSize);
    }

    return waveform; // Array of amplitude values
}
```

---

## Phase 4: Real-Time Editing Capabilities

### 4.1 Scene Timing Adjustments

Users can adjust:
- **Scene start time**: When scene begins
- **Scene duration**: How long scene displays
- **Voiceover offset**: Delay before voiceover starts within scene
- **Transition duration**: How long transition takes

### 4.2 Edit Operations

```javascript
class TimelineEditor {
    // Scene operations
    moveScene(sceneId, newStartTime)
    trimSceneStart(sceneId, newStart)
    trimSceneEnd(sceneId, newEnd)
    splitScene(sceneId, splitTime)
    deleteScene(sceneId)
    duplicateScene(sceneId)

    // Timing operations
    adjustVoiceoverOffset(sceneId, offset)
    setTransition(sceneId, type, duration)

    // Global operations
    rippleEdit(sceneId, delta)  // Move all following scenes
    insertGap(time, duration)    // Add silence/blank

    // History
    undo()
    redo()
    getHistory()
}
```

### 4.3 Undo/Redo System

```javascript
class EditHistory {
    constructor(maxHistory = 50) {
        this.history = [];
        this.position = -1;
        this.maxHistory = maxHistory;
    }

    push(state) {
        // Remove any redo history
        this.history = this.history.slice(0, this.position + 1);
        this.history.push(JSON.parse(JSON.stringify(state)));
        this.position++;

        // Limit history size
        if (this.history.length > this.maxHistory) {
            this.history.shift();
            this.position--;
        }
    }

    undo() {
        if (this.position > 0) {
            this.position--;
            return this.history[this.position];
        }
        return null;
    }

    redo() {
        if (this.position < this.history.length - 1) {
            this.position++;
            return this.history[this.position];
        }
        return null;
    }
}
```

---

## Phase 5: Export Integration

### 5.1 Save Timeline State

Before export, save all timeline adjustments:

```javascript
function saveTimelineState() {
    return {
        scenes: state.timeline.scenes.map(scene => ({
            id: scene.id,
            startTime: scene.startTime,
            duration: scene.duration,
            voiceoverOffset: scene.voiceoverOffset,
            transition: scene.transition,
            transitionDuration: scene.transitionDuration,
            // ... other edits
        })),
        music: {
            enabled: state.assembly.music.enabled,
            track: state.assembly.music.track,
            volume: state.assembly.music.volume
        },
        captions: {
            enabled: state.assembly.captions.enabled,
            style: state.assembly.captions.style,
            position: state.assembly.captions.position
        },
        totalDuration: calculateTotalDuration()
    };
}
```

### 5.2 Export with Edits

The Cloud Function receives the timeline state and applies all edits during render:

```javascript
// In Cloud Function
exports.exportVideo = functions.https.onCall(async (data, context) => {
    const { projectId, timelineState, quality } = data;

    // Build FFmpeg command based on timeline state
    const filterComplex = buildFilterComplex(timelineState);

    // Each scene has its adjusted timing
    for (const scene of timelineState.scenes) {
        // Apply scene at scene.startTime for scene.duration
        // Apply transition of scene.transition type
        // Offset voiceover by scene.voiceoverOffset
    }

    // Render with FFmpeg
    await renderVideo(filterComplex, quality);
});
```

---

## Implementation Order

### Week 1: Core Preview Engine
- [ ] Create `VideoPreviewEngine` class
- [ ] Implement basic image rendering to canvas
- [ ] Implement video element playback
- [ ] Implement audio synchronization
- [ ] Implement basic transitions (cut, fade)

### Week 2: Assembly Preview Panel
- [ ] Restructure Assembly step layout (2 columns)
- [ ] Add preview canvas component
- [ ] Add playback controls
- [ ] Connect scene list to preview (click to jump)
- [ ] Add scene progress indicator

### Week 3: Timeline Foundation
- [ ] Create timeline component structure
- [ ] Implement zoom/scroll
- [ ] Render scene clips on video track
- [ ] Implement playhead
- [ ] Connect to preview engine

### Week 4: Timeline Editing
- [ ] Implement drag to reorder
- [ ] Implement trim handles
- [ ] Add waveform visualization
- [ ] Implement clip inspector panel
- [ ] Add keyboard shortcuts

### Week 5: Polish & Integration
- [ ] Implement undo/redo
- [ ] Save timeline state to project
- [ ] Update export to use timeline state
- [ ] Performance optimization
- [ ] Testing & bug fixes

---

## Technical Considerations

### Performance
- Use `requestAnimationFrame` for smooth playback
- Lazy-load scene images/videos
- Generate waveforms in Web Worker
- Debounce timeline updates
- Use virtual scrolling for many scenes

### Browser Compatibility
- Fallback for older browsers without Web Audio API
- Test on Chrome, Firefox, Safari, Edge
- Mobile-friendly controls (but full editor desktop-only)

### File Handling
- Cache loaded media in memory
- Use IndexedDB for offline project data
- Implement progressive loading for large projects

---

## Files to Create/Modify

### New Files
- `frontend/js/VideoPreviewEngine.js` - Core preview class
- `frontend/js/TimelineEditor.js` - Timeline editing logic
- `frontend/js/WaveformGenerator.js` - Audio waveform rendering
- `frontend/js/EditHistory.js` - Undo/redo system
- `frontend/css/timeline.css` - Timeline styling

### Modified Files
- `frontend/video-creation-wizard.html` - Add preview panels, timeline UI
- `functions/index.js` - Update export to handle timeline state

---

## Success Metrics

1. **Preview Accuracy**: Preview matches final export within 95%
2. **Playback Smoothness**: Maintain 30fps during preview
3. **Edit Responsiveness**: Timeline operations complete in <100ms
4. **User Satisfaction**: Users can make edits without re-exporting
