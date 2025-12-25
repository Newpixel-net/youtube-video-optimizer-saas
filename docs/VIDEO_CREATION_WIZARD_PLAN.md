# Video Creation Wizard - Implementation Plan

## Executive Summary

A comprehensive AI-powered video creation wizard that enables users to generate complete videos from scratch using AI-generated scripts, images, and animations. The wizard leverages existing infrastructure (Nanobananapro image generation, GPU processing, FFmpeg) while integrating new capabilities (Runpod Multi-talk for image-to-video animation).

---

## 1. Platform & Format Configuration

### Supported Platforms with Format Options

| Platform | Supported Formats | Recommended | Max Length |
|----------|-------------------|-------------|------------|
| **YouTube Long-form** | 16:9 | 16:9 (1920x1080) | 5 min (our limit) |
| **YouTube Shorts** | 9:16 | 9:16 (1080x1920) | 60 seconds |
| **TikTok** | 9:16, 16:9, 1:1 | 9:16 (1080x1920) | 10 min app, 60 min upload |
| **Instagram Reels** | 9:16, 4:5 | 9:16 (1080x1920) | 3 minutes |
| **Instagram Feed** | 16:9, 1:1, 4:5 | 1:1 or 4:5 | 60 minutes |
| **Facebook Reels** | 9:16 | 9:16 (1080x1920) | 90 seconds |
| **Facebook Feed** | 16:9, 9:16, 1:1 | 16:9 or 1:1 | 240 minutes |
| **LinkedIn** | 16:9, 1:1, 9:16, 4:5 | 16:9 or 4:5 | 15 min (desktop) |

### Platform Preset Configuration

```javascript
const PLATFORM_PRESETS = {
  'youtube-long': {
    name: 'YouTube Long-form',
    icon: '📺',
    formats: ['16:9'],
    defaultFormat: '16:9',
    resolution: { width: 1920, height: 1080 },
    maxDuration: 300, // 5 minutes (our limit)
    minDuration: 60,
    fps: 30,
    bitrate: '8M'
  },
  'youtube-shorts': {
    name: 'YouTube Shorts',
    icon: '📱',
    formats: ['9:16'],
    defaultFormat: '9:16',
    resolution: { width: 1080, height: 1920 },
    maxDuration: 60,
    minDuration: 15,
    fps: 30,
    bitrate: '4M'
  },
  'tiktok': {
    name: 'TikTok',
    icon: '🎵',
    formats: ['9:16', '16:9', '1:1'],
    defaultFormat: '9:16',
    resolution: { width: 1080, height: 1920 },
    maxDuration: 180, // 3 min optimal engagement
    minDuration: 15,
    fps: 30,
    bitrate: '4M'
  },
  'instagram-reels': {
    name: 'Instagram Reels',
    icon: '📸',
    formats: ['9:16'],
    defaultFormat: '9:16',
    resolution: { width: 1080, height: 1920 },
    maxDuration: 180,
    minDuration: 15,
    fps: 30,
    bitrate: '4M'
  },
  'instagram-feed': {
    name: 'Instagram Feed',
    icon: '🖼️',
    formats: ['1:1', '4:5', '16:9'],
    defaultFormat: '1:1',
    resolution: { width: 1080, height: 1080 },
    maxDuration: 60,
    minDuration: 3,
    fps: 30,
    bitrate: '4M'
  },
  'facebook-reels': {
    name: 'Facebook Reels',
    icon: '👍',
    formats: ['9:16'],
    defaultFormat: '9:16',
    resolution: { width: 1080, height: 1920 },
    maxDuration: 90,
    minDuration: 3,
    fps: 30,
    bitrate: '4M'
  },
  'facebook-feed': {
    name: 'Facebook Feed',
    icon: '📘',
    formats: ['16:9', '1:1', '9:16'],
    defaultFormat: '16:9',
    resolution: { width: 1920, height: 1080 },
    maxDuration: 300,
    minDuration: 3,
    fps: 30,
    bitrate: '6M'
  },
  'linkedin': {
    name: 'LinkedIn',
    icon: '💼',
    formats: ['16:9', '1:1', '4:5'],
    defaultFormat: '4:5',
    resolution: { width: 1080, height: 1350 },
    maxDuration: 300,
    minDuration: 3,
    fps: 30,
    bitrate: '5M'
  },
  'multi-platform': {
    name: 'Multi-Platform',
    icon: '🌐',
    formats: ['9:16', '16:9', '1:1'],
    defaultFormat: '9:16',
    resolution: { width: 1080, height: 1920 },
    maxDuration: 60,
    minDuration: 15,
    fps: 30,
    bitrate: '4M'
  }
};
```

---

## 2. Niche & Category System

### Primary Niche Categories

```javascript
const VIDEO_NICHES = {
  // Entertainment & Lifestyle
  entertainment: {
    name: 'Entertainment',
    icon: '🎬',
    subniches: [
      { id: 'comedy', name: 'Comedy & Humor', keywords: ['funny', 'jokes', 'sketches'] },
      { id: 'stories', name: 'Story Time', keywords: ['narrative', 'tales', 'drama'] },
      { id: 'reactions', name: 'Reactions & Commentary', keywords: ['react', 'response'] },
      { id: 'celebrity', name: 'Celebrity & Pop Culture', keywords: ['news', 'gossip'] },
      { id: 'true-crime', name: 'True Crime', keywords: ['mystery', 'investigation'] }
    ]
  },

  // Education & Information
  education: {
    name: 'Education',
    icon: '📚',
    subniches: [
      { id: 'explainer', name: 'Explainer Videos', keywords: ['how', 'why', 'explained'] },
      { id: 'tutorials', name: 'Tutorials & How-To', keywords: ['guide', 'learn', 'step-by-step'] },
      { id: 'science', name: 'Science & Technology', keywords: ['tech', 'science', 'facts'] },
      { id: 'history', name: 'History & Culture', keywords: ['historical', 'cultural'] },
      { id: 'language', name: 'Language Learning', keywords: ['learn', 'vocabulary'] }
    ]
  },

  // Business & Finance
  business: {
    name: 'Business & Finance',
    icon: '💰',
    subniches: [
      { id: 'investing', name: 'Investing & Trading', keywords: ['stocks', 'crypto', 'markets'] },
      { id: 'entrepreneurship', name: 'Entrepreneurship', keywords: ['startup', 'business tips'] },
      { id: 'productivity', name: 'Productivity & Success', keywords: ['habits', 'efficiency'] },
      { id: 'career', name: 'Career & Jobs', keywords: ['interview', 'resume', 'skills'] },
      { id: 'money-tips', name: 'Money Tips', keywords: ['saving', 'budgeting', 'wealth'] }
    ]
  },

  // Health & Wellness
  health: {
    name: 'Health & Wellness',
    icon: '💪',
    subniches: [
      { id: 'fitness', name: 'Fitness & Exercise', keywords: ['workout', 'gym', 'training'] },
      { id: 'nutrition', name: 'Nutrition & Diet', keywords: ['food', 'healthy eating', 'recipes'] },
      { id: 'mental-health', name: 'Mental Health', keywords: ['mindfulness', 'stress', 'anxiety'] },
      { id: 'meditation', name: 'Meditation & Relaxation', keywords: ['calm', 'peace', 'sleep'] },
      { id: 'self-improvement', name: 'Self Improvement', keywords: ['growth', 'habits', 'motivation'] }
    ]
  },

  // Technology
  technology: {
    name: 'Technology',
    icon: '💻',
    subniches: [
      { id: 'tech-reviews', name: 'Tech Reviews', keywords: ['review', 'unboxing', 'comparison'] },
      { id: 'ai-tech', name: 'AI & Future Tech', keywords: ['artificial intelligence', 'innovation'] },
      { id: 'coding', name: 'Coding & Development', keywords: ['programming', 'software'] },
      { id: 'gadgets', name: 'Gadgets & Apps', keywords: ['devices', 'tools', 'apps'] },
      { id: 'gaming-tech', name: 'Gaming', keywords: ['games', 'gameplay', 'reviews'] }
    ]
  },

  // Creative & Arts
  creative: {
    name: 'Creative & Arts',
    icon: '🎨',
    subniches: [
      { id: 'art-tutorials', name: 'Art Tutorials', keywords: ['drawing', 'painting', 'design'] },
      { id: 'music', name: 'Music & Audio', keywords: ['songs', 'beats', 'instruments'] },
      { id: 'photography', name: 'Photography', keywords: ['photos', 'editing', 'tips'] },
      { id: 'diy-crafts', name: 'DIY & Crafts', keywords: ['handmade', 'create', 'projects'] },
      { id: 'animation', name: 'Animation & Motion', keywords: ['animate', 'motion graphics'] }
    ]
  },

  // Travel & Lifestyle
  travel: {
    name: 'Travel & Lifestyle',
    icon: '✈️',
    subniches: [
      { id: 'travel-guides', name: 'Travel Guides', keywords: ['destination', 'places', 'tips'] },
      { id: 'food-travel', name: 'Food & Cuisine', keywords: ['restaurants', 'recipes', 'cooking'] },
      { id: 'luxury', name: 'Luxury & Lifestyle', keywords: ['expensive', 'high-end', 'exclusive'] },
      { id: 'minimalism', name: 'Minimalism', keywords: ['simple', 'declutter', 'less'] },
      { id: 'adventure', name: 'Adventure & Outdoors', keywords: ['hiking', 'nature', 'extreme'] }
    ]
  },

  // Motivation & Inspiration
  motivation: {
    name: 'Motivation',
    icon: '🔥',
    subniches: [
      { id: 'motivational', name: 'Motivational Speeches', keywords: ['inspire', 'success', 'overcome'] },
      { id: 'quotes', name: 'Quotes & Affirmations', keywords: ['wisdom', 'positive', 'daily'] },
      { id: 'success-stories', name: 'Success Stories', keywords: ['journey', 'achievement', 'transformation'] },
      { id: 'life-lessons', name: 'Life Lessons', keywords: ['advice', 'experience', 'wisdom'] },
      { id: 'spirituality', name: 'Spirituality', keywords: ['faith', 'purpose', 'meaning'] }
    ]
  },

  // News & Current Events
  news: {
    name: 'News & Commentary',
    icon: '📰',
    subniches: [
      { id: 'world-news', name: 'World News', keywords: ['breaking', 'global', 'events'] },
      { id: 'politics', name: 'Politics', keywords: ['government', 'policy', 'elections'] },
      { id: 'sports', name: 'Sports', keywords: ['games', 'highlights', 'analysis'] },
      { id: 'social-commentary', name: 'Social Commentary', keywords: ['society', 'trends', 'opinion'] }
    ]
  }
};
```

---

## 3. Video Style System

### Visual Styles

```javascript
const VIDEO_STYLES = {
  // Modern & Trendy
  modern: {
    name: 'Modern Minimalist',
    icon: '✨',
    description: 'Clean, sleek aesthetics with bold typography',
    imagePromptModifiers: 'minimalist, clean design, modern aesthetic, solid colors, geometric shapes',
    transitionStyle: 'smooth-fade',
    colorPalette: 'modern-neutral',
    typography: 'sans-serif-bold',
    pacing: 'medium'
  },

  cinematic: {
    name: 'Cinematic',
    icon: '🎬',
    description: 'Movie-quality visuals with dramatic lighting',
    imagePromptModifiers: 'cinematic lighting, dramatic, film quality, depth of field, professional photography',
    transitionStyle: 'cinematic-fade',
    colorPalette: 'cinematic-grade',
    typography: 'elegant-serif',
    pacing: 'slow'
  },

  energetic: {
    name: 'Energetic & Dynamic',
    icon: '⚡',
    description: 'Fast-paced, bold colors, high energy',
    imagePromptModifiers: 'vibrant colors, dynamic composition, energetic, bold, eye-catching',
    transitionStyle: 'quick-cuts',
    colorPalette: 'vibrant',
    typography: 'bold-impact',
    pacing: 'fast'
  },

  documentary: {
    name: 'Documentary',
    icon: '📹',
    description: 'Authentic, raw, informative aesthetic',
    imagePromptModifiers: 'documentary style, realistic, photojournalistic, authentic, raw',
    transitionStyle: 'simple-cut',
    colorPalette: 'natural',
    typography: 'clean-readable',
    pacing: 'medium'
  },

  retro: {
    name: 'Retro/Vintage',
    icon: '📼',
    description: 'Nostalgic with film grain and warm tones',
    imagePromptModifiers: 'vintage aesthetic, retro style, film grain, warm tones, nostalgic, 80s/90s style',
    transitionStyle: 'vhs-glitch',
    colorPalette: 'vintage-warm',
    typography: 'retro',
    pacing: 'medium'
  },

  futuristic: {
    name: 'Futuristic/Sci-Fi',
    icon: '🚀',
    description: 'High-tech, neon, digital aesthetic',
    imagePromptModifiers: 'futuristic, sci-fi, neon lights, cyber, holographic, high-tech',
    transitionStyle: 'digital-glitch',
    colorPalette: 'neon-cyber',
    typography: 'tech-futuristic',
    pacing: 'medium-fast'
  },

  cartoon: {
    name: 'Animated/Cartoon',
    icon: '🎨',
    description: 'Illustrated, playful, animated style',
    imagePromptModifiers: 'cartoon style, illustrated, colorful, playful, digital art, animation style',
    transitionStyle: 'bounce',
    colorPalette: 'bright-playful',
    typography: 'fun-rounded',
    pacing: 'medium'
  },

  elegant: {
    name: 'Elegant & Luxury',
    icon: '👑',
    description: 'Sophisticated, premium, high-end',
    imagePromptModifiers: 'luxury, elegant, sophisticated, premium quality, gold accents, refined',
    transitionStyle: 'smooth-elegant',
    colorPalette: 'luxury-dark',
    typography: 'serif-elegant',
    pacing: 'slow'
  },

  nature: {
    name: 'Nature & Organic',
    icon: '🌿',
    description: 'Natural, earthy, calming aesthetic',
    imagePromptModifiers: 'natural, organic, earthy tones, peaceful, nature photography, serene',
    transitionStyle: 'soft-dissolve',
    colorPalette: 'earth-natural',
    typography: 'organic-soft',
    pacing: 'slow'
  },

  dark: {
    name: 'Dark & Moody',
    icon: '🌙',
    description: 'Dramatic, shadowy, mysterious',
    imagePromptModifiers: 'dark mood, dramatic shadows, mysterious, noir style, moody lighting',
    transitionStyle: 'fade-dark',
    colorPalette: 'dark-dramatic',
    typography: 'bold-dark',
    pacing: 'medium'
  }
};
```

---

## 4. Wizard Flow Architecture

### Step-by-Step Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    VIDEO CREATION WIZARD                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  STEP 1: Platform & Format Selection                            │
│  ├── Select target platform (YouTube, TikTok, Instagram, etc.) │
│  ├── Choose aspect ratio (based on platform options)           │
│  └── Select video length preset or custom duration             │
│                                                                 │
│  STEP 2: Niche & Style Configuration                           │
│  ├── Select primary niche category                              │
│  ├── Choose sub-niche                                           │
│  ├── Select visual style                                        │
│  └── Optional: Add topic/theme description                      │
│                                                                 │
│  STEP 3: AI Script Generation                                   │
│  ├── AI generates complete video script                         │
│  ├── Script divided into scenes with:                          │
│  │   ├── Scene narration/dialogue                               │
│  │   ├── Visual description                                     │
│  │   ├── Duration estimate                                      │
│  │   └── Character/speaker info (if talking head)              │
│  ├── User can edit script                                       │
│  └── Regenerate options per scene                               │
│                                                                 │
│  STEP 4: Storyboard & Image Generation                         │
│  ├── Visual storyboard grid showing all scenes                 │
│  ├── Generate images for each scene (Nanobananapro)            │
│  ├── Multiple image variants per scene                          │
│  ├── Select or regenerate images                                │
│  └── Character consistency using reference images              │
│                                                                 │
│  STEP 5: Animation & Video Generation                          │
│  ├── Generate voiceover for narration (TTS)                    │
│  ├── Animate images → video (Runpod Multi-talk)                │
│  ├── Options for:                                               │
│  │   ├── Talking character scenes (lip-sync)                   │
│  │   ├── Ken Burns effect (zoom/pan)                           │
│  │   └── Static with transitions                               │
│  └── Preview individual scene animations                        │
│                                                                 │
│  STEP 6: Video Assembly & Preview                              │
│  ├── Full video preview with all scenes combined                │
│  ├── Add/edit:                                                  │
│  │   ├── Background music                                       │
│  │   ├── Captions/subtitles                                     │
│  │   ├── Transitions between scenes                             │
│  │   └── Audio mixing (voice/music balance)                    │
│  └── Scene reordering drag & drop                              │
│                                                                 │
│  STEP 7: Export & Publish                                      │
│  ├── Final rendering with GPU                                   │
│  ├── Export options (quality, format)                          │
│  ├── Download video                                             │
│  └── Optional: Direct publish to platforms                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Data Models

### Project State Structure

```javascript
const videoCreationState = {
  // Project metadata
  projectId: null,
  userId: null,
  projectName: 'Untitled Video',
  createdAt: null,
  updatedAt: null,

  // Current wizard step
  currentStep: 1,

  // Step 1: Platform & Format
  platform: {
    selected: 'youtube-shorts',
    preset: PLATFORM_PRESETS['youtube-shorts'],
    aspectRatio: '9:16',
    resolution: { width: 1080, height: 1920 },
    targetDuration: 60, // seconds
    fps: 30
  },

  // Step 2: Niche & Style
  content: {
    niche: null,           // 'entertainment'
    subniche: null,        // 'comedy'
    style: null,           // 'modern'
    topic: '',             // User-provided topic/theme
    tone: 'engaging',      // casual, professional, humorous, serious
    targetAudience: '',    // Optional audience description
  },

  // Step 3: Script
  script: {
    status: 'idle',        // idle, generating, ready, error
    title: '',
    hook: '',              // Opening hook line
    scenes: [],            // Array of scene objects
    cta: '',               // Call to action
    totalDuration: 0,      // Calculated from scenes
    wordCount: 0
  },

  // Step 4: Storyboard
  storyboard: {
    status: 'idle',
    scenes: [],            // Array with images
    characterReference: null,  // For consistency
    styleReference: null
  },

  // Step 5: Animation
  animation: {
    status: 'idle',
    scenes: [],            // Scenes with video URLs
    voiceover: {
      voice: 'default',
      speed: 1.0,
      status: 'idle'
    }
  },

  // Step 6: Assembly
  assembly: {
    status: 'idle',
    sceneOrder: [],        // Scene IDs in order
    transitions: {},       // Per-scene transition settings
    music: {
      enabled: false,
      trackId: null,
      volume: 30
    },
    captions: {
      enabled: true,
      style: 'karaoke',
      position: 'bottom'
    },
    audioMix: {
      voiceVolume: 100,
      musicVolume: 30
    }
  },

  // Step 7: Export
  export: {
    status: 'idle',
    jobId: null,
    progress: 0,
    outputUrl: null
  },

  // Token tracking
  tokens: {
    used: 0,
    breakdown: {
      scriptGeneration: 0,
      imageGeneration: 0,
      voiceGeneration: 0,
      videoAnimation: 0,
      export: 0
    }
  }
};

// Scene object structure
const sceneObject = {
  id: 'scene_001',
  order: 1,

  // Script data
  narration: 'The spoken text for this scene...',
  visualDescription: 'Description of what should be shown...',
  duration: 5,           // seconds
  speakerType: 'voiceover', // voiceover, talking-head, none
  speakerName: null,     // For talking head

  // Image data
  images: [],            // Generated image variants
  selectedImageIndex: 0,
  imagePrompt: '',       // Final prompt used

  // Animation data
  animationType: 'ken-burns',  // ken-burns, talking-head, static
  animationSettings: {},
  videoUrl: null,        // Generated video segment

  // Audio data
  voiceoverUrl: null,
  voiceoverDuration: 0,

  // Transition
  transitionIn: 'fade',
  transitionOut: 'fade'
};
```

### Firestore Collection Structure

```
/videoCreationProjects/{projectId}
  - userId: string
  - projectName: string
  - platform: object
  - content: object
  - script: object
  - createdAt: timestamp
  - updatedAt: timestamp
  - status: 'draft' | 'processing' | 'complete'

/videoCreationProjects/{projectId}/scenes/{sceneId}
  - order: number
  - narration: string
  - visualDescription: string
  - images: array
  - videoUrl: string
  - ...scene data

/videoCreationHistory/{historyId}
  - userId: string
  - projectId: string
  - outputUrl: string
  - exportedAt: timestamp
  - platform: string
  - duration: number
```

---

## 6. API Architecture

### Cloud Functions Required

```javascript
// 1. Script Generation
exports.videoCreation_generateScript = functions.https.onCall(async (data, context) => {
  // Uses Claude API to generate video script
  // Input: platform, niche, style, topic, duration
  // Output: { title, hook, scenes[], cta }
});

// 2. Scene Image Generation (reuse creative studio)
exports.videoCreation_generateSceneImage = functions.https.onCall(async (data, context) => {
  // Uses Nanobananapro/Imagen
  // Input: visualDescription, style modifiers, aspectRatio, characterRef
  // Output: { images[], prompt }
});

// 3. Voiceover Generation
exports.videoCreation_generateVoiceover = functions.https.onCall(async (data, context) => {
  // Uses ElevenLabs or Google TTS
  // Input: text, voice, speed
  // Output: { audioUrl, duration }
});

// 4. Scene Animation (Runpod)
exports.videoCreation_animateScene = functions.https.onCall(async (data, context) => {
  // Uses Runpod Multi-talk API
  // Input: imageUrl, audioUrl, animationType
  // Output: { videoUrl, duration }
});

// 5. Video Assembly & Export
exports.videoCreation_assembleVideo = functions.https.onCall(async (data, context) => {
  // Uses existing GPU pipeline (FFmpeg)
  // Input: scenes[], transitions, music, captions
  // Output: { jobId }
});

// 6. Project Management
exports.videoCreation_saveProject = functions.https.onCall(...);
exports.videoCreation_loadProject = functions.https.onCall(...);
exports.videoCreation_deleteProject = functions.https.onCall(...);
```

### Runpod Integration

```javascript
// Runpod Multi-talk API Integration
const animateWithRunpod = async ({ imageUrl, audioUrl, animationType }) => {
  const runpodEndpoint = process.env.RUNPOD_MULTITALK_ENDPOINT;

  const payload = {
    input: {
      image_url: imageUrl,
      audio_url: audioUrl,
      animation_type: animationType, // 'talking_head' | 'ken_burns' | 'static'
      // For talking head:
      lip_sync: true,
      head_motion: true,
      eye_blink: true,
      // For ken burns:
      zoom_direction: 'in', // 'in' | 'out' | 'none'
      pan_direction: 'left', // 'left' | 'right' | 'up' | 'down' | 'none'
      motion_intensity: 0.3 // 0.0 - 1.0
    }
  };

  const response = await fetch(`${runpodEndpoint}/run`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RUNPOD_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  return response.json();
};
```

---

## 7. Token Economy

### Cost Structure

| Action | Token Cost | Notes |
|--------|------------|-------|
| Script Generation | 5 | Per full script |
| Script Regeneration | 2 | Per scene |
| Image Generation | 2 | Per image (HD quality) |
| Voiceover Generation | 1 | Per 30 seconds |
| Scene Animation | 5 | Per scene (Runpod cost) |
| Video Export | 3 | Per video |
| **Typical Short (60s, 6 scenes)** | ~50-60 | Full workflow |
| **Typical Long (5min, 20 scenes)** | ~150-180 | Full workflow |

---

## 8. UI/UX Design Specifications

### Layout Structure

```
┌──────────────────────────────────────────────────────────────────┐
│  HEADER: Logo | Project Name | Tokens: 150 | Save | Settings     │
├──────────────────────────────────────────────────────────────────┤
│  STEPPER: [1]─[2]─[3]─[4]─[5]─[6]─[7]                           │
├─────────────────────────────┬────────────────────────────────────┤
│                             │                                    │
│                             │                                    │
│      MAIN CONTENT           │       PREVIEW / SIDEBAR            │
│      (Step-specific UI)     │       (Contextual preview)         │
│                             │                                    │
│                             │                                    │
│                             │                                    │
│                             │                                    │
├─────────────────────────────┴────────────────────────────────────┤
│  FOOTER: Back | Next | Skip (if applicable)                      │
└──────────────────────────────────────────────────────────────────┘
```

### Step-Specific UI Components

**Step 1 (Platform):**
- Platform card grid with icons
- Format selector (shows only available formats)
- Duration slider with presets
- Platform-specific tips

**Step 2 (Niche):**
- Niche category grid
- Sub-niche dropdown/chips
- Style carousel with previews
- Topic input with AI suggestions

**Step 3 (Script):**
- Full script editor with scene dividers
- Scene cards with:
  - Narration text (editable)
  - Visual description (editable)
  - Duration estimate
  - Regenerate button
- Total duration tracker
- Script tips based on platform

**Step 4 (Storyboard):**
- Scene grid with image thumbnails
- Per-scene:
  - 3-4 image variants
  - Select/regenerate options
  - Edit prompt modal
- Character reference upload
- Style consistency indicator

**Step 5 (Animation):**
- Scene timeline
- Per-scene animation options:
  - Animation type selector
  - Preview button
  - Progress indicator
- Voice settings panel
- Batch generate option

**Step 6 (Assembly):**
- Video timeline with scene thumbnails
- Drag-to-reorder scenes
- Transition selector between scenes
- Music library sidebar
- Caption style selector
- Full preview player

**Step 7 (Export):**
- Export settings summary
- Quality options
- Progress bar
- Download button
- Share options

---

## 9. Implementation Phases

### Phase 1: Foundation (Week 1-2)
- [ ] Create `frontend/video-creation-wizard.html`
- [ ] Implement wizard step navigation
- [ ] Build platform/format selection UI
- [ ] Build niche/style selection UI
- [ ] Create Firestore data models
- [ ] Set up project save/load functions

### Phase 2: Script Generation (Week 2-3)
- [ ] Implement Claude API script generation
- [ ] Build script editor UI
- [ ] Scene management (add/remove/edit)
- [ ] Script regeneration per scene
- [ ] Duration calculation logic

### Phase 3: Storyboard (Week 3-4)
- [ ] Integrate Nanobananapro for image generation
- [ ] Build storyboard grid UI
- [ ] Implement character reference consistency
- [ ] Multi-variant image generation
- [ ] Image selection and regeneration

### Phase 4: Animation (Week 4-5)
- [ ] Set up Runpod Multi-talk integration
- [ ] Implement voiceover generation (ElevenLabs/Google TTS)
- [ ] Build animation options UI
- [ ] Ken Burns effect implementation
- [ ] Talking head animation integration

### Phase 5: Assembly (Week 5-6)
- [ ] Build video timeline UI
- [ ] Implement scene reordering
- [ ] Add transition system
- [ ] Integrate music library
- [ ] Caption overlay system
- [ ] Full preview player

### Phase 6: Export & Polish (Week 6-7)
- [ ] Integrate with existing GPU export pipeline
- [ ] Export progress tracking
- [ ] Final video preview
- [ ] Download and share options
- [ ] Error handling and recovery
- [ ] Performance optimization

### Phase 7: Testing & Launch (Week 7-8)
- [ ] End-to-end testing
- [ ] User acceptance testing
- [ ] Performance testing
- [ ] Bug fixes
- [ ] Documentation
- [ ] Launch preparation

---

## 10. Technical Considerations

### Performance Optimization

1. **Lazy Loading**: Load scene data on-demand
2. **Image Caching**: Cache generated images in state
3. **Progressive Generation**: Generate images/animations in parallel
4. **Chunked Uploads**: Handle large video files properly
5. **WebSocket Progress**: Real-time export progress updates

### Error Handling

1. **Retry Logic**: Exponential backoff for API failures
2. **Partial Recovery**: Save progress at each step
3. **Graceful Degradation**: Fallback options for animation failures
4. **User Feedback**: Clear error messages with recovery options

### Security

1. **Auth Required**: All endpoints require Firebase Auth
2. **Rate Limiting**: Prevent abuse
3. **Content Moderation**: Filter inappropriate content
4. **Token Validation**: Ensure sufficient balance before operations

---

## 11. File Structure

```
frontend/
├── video-creation-wizard.html    # Main wizard page
├── css/
│   └── video-creation.css        # Wizard-specific styles
└── js/
    └── video-creation/
        ├── state.js              # State management
        ├── api.js                # API calls
        ├── render.js             # UI rendering
        └── utils.js              # Utilities

functions/
├── video-creation/
│   ├── generateScript.js         # Claude script generation
│   ├── generateSceneImage.js     # Image generation
│   ├── generateVoiceover.js      # TTS generation
│   ├── animateScene.js           # Runpod animation
│   └── assembleVideo.js          # FFmpeg assembly
└── index.js                      # Export all functions

services/video-processor/
├── src/
│   ├── video-creation-processor.js  # New processor for this workflow
│   └── scene-animator.js            # Animation handling
```

---

## 12. Success Metrics

- **Completion Rate**: % of users completing full wizard
- **Time to First Video**: Average time from start to export
- **Regeneration Rate**: How often users regenerate content
- **Export Success Rate**: % of successful exports
- **User Satisfaction**: Feedback and ratings
- **Token Efficiency**: Cost per completed video

---

## Sources & References

### Platform Specifications
- [YouTube Video Dimensions Guide](https://www.descript.com/blog/article/the-ultimate-guide-to-youtube-video-sizes)
- [TikTok Video Size Guide](https://fliki.ai/blog/tiktok-video-size)
- [Instagram Reels Specifications](https://influencermarketinghub.com/instagram-video-size/)
- [Facebook Video Format Guide](https://sproutsocial.com/insights/social-media-video-specs-guide/)
- [LinkedIn Video Specifications](https://www.linkedin.com/help/linkedin/answer/a1311816)

### AI Video Generation
- [Runpod Serverless Deployment](https://www.runpod.io/blog/deploy-comfyui-as-a-serverless-api-endpoint)
- [Hedra AI Lip Sync](https://www.hedra.com/blog/ai-lip-sync-video-guide)
- [AI Storyboarding Guide 2025](https://lumacreative.com/ai-storyboarding-guide-2025/)

### Content Niches
- [Faceless YouTube Niches 2025](https://maestra.ai/blogs/top-faceless-youtube-niches)
- [TikTok Niches Guide](https://www.zebracat.ai/post/best-tiktok-faceless-niches)

### Design Trends
- [Video Aesthetics 2025](https://www.kapwing.com/resources/aesthetics-for-2025-colors-fonts-and-design-trends-for-video/)
- [Video Editing Trends 2025](https://pixflow.net/blog/top-video-editing-trends-2025/)
