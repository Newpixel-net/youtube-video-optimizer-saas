# Professional Cinematography Upgrade Plan

## Executive Summary

Upgrade the video generation system to produce Hollywood-level production quality with:
- Dynamic shot breakdown based on scene content
- Professional shot/reverse shot coverage for dialogue
- Genre-specific cinematography profiles
- Subtle camera movements appropriate for scene type
- Dynamic scene duration based on dialogue/action content

---

## Phase 1: Enhanced Scene Pattern System

### 1.1 Dialogue Scene Coverage Upgrade

**Current Problem:**
- Dialogue scenes use only 4 shots regardless of content
- No proper shot/reverse shot pattern
- Camera movements too dynamic for conversation

**Solution - Professional Dialogue Coverage:**

```javascript
// NEW: Enhanced dialogue patterns based on character count
dialoguePatterns: {
  'dialogue_two_character': {
    name: 'Two-Character Dialogue (Shot/Reverse Shot)',
    coverageStructure: [
      { type: 'establishing_wide', purpose: 'Set the scene', duration: 3-4s },
      { type: 'two_shot_medium', purpose: 'Show relationship', duration: 4-5s },
      { type: 'over_shoulder_A', purpose: 'Character A speaks', duration: 3-4s },
      { type: 'over_shoulder_B', purpose: 'Character B responds', duration: 3-4s },
      { type: 'closeup_A', purpose: 'A reaction/emotional beat', duration: 2-3s },
      { type: 'medium_B', purpose: 'B continues', duration: 3-4s },
      { type: 'closeup_B', purpose: 'B emotional peak', duration: 2-3s },
      { type: 'two_shot_medium', purpose: 'Resolution/conclude', duration: 3-4s }
    ],
    cameraMovements: ['static', 'subtle_push', 'subtle_pull'], // SUBTLE only
    avgShotsPerScene: 6-8,
    shotsPerDialogueLine: 1.5 // 1.5 shots per line of dialogue
  },

  'dialogue_multi_character': {
    name: 'Multi-Character Dialogue (Ensemble)',
    coverageStructure: [
      { type: 'establishing_wide', purpose: 'Show all characters' },
      { type: 'group_medium', purpose: 'Establish dynamics' },
      { type: 'single_medium', purpose: 'Each speaker gets coverage' },
      { type: 'reaction_shots', purpose: 'Listeners react' },
      { type: 'closeup', purpose: 'Emotional peaks' }
    ],
    cameraMovements: ['static', 'slow_pan', 'subtle_push'],
    avgShotsPerScene: 8-12
  },

  'dialogue_monologue': {
    name: 'Single Character Monologue',
    coverageStructure: [
      { type: 'medium', purpose: 'Establish speaker' },
      { type: 'closeup', purpose: 'Emotional depth' },
      { type: 'extreme_closeup', purpose: 'Key moment' },
      { type: 'cutaway/insert', purpose: 'Visual interest' }
    ],
    cameraMovements: ['static', 'slow_push'],
    avgShotsPerScene: 3-5
  }
}
```

### 1.2 Action Scene Types

```javascript
actionPatterns: {
  'action_fight': {
    avgShotDuration: 1.5-2s,
    shotsPerScene: 8-15,
    cameraMovements: ['tracking', 'handheld', 'whip_pan']
  },
  'action_chase': {
    avgShotDuration: 2-3s,
    shotsPerScene: 6-10,
    cameraMovements: ['tracking', 'crane', 'pov']
  },
  'action_subtle': {
    avgShotDuration: 4-6s,
    shotsPerScene: 4-6,
    cameraMovements: ['static', 'slow_track', 'subtle_push']
  }
}
```

---

## Phase 2: Genre-Specific Cinematography Profiles

### 2.1 Genre Profile Structure

```javascript
GENRE_CINEMATOGRAPHY_PROFILES = {
  'drama': {
    name: 'Drama',
    avgShotLength: 5-8,        // Longer shots for emotional weight
    preferredMovements: ['static', 'slow_push', 'slow_pull'],
    lightingStyle: 'motivated', // Natural, realistic lighting
    colorPalette: 'muted',
    dialogueCoverage: 'intimate', // More close-ups
    actionIntensity: 'subtle',
    referenceFilms: ['Moonlight', 'Marriage Story', 'The Father']
  },

  'thriller': {
    name: 'Thriller/Suspense',
    avgShotLength: 3-5,        // Moderate pacing builds tension
    preferredMovements: ['slow_push', 'static', 'subtle_handheld'],
    lightingStyle: 'low_key',   // Dramatic shadows
    colorPalette: 'desaturated_with_accent',
    dialogueCoverage: 'tense',  // Tight framing, uncomfortable
    actionIntensity: 'building',
    referenceFilms: ['Sicario', 'Prisoners', 'Gone Girl']
  },

  'action': {
    name: 'Action/Adventure',
    avgShotLength: 2-4,        // Fast cutting
    preferredMovements: ['tracking', 'crane', 'handheld'],
    lightingStyle: 'high_contrast',
    colorPalette: 'saturated',
    dialogueCoverage: 'efficient', // Quick coverage, move to action
    actionIntensity: 'high',
    referenceFilms: ['John Wick', 'Mad Max', 'Mission Impossible']
  },

  'scifi': {
    name: 'Science Fiction',
    avgShotLength: 4-6,
    preferredMovements: ['slow_tracking', 'crane', 'static'],
    lightingStyle: 'stylized',
    colorPalette: 'cool_with_neon',
    dialogueCoverage: 'contemplative',
    actionIntensity: 'variable',
    referenceFilms: ['Blade Runner 2049', 'Arrival', 'Dune']
  },

  'horror': {
    name: 'Horror',
    avgShotLength: 4-8,        // Long shots build dread
    preferredMovements: ['static', 'very_slow_push', 'handheld'],
    lightingStyle: 'low_key_extreme',
    colorPalette: 'desaturated',
    dialogueCoverage: 'isolated', // Characters feel alone
    actionIntensity: 'sudden_bursts',
    referenceFilms: ['Hereditary', 'The Witch', 'It Follows']
  },

  'comedy': {
    name: 'Comedy',
    avgShotLength: 3-5,
    preferredMovements: ['static', 'whip_pan', 'quick_zoom'],
    lightingStyle: 'high_key',
    colorPalette: 'bright_warm',
    dialogueCoverage: 'reactive', // Cut to reactions
    actionIntensity: 'comedic_timing',
    referenceFilms: ['The Grand Budapest Hotel', 'Superbad']
  },

  'fantasy': {
    name: 'Fantasy/Epic',
    avgShotLength: 5-7,
    preferredMovements: ['crane', 'epic_slow_tracking', 'static'],
    lightingStyle: 'dramatic_natural',
    colorPalette: 'rich_saturated',
    dialogueCoverage: 'formal', // Wider shots, show world
    actionIntensity: 'epic_scale',
    referenceFilms: ['Lord of the Rings', 'Game of Thrones']
  },

  'noir': {
    name: 'Neo-Noir',
    avgShotLength: 4-6,
    preferredMovements: ['slow_tracking', 'static', 'dutch_angle'],
    lightingStyle: 'chiaroscuro',
    colorPalette: 'high_contrast_limited',
    dialogueCoverage: 'atmospheric',
    actionIntensity: 'stylized',
    referenceFilms: ['Sin City', 'Drive', 'Chinatown']
  }
}
```

---

## Phase 3: Dynamic Scene Duration Calculator

### 3.1 Scene Duration Based on Content

```javascript
calculateSceneDuration(scene) {
  let baseDuration = 0;

  // Dialogue-based calculation
  if (scene.dialogue && scene.dialogue.length > 0) {
    scene.dialogue.forEach(line => {
      // ~150 words per minute speaking rate
      const wordCount = line.text.split(' ').length;
      const speakingTime = (wordCount / 150) * 60; // seconds

      // Add time for reactions/pauses
      const reactionTime = 1.5; // seconds between lines

      baseDuration += speakingTime + reactionTime;
    });
  }

  // Narration/voiceover calculation
  if (scene.narration) {
    const wordCount = scene.narration.split(' ').length;
    baseDuration += (wordCount / 140) * 60; // Slightly slower narration pace
  }

  // Action-based additions
  if (scene.sceneAction) {
    const actionComplexity = analyzeActionComplexity(scene.sceneAction);
    baseDuration += actionComplexity.estimatedDuration;
  }

  // Scene type modifiers
  const sceneTypeModifiers = {
    'establishing': 1.2,      // Add 20% for atmosphere
    'emotional': 1.3,         // Add 30% for emotional weight
    'action': 0.9,            // Slightly tighter
    'montage': 0.7,           // Quick cuts
    'revelation': 1.1         // Pause for impact
  };

  baseDuration *= sceneTypeModifiers[scene.type] || 1.0;

  // Minimum/maximum constraints
  return Math.max(8, Math.min(60, Math.round(baseDuration)));
}
```

### 3.2 Shot Count Based on Duration and Type

```javascript
calculateShotCount(sceneDuration, sceneType, dialogueLines, genre) {
  const genreProfile = GENRE_CINEMATOGRAPHY_PROFILES[genre];
  const avgShotLength = genreProfile?.avgShotLength || 5;

  // Base calculation
  let shotCount = Math.ceil(sceneDuration / avgShotLength);

  // Dialogue adjustment - more shots for more back-and-forth
  if (sceneType === 'dialogue' && dialogueLines > 2) {
    // Shot/reverse shot pattern: roughly 1.5 shots per dialogue line
    const dialogueShotCount = Math.ceil(dialogueLines * 1.5);
    shotCount = Math.max(shotCount, dialogueShotCount);
  }

  // Scene type adjustments
  const typeMultipliers = {
    'action': 1.5,        // More shots
    'montage': 2.0,       // Many quick shots
    'contemplative': 0.6, // Fewer, longer shots
    'dialogue': 1.2,      // Adequate coverage
    'emotional': 0.8      // Let moments breathe
  };

  shotCount *= typeMultipliers[sceneType] || 1.0;

  // Clamp between reasonable bounds
  return Math.max(2, Math.min(15, Math.round(shotCount)));
}
```

---

## Phase 4: Subtle Camera Movement System

### 4.1 Movement Intensity by Scene Type

```javascript
CAMERA_MOVEMENT_PROFILES = {
  'dialogue': {
    allowed: ['static', 'subtle_push', 'subtle_pull'],
    forbidden: ['crane', 'tracking', 'handheld', 'orbit'],
    defaultSpeed: 'very_slow',
    maxMovementPerScene: 2 // Only 2 shots with movement per dialogue scene
  },

  'emotional': {
    allowed: ['static', 'very_slow_push', 'subtle_pull'],
    forbidden: ['tracking', 'handheld', 'crane'],
    defaultSpeed: 'glacial',
    maxMovementPerScene: 1
  },

  'action': {
    allowed: ['tracking', 'handheld', 'crane', 'whip_pan', 'orbit'],
    forbidden: [],
    defaultSpeed: 'dynamic',
    maxMovementPerScene: null // Unlimited
  },

  'establishing': {
    allowed: ['slow_pan', 'slow_crane', 'static', 'very_slow_push'],
    forbidden: ['handheld', 'whip_pan'],
    defaultSpeed: 'slow',
    maxMovementPerScene: 1
  },

  'contemplative': {
    allowed: ['static', 'imperceptible_push'],
    forbidden: ['all_dynamic'],
    defaultSpeed: 'almost_static',
    maxMovementPerScene: 1
  }
}
```

### 4.2 Character Action Moderation

```javascript
CHARACTER_ACTION_GUIDELINES = {
  'dialogue': {
    allowed: [
      'subtle hand gestures while speaking',
      'slight head movements',
      'natural eye contact shifts',
      'gentle lean forward/back',
      'small facial expressions',
      'picking up/setting down objects',
      'slow walk while talking'
    ],
    forbidden: [
      'dramatic running',
      'fighting while talking',
      'extreme physical action',
      'rapid movement',
      'acrobatics'
    ],
    promptModifier: 'Characters engaged in natural, subtle movements typical of real conversation. No dramatic physical action.'
  },

  'action': {
    allowed: ['full range of physical movement'],
    forbidden: [],
    promptModifier: 'Dynamic, fluid physical action.'
  }
}
```

---

## Phase 5: Implementation Changes

### Files to Modify:

1. **`functions/index.js`** - SHOT_DECOMPOSITION_ENGINE
   - Add `GENRE_CINEMATOGRAPHY_PROFILES`
   - Add `DIALOGUE_COVERAGE_PATTERNS`
   - Add `CAMERA_MOVEMENT_PROFILES`
   - Update `calculateShotCount()` for dynamic calculation
   - Update `generateShotSequence()` for proper dialogue coverage
   - Add `calculateSceneDuration()` based on content
   - Update video prompt templates for subtle character action

2. **`functions/index.js`** - Scene decomposition prompt
   - Include genre profile in system prompt
   - Add shot/reverse shot guidance for dialogue
   - Add subtle camera movement instructions

---

## Phase 6: Video Prompt Template Updates

### 6.1 Dialogue Scene Video Prompts

**Before (too dramatic):**
```
"Character A stands dramatically, gesturing emphatically while speaking,
dynamic camera movement circles around the conversation..."
```

**After (professional):**
```
"Static medium shot. Character A speaks naturally, subtle hand gestures
emphasizing key points. Minimal body movement, natural conversation stance.
Camera holds steady, focus on facial expression and dialogue delivery."
```

### 6.2 Shot Type Prompt Modifiers

```javascript
SHOT_TYPE_VIDEO_MODIFIERS = {
  'over_shoulder': {
    camera: 'Static or imperceptible push',
    action: 'Speaking character uses natural gestures, listening character shows subtle reactions',
    framing: 'Shoulder of foreground character softly out of focus, face of speaking character sharp'
  },

  'closeup': {
    camera: 'Static or very slow push',
    action: 'Subtle facial expressions, eye movements, minimal body motion',
    framing: 'Face fills frame, eyes in upper third'
  },

  'two_shot': {
    camera: 'Static',
    action: 'Both characters visible, natural interaction, subtle movements',
    framing: 'Both faces clearly visible, balanced composition'
  },

  'reaction': {
    camera: 'Static',
    action: 'Character processes information, subtle change in expression',
    framing: 'Tight on face to capture subtle reaction'
  }
}
```

---

## Expected Results

After implementation:
- **Dialogue scenes**: 6-10 professional shots with proper coverage
- **Camera movement**: 80% static, 20% subtle movement for dialogue
- **Scene duration**: Dynamic based on actual content
- **Genre consistency**: Visual style matches chosen genre
- **Character action**: Natural, subtle movements during conversation
- **Professional quality**: Matches industry-standard TV/film production

---

## Rollout Strategy

1. Implement genre profiles (non-breaking)
2. Update shot calculation logic
3. Add dialogue coverage patterns
4. Update video prompt templates
5. Test with various genres
6. Commit and deploy
