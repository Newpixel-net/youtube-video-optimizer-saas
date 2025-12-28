# Visual Consistency Methodology for AI Video Generation

## The Problem

Each scene in an AI video is generated with an independent prompt. The AI has **no memory** between generations, so:

- Scene 1's "lone figure" is a completely different person than Scene 4's "two characters"
- Scene 2's neon cyberpunk look has nothing in common with Scene 6's desert
- No consistent color grade, lighting style, or camera language

## The Solution: 4-Layer Prompt Architecture

Every prompt must be assembled from 4 layers:

```
[STYLE BIBLE] + [CHARACTER BIBLE] + [SCENE CONTENT] + [TECHNICAL SPECS]
```

### Layer 1: Style Bible (SAME for every scene)

The Style Bible defines the visual DNA of your entire project. This text is **copy-pasted exactly** into every scene prompt.

**Example Style Bible:**
```
Style: ultra-cinematic photoreal, noir thriller, high contrast
Color Grade: desaturated teal shadows, amber highlights, crushed blacks
Lighting: harsh single-source, dramatic rim lights
Atmosphere: smoke, rain reflections, wet surfaces
Camera: slow dolly, low angles, stabilized gimbal
```

**What to include:**
- Overall visual style (cinematic, documentary, stylized, etc.)
- Color grading approach
- Lighting philosophy
- Environmental atmosphere
- Camera language and movement

### Layer 2: Character Bible (SAME for every scene with that character)

The Character Bible provides **exact character descriptions** that are copy-pasted whenever that character appears.

**Example Character Bible:**
```
Male protagonist, early 30s, athletic build, weathered skin,
short dark hair, 3-day stubble, intense grey eyes, scar on cheekbone,
worn charcoal tactical jacket, black cargo pants, leather satchel
```

**What to include:**
- Age, build, ethnicity
- Face details (hair, eyes, facial hair, distinguishing marks)
- Clothing (be specific about colors and styles)
- Props/accessories they always carry
- Posture/demeanor

### Layer 3: Scene Content (UNIQUE per scene)

This is what actually happens in the scene - the action, emotion, and specific visual elements.

**Example Scene Content:**
```
[Push in] A dimly lit cluttered garage. The protagonist hunches over
blueprints spread on a workbench. Shadows creep around like silent
witnesses. A single hanging lamp sways slightly overhead.
```

**What to include:**
- Camera motion direction: [Push in], [Pull out], [Pan left], [Tracking shot], etc.
- Location/setting
- Action being performed
- Specific scene props
- Emotional beat

### Layer 4: Technical Specs + Negative Prompt

Quality parameters and things to avoid.

**Example Technical Specs:**
```
Positive: 4K, ultra detailed, shallow DOF, motion blur, cinematic aspect ratio
Negative: no text, no logos, no watermarks, no glitch artifacts, no deformed hands, no extra fingers
```

---

## The Critical Rule

**You must copy-paste the EXACT same Style Bible and Character Bible text into EVERY prompt.**

- Don't paraphrase
- Don't summarize
- Don't "improve" it scene by scene

The AI sees each prompt fresh - consistency only comes from you repeating the **same words, same order, same everything**.

---

## Implementation in Video Creation Wizard

### State Structure

```javascript
storyboard: {
  // Existing fields...

  // Scene Memory System
  styleBible: {
    enabled: true,
    style: '',           // Visual style description
    colorGrade: '',      // Color grading approach
    lighting: '',        // Lighting philosophy
    atmosphere: '',      // Environmental elements
    camera: ''           // Camera language
  },

  characterBible: {
    enabled: true,
    characters: [
      {
        id: 'char-1',
        name: 'Protagonist',
        description: '',   // Full character description
        appliedToScenes: [] // Which scenes this character appears in
      }
    ]
  },

  technicalSpecs: {
    positive: '4K, ultra detailed, shallow DOF, cinematic',
    negative: 'blurry, low quality, watermark, text, logo, deformed'
  }
}
```

### Prompt Assembly

When generating an image, the prompt is assembled as:

```javascript
function assembleScenePrompt(scene) {
  const parts = [];

  // Layer 1: Style Bible
  if (state.storyboard.styleBible?.enabled) {
    const bible = state.storyboard.styleBible;
    if (bible.style) parts.push(`Style: ${bible.style}`);
    if (bible.colorGrade) parts.push(`Color Grade: ${bible.colorGrade}`);
    if (bible.lighting) parts.push(`Lighting: ${bible.lighting}`);
    if (bible.atmosphere) parts.push(`Atmosphere: ${bible.atmosphere}`);
    if (bible.camera) parts.push(`Camera: ${bible.camera}`);
  }

  // Layer 2: Character Bible
  const sceneCharacters = getCharactersForScene(scene.id);
  for (const char of sceneCharacters) {
    parts.push(char.description);
  }

  // Layer 3: Scene Content
  parts.push(scene.visual);

  // Layer 4: Technical Specs
  parts.push(state.storyboard.technicalSpecs?.positive || '');

  return {
    prompt: parts.filter(Boolean).join('. '),
    negativePrompt: state.storyboard.technicalSpecs?.negative || ''
  };
}
```

---

## Quick Start Templates

### Template: Cinematic Thriller

**Style Bible:**
```
Style: ultra-cinematic photoreal, noir thriller, high contrast
Color Grade: desaturated teal shadows, amber highlights, crushed blacks
Lighting: harsh single-source, dramatic rim lights, deep shadows
Atmosphere: smoke, rain reflections, wet surfaces, urban grit
Camera: slow dolly, low angles, stabilized gimbal, anamorphic lens feel
```

### Template: Documentary Nature

**Style Bible:**
```
Style: cinematic documentary, National Geographic quality, epic landscapes
Color Grade: rich earth tones, golden highlights, deep greens
Lighting: natural golden hour, soft diffused daylight
Atmosphere: volumetric fog, dust particles, lens flares
Camera: smooth tracking, wide establishing shots, intimate close-ups
```

### Template: Tech Explainer

**Style Bible:**
```
Style: clean modern, minimal, high-tech aesthetic
Color Grade: cool blues, clean whites, accent neon
Lighting: high-key soft lighting, no harsh shadows
Atmosphere: clean gradient backgrounds, subtle particle effects
Camera: smooth dolly, symmetrical framing, focus pulls
```

### Template: Horror/Suspense

**Style Bible:**
```
Style: psychological horror, unsettling, dreamlike quality
Color Grade: desaturated, sickly greens, deep blacks, red accents
Lighting: low-key, single source, harsh shadows, flickering
Atmosphere: fog, dust motes, decayed textures, uncanny valley
Camera: dutch angles, slow creeping push-ins, unstable handheld
```

---

## Character Bible Examples

### Example: Action Hero

```
Male protagonist, early 30s, athletic muscular build, weathered tan skin,
short cropped dark brown hair with grey at temples, 3-day stubble,
intense steel-grey eyes, thin scar across left cheekbone,
wearing worn charcoal tactical jacket with velcro patches,
fitted black cargo pants with utility pockets, brown leather belt,
dusty military-style boots, carrying weathered leather satchel
```

### Example: Tech Professional

```
Female lead, late 20s, slender athletic build, light olive complexion,
shoulder-length straight black hair often tucked behind ear,
dark brown eyes with sharp focus, minimalist silver earrings,
wearing fitted navy blazer over white crew neck t-shirt,
high-waisted dark grey wool trousers, clean white sneakers,
silver smartwatch on left wrist, thin-frame glasses
```

### Example: Mysterious Figure

```
Gender-ambiguous figure, age indeterminate, tall lean silhouette,
face often obscured or in shadow, pale porcelain-like skin when visible,
long dark hair that partially covers face, eyes that reflect light unnaturally,
wearing floor-length black coat with high collar,
dark formless clothing underneath, barefoot or in silent shoes,
moves with fluid unnatural grace, often positioned in doorways or edges of frame
```

---

## Troubleshooting

### Problem: Characters still look different between scenes

**Solution:** Make your Character Bible more specific. Instead of "dark hair", say "short cropped dark brown hair with subtle grey at temples, parted on the left, slightly messy". Every detail you don't specify, the AI will randomize.

### Problem: Scenes don't feel cohesive

**Solution:** Your Style Bible may be too vague. Add specific camera lenses ("anamorphic 40mm"), specific color references ("Blade Runner 2049 teal"), or named film references ("Roger Deakins cinematography style").

### Problem: Prompts are getting too long

**Solution:** Prioritize consistency over variety. A shorter, repeated description beats a longer, varied one. The AI responds better to clear, consistent instructions.

---

## Version History

- **v1.0** - Initial methodology documentation
- Integrated with Video Creation Wizard Phase 4: Scene Memory System
