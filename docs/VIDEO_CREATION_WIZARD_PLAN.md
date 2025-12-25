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

## 7. Scene Generation & Video Animation Architecture (EXPANDED)

This section details the core video generation system - the most critical component for creating professional, cinematic videos with seamless scene transitions.

### 7.1 Video Generation Engine Options

We have TWO video generation engines available:

| Engine | Max Duration | Cost | Best For | Quality |
|--------|-------------|------|----------|---------|
| **Runpod Multi-talk** | 15 seconds/clip | ~$0.03-0.05/clip | Talking heads, image animation | Good |
| **Google Veo 3.1** | 8 seconds (extendable to ~148s) | $0.15-0.40/second | Pure AI generation, complex motion | Excellent |

#### Runpod Multi-talk (Primary - Cost-Effective)
```javascript
const RUNPOD_MULTITALK_CONFIG = {
  endpoint: 'https://api.runpod.ai/v2/mekewddvpqb0b4/run',
  maxClipDuration: 15, // seconds
  supportedAnimations: ['talking_head', 'ken_burns', 'static'],
  inputFormats: ['image + audio'],
  outputFormat: 'mp4',
  estimatedCost: 0.04, // per 15-second clip
  coldStartTime: '10-30 seconds',
  gpuTypes: ['141 GB', '80 GB Pro', '96 GB']
};
```

#### Google Veo 3.1 (Premium Option)
```javascript
const VEO_CONFIG = {
  model: 'veo-3.1-generate-preview',
  baseDuration: 8,              // seconds per generation
  maxExtensions: 20,            // can extend 20 times
  extensionDuration: 7,         // seconds per extension
  maxTotalDuration: 148,        // seconds (~2.5 minutes)
  supportedAspectRatios: ['9:16', '16:9'],
  resolution: '1080p',
  nativeAudio: true,            // Generates synchronized audio!
  pricing: {
    fast: 0.15,                 // per second
    standard: 0.40              // per second
  },
  capabilities: [
    'video_extension',          // Extend existing clips
    'frame_specific',           // First/last frame control
    'image_reference',          // Up to 3 reference images
    'native_audio',             // Dialogue, effects, music
    'realistic_physics'         // Natural motion
  ]
};
```

### 7.2 Scene Duration Architecture

#### Scene Duration Rules by Video Length

```javascript
const SCENE_DURATION_RULES = {
  // Short-form content (15-60 seconds)
  short: {
    maxDuration: 60,
    idealSceneDuration: 8,      // 8 seconds optimal for engagement
    minSceneDuration: 5,
    maxSceneDuration: 15,
    scenesCount: { min: 4, max: 8, ideal: 6 },
    pacingNotes: 'Fast cuts, high energy, hook in first 2 seconds'
  },

  // Medium content (1-3 minutes)
  medium: {
    maxDuration: 180,
    idealSceneDuration: 12,
    minSceneDuration: 8,
    maxSceneDuration: 15,
    scenesCount: { min: 8, max: 15, ideal: 12 },
    pacingNotes: 'Balanced pacing, allow story development'
  },

  // Long-form content (3-5 minutes)
  long: {
    maxDuration: 300,
    idealSceneDuration: 15,
    minSceneDuration: 10,
    maxSceneDuration: 20,       // May require Veo extension or stitching
    scenesCount: { min: 15, max: 25, ideal: 20 },
    pacingNotes: 'Slower pacing, detailed storytelling, chapter-like structure'
  }
};
```

#### Scene Segment Strategy

For a 15-second Multi-talk limit, we structure scenes intelligently:

```javascript
const SCENE_SEGMENTATION = {
  // Single-segment scenes (≤15 seconds)
  simple: {
    maxDuration: 15,
    structure: 'One continuous shot',
    useCase: 'Talking head, simple narration, single visual'
  },

  // Multi-segment scenes (>15 seconds, requires stitching)
  complex: {
    segmentDuration: 15,
    transitionBetweenSegments: 'match-cut', // Seamless transition
    structure: 'Multiple 15s clips with matching end/start frames',
    useCase: 'Extended explanations, complex narratives'
  },

  // Veo-extended scenes (premium, up to 148s)
  extended: {
    baseDuration: 8,
    extensions: 'up to 20x 7-second extensions',
    structure: 'Single continuous generation with extensions',
    useCase: 'Long takes, complex motion, premium content'
  }
};
```

### 7.3 Scene Continuity System

The KEY to professional video output is seamless scene transitions.

#### Visual Continuity Framework

```javascript
const VISUAL_CONTINUITY = {
  // Environment Consistency
  environment: {
    rule: 'Maintain consistent environment across related scenes',
    implementation: {
      // Store environment details in scene context
      context: {
        location: 'modern office',
        timeOfDay: 'afternoon',
        weather: 'sunny',
        lighting: 'natural side light',
        colorTemperature: 'warm (5500K)'
      },
      // Propagate to subsequent scene prompts
      promptPrefix: 'Maintaining the same {location} environment with {lighting} lighting, {timeOfDay} time of day'
    }
  },

  // Character Consistency
  character: {
    rule: 'Same character appearance across all scenes',
    implementation: {
      // Use Nanobananapro reference image feature
      referenceImage: {
        characterRef: 'uploaded_character_image_url',
        styleRef: 'uploaded_style_image_url'
      },
      // Character description for prompts
      characterDescription: {
        appearance: 'detailed physical description',
        clothing: 'specific outfit details',
        distinguishingFeatures: 'any unique features'
      },
      // Prompt modifier
      promptModifier: 'The same character as shown in the reference image, wearing {clothing}, with {distinguishingFeatures}'
    }
  },

  // Style Consistency
  style: {
    rule: 'Uniform visual style throughout',
    implementation: {
      // Style spine - defined once, applied everywhere
      styleSpine: {
        colorGrade: 'teal-and-orange cinematic',
        contrast: 'high',
        saturation: 'slightly desaturated',
        filmGrain: 'subtle 16mm grain',
        lensStyle: 'anamorphic bokeh'
      },
      // Applied as suffix to every prompt
      styleSuffix: '{colorGrade} color grading, {contrast} contrast, {filmGrain}, shot on {lensStyle}'
    }
  }
};
```

#### Camera Continuity Framework

```javascript
const CAMERA_CONTINUITY = {
  // The 180-degree rule
  spatialContinuity: {
    rule: 'Maintain consistent screen direction',
    implementation: 'Track character positions (left/right) across cuts'
  },

  // Matching camera movements
  movementMatching: {
    rule: 'End movement of scene N should match start of scene N+1',
    patterns: {
      // If scene ends with zoom-in, next scene starts zoomed
      'zoom_in_end': 'close_up_start',
      'pan_right_end': 'pan_right_continue_or_static',
      'dolly_forward_end': 'close_subject_start',
      'static_end': 'any_start'
    }
  },

  // Eye-line matching
  eyeLineMatching: {
    rule: 'Subject gaze direction should make sense across cuts',
    implementation: 'Track where subjects are looking relative to camera'
  }
};
```

#### Transition Matching System

```javascript
const TRANSITION_MATCHING = {
  // Scene ending → Scene beginning pairs for seamless cuts
  matchPairs: {
    // Visual matching
    visual: {
      'dark_frame_end': 'dark_frame_begin',       // Fade through black
      'bright_frame_end': 'bright_frame_begin',   // Fade through white
      'blur_end': 'blur_begin',                   // Match dissolve
      'subject_center_end': 'subject_center_begin' // Direct cut
    },

    // Motion matching
    motion: {
      'zoom_in_fast': 'zoom_out_from_detail',     // Seamless zoom transition
      'pan_left': 'pan_left_continue',            // Continuous pan
      'static_on_subject': 'static_on_subject',   // Clean cut
      'whip_pan_right': 'whip_pan_left_settle'    // Whip pan transition
    },

    // Content matching
    content: {
      'closeup_eye': 'wideshot_same_subject',     // Eye to full body
      'object_detail': 'object_in_context',        // Detail to context
      'silhouette': 'lit_reveal'                   // Shadow to light reveal
    }
  },

  // Auto-generate transition prompts
  generateTransitionPrompts: (endScene, startScene) => {
    return {
      endFrameHint: `Scene ends with ${endScene.transitionOut} focusing on ${endScene.focusElement}`,
      startFrameHint: `Scene begins with ${startScene.transitionIn} from ${startScene.openingElement}`
    };
  }
};
```

### 7.4 Cinematic Prompt Engineering System

The prompt system is the brain of video generation. AI models understand professional cinematography terminology.

#### Master Prompt Structure

```javascript
const CINEMATIC_PROMPT_STRUCTURE = {
  // Optimal prompt order for best results
  order: [
    'shot_type',           // 1. What kind of shot
    'subject_action',      // 2. Who/what is doing what
    'environment',         // 3. Where
    'camera_movement',     // 4. How camera moves
    'lens_specification',  // 5. Technical look
    'lighting',            // 6. Light quality
    'atmosphere',          // 7. Mood/feeling
    'style_modifiers'      // 8. Visual style
  ],

  // Template
  template: '{shot_type} of {subject} {action} in {environment}, {camera_movement}, {lens}, {lighting}, {atmosphere}, {style}',

  // Example
  example: 'Medium close-up of a confident businessman presenting to an audience in a modern glass office, slow dolly-in, 50mm lens with shallow depth of field, soft side lighting from large windows, professional and inspiring atmosphere, cinematic color grading with slight orange and teal tones'
};
```

#### Shot Type Library

```javascript
const SHOT_TYPES = {
  // Distance-based shots
  distance: {
    'extreme_wide': {
      description: 'Shows vast environment, subject very small',
      useCase: 'Establishing shots, epic scale',
      promptText: 'Extreme wide shot',
      alternates: ['aerial view', 'panoramic shot', 'God\'s eye view']
    },
    'wide': {
      description: 'Full environment visible, subject in context',
      useCase: 'Establishing location, showing action in space',
      promptText: 'Wide shot',
      alternates: ['long shot', 'full shot', 'master shot']
    },
    'medium_wide': {
      description: 'Subject from knees up with environment',
      useCase: 'Group shots, walking scenes',
      promptText: 'Medium wide shot',
      alternates: ['American shot', '3/4 shot']
    },
    'medium': {
      description: 'Subject from waist up',
      useCase: 'Dialogue, presentations, demonstrations',
      promptText: 'Medium shot',
      alternates: ['mid shot', 'waist shot']
    },
    'medium_closeup': {
      description: 'Subject from chest up',
      useCase: 'Conversations, emotional moments',
      promptText: 'Medium close-up',
      alternates: ['MCU', 'bust shot']
    },
    'closeup': {
      description: 'Face fills frame',
      useCase: 'Emotion, reaction, emphasis',
      promptText: 'Close-up',
      alternates: ['CU', 'head shot']
    },
    'extreme_closeup': {
      description: 'Detail of face or object',
      useCase: 'Intense emotion, important details',
      promptText: 'Extreme close-up',
      alternates: ['ECU', 'detail shot', 'macro shot']
    }
  },

  // Angle-based shots
  angle: {
    'eye_level': {
      description: 'Camera at subject eye height',
      useCase: 'Neutral, natural perspective',
      promptText: 'Eye-level angle'
    },
    'low_angle': {
      description: 'Camera below subject looking up',
      useCase: 'Power, dominance, heroism',
      promptText: 'Low angle shot'
    },
    'high_angle': {
      description: 'Camera above subject looking down',
      useCase: 'Vulnerability, overview, surveillance',
      promptText: 'High angle shot'
    },
    'dutch_angle': {
      description: 'Camera tilted on axis',
      useCase: 'Tension, disorientation, unease',
      promptText: 'Dutch angle',
      alternates: ['tilted frame', 'canted angle']
    },
    'birds_eye': {
      description: 'Directly overhead',
      useCase: 'Patterns, symmetry, disconnection',
      promptText: 'Bird\'s eye view',
      alternates: ['overhead shot', 'top-down']
    },
    'worms_eye': {
      description: 'Ground level looking up',
      useCase: 'Extreme power, monumentality',
      promptText: 'Worm\'s eye view',
      alternates: ['ground level shot']
    }
  },

  // Compositional shots
  composition: {
    'over_the_shoulder': {
      description: 'Behind one subject looking at another',
      useCase: 'Dialogue, connection between subjects',
      promptText: 'Over-the-shoulder shot',
      alternates: ['OTS', 'OTS shot']
    },
    'two_shot': {
      description: 'Two subjects in frame',
      useCase: 'Relationships, conversations',
      promptText: 'Two-shot'
    },
    'point_of_view': {
      description: 'What subject sees',
      useCase: 'Immersion, subjective experience',
      promptText: 'POV shot',
      alternates: ['first-person view', 'subjective shot']
    },
    'insert': {
      description: 'Close detail within larger scene',
      useCase: 'Important objects, hands, details',
      promptText: 'Insert shot',
      alternates: ['cutaway', 'detail insert']
    }
  }
};
```

#### Camera Movement Library

```javascript
const CAMERA_MOVEMENTS = {
  // Static
  static: {
    'locked_off': {
      description: 'Camera completely still on tripod',
      useCase: 'Stability, observation, formal scenes',
      promptText: 'Static tripod shot',
      intensity: 0
    }
  },

  // Pan movements (horizontal rotation)
  pan: {
    'pan_left': {
      description: 'Camera rotates left on axis',
      useCase: 'Following action, revealing space',
      promptText: 'Slow pan left',
      variants: ['slow pan left', 'fast pan left', 'whip pan left']
    },
    'pan_right': {
      description: 'Camera rotates right on axis',
      useCase: 'Following action, revealing space',
      promptText: 'Slow pan right',
      variants: ['slow pan right', 'fast pan right', 'whip pan right']
    }
  },

  // Tilt movements (vertical rotation)
  tilt: {
    'tilt_up': {
      description: 'Camera tilts upward',
      useCase: 'Revealing height, looking up at subject',
      promptText: 'Slow tilt up'
    },
    'tilt_down': {
      description: 'Camera tilts downward',
      useCase: 'Revealing depth, looking down',
      promptText: 'Slow tilt down'
    }
  },

  // Dolly movements (physical camera movement)
  dolly: {
    'dolly_in': {
      description: 'Camera moves toward subject',
      useCase: 'Increasing intensity, focusing attention',
      promptText: 'Slow dolly in',
      emotionalEffect: 'intimacy, tension, focus'
    },
    'dolly_out': {
      description: 'Camera moves away from subject',
      useCase: 'Revealing context, ending scenes',
      promptText: 'Slow dolly out',
      emotionalEffect: 'distance, revelation, conclusion'
    },
    'dolly_lateral': {
      description: 'Camera moves sideways',
      useCase: 'Tracking subject, revealing depth',
      promptText: 'Lateral tracking shot'
    }
  },

  // Zoom (lens-based, not physical)
  zoom: {
    'zoom_in': {
      description: 'Lens zooms toward subject (differs from dolly)',
      useCase: 'Quick emphasis, surprise, focus',
      promptText: 'Smooth zoom in',
      note: 'Creates flattening effect unlike dolly'
    },
    'zoom_out': {
      description: 'Lens zooms away from subject',
      useCase: 'Revealing, disorientation',
      promptText: 'Smooth zoom out'
    }
  },

  // Complex movements
  complex: {
    'tracking': {
      description: 'Camera follows moving subject',
      useCase: 'Following action, chase scenes',
      promptText: 'Tracking shot following subject'
    },
    'crane': {
      description: 'Camera rises or descends vertically',
      useCase: 'Dramatic reveals, establishing shots',
      promptText: 'Crane shot rising upward'
    },
    'orbit': {
      description: 'Camera circles around subject',
      useCase: 'Hero shots, emphasis, drama',
      promptText: 'Slow 180-degree orbit around subject'
    },
    'steadicam': {
      description: 'Smooth handheld following',
      useCase: 'Immersive following, documentary feel',
      promptText: 'Steadicam following shot'
    },
    'handheld': {
      description: 'Intentional camera shake',
      useCase: 'Urgency, realism, documentary',
      promptText: 'Handheld camera with subtle movement'
    }
  },

  // Ken Burns (for still image animation)
  kenBurns: {
    'push_in': {
      description: 'Slow zoom into image',
      useCase: 'Focus on detail, building intensity',
      promptText: 'Slow Ken Burns push in',
      parameters: { zoomStart: 1.0, zoomEnd: 1.3, duration: 15 }
    },
    'pull_out': {
      description: 'Slow zoom out from image',
      useCase: 'Revealing context',
      promptText: 'Slow Ken Burns pull out',
      parameters: { zoomStart: 1.3, zoomEnd: 1.0, duration: 15 }
    },
    'pan_with_zoom': {
      description: 'Pan across while zooming',
      useCase: 'Dynamic image exploration',
      promptText: 'Ken Burns pan right with subtle zoom in',
      parameters: { panDirection: 'right', panAmount: 0.2, zoomEnd: 1.15 }
    }
  }
};
```

#### Lighting Library

```javascript
const LIGHTING_STYLES = {
  // Natural lighting
  natural: {
    'golden_hour': {
      description: 'Warm, soft light during sunrise/sunset',
      useCase: 'Romantic, nostalgic, beautiful',
      promptText: 'Golden hour lighting with warm orange tones',
      colorTemp: '3000K-3500K'
    },
    'blue_hour': {
      description: 'Cool, soft light during twilight',
      useCase: 'Mysterious, melancholic, ethereal',
      promptText: 'Blue hour lighting with soft cool tones',
      colorTemp: '10000K+'
    },
    'overcast': {
      description: 'Soft, diffused daylight',
      useCase: 'Even lighting, no harsh shadows',
      promptText: 'Soft overcast daylight, diffused lighting'
    },
    'harsh_sun': {
      description: 'Direct, hard sunlight',
      useCase: 'Drama, contrast, outdoor realism',
      promptText: 'Harsh direct sunlight with strong shadows'
    },
    'window_light': {
      description: 'Natural light through windows',
      useCase: 'Interior scenes, soft modeling',
      promptText: 'Natural window light from the side'
    }
  },

  // Studio lighting
  studio: {
    'rembrandt': {
      description: 'Triangle of light on cheek',
      useCase: 'Dramatic portraits, classic look',
      promptText: 'Rembrandt lighting with triangle highlight on cheek'
    },
    'butterfly': {
      description: 'Light directly above, shadow under nose',
      useCase: 'Beauty, glamour, fashion',
      promptText: 'Butterfly lighting from above'
    },
    'split': {
      description: 'Half face lit, half in shadow',
      useCase: 'Drama, duality, mystery',
      promptText: 'Split lighting with half face in shadow'
    },
    'rim_light': {
      description: 'Light from behind creating edge glow',
      useCase: 'Separation, drama, ethereal',
      promptText: 'Strong rim light creating glowing edge around subject'
    },
    'three_point': {
      description: 'Key, fill, and back light',
      useCase: 'Standard professional lighting',
      promptText: 'Professional three-point lighting setup'
    }
  },

  // Atmospheric lighting
  atmospheric: {
    'neon': {
      description: 'Colorful artificial neon lights',
      useCase: 'Urban, cyberpunk, nightlife',
      promptText: 'Neon lighting with pink and blue tones'
    },
    'volumetric': {
      description: 'Light rays visible through atmosphere',
      useCase: 'Dramatic, ethereal, cinematic',
      promptText: 'Volumetric light rays through haze'
    },
    'chiaroscuro': {
      description: 'Strong contrast between light and dark',
      useCase: 'Drama, film noir, art',
      promptText: 'Chiaroscuro lighting with deep shadows and bright highlights'
    },
    'practical': {
      description: 'Light from visible sources in scene',
      useCase: 'Realism, immersion',
      promptText: 'Practical lighting from lamp in scene'
    }
  },

  // Time-based
  timeBased: {
    'morning': {
      promptText: 'Soft morning light, slightly cool tones'
    },
    'midday': {
      promptText: 'Bright midday sun, neutral color temperature'
    },
    'afternoon': {
      promptText: 'Warm afternoon light'
    },
    'evening': {
      promptText: 'Warm evening light transitioning to golden hour'
    },
    'night': {
      promptText: 'Night scene with artificial lighting'
    }
  }
};
```

#### Lens & Technical Specifications

```javascript
const LENS_SPECIFICATIONS = {
  // Focal lengths
  focalLength: {
    '14mm': {
      description: 'Ultra-wide angle',
      effect: 'Extreme distortion, vast space',
      useCase: 'Architecture, landscapes, dramatic effect'
    },
    '24mm': {
      description: 'Wide angle',
      effect: 'Expanded space, some distortion',
      useCase: 'Interiors, establishing shots'
    },
    '35mm': {
      description: 'Moderate wide',
      effect: 'Natural perspective with context',
      useCase: 'Documentary, walking shots, environmental portraits'
    },
    '50mm': {
      description: 'Normal/standard lens',
      effect: 'Closest to human eye perspective',
      useCase: 'Dialogue, natural scenes, versatile'
    },
    '85mm': {
      description: 'Short telephoto',
      effect: 'Flattering compression, beautiful bokeh',
      useCase: 'Portraits, close-ups, interviews'
    },
    '135mm': {
      description: 'Medium telephoto',
      effect: 'Strong compression, isolated subject',
      useCase: 'Portraits, emotional moments'
    },
    '200mm+': {
      description: 'Long telephoto',
      effect: 'Extreme compression, voyeuristic feel',
      useCase: 'Sports, wildlife, surveillance feel'
    }
  },

  // Depth of field
  depthOfField: {
    'shallow': {
      promptText: 'Shallow depth of field with soft bokeh background',
      aperture: 'f/1.4 - f/2.8',
      effect: 'Subject isolation, dreamy'
    },
    'medium': {
      promptText: 'Medium depth of field',
      aperture: 'f/4 - f/5.6',
      effect: 'Subject clear with recognizable background'
    },
    'deep': {
      promptText: 'Deep depth of field with everything in focus',
      aperture: 'f/8 - f/16',
      effect: 'Environmental context, documentary'
    }
  },

  // Special lens effects
  special: {
    'anamorphic': {
      promptText: 'Anamorphic lens with horizontal flares and oval bokeh',
      effect: 'Cinematic, widescreen feel'
    },
    'tilt_shift': {
      promptText: 'Tilt-shift effect with selective focus plane',
      effect: 'Miniature effect, unique focus'
    },
    'fisheye': {
      promptText: 'Fisheye lens with circular distortion',
      effect: 'Extreme wide, action sports feel'
    },
    'vintage': {
      promptText: 'Vintage lens with soft edges and warm color cast',
      effect: 'Nostalgic, dreamy'
    }
  }
};
```

### 7.5 Intelligent Prompt Generation Engine

```javascript
const generateCinematicPrompt = ({
  sceneDescription,
  style,
  previousScene,
  nextScene,
  aspectRatio,
  mood,
  characterRef
}) => {
  // 1. Determine optimal shot type based on content
  const shotType = analyzeContentForShotType(sceneDescription);

  // 2. Select camera movement based on pacing and previous scene
  const cameraMovement = selectCameraMovement({
    previousSceneEnding: previousScene?.cameraMovement,
    sceneContent: sceneDescription,
    pacing: style.pacing
  });

  // 3. Match lighting to mood and style
  const lighting = selectLighting({
    mood,
    style: style.colorPalette,
    timeOfDay: sceneDescription.timeOfDay
  });

  // 4. Select lens for desired effect
  const lens = selectLens({
    shotType,
    emotionalIntent: mood,
    style
  });

  // 5. Build atmosphere description
  const atmosphere = buildAtmosphere({
    mood,
    style,
    sceneDescription
  });

  // 6. Generate transition hints
  const transitionHints = generateTransitionHints({
    previousScene,
    nextScene
  });

  // 7. Assemble final prompt
  const prompt = assemblePrompt({
    shotType,
    subject: sceneDescription.subject,
    action: sceneDescription.action,
    environment: sceneDescription.environment,
    cameraMovement,
    lens,
    lighting,
    atmosphere,
    styleModifiers: style.imagePromptModifiers,
    characterReference: characterRef,
    transitionHints
  });

  return {
    prompt,
    metadata: {
      shotType,
      cameraMovement,
      lighting,
      lens,
      transitionIn: transitionHints.in,
      transitionOut: transitionHints.out
    }
  };
};

// Example output:
// "Medium close-up of a confident entrepreneur explaining a concept
// in a modern minimalist office, slow dolly-in toward subject,
// 50mm lens with shallow depth of field, soft natural window light
// from the left side, professional and inspiring atmosphere,
// cinematic color grading with subtle teal and orange tones,
// [scene ends with subject looking directly at camera for clean cut
// to next scene]"
```

### 7.6 Scene Blueprint System

Each scene requires a complete blueprint for consistent generation:

```javascript
const SCENE_BLUEPRINT = {
  // Basic identification
  id: 'scene_001',
  order: 1,

  // Content
  content: {
    narration: 'The spoken text for this scene',
    visualDescription: 'What happens visually',
    duration: 12,              // Target duration in seconds
    pacing: 'medium'           // slow, medium, fast
  },

  // Cinematic specifications
  cinematics: {
    shotType: 'medium_closeup',
    cameraMovement: 'slow_dolly_in',
    cameraAngle: 'eye_level',
    lens: '50mm',
    depthOfField: 'shallow',
    composition: 'rule_of_thirds_left'
  },

  // Environment
  environment: {
    location: 'modern office',
    timeOfDay: 'afternoon',
    weather: null,             // For outdoor scenes
    props: ['desk', 'laptop', 'plant']
  },

  // Lighting
  lighting: {
    primary: 'window_light',
    secondary: 'practical_lamp',
    mood: 'professional',
    colorTemperature: 'warm_neutral'
  },

  // Character (if present)
  character: {
    referenceImage: 'character_ref_url',
    appearance: 'Businessman in navy suit',
    expression: 'confident, engaged',
    action: 'explaining with hand gestures',
    eyeline: 'direct_to_camera'
  },

  // Style application
  style: {
    colorGrade: 'teal_orange_cinematic',
    filmGrain: 'subtle',
    contrast: 'high',
    saturation: 'slightly_desaturated'
  },

  // Transition planning
  transitions: {
    in: {
      type: 'cut',             // cut, fade, dissolve, wipe
      fromPrevious: 'match_action',
      hint: 'Continue from previous zoom momentum'
    },
    out: {
      type: 'cut',
      toNext: 'match_eyeline',
      hint: 'End on direct camera look for cut to different angle'
    }
  },

  // Generation options
  generation: {
    engine: 'runpod_multitalk',  // or 'veo_3.1'
    animationType: 'talking_head', // talking_head, ken_burns, pure_ai
    segments: 1,                // Number of 15s segments needed
    priority: 'quality'         // quality or speed
  },

  // Generated assets (filled after generation)
  assets: {
    imageVariants: [],
    selectedImage: null,
    voiceoverUrl: null,
    videoUrl: null,
    thumbnailUrl: null
  }
};
```

### 7.7 Cost Optimization Strategy

```javascript
const COST_STRATEGY = {
  // When to use each engine
  engineSelection: {
    runpod_multitalk: {
      conditions: [
        'Scene ≤ 15 seconds',
        'Talking head content',
        'Image + audio animation',
        'Budget-conscious',
        'Standard quality acceptable'
      ],
      costPerScene: '$0.03-0.05'
    },

    veo_3_1_fast: {
      conditions: [
        'Need native audio generation',
        'Complex motion required',
        'No source image available',
        'Extended duration (>15s)',
        'Moderate budget'
      ],
      costPerSecond: '$0.15'
    },

    veo_3_1_standard: {
      conditions: [
        'Premium quality required',
        'Complex cinematography',
        'Long continuous shots',
        'Professional output',
        'Budget available'
      ],
      costPerSecond: '$0.40'
    }
  },

  // Cost estimation
  estimateCost: (scenes, engine = 'auto') => {
    let total = 0;
    scenes.forEach(scene => {
      if (engine === 'auto') {
        // Auto-select based on scene requirements
        if (scene.duration <= 15 && scene.hasImage) {
          total += 0.04; // Multi-talk
        } else if (scene.duration <= 60) {
          total += scene.duration * 0.15; // Veo Fast
        } else {
          total += scene.duration * 0.40; // Veo Standard
        }
      }
    });
    return total;
  },

  // Token to dollar mapping
  tokenCostMapping: {
    runpod_15s: 3,      // tokens
    veo_fast_8s: 10,    // tokens
    veo_standard_8s: 25 // tokens
  }
};
```

### 7.8 End-Frame Conditioning for Seamless Transitions

```javascript
const END_FRAME_CONDITIONING = {
  // How to ensure seamless scene connections
  strategy: {
    // For Veo 3.1 - use frame-specific generation
    veo: {
      method: 'last_frame_specification',
      implementation: {
        // Generate scene N
        sceneN: 'Generate normally',
        // Extract last frame
        lastFrame: 'Extract final frame from scene N video',
        // Use as first frame for scene N+1
        sceneN1: 'Use last frame as first-frame reference for scene N+1'
      }
    },

    // For Multi-talk - use matching image generation
    multitalk: {
      method: 'matching_keyframes',
      implementation: {
        // Generate end keyframe for scene N
        endKeyframe: 'Generate image showing scene N ending state',
        // Generate start keyframe for scene N+1
        startKeyframe: 'Generate image showing scene N+1 start, matching end state',
        // Apply transitions in assembly
        transition: 'Use crossfade/morph between end and start keyframes'
      }
    }
  },

  // Transition types and their frame requirements
  transitionFrameRequirements: {
    'cut': {
      requirement: 'Match composition, lighting, color',
      frameOverlap: 0
    },
    'crossfade': {
      requirement: 'Similar brightness, compatible compositions',
      frameOverlap: 15 // frames
    },
    'morph': {
      requirement: 'Similar subject position and size',
      frameOverlap: 30
    },
    'match_cut': {
      requirement: 'Matching shapes or movements',
      frameOverlap: 0
    },
    'j_cut': {
      requirement: 'Audio continues over cut',
      frameOverlap: 0,
      audioOverlap: 24 // frames
    },
    'l_cut': {
      requirement: 'Video continues under new audio',
      frameOverlap: 0,
      audioOverlap: 24
    }
  }
};
```

### 7.9 Quality Assurance Checklist

```javascript
const QA_CHECKLIST = {
  // Per-scene validation
  perScene: {
    visual: [
      'Subject clearly visible and centered appropriately',
      'No artifacts or distortions',
      'Consistent lighting with scene blueprint',
      'Character appearance matches reference',
      'Color grade matches style spine'
    ],
    motion: [
      'Camera movement smooth, no jitters',
      'Motion matches prompt specifications',
      'Realistic physics (no floating objects)',
      'Character movements natural'
    ],
    audio: [
      'Voiceover clear and audible',
      'Lip sync accurate (for talking head)',
      'No audio artifacts or distortion',
      'Volume levels consistent'
    ],
    timing: [
      'Scene duration matches target (±0.5s)',
      'Pacing appropriate for content',
      'No awkward pauses or rushes'
    ]
  },

  // Cross-scene validation
  crossScene: {
    continuity: [
      'Visual style consistent across all scenes',
      'Character appearance consistent',
      'Environment details consistent (if same location)',
      'Color grade uniform throughout'
    ],
    transitions: [
      'No jarring cuts between scenes',
      'Motion continuity maintained',
      'Audio transitions smooth',
      'No duplicate frames at cut points'
    ],
    flow: [
      'Story flows logically',
      'Pacing builds appropriately',
      'Emotional arc maintained',
      'No missing narrative beats'
    ]
  },

  // Auto-retry conditions
  autoRetry: {
    conditions: [
      'Generation failed/timed out',
      'Obvious artifacts detected',
      'Duration significantly off target',
      'Character consistency score < 0.7'
    ],
    maxRetries: 3,
    backoffMs: [1000, 3000, 10000]
  }
};
```

---

## 8. Token Economy

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
