# Video Wizard Platform Presets - Implementation Plan

## Overview
Upgrade the Video Wizard to include a **Platform Selection** step that determines optimal clip lengths and formats based on the target social media platform.

---

## Platform Video Length Research (December 2024)

| Platform | Max Length | Optimal Length | Vertical Video | Notes |
|----------|-----------|----------------|----------------|-------|
| **YouTube Shorts** | 60 seconds | 50-60 sec | 9:16 required | Longer = more watch time = better algorithm |
| **TikTok** | 10 minutes | 30-90 sec | 9:16 | Extended from 3 min in 2024; 30-90s performs best |
| **Instagram Reels** | 90 seconds | 60-90 sec | 9:16 | Longer reels now promoted more |
| **Facebook Reels** | 90 seconds | 60-90 sec | 9:16 | Same as Instagram |
| **LinkedIn Video** | 10 minutes | 30-90 sec | 9:16 or 16:9 | Vertical gaining traction |
| **X/Twitter** | 140 seconds | 30-60 sec | Any | 2 min 20 sec max |

---

## Content Type Presets

### 1. YouTube Shorts
- **Icon:** TV/Monitor (📺)
- **Subtitle:** "Platform optimized"
- **Target Length:** 50-60 seconds (maximize the 60s limit)
- **Min Length:** 45 seconds
- **Max Length:** 60 seconds
- **Focus:** Complete story arcs, satisfying endings

### 2. TikTok Viral
- **Icon:** Music Note (🎵)
- **Subtitle:** "Trending style"
- **Target Length:** 30-60 seconds (sweet spot for virality)
- **Min Length:** 20 seconds
- **Max Length:** 90 seconds
- **Focus:** Hook in first 2 seconds, trending formats

### 3. Instagram Reels
- **Icon:** Camera (📷)
- **Subtitle:** "Visual focus"
- **Target Length:** 60-90 seconds
- **Min Length:** 45 seconds
- **Max Length:** 90 seconds
- **Focus:** Visually striking moments, aesthetic appeal

### 4. Podcast Clip
- **Icon:** Microphone (🎙️)
- **Subtitle:** "Clean & clear"
- **Target Length:** 45-90 seconds
- **Min Length:** 30 seconds
- **Max Length:** 120 seconds
- **Focus:** Clear dialogue, quotable moments, insights

### 5. Gaming Highlight
- **Icon:** Game Controller (🎮)
- **Subtitle:** "Action-packed"
- **Target Length:** 30-60 seconds
- **Min Length:** 15 seconds
- **Max Length:** 90 seconds
- **Focus:** Action peaks, reactions, impressive plays

### 6. Multi-Platform (NEW - Default)
- **Icon:** Globe (🌐)
- **Subtitle:** "Universal fit"
- **Target Length:** 45-60 seconds
- **Min Length:** 30 seconds
- **Max Length:** 60 seconds
- **Focus:** Works well on all platforms

---

## UI/UX Design

### New Step: Content Type Selection (Step 0 or integrated into Step 1)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    What are you creating?                           │
│           Choose your content type for optimal clip lengths          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │    📺    │  │    🎵    │  │    📷    │  │    🎙️    │  │   🎮   │ │
│  │          │  │          │  │          │  │          │  │        │ │
│  │ YouTube  │  │  TikTok  │  │Instagram │  │ Podcast  │  │ Gaming │ │
│  │ Shorts   │  │  Viral   │  │  Reels   │  │  Clip    │  │Highlight│ │
│  │          │  │          │  │          │  │          │  │        │ │
│  │ 50-60s   │  │ 30-60s   │  │ 60-90s   │  │ 45-90s   │  │ 30-60s │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └────────┘ │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ 🌐 Multi-Platform                                              │ │
│  │ Create clips optimized for all platforms (45-60 seconds)       │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ℹ️ Longer clips = more watch time = better algorithm performance   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Selection Behavior
1. User clicks a preset card
2. Card gets highlighted border (like in the screenshot)
3. Settings are stored in state
4. User can change selection before/during analysis

---

## Implementation Changes

### Frontend: `video-wizard.html`

#### 1. Add Platform Presets Configuration
```javascript
const PLATFORM_PRESETS = {
    'youtube-shorts': {
        id: 'youtube-shorts',
        name: 'YouTube Shorts',
        icon: '📺',
        subtitle: 'Platform optimized',
        minDuration: 45,
        maxDuration: 60,
        targetDuration: 55,
        aspectRatio: '9:16',
        description: 'Maximize the 60-second limit for better watch time'
    },
    'tiktok-viral': {
        id: 'tiktok-viral',
        name: 'TikTok Viral',
        icon: '🎵',
        subtitle: 'Trending style',
        minDuration: 20,
        maxDuration: 90,
        targetDuration: 45,
        aspectRatio: '9:16',
        description: 'Hook-driven content with trending formats'
    },
    'instagram-reels': {
        id: 'instagram-reels',
        name: 'Instagram Reels',
        icon: '📷',
        subtitle: 'Visual focus',
        minDuration: 45,
        maxDuration: 90,
        targetDuration: 70,
        aspectRatio: '9:16',
        description: 'Visually striking moments for the gram'
    },
    'podcast-clip': {
        id: 'podcast-clip',
        name: 'Podcast Clip',
        icon: '🎙️',
        subtitle: 'Clean & clear',
        minDuration: 30,
        maxDuration: 120,
        targetDuration: 60,
        aspectRatio: '9:16',
        description: 'Quotable insights and clear dialogue'
    },
    'gaming-highlight': {
        id: 'gaming-highlight',
        name: 'Gaming Highlight',
        icon: '🎮',
        subtitle: 'Action-packed',
        minDuration: 15,
        maxDuration: 90,
        targetDuration: 45,
        aspectRatio: '9:16',
        description: 'Peak action moments and reactions'
    },
    'multi-platform': {
        id: 'multi-platform',
        name: 'Multi-Platform',
        icon: '🌐',
        subtitle: 'Universal fit',
        minDuration: 30,
        maxDuration: 60,
        targetDuration: 50,
        aspectRatio: '9:16',
        description: 'Optimized for all platforms'
    }
};
```

#### 2. Add to State
```javascript
const state = {
    // ... existing state
    contentType: {
        selected: 'youtube-shorts', // Default to YouTube Shorts
        preset: PLATFORM_PRESETS['youtube-shorts']
    }
};
```

#### 3. Render Platform Selection
Add platform selection UI in Step 1 (before URL input) or as a new step.

### Backend: `functions/index.js`

#### Update `wizardAnalyzeVideo` Function

**Current prompt (line ~17721-17749):**
```javascript
4. VARIED LENGTHS: Mix of 15-30 second clips (hooks) and 30-60 second clips (stories)
...
"duration": <clip length in seconds, between 15-60>,
```

**New prompt with platform awareness:**
```javascript
const platformPrompts = {
    'youtube-shorts': {
        lengthGuide: 'Each clip should be 50-60 seconds to maximize YouTube Shorts watch time',
        durationRange: '50-60 seconds',
        focus: 'Complete story arcs with satisfying conclusions'
    },
    'tiktok-viral': {
        lengthGuide: 'Clips should be 30-60 seconds with strong hooks in first 2 seconds',
        durationRange: '30-60 seconds',
        focus: 'Hook-driven moments with trending appeal'
    },
    'instagram-reels': {
        lengthGuide: 'Clips should be 60-90 seconds focusing on visual impact',
        durationRange: '60-90 seconds',
        focus: 'Visually striking moments with aesthetic appeal'
    },
    'podcast-clip': {
        lengthGuide: 'Clips should be 45-90 seconds capturing complete thoughts',
        durationRange: '45-90 seconds',
        focus: 'Quotable insights, clear dialogue, valuable information'
    },
    'gaming-highlight': {
        lengthGuide: 'Clips should be 30-60 seconds of peak action',
        durationRange: '30-60 seconds',
        focus: 'Action peaks, reactions, impressive moments'
    },
    'multi-platform': {
        lengthGuide: 'Clips should be 45-60 seconds to work across all platforms',
        durationRange: '45-60 seconds',
        focus: 'Universal appeal with complete moments'
    }
};
```

**Updated AI Prompt:**
```javascript
const platformConfig = platformPrompts[contentType] || platformPrompts['multi-platform'];

const prompt = `
IMPORTANT RULES FOR CLIP SELECTION:
1. DIVERSITY: Each clip must focus on a DIFFERENT topic or moment
2. SPREAD: Distribute clips across the ENTIRE video duration
3. NO OVERLAP: Minimum 60 second gap between clip start times
4. TARGET DURATION: ${platformConfig.lengthGuide}
5. CONTENT FOCUS: ${platformConfig.focus}

For each clip provide:
{
  "startTime": <integer seconds>,
  "endTime": <integer seconds>,
  "duration": <${platformConfig.durationRange}>,
  ...
}
`;
```

---

## File Changes Summary

| File | Changes |
|------|---------|
| `frontend/video-wizard.html` | Add PLATFORM_PRESETS config, state.contentType, renderPlatformSelector(), platform selection UI, pass contentType to analysis |
| `functions/index.js` | Update `wizardAnalyzeVideo` to accept `contentType` parameter, modify AI prompt for platform-specific lengths |

---

## Development Tasks

### Phase 1: Platform Selection UI
- [ ] Add PLATFORM_PRESETS configuration object
- [ ] Add contentType to state
- [ ] Create renderPlatformSelector() function
- [ ] Add CSS styles for platform cards
- [ ] Integrate into Step 1 (before URL input)

### Phase 2: Backend Integration
- [ ] Add `contentType` parameter to `wizardAnalyzeVideo`
- [ ] Create platform-specific prompt templates
- [ ] Update AI prompt to use platform settings
- [ ] Update clip duration validation

### Phase 3: Enhanced Features
- [ ] Remember user's last selected platform (localStorage)
- [ ] Show platform icon in clip cards
- [ ] Add platform-specific tips during analysis
- [ ] Platform recommendation based on video content

---

## Current vs. New Clip Lengths

| Scenario | Current | After Implementation |
|----------|---------|---------------------|
| Default clips | 15-60s (often 30s) | Platform-specific (45-60s for YouTube) |
| AI guidance | Generic | Platform-optimized |
| Fallback clips | 20-50s random | Target duration ±10s |

---

## Expected Outcomes

1. **YouTube Shorts clips will be 50-60 seconds** instead of 30 seconds
2. **Users can choose their target platform** for optimized results
3. **AI analysis produces better-suited clips** for each platform
4. **Increased watch time** = better algorithm performance
5. **Reduced manual trimming** by users

---

## Questions to Resolve

1. Should platform selection be a separate step or part of Video Input?
2. Should we allow changing platform after analysis (re-analyze)?
3. Do we want to show multiple preset options or just the top 3 most common?
4. Should the platform affect thumbnail generation prompts too?

---

## Ready for Implementation?

This plan covers:
- ✅ Platform video length limits (researched)
- ✅ UI design mockup
- ✅ Frontend implementation details
- ✅ Backend prompt changes
- ✅ Configuration structure
- ✅ Development task breakdown

**Estimated effort:** 4-6 hours for full implementation
