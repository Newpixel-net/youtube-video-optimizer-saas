# Hollywood-Quality Prompt Generation Upgrade Plan

## Executive Summary

This document outlines a comprehensive upgrade to transform the current prompt generation system from producing basic technical prompts like:

```
Quality: 8K, photorealistic, cinematic composition, high detail
```

Into Hollywood-grade cinematographic prompts like:

```
A lone male traveler in a dark cloak sprinting through a devastated, burning city canyon at dusk, towering broken metal-and-stone structures leaning inward, flames bursting from rubble, embers and ash swirling in the air, wet reflective ground with scattered debris, intense orange firelight and heavy smoke, dramatic backlight, cinematic handheld-gimbal tracking shot from behind then slightly low-angle as he runs forward, shallow depth of field, realistic motion blur, high contrast film grade, gritty realism, 4K, ultra detailed.
```

---

## Problem Analysis

### Current Architecture Gap

The system has sophisticated components that aren't being utilized:

1. **SCENE_SCRIPT_STRUCTURE** (line 34782): Defines detailed visual/action blueprints
2. **VISUAL_INTELLIGENCE** (line 24943): Contains 20+ genres, 12 shot types, 10 lighting styles
3. **IMAGE_PROMPT_GENERATOR** (line 34975): Can compile rich prompts from structured data

**BUT**: Script generation outputs simple `scene.visual` text like:
```
"[Push in] A cluttered workshop filled with blueprints"
```

While IMAGE_PROMPT_GENERATOR expects structured data:
```javascript
{
  visualBlueprint: {
    shotType: 'medium-wide',
    cameraAngle: 'low-angle',
    cameraMovement: 'push-in',
    subjectPlacement: 'rule-of-thirds-left',
    foreground: 'scattered tools and metal shavings',
    midground: 'inventor bent over workbench, goggles raised',
    background: 'wall of diagrams and failed prototypes',
    lightingSetup: 'practical',
    keyLight: 'overhead work lamp, warm tungsten',
    particles: 'dust motes floating in light beam',
    mood: 'determined, obsessive'
  },
  actionBlueprint: {...}
}
```

### The Missing Link

There's no **Blueprint Extraction** step that converts simple scene descriptions into structured cinematographic data. The `buildSubjectDescription()` function falls back to raw `scene.visual` text when no blueprint exists.

---

## Hollywood Prompt Anatomy

Based on analysis of professional AI video prompts, a Hollywood-quality prompt contains **10 essential layers**:

### Layer 1: Subject Description
- Who/what is the main focus
- Physical appearance, clothing, pose
- Emotional state, expression
- **Example**: "A weathered male inventor in his 60s with wild gray hair, wearing oil-stained leather apron and brass goggles pushed up on forehead, hunched intensely over a glowing mechanism"

### Layer 2: Action/Movement
- What the subject is doing
- Direction and speed of movement
- Interaction with environment
- **Example**: "carefully adjusting delicate gears with trembling hands, sparks occasionally flying from the mechanism"

### Layer 3: Environment Layers (FG/MG/BG)
- **Foreground**: Immediate visual frame elements
- **Midground**: Main action space
- **Background**: Depth and context
- **Example**: "foreground: scattered brass gears and burnt-out bulbs; midground: cluttered workbench with smoking apparatus; background: shelves of failed inventions and yellowed blueprints covering brick walls"

### Layer 4: Time & Atmosphere
- Time of day/lighting conditions
- Weather, particles, environmental effects
- **Example**: "late night, single work lamp casting harsh shadows, dust motes and tiny sparks floating in amber light, steam rising from cooling metal"

### Layer 5: Lighting Design
- Key light source and direction
- Fill light and contrast
- Practical lights in scene
- Color temperature
- **Example**: "low-key lighting, harsh key light from overhead lamp creating deep shadows, warm tungsten glow (3200K), green-tinted fill from glowing mechanism, rim light from window moonlight"

### Layer 6: Color Palette
- Dominant colors
- Accent colors
- Color temperature
- **Example**: "dominant colors: amber, copper, deep shadow; accent: electric blue from mechanism, moonlight silver; overall warm with cool technological accents"

### Layer 7: Camera & Composition
- Shot type (wide, medium, close-up)
- Camera angle and height
- Camera movement
- Subject placement in frame
- **Example**: "medium close-up, camera slightly below eye level looking up, slow push-in, subject positioned rule-of-thirds left with mechanism filling right side"

### Layer 8: Depth & Focus
- Depth of field
- Focus point
- Bokeh characteristics
- **Example**: "shallow depth of field, focus rack from hands to face, background beautifully blurred with bokeh circles from distant lights"

### Layer 9: Film Look & Style
- Genre/cinematic reference
- Film stock/grade look
- Texture and grain
- **Example**: "Ridley Scott industrial aesthetic, Blade Runner color grade, subtle film grain, anamorphic lens flare, high contrast with crushed blacks"

### Layer 10: Technical Specifications
- Resolution and quality
- Specific AI model optimizations
- **Example**: "8K resolution, photorealistic, cinematic aspect ratio, ultra-detailed textures, no text, no watermarks"

---

## Implementation Plan

### Phase 1: Enhanced Script Generation (Priority: HIGH)

**Goal**: Make script generation output richer, more cinematic visual descriptions from the start.

#### 1.1 Upgrade Script Generation Prompt

**File**: `functions/index.js` (line 24361)

**Current**: Script generation asks for basic visual descriptions
**Upgrade**: Add explicit cinematography requirements to the system prompt

```javascript
const ENHANCED_VISUAL_REQUIREMENTS = `
For EACH scene's visualPrompt, you MUST include ALL of these elements in flowing prose:

1. SUBJECT: Specific description of main subject(s) - age, appearance, clothing, pose, expression, action
2. ENVIRONMENT: Three-layer depth - foreground elements, midground action space, background context
3. ATMOSPHERE: Time of day, weather, particles (dust/smoke/embers/rain), environmental effects
4. LIGHTING: Light source type, direction, color temperature, shadows, practical lights in scene
5. CAMERA: Shot type + angle + movement in natural language (e.g., "low-angle tracking shot pushing in")
6. MOOD: Emotional quality conveyed through all visual elements

FORMAT each visualPrompt as a single flowing cinematic description, NOT a list.

EXAMPLE of excellent visualPrompt:
"[Slow push-in] A weathered inventor in his 60s with wild gray hair hunches over a glowing brass mechanism at his cluttered workbench, tools and failed prototypes scattered across the foreground, walls covered in yellowed blueprints visible in the dusty background. A single overhead work lamp casts harsh amber light, creating deep shadows across his determined face while sparks and dust motes float in the warm tungsten glow. Low-angle framing emphasizes his obsessive focus."

EXAMPLE of poor visualPrompt (DO NOT DO THIS):
"[Push in] A workshop with an inventor working on something."
`;
```

#### 1.2 Add Cinematography Reference Guide

Inject genre-specific cinematography examples into script generation:

```javascript
const GENRE_CINEMATOGRAPHY_GUIDE = {
  'documentary-nature': {
    shotTypes: 'epic establishing shots, intimate close-ups of details, patient observation shots',
    lighting: 'golden hour, blue hour, natural backlighting, god rays through foliage',
    movement: 'smooth tracking, elegant crane shots, patient static holds',
    atmosphere: 'mist, rain, dust particles, dappled light, weather elements',
    reference: 'Planet Earth cinematography, 65mm IMAX quality, National Geographic'
  },
  'thriller': {
    shotTypes: 'dutch angles, tight close-ups on eyes/hands, claustrophobic framing',
    lighting: 'high contrast, noir shadows, single source lighting, motivated darkness',
    movement: 'handheld tension, slow creeping push-ins, sudden whip pans',
    atmosphere: 'smoke, fog, rain on windows, harsh fluorescent flicker',
    reference: 'David Fincher aesthetic, Se7en color grade, paranoid framing'
  },
  // ... more genres
};
```

#### 1.3 Visual Description Validator

Add validation to ensure generated visuals meet quality threshold:

```javascript
const VISUAL_QUALITY_VALIDATOR = {
  minimumElements: ['subject', 'environment', 'lighting', 'camera'],
  minimumLength: 100, // characters
  requiredKeywords: {
    lighting: ['light', 'shadow', 'glow', 'illuminat', 'lamp', 'sun', 'ambient'],
    camera: ['shot', 'angle', 'frame', 'close', 'wide', 'track', 'pan', 'push'],
    atmosphere: ['dust', 'smoke', 'mist', 'particles', 'fog', 'rain', 'glow']
  },

  validate(visualPrompt) {
    const issues = [];
    if (visualPrompt.length < this.minimumLength) {
      issues.push('Visual description too short - add more cinematic detail');
    }
    // Check for required elements
    for (const [element, keywords] of Object.entries(this.requiredKeywords)) {
      if (!keywords.some(kw => visualPrompt.toLowerCase().includes(kw))) {
        issues.push(`Missing ${element} description`);
      }
    }
    return { valid: issues.length === 0, issues };
  }
};
```

---

### Phase 2: Blueprint Extraction Pipeline (Priority: HIGH)

**Goal**: Create a new processing step that converts simple scene.visual text into structured visualBlueprint and actionBlueprint objects.

#### 2.1 Create BLUEPRINT_EXTRACTOR Module

**New module** to add to `functions/index.js`:

```javascript
const BLUEPRINT_EXTRACTOR = {
  /**
   * Extracts structured cinematographic data from scene visual description
   * Uses GPT-4 to analyze and decompose visual prose into structured blueprint
   */
  async extractFromVisual(sceneVisual, genre, productionMode) {
    const prompt = `
Analyze this scene visual description and extract structured cinematographic data:

VISUAL DESCRIPTION:
"${sceneVisual}"

GENRE: ${genre}
PRODUCTION MODE: ${productionMode}

Extract and return a JSON object with this EXACT structure:
{
  "visualBlueprint": {
    "shotType": "[extreme-wide|wide|medium-wide|medium|medium-close|close-up|extreme-close-up|establishing]",
    "cameraAngle": "[eye-level|low-angle|high-angle|dutch-angle|birds-eye|worms-eye|over-shoulder]",
    "cameraMovement": "[static|push-in|pull-out|pan-left|pan-right|tilt-up|tilt-down|tracking|crane|handheld]",
    "subjectPlacement": "[center|rule-of-thirds-left|rule-of-thirds-right|bottom-third|top-third|leading-space]",
    "subject": {
      "who": "detailed description of main subject",
      "appearance": "physical details, age, distinguishing features",
      "clothing": "what they're wearing",
      "pose": "body position and posture",
      "expression": "facial expression and emotional state",
      "action": "what they're actively doing"
    },
    "foreground": "elements in front of main subject",
    "midground": "main action area description",
    "background": "distant elements and context",
    "lightingSetup": "[three-point|high-key|low-key|chiaroscuro|motivated|neon|golden-hour|blue-hour|practical]",
    "keyLight": "main light source description with direction and color",
    "fillLight": "secondary light description",
    "practicalLights": ["in-scene light sources"],
    "colorTemperature": "warm/cool/mixed with Kelvin estimate",
    "weather": "environmental conditions",
    "particles": "floating elements in air (dust, smoke, embers, rain, etc)",
    "timeOfDay": "specific time and lighting conditions",
    "mood": "emotional quality of the scene",
    "dominantColors": ["primary colors in scene"],
    "accentColors": ["secondary highlight colors"],
    "depthOfField": "shallow/medium/deep with focus description",
    "filmLook": "cinematic reference or film stock style"
  },
  "actionBlueprint": {
    "characterAction": {
      "who": "character name or description",
      "startPose": "initial position",
      "action": "movement or action performed",
      "endPose": "final position",
      "timing": "speed and rhythm of action"
    },
    "environmentAction": ["background movements", "atmospheric animations"],
    "cameraAction": {
      "movement": "camera motion description",
      "speed": "slow|medium|fast",
      "focus": "what camera focuses on"
    }
  }
}

RULES:
- If information is not present in the description, make intelligent cinematic choices based on genre and mood
- Be specific and detailed - no generic descriptions
- Ensure all values match the allowed options in brackets
- For colors, use specific color names, not vague terms
`;

    // Call GPT-4 to extract blueprint
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    });

    return JSON.parse(response.choices[0].message.content);
  },

  /**
   * Quick extraction using pattern matching for simple cases
   * Falls back to AI extraction for complex descriptions
   */
  quickExtract(sceneVisual) {
    const blueprint = {
      visualBlueprint: {},
      actionBlueprint: {}
    };

    // Extract camera movement from brackets
    const cameraMatch = sceneVisual.match(/\[(.*?)\]/);
    if (cameraMatch) {
      const movement = cameraMatch[1].toLowerCase();
      if (movement.includes('push')) blueprint.visualBlueprint.cameraMovement = 'push-in';
      else if (movement.includes('pull')) blueprint.visualBlueprint.cameraMovement = 'pull-out';
      else if (movement.includes('pan')) blueprint.visualBlueprint.cameraMovement = movement.includes('left') ? 'pan-left' : 'pan-right';
      else if (movement.includes('track')) blueprint.visualBlueprint.cameraMovement = 'tracking';
      else if (movement.includes('static') || movement.includes('hold')) blueprint.visualBlueprint.cameraMovement = 'static';
      else if (movement.includes('crane')) blueprint.visualBlueprint.cameraMovement = 'crane';
    }

    // Extract lighting keywords
    if (sceneVisual.toLowerCase().includes('golden hour') || sceneVisual.includes('sunset')) {
      blueprint.visualBlueprint.lightingSetup = 'golden-hour';
    } else if (sceneVisual.toLowerCase().includes('shadow') || sceneVisual.includes('dark')) {
      blueprint.visualBlueprint.lightingSetup = 'low-key';
    } else if (sceneVisual.toLowerCase().includes('neon') || sceneVisual.includes('electric')) {
      blueprint.visualBlueprint.lightingSetup = 'neon';
    }

    // Extract shot type keywords
    if (sceneVisual.toLowerCase().includes('close-up') || sceneVisual.includes('closeup')) {
      blueprint.visualBlueprint.shotType = 'close-up';
    } else if (sceneVisual.toLowerCase().includes('wide shot') || sceneVisual.includes('establishing')) {
      blueprint.visualBlueprint.shotType = 'wide';
    }

    // Store raw midground as fallback
    blueprint.visualBlueprint.midground = sceneVisual.replace(/\[.*?\]\s*/, '');

    return blueprint;
  }
};
```

#### 2.2 Integrate Blueprint Extraction into Scene Pipeline

Modify `SCENE_PIPELINE.processScene()` to include blueprint extraction:

```javascript
// In SCENE_PIPELINE.processScene()
async processScene(sceneScript, context) {
  const result = {
    sceneId: sceneScript.id,
    steps: [],
    errors: []
  };

  try {
    // STEP 0: Extract Blueprint (NEW)
    result.steps.push({ step: 'blueprint_extraction', status: 'processing' });

    if (!sceneScript.visualBlueprint || Object.keys(sceneScript.visualBlueprint).length === 0) {
      // No blueprint exists - extract from visual description
      const extracted = await BLUEPRINT_EXTRACTOR.extractFromVisual(
        sceneScript.visual || sceneScript.visualPrompt,
        context.genre,
        context.productionMode
      );
      sceneScript.visualBlueprint = extracted.visualBlueprint;
      sceneScript.actionBlueprint = extracted.actionBlueprint;
    }

    result.visualBlueprint = sceneScript.visualBlueprint;
    result.steps[0].status = 'complete';

    // Continue with existing pipeline...
  }
}
```

---

### Phase 3: Upgraded Image Prompt Generator (Priority: HIGH)

**Goal**: Completely rewrite `compileImagePrompt` to produce Hollywood-quality output.

#### 3.1 Hollywood Prompt Compiler

Replace current `compileImagePrompt` with cinematographic version:

```javascript
const HOLLYWOOD_PROMPT_COMPILER = {
  /**
   * Compiles extracted blueprint into Hollywood-quality image prompt
   */
  compile(visualBlueprint, actionBlueprint, styleBible, genre) {
    const parts = [];

    // LAYER 1: Subject Description (most important - goes first)
    const subject = this.buildSubjectLayer(visualBlueprint);
    if (subject) parts.push(subject);

    // LAYER 2: Action/Movement
    const action = this.buildActionLayer(visualBlueprint, actionBlueprint);
    if (action) parts.push(action);

    // LAYER 3: Environment (FG/MG/BG)
    const environment = this.buildEnvironmentLayer(visualBlueprint);
    if (environment) parts.push(environment);

    // LAYER 4: Time & Atmosphere
    const atmosphere = this.buildAtmosphereLayer(visualBlueprint);
    if (atmosphere) parts.push(atmosphere);

    // LAYER 5: Lighting Design
    const lighting = this.buildLightingLayer(visualBlueprint);
    if (lighting) parts.push(lighting);

    // LAYER 6: Camera & Composition
    const camera = this.buildCameraLayer(visualBlueprint);
    if (camera) parts.push(camera);

    // LAYER 7: Depth & Focus
    const depth = this.buildDepthLayer(visualBlueprint);
    if (depth) parts.push(depth);

    // LAYER 8: Film Look & Style
    const style = this.buildStyleLayer(visualBlueprint, styleBible, genre);
    if (style) parts.push(style);

    // LAYER 9: Technical Specs (always last)
    parts.push(this.buildTechnicalLayer());

    // Join as flowing prose, not comma-separated list
    return parts.join(', ');
  },

  buildSubjectLayer(vb) {
    if (!vb.subject) return vb.midground || '';

    const { who, appearance, clothing, pose, expression, action } = vb.subject;
    const parts = [];

    if (who) parts.push(who);
    if (appearance) parts.push(appearance);
    if (clothing) parts.push(`wearing ${clothing}`);
    if (pose) parts.push(pose);
    if (expression) parts.push(`${expression} expression`);
    if (action) parts.push(action);

    return parts.join(', ') || vb.midground;
  },

  buildActionLayer(vb, ab) {
    if (!ab?.characterAction?.action) return '';
    const ca = ab.characterAction;
    return ca.action;
  },

  buildEnvironmentLayer(vb) {
    const parts = [];

    if (vb.foreground) parts.push(`foreground: ${vb.foreground}`);
    if (vb.midground && !vb.subject) parts.push(vb.midground);
    if (vb.background) parts.push(`background: ${vb.background}`);

    if (parts.length === 0) return '';
    return parts.join(', ');
  },

  buildAtmosphereLayer(vb) {
    const parts = [];

    if (vb.timeOfDay) parts.push(vb.timeOfDay);
    if (vb.weather && vb.weather !== 'clear') parts.push(vb.weather);
    if (vb.particles) parts.push(`${vb.particles} in the air`);
    if (vb.mood) parts.push(`${vb.mood} mood`);

    return parts.join(', ');
  },

  buildLightingLayer(vb) {
    const parts = [];

    if (vb.keyLight) parts.push(vb.keyLight);
    if (vb.fillLight) parts.push(vb.fillLight);
    if (vb.practicalLights?.length) {
      parts.push(`practical lights: ${vb.practicalLights.join(', ')}`);
    }
    if (vb.colorTemperature) parts.push(`${vb.colorTemperature} color temperature`);

    // Add lighting setup descriptor
    const setupDescriptors = {
      'low-key': 'dramatic shadows, high contrast',
      'high-key': 'bright, even illumination',
      'golden-hour': 'warm golden sunlight',
      'blue-hour': 'cool twilight ambiance',
      'chiaroscuro': 'Renaissance-style light and shadow',
      'neon': 'vibrant neon glow, cyberpunk lighting',
      'practical': 'realistic motivated lighting from scene sources'
    };

    if (vb.lightingSetup && setupDescriptors[vb.lightingSetup]) {
      parts.push(setupDescriptors[vb.lightingSetup]);
    }

    return parts.join(', ');
  },

  buildCameraLayer(vb) {
    const parts = [];

    // Shot type with descriptor
    const shotDescriptors = {
      'extreme-wide': 'extreme wide shot showing vast scale',
      'wide': 'wide shot establishing the scene',
      'medium-wide': 'medium-wide shot',
      'medium': 'medium shot',
      'medium-close': 'medium close-up',
      'close-up': 'close-up shot with intimate framing',
      'extreme-close-up': 'extreme close-up on detail',
      'establishing': 'establishing shot'
    };
    if (vb.shotType) parts.push(shotDescriptors[vb.shotType] || vb.shotType);

    // Camera angle with impact
    const angleDescriptors = {
      'low-angle': 'low-angle looking up, conveying power',
      'high-angle': 'high-angle looking down',
      'dutch-angle': 'dutch angle creating tension',
      'eye-level': 'eye-level framing',
      'birds-eye': 'bird\'s eye view from above',
      'worms-eye': 'worm\'s eye extreme low angle',
      'over-shoulder': 'over-the-shoulder perspective'
    };
    if (vb.cameraAngle) parts.push(angleDescriptors[vb.cameraAngle] || vb.cameraAngle);

    // Camera movement
    const movementDescriptors = {
      'push-in': 'slow push-in',
      'pull-out': 'pull-out reveal',
      'tracking': 'tracking shot following action',
      'pan-left': 'pan left',
      'pan-right': 'pan right',
      'crane': 'crane shot',
      'handheld': 'handheld camera movement',
      'static': 'static locked-off shot'
    };
    if (vb.cameraMovement) parts.push(movementDescriptors[vb.cameraMovement] || vb.cameraMovement);

    // Subject placement
    if (vb.subjectPlacement && vb.subjectPlacement !== 'center') {
      parts.push(`subject ${vb.subjectPlacement.replace(/-/g, ' ')}`);
    }

    return parts.join(', ');
  },

  buildDepthLayer(vb) {
    if (!vb.depthOfField) return 'shallow depth of field, cinematic bokeh';
    return `${vb.depthOfField} depth of field`;
  },

  buildStyleLayer(vb, styleBible, genre) {
    const parts = [];

    if (vb.filmLook) parts.push(vb.filmLook);
    if (styleBible?.cinematicReference) parts.push(styleBible.cinematicReference);

    // Add genre-specific style
    const genreStyles = {
      'documentary-nature': 'National Geographic cinematography, BBC Earth quality',
      'thriller': 'David Fincher aesthetic, high contrast, paranoid framing',
      'horror': 'atmospheric horror, practical effects quality, dread-inducing',
      'cinematic': 'Hollywood blockbuster quality, Roger Deakins lighting',
      'drama': 'prestige television cinematography, emotional depth'
    };
    if (genre && genreStyles[genre]) parts.push(genreStyles[genre]);

    // Color information
    if (vb.dominantColors?.length) {
      parts.push(`color palette: ${vb.dominantColors.join(', ')}`);
    }

    return parts.join(', ');
  },

  buildTechnicalLayer() {
    return '8K resolution, photorealistic, ultra-detailed, cinematic aspect ratio, sharp focus, professional color grading';
  }
};
```

---

### Phase 4: Video Prompt Enhancement (Priority: MEDIUM)

**Goal**: Upgrade video prompts to include proper motion language for AI video models.

#### 4.1 Enhanced Video Prompt Structure

```javascript
const ENHANCED_VIDEO_PROMPT_GENERATOR = {
  /**
   * Generates detailed motion prompts for AI video generation
   */
  generateMotionPrompt(imageUrl, scene, actionBlueprint, videoModel) {
    const motion = {
      primary: this.buildPrimaryMotion(actionBlueprint),
      camera: this.buildCameraMotion(actionBlueprint, scene),
      environment: this.buildEnvironmentMotion(actionBlueprint, scene),
      atmosphere: this.buildAtmosphericMotion(scene)
    };

    // Model-specific formatting
    return this.formatForModel(motion, imageUrl, videoModel);
  },

  buildPrimaryMotion(ab) {
    if (!ab?.characterAction) return 'subtle movement, natural micro-motions';

    const ca = ab.characterAction;
    const parts = [];

    if (ca.who) parts.push(ca.who);
    if (ca.action) parts.push(ca.action);
    if (ca.timing) parts.push(`${ca.timing} pace`);

    return parts.join(', ') || 'subtle character movement';
  },

  buildCameraMotion(ab, scene) {
    const camera = ab?.cameraAction || {};
    const vb = scene.visualBlueprint || {};

    const movement = camera.movement || vb.cameraMovement || 'static';
    const speed = camera.speed || 'slow';

    const motionPhrases = {
      'push-in': `${speed} push in towards subject`,
      'pull-out': `${speed} pull out revealing environment`,
      'tracking': `${speed} tracking shot following action`,
      'pan-left': `${speed} pan left`,
      'pan-right': `${speed} pan right`,
      'crane': `${speed} crane movement`,
      'handheld': 'subtle handheld drift, organic movement',
      'static': 'locked-off static frame, no camera movement'
    };

    return motionPhrases[movement] || 'minimal camera movement';
  },

  buildEnvironmentMotion(ab, scene) {
    const envActions = ab?.environmentAction || [];
    const particles = scene.visualBlueprint?.particles;

    const motions = [...envActions];

    if (particles) {
      if (particles.includes('dust')) motions.push('dust particles drifting slowly');
      if (particles.includes('smoke')) motions.push('smoke wisping and curling');
      if (particles.includes('ember')) motions.push('embers floating upward');
      if (particles.includes('rain')) motions.push('rain falling continuously');
    }

    return motions.length > 0 ? motions.join(', ') : 'subtle environmental movement';
  },

  buildAtmosphericMotion(scene) {
    const vb = scene.visualBlueprint || {};
    const motions = [];

    if (vb.weather === 'windy') motions.push('wind affecting hair and fabric');
    if (vb.lightingSetup === 'practical') motions.push('subtle light flicker');
    if (vb.mood === 'tense') motions.push('nervous micro-movements');

    return motions.join(', ');
  },

  formatForModel(motion, imageUrl, videoModel) {
    const modelName = videoModel?.model || 'minimax';

    if (modelName.includes('minimax') || modelName.includes('hailuo')) {
      // Minimax/Hailuo format - natural language
      return `Starting from this exact image, animate with: ${motion.primary}. Camera: ${motion.camera}. Environment: ${motion.environment}. ${motion.atmosphere}. Maintain exact lighting, colors, and style from the source image. Smooth, cinematic motion. Duration: 6 seconds.`;
    }

    if (modelName.includes('runway')) {
      // Runway Gen-3 format
      return {
        prompt: `${motion.primary}, ${motion.camera}, ${motion.environment}`,
        motion_amount: motion.camera.includes('static') ? 'low' : 'medium',
        style_reference: imageUrl
      };
    }

    // Default format
    return `Animate: ${motion.primary}. ${motion.camera}. ${motion.environment}. ${motion.atmosphere}`;
  }
};
```

---

### Phase 5: Quality Assurance Pipeline (Priority: MEDIUM)

**Goal**: Validate and enhance prompts before generation.

#### 5.1 Prompt Quality Analyzer

```javascript
const PROMPT_QUALITY_ANALYZER = {
  qualityThresholds: {
    minimum: {
      length: 100,
      requiredElements: ['subject', 'lighting'],
      score: 40
    },
    standard: {
      length: 200,
      requiredElements: ['subject', 'lighting', 'camera', 'environment'],
      score: 60
    },
    hollywood: {
      length: 350,
      requiredElements: ['subject', 'lighting', 'camera', 'environment', 'atmosphere', 'style'],
      score: 80
    }
  },

  analyze(prompt) {
    let score = 0;
    const analysis = {
      length: prompt.length,
      elements: {},
      suggestions: []
    };

    // Length scoring (0-20 points)
    if (prompt.length >= 400) score += 20;
    else if (prompt.length >= 250) score += 15;
    else if (prompt.length >= 150) score += 10;
    else score += 5;

    // Element detection (0-60 points)
    const elements = {
      subject: /\b(man|woman|person|character|figure|[A-Z][a-z]+ in)\b/i.test(prompt),
      lighting: /\b(light|shadow|glow|illuminat|lamp|sun|ambient|backlight|rim)\b/i.test(prompt),
      camera: /\b(shot|angle|frame|close|wide|track|pan|push|pull|POV)\b/i.test(prompt),
      environment: /\b(background|foreground|midground|setting|location|room|space)\b/i.test(prompt),
      atmosphere: /\b(dust|smoke|mist|fog|rain|particles|embers|mood|atmosphere)\b/i.test(prompt),
      color: /\b(color|palette|teal|orange|warm|cool|saturate|tone|grade)\b/i.test(prompt),
      style: /\b(cinematic|film|aesthetic|style|quality|8K|4K|photorealistic)\b/i.test(prompt)
    };

    for (const [element, present] of Object.entries(elements)) {
      analysis.elements[element] = present;
      if (present) score += 8;
      else {
        analysis.suggestions.push(`Add ${element} description`);
      }
    }

    // Technical quality (0-20 points)
    if (/\b8K|4K|high.?res/i.test(prompt)) score += 5;
    if (/photorealistic|hyper.?realistic/i.test(prompt)) score += 5;
    if (/cinematic|film/i.test(prompt)) score += 5;
    if (/detailed|ultra/i.test(prompt)) score += 5;

    analysis.score = Math.min(100, score);
    analysis.quality = score >= 80 ? 'hollywood' : score >= 60 ? 'standard' : score >= 40 ? 'minimum' : 'poor';

    return analysis;
  },

  async enhance(prompt, targetQuality = 'hollywood') {
    const analysis = this.analyze(prompt);

    if (analysis.score >= this.qualityThresholds[targetQuality].score) {
      return { enhanced: prompt, analysis, wasEnhanced: false };
    }

    // Use AI to enhance the prompt
    const enhancePrompt = `
Enhance this image generation prompt to Hollywood cinematography quality.

CURRENT PROMPT:
"${prompt}"

MISSING ELEMENTS: ${analysis.suggestions.join(', ')}

REQUIREMENTS:
- Add specific subject details (appearance, clothing, pose, expression)
- Add three-layer environment (foreground, midground, background)
- Add atmospheric elements (particles, weather, mood)
- Add lighting design (key light, fill, color temperature)
- Add camera language (shot type, angle, movement)
- Add cinematic style reference
- Maintain the original scene's intent and content

Return ONLY the enhanced prompt as a single flowing paragraph, no explanations.
`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: enhancePrompt }],
      temperature: 0.7
    });

    const enhanced = response.choices[0].message.content.trim();

    return {
      enhanced,
      analysis: this.analyze(enhanced),
      wasEnhanced: true,
      originalAnalysis: analysis
    };
  }
};
```

---

### Phase 6: Genre-Specific Templates (Priority: LOW)

**Goal**: Pre-built cinematography templates for each genre.

#### 6.1 Genre Cinematography Presets

```javascript
const GENRE_CINEMATOGRAPHY_PRESETS = {
  'documentary-nature': {
    defaultShot: 'wide establishing into intimate close-up',
    lightingStyle: 'natural available light, golden hour preferred',
    cameraMovement: 'smooth tracking, patient static holds, elegant crane reveals',
    atmosphere: 'natural weather elements, god rays, morning mist',
    colorGrade: 'rich earth tones, vibrant natural colors',
    reference: 'Planet Earth, Our Planet, Life',
    promptSuffix: 'National Geographic quality, BBC Earth cinematography, wildlife documentary aesthetic'
  },
  'thriller': {
    defaultShot: 'tight framing, claustrophobic compositions',
    lightingStyle: 'high contrast noir lighting, motivated shadows, single source',
    cameraMovement: 'handheld tension, slow creeping push-ins, sudden reveals',
    atmosphere: 'smoke, rain, harsh fluorescent, urban grit',
    colorGrade: 'desaturated, teal shadows, sodium vapor orange',
    reference: 'Se7en, Zodiac, Sicario',
    promptSuffix: 'David Fincher aesthetic, paranoid framing, oppressive atmosphere'
  },
  'cinematic-epic': {
    defaultShot: 'grand scale establishing, epic wide shots',
    lightingStyle: 'dramatic key lighting, Deakins-style naturalism',
    cameraMovement: 'sweeping crane, dolly reveals, anamorphic beauty',
    atmosphere: 'weather elements, dust, atmospheric haze',
    colorGrade: 'blockbuster color science, rich shadows, beautiful highlights',
    reference: 'Blade Runner 2049, Dune, Mad Max',
    promptSuffix: 'Hollywood blockbuster quality, Roger Deakins cinematography, IMAX-worthy visual spectacle'
  },
  // ... more genres
};
```

---

## Implementation Roadmap

### Immediate Priority (Phase 1-3)

1. **Update Script Generation Prompt** - Add ENHANCED_VISUAL_REQUIREMENTS to system prompt
2. **Implement BLUEPRINT_EXTRACTOR** - Convert simple visuals to structured blueprints
3. **Replace compileImagePrompt** - Use HOLLYWOOD_PROMPT_COMPILER

### Short-term (Phase 4-5)

4. **Upgrade Video Prompts** - Implement ENHANCED_VIDEO_PROMPT_GENERATOR
5. **Add Quality Analysis** - Implement PROMPT_QUALITY_ANALYZER with auto-enhancement

### Medium-term (Phase 6)

6. **Genre Templates** - Add GENRE_CINEMATOGRAPHY_PRESETS
7. **Testing & Refinement** - A/B test prompt quality impact on generated content

---

## Expected Outcomes

### Before Upgrade
```
Quality: 8K, photorealistic, cinematic composition, high detail
```

### After Upgrade
```
A weathered inventor in his 60s with wild gray hair and oil-stained leather apron hunches intensely over a glowing brass mechanism at his cluttered workbench, scattered gears and burnt-out bulbs in the foreground, walls of yellowed blueprints and failed prototypes visible in the dusty background. Late night atmosphere with single overhead work lamp casting harsh amber tungsten light (3200K), deep dramatic shadows across his determined face, dust motes and tiny sparks floating in the warm glow. Medium close-up shot, slight low-angle emphasizing obsessive focus, slow push-in, subject positioned rule-of-thirds left. Shallow depth of field with background bokeh, Ridley Scott industrial aesthetic, steampunk inventor film quality, 8K resolution, photorealistic, ultra-detailed, cinematic color grading.
```

---

## Files to Modify

1. **functions/index.js**
   - Add BLUEPRINT_EXTRACTOR module (~line 34970)
   - Replace IMAGE_PROMPT_GENERATOR.compileImagePrompt with HOLLYWOOD_PROMPT_COMPILER
   - Update VIDEO_PROMPT_GENERATOR
   - Add PROMPT_QUALITY_ANALYZER
   - Enhance script generation system prompt (line 24361)

2. **frontend/video-creation-wizard.html**
   - Update storyboard display to show enhanced prompts
   - Add prompt quality indicator UI

---

## Success Metrics

1. **Prompt Length**: Average > 300 characters (currently ~50)
2. **Quality Score**: Average > 80 (Hollywood tier)
3. **Element Coverage**: 6+ of 7 cinematographic elements present
4. **Image Diversity**: No more identical-looking images across scenes
5. **User Satisfaction**: Rich, cinematic visuals that match script intent
