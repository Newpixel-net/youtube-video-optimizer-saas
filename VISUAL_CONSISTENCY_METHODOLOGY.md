# Visual Consistency Methodology for AI Video Production

## The Problem

Current approach generates each scene prompt independently, resulting in:
- Different character appearances across scenes (clothing, features, age)
- Inconsistent color palettes and lighting styles
- No unified camera language
- Scenes that look like they're from different movies
- No visual storytelling coherence

## The Solution: Layered Prompt Architecture

Every scene prompt must be constructed from **4 layers**:

```
[GLOBAL STYLE BIBLE] + [CHARACTER BIBLE] + [SCENE-SPECIFIC] + [TECHNICAL SPECS]
```

---

## Layer 1: Global Style Bible (Same for ALL scenes)

This defines the "look" of your entire video and NEVER changes between scenes.

### Structure:
```
STYLE BIBLE:
- Aspect: {16:9 cinematic | 9:16 vertical | 1:1 square}
- Visual Style: {ultra-cinematic photoreal | stylized anime | noir | documentary}
- Color Grade: {specific palette description}
- Lighting Approach: {high contrast noir | soft naturalistic | neon-lit | golden hour warm}
- Atmosphere: {fog/haze level, particle effects}
- Film Texture: {clean digital | subtle film grain | heavy grain}
- Camera Feel: {stabilized gimbal | handheld docu-style | locked tripod | crane/dolly}

NEGATIVE (always include):
no text, no logos, no watermarks, no split-screen, no UI, no subtitles, no frame borders, no glitch artifacts, no extra limbs, no deformed hands, no morphing faces
```

### Example Style Bibles by Genre:

**Noir Thriller:**
```
Style: ultra-cinematic photoreal, high contrast noir, deep shadows
Color Grade: desaturated with teal shadows and amber highlights, crushed blacks
Lighting: harsh single-source lighting, dramatic rim lights, venetian blind shadows
Atmosphere: cigarette smoke, rain on windows, wet reflective surfaces
Film Texture: subtle film grain, anamorphic lens characteristics
Camera Feel: slow dolly movements, static tension shots, low angles
```

**Cyberpunk Action:**
```
Style: ultra-cinematic photoreal, neon-noir aesthetic, high detail
Color Grade: deep blacks with electric cyan, magenta, and orange neon accents
Lighting: neon signage as primary light source, wet reflective streets, lens flares
Atmosphere: rain, steam from vents, holographic particles, light fog
Film Texture: clean digital with subtle chromatic aberration
Camera Feel: stabilized gimbal tracking, dynamic crane movements
```

**Epic Fantasy:**
```
Style: ultra-cinematic photoreal, painterly lighting, mythic grandeur
Color Grade: rich warm golds and deep forest greens, ethereal highlights
Lighting: volumetric god rays, golden hour sun, dramatic backlight
Atmosphere: dust motes, pollen particles, mist in valleys, dappled forest light
Film Texture: subtle grain, soft bloom on highlights
Camera Feel: sweeping crane shots, majestic slow push-ins
```

**Documentary/Realistic:**
```
Style: photoreal documentary, naturalistic lighting, grounded realism
Color Grade: neutral with slight warmth, high dynamic range, natural skin tones
Lighting: available light feel, soft window light, practical light sources
Atmosphere: minimal effects, authentic environments
Film Texture: clean or subtle grain depending on era
Camera Feel: handheld with subtle movement, observational angles
```

---

## Layer 2: Character Bible (Consistent across all scenes with that character)

If your video has recurring characters, define them ONCE and inject into every relevant scene.

### Structure:
```
CHARACTER: {Name}
- Physical: {age, gender, build, skin tone, hair color/style, distinguishing features}
- Face: {specific facial features for consistency}
- Costume: {detailed clothing description that stays consistent}
- Props: {items they carry/wear consistently}
- Presence: {how they carry themselves - confident, nervous, mysterious}
```

### Example Character Bibles:

**Protagonist - "The Runner":**
```
CHARACTER: Male protagonist, early 30s
- Physical: athletic lean build, weathered Caucasian skin, short dark brown hair with dust/ash, 3-day stubble
- Face: strong jaw, intense blue-grey eyes, small scar on left cheekbone
- Costume: worn dark tactical jacket (charcoal grey, hood down), black cargo pants with knee guards, dusty military boots, fingerless gloves
- Props: weathered leather satchel across chest, no visible weapons
- Presence: determined, survival-hardened, moves with purpose
```

**Mysterious Guide:**
```
CHARACTER: Female guide, ageless (appears 40s)
- Physical: tall willowy build, dark brown skin, silver-grey locs pulled back
- Face: high cheekbones, amber eyes, calm knowing expression
- Costume: flowing burgundy cloak over earth-tone layered robes, leather cord necklace with amber stone
- Props: wooden walking staff with carved symbols
- Presence: serene authority, moves gracefully, seems to know more than she reveals
```

---

## Layer 3: Scene-Specific Content

Now add what's unique to THIS scene:

### Structure:
```
SCENE CONTENT:
- Action: {what is happening in this shot}
- Location: {specific environment details}
- Time/Weather: {time of day, weather conditions}
- Camera Shot: {shot type and movement}
- Emotional Beat: {what feeling this scene conveys}
- Key Visual Elements: {specific objects, effects, or details for this scene}
```

### Camera Shot Vocabulary:
- **Wide establishing** - shows full environment, subject small in frame
- **Medium shot** - subject from waist up, shows body language
- **Close-up** - face or important object fills frame
- **Extreme close-up** - eyes, hands, small detail
- **Over-shoulder** - from behind one character looking at another
- **POV** - from character's eye perspective
- **Low angle** - camera looking up, subject appears powerful
- **High angle** - camera looking down, subject appears vulnerable
- **Dutch angle** - tilted frame, creates unease
- **Tracking shot** - camera moves alongside subject
- **Push in** - camera slowly moves toward subject (building tension)
- **Pull out** - camera moves away from subject (revealing context)
- **Crane up/down** - vertical camera movement
- **Dolly zoom** - zoom out while moving in (or vice versa) - vertigo effect

---

## Layer 4: Technical Quality Specs

Always end with quality markers:

```
TECHNICAL:
4K, ultra detailed, photorealistic, shallow depth of field, realistic motion blur, cinematic aspect ratio, professional color grade, ray-traced lighting
```

---

## Complete Prompt Assembly Example

### Project: Post-Apocalyptic Survival Thriller

**Style Bible (used for ALL scenes):**
```
ultra-cinematic photoreal, gritty post-apocalyptic, high detail
Color: desaturated earth tones with orange fire accents and teal shadows
Lighting: harsh directional light, heavy contrast, atmospheric haze
Atmosphere: ash, embers, dust particles, smoke wisps, wet reflective rubble
Texture: subtle film grain, anamorphic lens characteristics
Camera: stabilized gimbal tracking, dynamic handheld tension shots

Negative: no text, no logos, no watermarks, no split-screen, no UI, no glitch artifacts, no extra limbs, no deformed hands
```

**Character Bible - Protagonist:**
```
Male, early 30s, athletic lean build, weathered Caucasian skin, short dark brown hair with dust, 3-day stubble, strong jaw, intense blue-grey eyes, small scar on left cheekbone, worn charcoal tactical jacket with hood, black cargo pants, dusty military boots, leather satchel across chest
```

---

### Scene 1: Opening - Discovery

**Final Assembled Prompt:**
```
A lone male survivor, early 30s, athletic lean build, weathered skin, short dark brown hair dusted with ash, 3-day stubble, strong jaw, intense blue-grey eyes, small scar on left cheekbone, wearing a worn charcoal tactical jacket with hood down, black cargo pants, dusty military boots, leather satchel across chest, crouching in the shadows of a collapsed concrete parking structure, examining a faded photograph, dust motes floating in a shaft of pale light from a crack above, rubble and abandoned vehicles in background, ultra-cinematic photoreal, gritty post-apocalyptic, desaturated earth tones with teal shadows, harsh directional light from above, medium close-up shot from slight low angle, atmospheric haze and dust particles, subtle film grain, 4K, ultra detailed, shallow depth of field, cinematic lighting

Negative prompt: no text, no logos, no watermarks, no split-screen, no UI, no glitch artifacts, no extra limbs, no deformed hands
```

### Scene 2: Journey - Running Through Ruins

**Final Assembled Prompt:**
```
A lone male survivor, early 30s, athletic lean build, weathered skin, short dark brown hair dusted with ash, 3-day stubble, strong jaw, intense blue-grey eyes, small scar on left cheekbone, wearing a worn charcoal tactical jacket with hood up, black cargo pants, dusty military boots, leather satchel bouncing as he runs, sprinting through a devastated burning city canyon at dusk, towering broken metal and stone structures leaning inward, flames bursting from rubble piles, embers and ash swirling violently, wet reflective debris-covered ground, intense orange firelight and heavy smoke, dramatic backlight, cinematic gimbal tracking shot from behind at low angle as he runs toward camera, ultra-cinematic photoreal, gritty post-apocalyptic, desaturated with intense orange fire accents, heavy contrast, atmospheric smoke and ember particles, shallow depth of field, realistic motion blur, subtle film grain, 4K, ultra detailed

Negative prompt: no text, no logos, no watermarks, no split-screen, no UI, no glitch artifacts, no extra limbs, no deformed hands
```

### Scene 3: Encounter - Meeting the Guide

**Final Assembled Prompt:**
```
A lone male survivor, early 30s, athletic lean build, weathered skin, short dark brown hair dusted with ash, 3-day stubble, wearing a worn charcoal tactical jacket, leather satchel, standing tensely facing a mysterious tall woman with silver-grey locs, dark brown skin, wearing a flowing burgundy cloak over earth-tone robes, holding a wooden staff with carved symbols, amber stone necklace glowing faintly, inside a partially collapsed cathedral with shattered stained glass, pale dusty light streaming through holes in the ceiling, rubble and broken pews, tense standoff composition, ultra-cinematic photoreal, gritty post-apocalyptic, desaturated earth tones with warm amber accent from the stone, dramatic rim lighting, medium two-shot with characters on rule-of-thirds, atmospheric dust particles in light beams, subtle film grain, 4K, ultra detailed, shallow depth of field

Negative prompt: no text, no logos, no watermarks, no split-screen, no UI, no glitch artifacts, no extra limbs, no deformed hands
```

---

## Implementation Rules

### Rule 1: Style Bible is SACRED
Never deviate from your style bible within a project. If Scene 1 is "desaturated teal and orange," Scene 5 cannot suddenly be "vibrant saturated colors."

### Rule 2: Character Descriptions are EXACT
Copy-paste the exact same character description into every prompt. Don't paraphrase. "Short dark brown hair" in one scene cannot become "black hair" in another.

### Rule 3: Lighting Continuity
If your scenes are supposed to be sequential:
- Track time of day across scenes
- Maintain consistent light direction within a location
- Weather should be consistent unless story requires change

### Rule 4: Camera Language Supports Story
- Tension building: slow push-ins, low angles, tight framing
- Action: tracking shots, dynamic angles, motion blur
- Emotional beats: close-ups, shallow DOF, soft lighting
- Reveals: pull-outs, crane ups, wide establishing shots

### Rule 5: Environment Consistency
If characters are in the "same world":
- Architecture style should match (all brutalist, all gothic, all organic)
- Technology level consistent
- Damage/wear level consistent
- Flora/fauna consistent

---

## Video-to-Prompt Workflow

### Step 1: Before generating ANY images
1. Define your Style Bible completely
2. Create Character Bibles for all recurring characters
3. Map out scene locations and times

### Step 2: For each scene
1. Start with Style Bible (copy exact text)
2. Add Character Bible(s) for characters in scene
3. Add scene-specific action, location, camera
4. Add technical specs
5. Add negative prompts

### Step 3: Quality check
Before generating, verify:
- [ ] Character description matches exactly
- [ ] Color palette keywords match style bible
- [ ] Lighting style matches style bible
- [ ] Atmosphere elements included
- [ ] Camera shot type specified
- [ ] Negative prompts included

---

## Genre-Specific Style Bible Templates

### Horror/Thriller
```
Style: ultra-cinematic photoreal, psychological horror, unsettling atmosphere
Color: desaturated sickly greens and pale flesh tones, deep shadow blacks
Lighting: harsh underlight, flickering practical sources, darkness crowding frame edges
Atmosphere: fog at floor level, dust motes, breath visible in cold, subtle lens distortion
Camera: static unnerving angles, slow creeping push-ins, dutch angles for unease
```

### Sci-Fi Epic
```
Style: ultra-cinematic photoreal, grand sci-fi, awe-inspiring scale
Color: clean whites and cool blues with warm accent lighting, deep space blacks
Lighting: dramatic rim lights, holographic glows, lens flares from bright sources
Atmosphere: floating particles, light dust, energy effects, atmospheric perspective for scale
Camera: sweeping establishing shots, smooth dolly moves, low angles for heroic framing
```

### Period Drama
```
Style: ultra-cinematic photoreal, painterly period aesthetic, intimate character focus
Color: rich warm candlelight tones, deep burgundies and golds, natural skin warmth
Lighting: soft window light, candle/firelight, Rembrandt lighting on faces
Atmosphere: dust in light beams, fire sparks, period-accurate environments
Camera: elegant slow moves, intimate close-ups, composed wide shots
```

### Action/Adventure
```
Style: ultra-cinematic photoreal, high-energy action, visceral impact
Color: high contrast, punchy saturation, dramatic color contrast in compositions
Lighting: dramatic backlight, practical explosion light, dynamic shadows
Atmosphere: debris, sparks, smoke, water spray, motion trails
Camera: dynamic tracking, impact close-ups, sweeping crane moves, speed ramping feel
```

---

## Summary

The key insight is that **every prompt is not independent** - they are all variations on a single visual language defined by your Style Bible and Character Bibles. The AI doesn't "remember" between generations, so YOU must enforce consistency by including the same foundational elements in every single prompt.

Think of it like giving instructions to a different cinematographer for each scene, but handing them all the same "show bible" document that defines exactly how this production should look.
