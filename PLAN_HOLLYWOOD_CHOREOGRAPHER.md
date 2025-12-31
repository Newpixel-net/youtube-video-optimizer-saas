# Hollywood Shot Choreographer - Complete Implementation Plan

## Executive Summary

This plan implements a **two-layer upgrade** to transform sparse video prompts into full Hollywood-quality choreographed scenes:

| Layer | Location | Purpose |
|-------|----------|---------|
| **Layer 1: Script Enrichment** | Upstream (script generation) | Generate rich scene data with beats, blocking, eyelines |
| **Layer 2: Shot Choreography** | Downstream (shot decomposition) | Expand rich data into detailed 4-beat prompts |

---

## The Problem: Script Richness Gap

### Current State (70% Ready)
The script generation has good foundations:
- Detailed `sceneAction` descriptions with character movements
- Rich `visualPrompt` with cinematography (150+ words)
- Character tracking across scenes
- Hollywood narrative structure

### What's Missing (30% Gap)

| Missing Element | Impact on Choreography |
|-----------------|------------------------|
| Performance Blueprint | No intensity arcs (40% → 70% → 100%), no energy states per character |
| Spatial Blocking | No positions ("Kai stage-right, elevated"), no distances between characters |
| Eyeline Charts | No "who looks at whom, when" choreography |
| Dialogue Timing | No word count, duration, pacing, breath pauses |
| Beat-Level Detail | `sceneAction` describes WHAT happens, not HOW across 4 beats |
| Environmental Sync | No timing for when wind picks up, lights shift, etc. |

### Example of the Gap

**Current `sceneAction`:**
```
"Kai stands at the edge of the rooftop, surveying the city. Wind catches his coat
as he turns to face Ryu and Li Mei. He speaks, gesturing toward their destination.
They exchange determined looks, then leap from the building."
```

**What we NEED for Hollywood choreography:**
```
BEAT 1 (0-2s): Kai stands stage-right at rooftop edge, weight on left foot,
gaze DOWN at city below. Shoulders slightly hunched - isolation visible.
Wind begins catching coat edge. Ryu and Li Mei wait 8 feet behind, frame-left.

BEAT 2 (2-5s): Kai's head turns first (0.5s), then shoulders follow, then full
body pivot to face companions. Weight shifts to center. Expression transitions:
contemplation → resolve. Eye contact lands on Ryu first, then Li Mei.

BEAT 3 (5-8s): Kai takes one step toward them, right hand rises to gesture at
distant tower. Voice firm: 'That's our target.' Ryu grins, cracks knuckles.
Li Mei steps forward, hand on Kai's shoulder.

BEAT 4 (8-10s): All three turn as one toward edge. Break into run - Kai leads
by half-step. Coats billow. LEAP at final second.
CAPTURE: Mid-air silhouettes against neon sky.
```

---

## Layer 1: Script Enrichment (Upstream)

### Goal
Upgrade the AI script generation prompt to output rich scene metadata that the choreography system can expand.

### New Scene Data Structure

Each scene in the generated script will include:

```typescript
interface EnrichedScene {
  // Existing fields
  sceneTitle: string;
  sceneNumber: number;
  sceneAction: string;           // Narrative description
  visualPrompt: string;          // Cinematography instructions
  dialogues: Dialogue[];
  characters: string[];

  // NEW: Performance Blueprint
  performanceBlueprint: {
    sceneArc: string;            // "build_to_climax" | "tension_release" | "steady_build"
    overallIntensity: {
      start: number;             // 0.0-1.0
      peak: number;
      end: number;
    };
    characterEnergy: {
      [characterName: string]: string[];  // ["contemplative:40%", "resolving:70%", "committed:100%"]
    };
  };

  // NEW: Spatial Blocking
  spatialBlocking: {
    initialPositions: {
      [characterName: string]: {
        stage: string;           // "stage-right" | "center" | "stage-left"
        depth: string;           // "foreground" | "midground" | "background"
        elevation: string;       // "floor" | "elevated" | "seated"
        facing: string;          // "camera" | "away" | "profile-left" | "profile-right"
      };
    };
    finalPositions: {
      [characterName: string]: {
        stage: string;
        depth: string;
        elevation: string;
        facing: string;
      };
    };
    formation: string;           // "triangle" | "line" | "scattered" | "intimate-pair"
    formationChange: string;     // "triangle → unified line" | "scattered → gathered"
    keyDistances: string[];      // ["Kai-to-Mei: 8ft → 3ft", "All converge to center"]
  };

  // NEW: Eyeline Choreography
  eyelines: {
    beat: number;                // 1-4
    from: string;                // Character name or "All"
    to: string;                  // Character name, object, or direction
    emotion: string;             // "searching" | "connecting" | "avoiding"
    duration: string;            // "brief" | "held" | "lingering"
  }[];

  // NEW: Beat Breakdown (4 beats per ~10s scene)
  beatBreakdown: {
    beat: number;
    timing: string;              // "0-2s" | "2-5s" | "5-8s" | "8-10s"
    action: string;              // What happens in this beat
    characterStates: {
      [characterName: string]: {
        position: string;        // Brief position description
        gesture: string;         // Key physical action
        expression: string;      // Emotional state visible on face
        bodyLanguage: string;    // Posture, weight, tension
      };
    };
    environmentState: string;    // What environment is doing
    cameraNote: string;          // Camera behavior for this beat
    intensity: number;           // 0.0-1.0
  }[];

  // NEW: Object Tracking (for props/artifacts)
  objectTracking: {
    object: string;              // "ancient artifact" | "sword" | "letter"
    states: {
      beat: number;
      holder: string;            // Character name or "none"
      visibility: string;        // "hidden" | "revealed" | "prominently displayed"
      position: string;          // "in pocket" | "extended in hand" | "on table"
    }[];
  }[];

  // NEW: Environmental Cues
  environmentalCues: {
    beat: number;
    element: string;             // "wind" | "light" | "sound" | "particles"
    state: string;               // "intensifying" | "calming" | "shifting"
    syncedTo: string;            // "character emotion" | "action" | "dialogue"
  }[];
}
```

### Prompt Modifications

**File:** `functions/index.js` - `generateScriptWithAI` function

Add to the system prompt for script generation:

```markdown
## SCENE ENRICHMENT REQUIREMENTS

For EACH scene, you must provide detailed choreography data:

### Performance Blueprint
- Define the emotional arc of the scene (build, release, steady)
- Specify intensity levels: start → peak → end (as percentages)
- Map each character's energy progression through the scene

### Spatial Blocking
- Place each character in the frame: stage position (left/center/right), depth (fore/mid/background)
- Define starting positions and ending positions
- Describe formation changes ("triangle converges to line")
- Note key distances between characters

### Eyeline Choreography
For each of the 4 beats, specify:
- Who is looking at whom/what
- The emotional quality of the gaze
- Whether the look is brief, held, or lingering

### Beat Breakdown (CRITICAL)
Divide EVERY scene into exactly 4 beats:
- Beat 1 (0-2 seconds): Establish - Characters and setting visible
- Beat 2 (2-5 seconds): Develop - Action begins, movement starts
- Beat 3 (5-8 seconds): Escalate - Key action, peak moment
- Beat 4 (8-10 seconds): Resolve/Transition - Conclusion, setup for next

For each beat, describe:
- Exact character positions and movements
- Specific gestures and expressions
- Body language (posture, weight distribution, tension)
- Environment state (lighting, particles, ambient elements)
- Camera behavior (static, push, pull, pan)
- Intensity level (0.0 to 1.0)

### Object/Prop Tracking
If the scene includes important objects:
- Track who holds it in each beat
- Note visibility changes (hidden → revealed)
- Describe position transitions

### Environmental Sync
- Sync environment changes to character emotions/actions
- Wind intensifies as tension rises
- Light shifts with revelations
- Particles react to movement
```

### Example Enriched Scene Output

```json
{
  "sceneNumber": 3,
  "sceneTitle": "The Artifact Exchange",
  "sceneAction": "Mei reveals the ancient artifact to Kai. He reaches for it hesitantly, then grasps it firmly. Their eyes meet over the glowing object, sealing their alliance.",

  "performanceBlueprint": {
    "sceneArc": "build_to_connection",
    "overallIntensity": { "start": 0.4, "peak": 0.85, "end": 0.7 },
    "characterEnergy": {
      "Kai": ["hesitant:40%", "curious:60%", "committed:85%", "connected:70%"],
      "Mei": ["offering:50%", "hopeful:65%", "trusting:80%", "satisfied:70%"]
    }
  },

  "spatialBlocking": {
    "initialPositions": {
      "Kai": { "stage": "center-left", "depth": "midground", "elevation": "standing", "facing": "profile-right" },
      "Mei": { "stage": "center-right", "depth": "midground", "elevation": "standing", "facing": "profile-left" }
    },
    "finalPositions": {
      "Kai": { "stage": "center", "depth": "midground", "elevation": "standing", "facing": "Mei" },
      "Mei": { "stage": "center", "depth": "midground", "elevation": "standing", "facing": "Kai" }
    },
    "formation": "facing-pair",
    "formationChange": "separated → intimate",
    "keyDistances": ["Kai-to-Mei: 4ft → 2ft", "Both move to center"]
  },

  "eyelines": [
    { "beat": 1, "from": "Kai", "to": "Mei's hands", "emotion": "wary", "duration": "held" },
    { "beat": 1, "from": "Mei", "to": "Kai's eyes", "emotion": "searching", "duration": "lingering" },
    { "beat": 2, "from": "Kai", "to": "artifact", "emotion": "wonder", "duration": "held" },
    { "beat": 2, "from": "Mei", "to": "Kai's reaction", "emotion": "hopeful", "duration": "brief" },
    { "beat": 3, "from": "Both", "to": "artifact between them", "emotion": "shared awe", "duration": "held" },
    { "beat": 4, "from": "Kai", "to": "Mei's eyes", "emotion": "gratitude", "duration": "lingering" },
    { "beat": 4, "from": "Mei", "to": "Kai's eyes", "emotion": "trust", "duration": "lingering" }
  ],

  "beatBreakdown": [
    {
      "beat": 1,
      "timing": "0-2s",
      "action": "Mei reveals artifact; Kai reacts with surprise",
      "characterStates": {
        "Kai": {
          "position": "Center-left, 4 feet from Mei",
          "gesture": "Hands at sides, fingers twitch",
          "expression": "Eyes widen, brows rise",
          "bodyLanguage": "Weight back, shoulders tight, guarded stance"
        },
        "Mei": {
          "position": "Center-right, facing Kai",
          "gesture": "Both hands extend, artifact cupped in palms",
          "expression": "Soft smile, eyes searching",
          "bodyLanguage": "Weight forward, offering posture, open shoulders"
        }
      },
      "environmentState": "Artifact emits soft blue glow, illuminating both faces from below. Dust particles visible in light beam.",
      "cameraNote": "Static medium two-shot, artifact centered between them",
      "intensity": 0.5
    },
    {
      "beat": 2,
      "timing": "2-5s",
      "action": "Kai's hand rises toward artifact; internal struggle visible",
      "characterStates": {
        "Kai": {
          "position": "Steps half-pace forward, now 3 feet from Mei",
          "gesture": "Right hand rises slowly, fingers spread, hesitates mid-air",
          "expression": "Conflict visible - desire vs. caution, jaw tightens",
          "bodyLanguage": "Weight shifts forward, breath held, shoulders still tense"
        },
        "Mei": {
          "position": "Holds position, steady",
          "gesture": "Hands remain extended, small encouraging tilt toward Kai",
          "expression": "Hope brightens eyes, lips part slightly",
          "bodyLanguage": "Subtle lean forward, encouraging"
        }
      },
      "environmentState": "Artifact glow pulses brighter, responding to proximity. Shadows deepen around edges of frame.",
      "cameraNote": "Slow push toward hands, shallow focus",
      "intensity": 0.65
    },
    {
      "beat": 3,
      "timing": "5-8s",
      "action": "Kai grasps artifact; both feel its power",
      "characterStates": {
        "Kai": {
          "position": "Now 2 feet from Mei, facing her directly",
          "gesture": "Both hands wrap around artifact, lifting it slightly",
          "expression": "Wonder replaces doubt, eyes glow with reflected light",
          "bodyLanguage": "Shoulders drop, tension releases, deep inhale visible"
        },
        "Mei": {
          "position": "Steps in, closing distance to 2 feet",
          "gesture": "Hands slide to support artifact from beneath, supporting not releasing",
          "expression": "Tears glisten, smile widens",
          "bodyLanguage": "Weight forward, fully committed"
        }
      },
      "environmentState": "Artifact flares bright, entire frame washes with blue. Candles in background flicker. Dust swirls outward in ring.",
      "cameraNote": "Tight on artifact, four hands visible, faces in shallow background",
      "intensity": 0.85
    },
    {
      "beat": 4,
      "timing": "8-10s",
      "action": "Eyes meet over artifact; alliance sealed in shared gaze",
      "characterStates": {
        "Kai": {
          "position": "Standing close, artifact between them at chest height",
          "gesture": "Grip secure, thumbs brush Mei's fingers",
          "expression": "Gratitude, determination, hint of vulnerability",
          "bodyLanguage": "Steady, grounded, protective stance"
        },
        "Mei": {
          "position": "Matching Kai, faces inches apart over artifact",
          "gesture": "Fingers curl around his, completing the grip",
          "expression": "Trust achieved, small nod, single tear falls",
          "bodyLanguage": "Relaxed shoulders, peaceful exhale"
        }
      },
      "environmentState": "Glow settles to warm steady light. Dust drifts down like snow. Candles return to calm.",
      "cameraNote": "Pull back to medium two-shot, hold on connected moment",
      "intensity": 0.7
    }
  ],

  "objectTracking": [
    {
      "object": "ancient artifact",
      "states": [
        { "beat": 1, "holder": "Mei", "visibility": "revealed", "position": "cupped in both palms, extended" },
        { "beat": 2, "holder": "Mei", "visibility": "prominent", "position": "extended, Kai's hand approaching" },
        { "beat": 3, "holder": "both", "visibility": "central focus", "position": "shared grip, lifted between them" },
        { "beat": 4, "holder": "both", "visibility": "present but secondary", "position": "held together, eye contact primary" }
      ]
    }
  ],

  "environmentalCues": [
    { "beat": 1, "element": "artifact glow", "state": "soft pulse", "syncedTo": "reveal moment" },
    { "beat": 2, "element": "artifact glow", "state": "intensifying", "syncedTo": "Kai's approach" },
    { "beat": 3, "element": "light + particles", "state": "flare + swirl", "syncedTo": "contact moment" },
    { "beat": 4, "element": "all elements", "state": "settling calm", "syncedTo": "emotional resolution" }
  ]
}
```

---

## Layer 2: Shot Choreography (Downstream)

### Goal
Build engines that take the enriched scene data and expand it into full Hollywood-quality video prompts.

### New Engines (6 Total)

#### 1. BEAT_TIMELINE_GENERATOR
**Purpose:** Divides 10-second shots into 4 timed beats with specific frame ranges.

```javascript
function generateBeatTimeline(beatBreakdown, fps = 30) {
  const beats = [
    { beat: 1, timing: "0-2s", frames: "0-60", duration: 2000 },
    { beat: 2, timing: "2-5s", frames: "60-150", duration: 3000 },
    { beat: 3, timing: "5-8s", frames: "150-240", duration: 3000 },
    { beat: 4, timing: "8-10s", frames: "240-300", duration: 2000 }
  ];

  return beats.map((beat, i) => ({
    ...beat,
    action: beatBreakdown[i]?.action || "",
    characterStates: beatBreakdown[i]?.characterStates || {},
    environmentState: beatBreakdown[i]?.environmentState || "",
    cameraNote: beatBreakdown[i]?.cameraNote || "",
    intensity: beatBreakdown[i]?.intensity || 0.5
  }));
}
```

#### 2. ENSEMBLE_BLOCKING_SYSTEM
**Purpose:** Tracks all characters' positions, movements, and eye-lines across beats.

```javascript
function generateEnsembleBlocking(spatialBlocking, eyelines, beatBreakdown) {
  const blocking = {
    characters: {},
    formations: [],
    eyeContact: []
  };

  // Track each character's journey through the scene
  Object.keys(spatialBlocking.initialPositions).forEach(char => {
    blocking.characters[char] = {
      startPosition: spatialBlocking.initialPositions[char],
      endPosition: spatialBlocking.finalPositions[char],
      beatPositions: beatBreakdown.map(b => b.characterStates[char]?.position || "")
    };
  });

  // Formation evolution
  blocking.formations = [{
    beat: 1,
    formation: spatialBlocking.formation.split(" → ")[0]
  }, {
    beat: 4,
    formation: spatialBlocking.formation.split(" → ")[1] || spatialBlocking.formation
  }];

  // Eyeline map
  blocking.eyeContact = eyelines;

  return blocking;
}
```

#### 3. OBJECT_STATE_MACHINE
**Purpose:** Tracks props through shots with state transitions.

```javascript
function generateObjectStates(objectTracking) {
  return objectTracking.map(obj => ({
    object: obj.object,
    transitions: obj.states.map((state, i) => ({
      ...state,
      transitionFrom: i > 0 ? obj.states[i-1] : null,
      transitionType: i > 0 ? determineTransition(obj.states[i-1], state) : "initial"
    }))
  }));
}

function determineTransition(from, to) {
  if (from.holder !== to.holder) return "transfer";
  if (from.visibility !== to.visibility) return "reveal";
  if (from.position !== to.position) return "reposition";
  return "maintain";
}
```

#### 4. PHYSICS_LAYER
**Purpose:** Adds body mechanics, weight distribution, breathing, and muscle tension.

```javascript
function generatePhysicsLayer(beatBreakdown, performanceBlueprint) {
  return beatBreakdown.map(beat => {
    const intensity = beat.intensity;

    return {
      beat: beat.beat,
      physics: {
        breathing: intensity > 0.7 ? "rapid, visible" : intensity > 0.4 ? "controlled, deep" : "slow, relaxed",
        muscleState: intensity > 0.7 ? "coiled, ready" : intensity > 0.4 ? "engaged" : "at ease",
        weightDistribution: deriveWeight(beat.characterStates),
        microMovements: intensity > 0.5 ? "fingers twitch, jaw tightens" : "subtle weight shifts"
      }
    };
  });
}

function deriveWeight(characterStates) {
  const weights = {};
  Object.entries(characterStates).forEach(([char, state]) => {
    if (state.bodyLanguage.includes("forward")) weights[char] = "balls of feet";
    else if (state.bodyLanguage.includes("back")) weights[char] = "heels";
    else weights[char] = "centered";
  });
  return weights;
}
```

#### 5. ENVIRONMENT_RESPONSE_SYSTEM
**Purpose:** Environment reacts to actions with synchronized changes.

```javascript
function generateEnvironmentResponses(environmentalCues, beatBreakdown) {
  return beatBreakdown.map((beat, i) => {
    const cues = environmentalCues.filter(c => c.beat === beat.beat);

    return {
      beat: beat.beat,
      baseEnvironment: beat.environmentState,
      reactiveElements: cues.map(cue => ({
        element: cue.element,
        state: cue.state,
        trigger: cue.syncedTo,
        description: `${cue.element} ${cue.state} in response to ${cue.syncedTo}`
      }))
    };
  });
}
```

#### 6. CROSS_SHOT_CALLBACKS
**Purpose:** Ensures visual continuity between shots.

```javascript
function generateCrossCallbacks(currentScene, previousScene, nextScene) {
  const callbacks = {
    fromPrevious: [],
    toNext: []
  };

  // Match positions from previous shot's end to this shot's start
  if (previousScene) {
    Object.keys(currentScene.spatialBlocking.initialPositions).forEach(char => {
      if (previousScene.spatialBlocking?.finalPositions?.[char]) {
        callbacks.fromPrevious.push({
          type: "position_match",
          character: char,
          expectedPosition: previousScene.spatialBlocking.finalPositions[char],
          note: `${char} enters matching their exit position from previous shot`
        });
      }
    });
  }

  // Setup continuity for next shot
  if (nextScene) {
    const lastBeat = currentScene.beatBreakdown[3];
    callbacks.toNext.push({
      type: "handoff",
      note: `Scene ends at intensity ${lastBeat.intensity}, next scene should acknowledge`
    });
  }

  return callbacks;
}
```

### Master Orchestrator: HOLLYWOOD_CHOREOGRAPHER

**Purpose:** Combines all engines into complete choreographed prompts.

```javascript
function generateHollywoodChoreography(enrichedScene, previousScene, nextScene, shotType) {
  // Generate all component data
  const beatTimeline = generateBeatTimeline(enrichedScene.beatBreakdown);
  const ensembleBlocking = generateEnsembleBlocking(
    enrichedScene.spatialBlocking,
    enrichedScene.eyelines,
    enrichedScene.beatBreakdown
  );
  const objectStates = generateObjectStates(enrichedScene.objectTracking || []);
  const physicsLayer = generatePhysicsLayer(enrichedScene.beatBreakdown, enrichedScene.performanceBlueprint);
  const environmentResponses = generateEnvironmentResponses(
    enrichedScene.environmentalCues || [],
    enrichedScene.beatBreakdown
  );
  const crossCallbacks = generateCrossCallbacks(enrichedScene, previousScene, nextScene);

  // Build the choreographed prompt
  return buildChoreographedPrompt({
    sceneInfo: {
      number: enrichedScene.sceneNumber,
      title: enrichedScene.sceneTitle,
      shotType: shotType
    },
    spatial: ensembleBlocking,
    beats: beatTimeline.map((beat, i) => ({
      ...beat,
      physics: physicsLayer[i].physics,
      environment: environmentResponses[i],
      objects: objectStates.map(obj => obj.transitions[i]).filter(Boolean)
    })),
    continuity: crossCallbacks,
    captureFrame: determineCaptureFrame(enrichedScene)
  });
}

function buildChoreographedPrompt(data) {
  const lines = [];

  // Header
  lines.push(`SHOT ${data.sceneInfo.number} | ${data.sceneInfo.shotType.toUpperCase()} | ${data.sceneInfo.title}`);
  lines.push("");

  // Spatial setup
  lines.push("[SPATIAL BLOCKING]");
  Object.entries(data.spatial.characters).forEach(([char, positions]) => {
    lines.push(`${char}: ${positions.startPosition.stage}, ${positions.startPosition.depth}, ${positions.startPosition.facing}`);
  });
  lines.push(`Formation: ${data.spatial.formations[0]?.formation}`);
  lines.push("");

  // Each beat
  data.beats.forEach(beat => {
    lines.push(`[BEAT ${beat.beat}: ${beat.timing}]`);

    // Character states
    Object.entries(beat.characterStates).forEach(([char, state]) => {
      lines.push(`${char}: ${state.position}`);
      lines.push(`  Gesture: ${state.gesture}`);
      lines.push(`  Expression: ${state.expression}`);
      lines.push(`  Body: ${state.bodyLanguage}`);
    });

    // Physics
    lines.push(`Physics: ${beat.physics.breathing}, ${beat.physics.muscleState}`);

    // Environment
    lines.push(`Environment: ${beat.environment.baseEnvironment}`);
    if (beat.environment.reactiveElements?.length > 0) {
      beat.environment.reactiveElements.forEach(elem => {
        lines.push(`  ${elem.description}`);
      });
    }

    // Objects
    if (beat.objects?.length > 0) {
      beat.objects.forEach(obj => {
        lines.push(`Object (${obj.object || "prop"}): ${obj.visibility}, ${obj.position}`);
      });
    }

    lines.push(`Camera: ${beat.cameraNote}`);
    lines.push(`Intensity: ${(beat.intensity * 100).toFixed(0)}%`);
    lines.push("");
  });

  // Continuity callbacks
  if (data.continuity.fromPrevious?.length > 0) {
    lines.push("[CONTINUITY FROM PREVIOUS]");
    data.continuity.fromPrevious.forEach(cb => {
      lines.push(`- ${cb.note}`);
    });
    lines.push("");
  }

  if (data.continuity.toNext?.length > 0) {
    lines.push("[CONTINUITY TO NEXT]");
    data.continuity.toNext.forEach(cb => {
      lines.push(`- ${cb.note}`);
    });
    lines.push("");
  }

  // Capture frame
  lines.push(`>>> CAPTURE FRAME: ${data.captureFrame} <<<`);

  return lines.join("\n");
}

function determineCaptureFrame(scene) {
  // Find the most visually compelling moment
  const peakBeat = scene.beatBreakdown.reduce((max, beat) =>
    beat.intensity > max.intensity ? beat : max
  );
  return `Beat ${peakBeat.beat} - ${peakBeat.action}`;
}
```

---

## Final Output Example

**Input:** Enriched scene data (from Layer 1)

**Output:** Full choreographed prompt

```
SHOT 3 | MEDIUM TWO-SHOT | The Artifact Exchange

[SPATIAL BLOCKING]
Kai: center-left, midground, profile-right
Mei: center-right, midground, profile-left
Formation: facing-pair

[BEAT 1: 0-2s]
Kai: Center-left, 4 feet from Mei
  Gesture: Hands at sides, fingers twitch
  Expression: Eyes widen, brows rise
  Body: Weight back, shoulders tight, guarded stance
Mei: Center-right, facing Kai
  Gesture: Both hands extend, artifact cupped in palms
  Expression: Soft smile, eyes searching
  Body: Weight forward, offering posture, open shoulders
Physics: controlled, deep breathing, engaged muscles
Environment: Artifact emits soft blue glow, illuminating both faces from below. Dust particles visible in light beam.
  artifact glow soft pulse in response to reveal moment
Object (ancient artifact): revealed, cupped in both palms, extended
Camera: Static medium two-shot, artifact centered between them
Intensity: 50%

[BEAT 2: 2-5s]
Kai: Steps half-pace forward, now 3 feet from Mei
  Gesture: Right hand rises slowly, fingers spread, hesitates mid-air
  Expression: Conflict visible - desire vs. caution, jaw tightens
  Body: Weight shifts forward, breath held, shoulders still tense
Mei: Holds position, steady
  Gesture: Hands remain extended, small encouraging tilt toward Kai
  Expression: Hope brightens eyes, lips part slightly
  Body: Subtle lean forward, encouraging
Physics: controlled, deep breathing, engaged muscles
Environment: Artifact glow pulses brighter, responding to proximity. Shadows deepen around edges of frame.
  artifact glow intensifying in response to Kai's approach
Object (ancient artifact): prominent, extended, Kai's hand approaching
Camera: Slow push toward hands, shallow focus
Intensity: 65%

[BEAT 3: 5-8s]
Kai: Now 2 feet from Mei, facing her directly
  Gesture: Both hands wrap around artifact, lifting it slightly
  Expression: Wonder replaces doubt, eyes glow with reflected light
  Body: Shoulders drop, tension releases, deep inhale visible
Mei: Steps in, closing distance to 2 feet
  Gesture: Hands slide to support artifact from beneath, supporting not releasing
  Expression: Tears glisten, smile widens
  Body: Weight forward, fully committed
Physics: rapid, visible breathing, coiled, ready muscles
Environment: Artifact flares bright, entire frame washes with blue. Candles in background flicker. Dust swirls outward in ring.
  light + particles flare + swirl in response to contact moment
Object (ancient artifact): central focus, shared grip, lifted between them
Camera: Tight on artifact, four hands visible, faces in shallow background
Intensity: 85%

[BEAT 4: 8-10s]
Kai: Standing close, artifact between them at chest height
  Gesture: Grip secure, thumbs brush Mei's fingers
  Expression: Gratitude, determination, hint of vulnerability
  Body: Steady, grounded, protective stance
Mei: Matching Kai, faces inches apart over artifact
  Gesture: Fingers curl around his, completing the grip
  Expression: Trust achieved, small nod, single tear falls
  Body: Relaxed shoulders, peaceful exhale
Physics: controlled, deep breathing, engaged muscles
Environment: Glow settles to warm steady light. Dust drifts down like snow. Candles return to calm.
  all elements settling calm in response to emotional resolution
Object (ancient artifact): present but secondary, held together, eye contact primary
Camera: Pull back to medium two-shot, hold on connected moment
Intensity: 70%

[CONTINUITY TO NEXT]
- Scene ends at intensity 70%, next scene should acknowledge

>>> CAPTURE FRAME: Beat 3 - Kai grasps artifact; both feel its power <<<
```

---

## Implementation Order

### Phase 1: Script Enrichment (Layer 1)
**Priority: CRITICAL - Must be done first**

1. **Update script generation prompt** (~100 lines)
   - Add enrichment requirements to system prompt
   - Include example formats for each new field
   - Add JSON schema validation hints

2. **Update TypeScript interfaces** (~80 lines)
   - Define `EnrichedScene` type
   - Add sub-types for all new fields
   - Ensure backwards compatibility

3. **Test enriched output**
   - Generate test scripts
   - Validate all fields populated
   - Verify beat breakdown quality

### Phase 2: Choreography Engines (Layer 2)
**Priority: HIGH - After script enrichment works**

4. **BEAT_TIMELINE_GENERATOR** (~50 lines)
   - Timing calculation
   - Frame mapping
   - Duration handling

5. **ENSEMBLE_BLOCKING_SYSTEM** (~80 lines)
   - Position tracking
   - Formation evolution
   - Eyeline mapping

6. **OBJECT_STATE_MACHINE** (~60 lines)
   - Prop tracking
   - State transitions
   - Visibility changes

7. **PHYSICS_LAYER** (~70 lines)
   - Body mechanics
   - Breathing patterns
   - Weight distribution

8. **ENVIRONMENT_RESPONSE_SYSTEM** (~60 lines)
   - Element reactions
   - Sync timing
   - Atmospheric changes

9. **CROSS_SHOT_CALLBACKS** (~50 lines)
   - Continuity tracking
   - Position matching
   - Intensity handoffs

### Phase 3: Master Integration
**Priority: HIGH - After all engines work**

10. **HOLLYWOOD_CHOREOGRAPHER** (~150 lines)
    - Engine orchestration
    - Prompt building
    - Capture frame selection

11. **Integration with shot decomposition** (~50 lines)
    - Feed choreographed prompts to video generation
    - Update `decomposeSceneIntoShots` function
    - Ensure Kling/Veo compatibility

### Phase 4: Testing & Refinement
**Priority: MEDIUM - After integration**

12. **End-to-end testing**
    - Full pipeline test
    - Output quality validation
    - Performance monitoring

---

## Estimated Scope

| Component | New Lines | Modified Lines |
|-----------|-----------|----------------|
| Script prompt enrichment | ~100 | ~50 |
| TypeScript interfaces | ~80 | ~20 |
| 6 Choreography engines | ~370 | 0 |
| HOLLYWOOD_CHOREOGRAPHER | ~150 | 0 |
| Integration code | ~50 | ~30 |
| **Total** | **~750** | **~100** |

---

## Success Criteria

### Layer 1 Success
- [ ] Script generation returns all enriched fields
- [ ] Beat breakdowns are coherent and connected
- [ ] Eyelines form logical sequences
- [ ] Object tracking is consistent

### Layer 2 Success
- [ ] All 6 engines produce valid output
- [ ] Orchestrator combines engines correctly
- [ ] Final prompts are detailed and rich
- [ ] Continuity callbacks connect shots

### Integration Success
- [ ] Video generation receives choreographed prompts
- [ ] Output videos show improved choreography
- [ ] No performance regression
- [ ] Backwards compatible with existing scripts

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| AI doesn't generate enriched fields consistently | Add explicit examples, validation, retry logic |
| Prompts become too long for video generation | Implement priority-based truncation |
| Performance degradation | Cache enrichment data, parallelize engine execution |
| Backwards compatibility breaks | Feature flag for choreography system |

---

## Approval Checklist

- [ ] Two-layer approach approved
- [ ] Implementation order approved
- [ ] Scope estimate acceptable
- [ ] Risk mitigations adequate

**Ready to proceed with implementation upon approval.**
