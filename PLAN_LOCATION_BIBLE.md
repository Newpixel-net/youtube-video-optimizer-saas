# Location Bible Implementation Plan

## Executive Summary

Add a **Location Bible** feature alongside Style Bible and Character Bible, arranged in a horizontal row layout. The Location Bible will generate and maintain reference images for key locations, which are then used as background references during scene/shot generation. Characters are composited INTO these locations, solving the current realism issues.

---

## Current Problems Identified

1. **Layout**: Style Bible and Character Bible are stacked vertically (wastes space)
2. **Locations**: Currently extracted via regex from scene text - no dedicated reference system
3. **Realism Gap**: AI generates everything from scratch each time, causing inconsistent environments
4. **Flow Issue**: Character references work, but backgrounds are generated ad-hoc

---

## Phase 1: Horizontal Layout (Style + Character + Location in a Row)

### 1.1 Update Card Layout

**Current** (lines ~13847-13902 in video-creation-wizard.html):
```
[Style Bible Card   ]
[Character Bible Card]
```

**New Layout:**
```
[Style Bible] [Character Bible] [Location Bible]
     33%           33%              33%
```

**Implementation:**
- Wrap the three Bible cards in a flex container with `flex-direction: row`
- Each card gets `flex: 1` for equal width
- Responsive: Stack vertically on mobile (`flex-wrap: wrap`)
- Add subtle dividers between cards

### 1.2 Card Design Updates

Each card will have:
- Icon + Title + Status badge
- Brief description/preview
- Edit button + Enable toggle
- Preview thumbnails (characters/locations) when populated

---

## Phase 2: Location Bible Core Architecture

### 2.1 State Structure

Add to `state.storyboard`:

```javascript
locationBible: {
    enabled: false,
    locations: [
        {
            id: 'loc-{timestamp}',
            name: 'Neon-lit alleyway',           // Short identifier
            description: 'Dark urban alleyway...',// Full description
            type: 'exterior',                     // exterior | interior | abstract
            timeOfDay: 'night',                   // dawn | day | golden-hour | dusk | night
            weather: 'rainy',                     // clear | cloudy | rainy | foggy | etc.
            mood: 'tense',                        // For atmosphere matching

            // Reference image (like character portrait)
            referenceImageUrl: null,
            referenceImageBase64: null,
            referenceImageStatus: 'none',        // none | generating | ready | error
            referenceImageMimeType: 'image/png',

            // Scene assignments
            appliedToScenes: [],                 // Empty = all scenes, or specific IDs

            // Style elements (auto-extracted or user-defined)
            lightingStyle: 'neon with wet reflections',
            colorPalette: ['#0ff', '#f0f', '#222'],
            keyElements: ['neon signs', 'wet pavement', 'steam vents']
        }
    ],
    autoDetected: false  // True if locations were auto-extracted from script
}
```

### 2.2 Location Detection from Script

**New Function: `extractLocationsFromScript()`**

Analyzes the script/storyboard to identify unique locations:

```javascript
function extractLocationsFromScript() {
    const scenes = state.storyboard.scenes || [];
    const locationPatterns = [
        // Interior patterns
        /(?:inside|within|in)\s+(?:a|the|an)?\s*([^,.]+(?:room|office|lab|kitchen|bedroom|studio|warehouse|factory|chamber|corridor|hall))/gi,
        // Exterior patterns
        /(?:outside|on|at)\s+(?:a|the|an)?\s*([^,.]+(?:street|rooftop|park|plaza|forest|beach|mountain|city|alley|bridge|garden))/gi,
        // Setting patterns
        /(?:the|a|an)\s+([^,.]+(?:metropolis|landscape|skyline|horizon|wasteland|facility|station|headquarters))/gi,
        // Time/place indicators
        /(?:during|at)\s+(?:the)?\s*(sunrise|sunset|dawn|dusk|midnight|noon)/gi
    ];

    // Extract, deduplicate, and group by similarity
    // Return unique locations with estimated scene assignments
}
```

**AI-Assisted Extraction (Optional Enhancement):**
- Call Gemini to analyze script and return structured location data
- Better understanding of context and scene transitions

### 2.3 Location Bible Modal

Similar to Character Bible modal structure:

```
+----------------------------------------------------------+
|  📍 Location Bible                              [×]      |
|  Define consistent environments for visual continuity    |
+----------------------------------------------------------+
|  [+ Add Location] [🔍 Auto-detect from Script]           |
+----------------------------------------------------------+
| LOCATIONS        | LOCATION EDITOR                       |
| +-------------+  | +-----------------------------------+ |
| | Alleyway    |  | | Reference Image     | Details    | |
| | [thumb]     |  | | +-----------+       | Name:_____ | |
| +-------------+  | | |           |       | Type:_____ | |
| | Rooftop     |  | | |   [img]   |       | Time:_____ | |
| | [thumb]     |  | | |           |       | Weather:__ | |
| +-------------+  | | +-----------+       | Mood:_____ | |
| | Lab         |  | | [Generate] [Upload] |            | |
| | [thumb]     |  | +-----------------------------------+ |
+------------------+ | Key Elements: [tag] [tag] [tag]    | |
                    | Scene Assignment: [1][2][3][4]...   | |
                    +-----------------------------------+ |
+----------------------------------------------------------+
```

---

## Phase 3: Location Reference Image Generation

### 3.1 Location Portrait Generation

**New Function: `generateLocationReference(locationId)`**

Uses the same NanoBananaPro/Gemini pipeline as character portraits:

```javascript
async function generateLocationReference(locationId) {
    const location = getLocationById(locationId);

    // Build optimized location prompt
    const prompt = buildLocationPrompt(location);

    // Generate with NanoBananaPro (no character reference - pure environment)
    const result = await generateCreativeImageFn({
        prompt: prompt,
        model: 'nanobanana-pro',
        aspectRatio: '16:9',
        quantity: 1
    });

    // Store URL and base64
    location.referenceImageUrl = result.images[0].url;
    location.referenceImageBase64 = await fetchImageAsBase64(location.referenceImageUrl);
    location.referenceImageStatus = 'ready';
}
```

### 3.2 Location Prompt Builder

**New Function: `buildLocationPrompt(location)`**

Optimized for environment-only generation (no people):

```javascript
function buildLocationPrompt(location) {
    const parts = [];

    // Core environment description
    parts.push(`EMPTY ${location.type.toUpperCase()} ENVIRONMENT:`);
    parts.push(location.description);

    // Time and atmosphere
    parts.push(`Time: ${location.timeOfDay}`);
    if (location.weather) parts.push(`Weather: ${location.weather}`);
    parts.push(`Mood: ${location.mood}`);

    // Lighting specific
    if (location.lightingStyle) {
        parts.push(`LIGHTING: ${location.lightingStyle}`);
    }

    // Key visual elements
    if (location.keyElements?.length) {
        parts.push(`KEY ELEMENTS: ${location.keyElements.join(', ')}`);
    }

    // Critical: No people
    parts.push('CRITICAL: NO PEOPLE, NO CHARACTERS, NO FIGURES. Pure environment only.');
    parts.push('Empty scene ready for character compositing.');

    // Technical quality
    parts.push('Photorealistic, cinematic, 8K detail, professional cinematography.');
    parts.push('Shot on Arri Alexa, anamorphic lens, film grain.');

    return parts.join('\n');
}
```

---

## Phase 4: Integration into Image Generation Pipeline

### 4.1 New Generation Flow

**Current Flow:**
```
Scene → Build Prompt → Add Character Reference → Generate Image
```

**New Flow (Location-First):**
```
Scene → Get Location Reference → Get Character Reference → Build Composite Prompt → Generate Image
                ↓
    (Background/Environment)     (Foreground/Subject)
```

### 4.2 Update `getLocationReferenceForScene(sceneId)`

**New Function:**

```javascript
function getLocationReferenceForScene(sceneId) {
    if (!state.storyboard.locationBible?.enabled) {
        return null;
    }

    const locations = state.storyboard.locationBible.locations || [];

    // Find location assigned to this scene
    const location = locations.find(loc => {
        const includeInAll = !loc.appliedToScenes || loc.appliedToScenes.length === 0;
        const includeInScene = loc.appliedToScenes?.includes(sceneId);
        return (includeInAll || includeInScene) &&
               loc.referenceImageBase64 &&
               loc.referenceImageStatus === 'ready';
    });

    if (location) {
        return {
            base64: location.referenceImageBase64,
            mimeType: location.referenceImageMimeType || 'image/png',
            locationName: location.name,
            locationDescription: location.description,
            lightingStyle: location.lightingStyle,
            timeOfDay: location.timeOfDay
        };
    }

    return null;
}
```

### 4.3 Update Backend Image Generation

**Modify `creationWizardBatchGenerateShotImages`:**

```javascript
// Get location reference for this shot/scene
const locationRef = getLocationReferenceForScene(shot.sceneId);

// Get character reference
const characterRef = getCharacterReferenceForScene(shot.sceneId);

const contentParts = [];

// 1. LOCATION REFERENCE FIRST (sets the background/environment)
if (locationRef?.base64) {
    contentParts.push({
        inlineData: {
            mimeType: locationRef.mimeType,
            data: locationRef.base64
        }
    });
    contentParts.push({
        text: `LOCATION REFERENCE: Use this environment as the exact background setting.
               Match the lighting (${locationRef.lightingStyle}),
               time of day (${locationRef.timeOfDay}),
               and atmosphere precisely.\n\n`
    });
}

// 2. CHARACTER REFERENCE SECOND (subjects to place in the environment)
if (characterRef?.base64) {
    contentParts.push({
        inlineData: {
            mimeType: characterRef.mimeType,
            data: characterRef.base64
        }
    });
    contentParts.push({
        text: `CHARACTER REFERENCE: Place this character in the environment above.
               Maintain their exact facial features, skin tone, and appearance.
               Integrate naturally with the location's lighting.\n\n`
    });
}

// 3. SCENE PROMPT (action, composition, camera)
contentParts.push({ text: enhancedPrompt });
```

### 4.4 Update Prompt Builder

**Modify `NANOBANANA_PROMPT_BUILDER.buildShotPrompt()`:**

Add location-aware prompt construction:

```javascript
buildShotPrompt(shot, context, characterBible, styleBible, locationBible) {
    const parts = [];

    // Location context (if reference provided)
    if (context.locationReference) {
        parts.push(`ENVIRONMENT: Match the provided location reference exactly.`);
        parts.push(`Setting: ${context.locationReference.locationDescription}`);
        parts.push(`Lighting: ${context.locationReference.lightingStyle}`);
    }

    // Character placement
    if (context.characterReference) {
        parts.push(`SUBJECT: Place the referenced character in this environment.`);
        parts.push(`Character: ${context.characterReference.characterName}`);
    }

    // ... rest of prompt building
}
```

---

## Phase 5: Scene-Location Assignment UI

### 5.1 Smart Location Assignment

When locations are detected/created:
1. Auto-assign based on scene descriptions (fuzzy matching)
2. User can manually assign/reassign via toggle buttons
3. "All Scenes" option (empty array = applies everywhere)

### 5.2 Visual Scene Timeline

Show location thumbnails in the scene timeline:
```
Scene 1        Scene 2        Scene 3        Scene 4
[Alleyway]    [Rooftop]      [Alleyway]     [Lab]
   ↓              ↓              ↓              ↓
[Shot 1-3]   [Shot 4-6]     [Shot 7-9]    [Shot 10-12]
```

---

## Phase 6: Style Bible Integration

### 6.1 Location + Style Harmony

The Location Bible should respect Style Bible settings:
- Location lighting should match Style Bible lighting preference
- Color grade from Style Bible applied to location reference
- Atmosphere elements (smoke, rain) added to location descriptions

### 6.2 Cross-Bible Consistency Check

New function to validate Bible consistency:

```javascript
function validateBibleConsistency() {
    const warnings = [];

    // Check style + location harmony
    if (styleBible.lighting === 'bright daylight' &&
        locationBible.locations.some(l => l.timeOfDay === 'night')) {
        warnings.push('Style Bible specifies daylight but some locations are night scenes');
    }

    // Check character + location presence
    const scenesWithCharacters = getCharacterAssignedScenes();
    const scenesWithLocations = getLocationAssignedScenes();

    // Warn if character appears in scene without location reference
    // ...

    return warnings;
}
```

---

## Phase 7: Realism Enhancement Pipeline

### 7.1 Two-Pass Generation (Optional)

For maximum realism:

**Pass 1: Generate Location**
```
Location Reference → Gemini → Background Image (empty)
```

**Pass 2: Composite Character**
```
Background Image + Character Reference → Gemini → Final Composite
```

This ensures the environment is established first, then characters are naturally integrated.

### 7.2 Location-Aware Lighting Matching

When generating character in location:
- Extract lighting direction from location reference
- Apply same lighting to character (rim lights, shadows, reflections)
- Match color temperature

### 7.3 Realism Checklist in Prompts

Add to NANOBANANA_PROMPT_BUILDER:

```javascript
const realismConstraints = [
    'Natural skin texture with pores and imperfections',
    'Clothing fabric with realistic folds and shadows',
    'Environmental reflections on skin and eyes',
    'Consistent shadow direction with location lighting',
    'Film grain and subtle chromatic aberration',
    'No AI smoothing or plastic-looking skin'
];
```

---

## Implementation Order

### Sprint 1: Layout & Structure (1 session)
1. Update card layout to horizontal row
2. Add Location Bible state structure
3. Create basic Location Bible modal (empty state)

### Sprint 2: Location Detection & Management (1 session)
4. Implement `extractLocationsFromScript()`
5. Add location CRUD operations (add, edit, delete)
6. Scene assignment UI

### Sprint 3: Reference Image Generation (1 session)
7. Implement `generateLocationReference()`
8. Build `buildLocationPrompt()`
9. Location upload functionality

### Sprint 4: Pipeline Integration (1 session)
10. Update backend to accept location references
11. Modify prompt builder for location-awareness
12. Update `creationWizardBatchGenerateShotImages`

### Sprint 5: Polish & Realism (1 session)
13. Cross-bible validation
14. Realism enhancement prompts
15. Testing & refinement

---

## File Changes Summary

### Frontend (`video-creation-wizard.html`)
- Lines ~13847-13902: Update Bible cards layout (horizontal)
- New: `renderLocationBibleModal()` function
- New: Location Bible management functions
- New: `getLocationReferenceForScene()` function
- Update: Scene/shot prompt assembly to include location

### Backend (`functions/index.js`)
- Update: `creationWizardBatchGenerateShotImages` - add location reference handling
- Update: Prompt building to include location context
- Optional: New `creationWizardGenerateLocationReference` function

### State Structure
- Add `state.storyboard.locationBible` with locations array

---

## Expected Outcomes

1. **Visual Consistency**: Same location looks identical across all shots
2. **Improved Realism**: Characters naturally integrated into environments
3. **Faster Generation**: Reference images guide AI, reducing hallucination
4. **Better Control**: Users define exactly what locations look like
5. **Scalable**: System can handle any number of locations
6. **Maintainable**: Follows existing Character Bible architecture

---

## Questions for User Before Implementation

1. **Location Templates**: Should we include preset location types (urban, nature, interior, sci-fi) like Style Bible templates?

2. **Auto-Detection Depth**: How smart should location extraction be?
   - Basic regex (fast, less accurate)
   - AI-assisted (slower, more accurate)

3. **Multi-Location Scenes**: Can a scene have multiple locations (e.g., transition from interior to exterior)?

4. **Location Variants**: Should the same location support variants (e.g., "Alleyway - Day" vs "Alleyway - Night")?
