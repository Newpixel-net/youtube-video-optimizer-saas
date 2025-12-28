# Video Creation Wizard - Complete Restructure Plan
## "Hollywood-Grade Production Intelligence System"

---

## Executive Summary

The current wizard fails because it treats all content types the same and lacks the intelligence to understand what the user actually wants to create. When a user says "Breaking Bad-style action/thriller/crime series", the system should understand they want:
- **Original content** in that STYLE
- Not recreations of Breaking Bad itself
- Professional cinematography, mood, and narrative structure
- Complex characters in morally gray situations
- Specific visual language (desert colors, tension-building shots)

This plan restructures the wizard into an intelligent production pipeline that thinks like a Hollywood producer.

---

## Current Problems Identified

1. **Platform Selection Bloat**: Takes up too much space for what's essentially just a resolution/format decision
2. **Generic Niche System**: "Entertainment", "Education" etc. doesn't capture the user's creative vision
3. **No Idea Development Phase**: Users jump straight to script without conceptualization
4. **Style vs Reference Confusion**: System can't distinguish between "like Breaking Bad" (style) and "about Breaking Bad" (subject)
5. **One-Size-Fits-All Characters**: Always assumes human narrator, doesn't consider dialogue-only or non-human characters
6. **Missing Production Context**: Doesn't understand that a Movie has different needs than a TikTok video

---

## The New Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    NEW WIZARD FLOW ARCHITECTURE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ PHASE 1: PRODUCTION FORMAT (Minimal - Just Technical Specs)         │   │
│  │ ──────────────────────────────────────────────────────────────────  │   │
│  │ Simple dropdown: What format?                                       │   │
│  │ • Widescreen (16:9) - YouTube, TV, Movies                          │   │
│  │ • Vertical (9:16) - TikTok, Reels, Shorts                          │   │
│  │ • Square (1:1) - Instagram Feed                                     │   │
│  │ • Custom dimensions                                                 │   │
│  │                                                                     │   │
│  │ Duration slider: 30s → 60min                                        │   │
│  │ Quality preset: HD / 4K                                            │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ PHASE 2: PRODUCTION TYPE (What Are You Making?)                     │   │
│  │ ──────────────────────────────────────────────────────────────────  │   │
│  │                                                                     │   │
│  │ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   │   │
│  │ │   SOCIAL    │ │   MOVIE     │ │   SERIES    │ │ EDUCATIONAL │   │   │
│  │ │   CONTENT   │ │  (Feature)  │ │ (Episodes)  │ │  (Learning) │   │   │
│  │ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘   │   │
│  │ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   │   │
│  │ │   MUSIC     │ │ COMMERCIAL  │ │   PODCAST   │ │   CUSTOM    │   │
│  │ │   VIDEO     │ │   /PROMO    │ │   VIDEO     │ │             │   │
│  │ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘   │   │
│  │                                                                     │   │
│  │ Each type expands to show relevant sub-genres (Phase 2B)           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ PHASE 2B: SUB-GENRE & STYLE REFERENCE                               │   │
│  │ ──────────────────────────────────────────────────────────────────  │   │
│  │                                                                     │   │
│  │ IF MOVIE selected:                                                  │   │
│  │ ┌────────────────────────────────────────────────────────────────┐ │   │
│  │ │ Action │ Drama │ Comedy │ Horror │ Sci-Fi │ Thriller │ Romance │ │   │
│  │ │ Western │ War │ Fantasy │ Animation │ Documentary │ Musical   │ │   │
│  │ └────────────────────────────────────────────────────────────────┘ │   │
│  │                                                                     │   │
│  │ IF SERIES selected:                                                 │   │
│  │ ┌────────────────────────────────────────────────────────────────┐ │   │
│  │ │ Crime/Thriller │ Drama │ Sci-Fi │ Fantasy │ Comedy │ Docuseries│ │   │
│  │ │ Anthology │ Limited Series │ Soap Opera │ Sitcom │ Anime      │ │   │
│  │ └────────────────────────────────────────────────────────────────┘ │   │
│  │                                                                     │   │
│  │ STYLE REFERENCES (What inspires you?):                             │   │
│  │ ┌────────────────────────────────────────────────────────────────┐ │   │
│  │ │ "Tell us what inspires your vision..."                         │ │   │
│  │ │ [Breaking Bad-style tension and moral complexity     ]         │ │   │
│  │ │                                                                 │ │   │
│  │ │ AI interprets as:                                               │ │   │
│  │ │ • Visual: Desert palette, stark lighting, symmetry              │ │   │
│  │ │ • Narrative: Moral ambiguity, slow-burn tension                 │ │   │
│  │ │ • Characters: Complex antiheroes, family dynamics              │ │   │
│  │ │ • NOT: Actual Breaking Bad characters or story                 │ │   │
│  │ └────────────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ PHASE 3: CONCEPT DEVELOPMENT (The Creative Heart)                   │   │
│  │ ──────────────────────────────────────────────────────────────────  │   │
│  │                                                                     │   │
│  │ Step 3A: Initial Concept Input                                      │   │
│  │ ┌────────────────────────────────────────────────────────────────┐ │   │
│  │ │ "Describe your concept, keywords, or basic idea..."            │ │   │
│  │ │ [A dark warrior who protects an ancient realm from shadows   ] │ │   │
│  │ └────────────────────────────────────────────────────────────────┘ │   │
│  │                                                                     │   │
│  │ Step 3B: AI Concept Generation (5-10 unique concepts)              │   │
│  │ ┌────────────────────────────────────────────────────────────────┐ │   │
│  │ │ 🎬 "Cybdemon: The Dark Guardian of Granola"                    │ │   │
│  │ │    A half-machine warrior protects the last organic realm...   │ │   │
│  │ │    [Select] [Modify] [Regenerate Similar]                      │ │   │
│  │ ├────────────────────────────────────────────────────────────────┤ │   │
│  │ │ 🗡️ "The Shadow Knight of Terravale"                            │ │   │
│  │ │    An exiled knight discovers his shadow has its own will...   │ │   │
│  │ │    [Select] [Modify] [Regenerate Similar]                      │ │   │
│  │ ├────────────────────────────────────────────────────────────────┤ │   │
│  │ │ 🌙 "Nightfall Protocol"                                        │ │   │
│  │ │    In a world where darkness gained sentience...               │ │   │
│  │ │    [Select] [Modify] [Regenerate Similar]                      │ │   │
│  │ └────────────────────────────────────────────────────────────────┘ │   │
│  │                                                                     │   │
│  │ Step 3C: Concept Refinement (after selection)                      │   │
│  │ ┌────────────────────────────────────────────────────────────────┐ │   │
│  │ │ Selected: "Cybdemon: The Dark Guardian of Granola"             │ │   │
│  │ │                                                                 │ │   │
│  │ │ Title: [Cybdemon: The Dark Guardian     ] ← editable          │ │   │
│  │ │ Tagline: [Where flesh meets circuit, hope survives] ← AI gen  │ │   │
│  │ │ Tone: [Dark] [Hopeful] [Intense] [Epic]  ← select multiple    │ │   │
│  │ │ Setting: [Post-apocalyptic organic realm]  ← editable          │ │   │
│  │ └────────────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ PHASE 4: PRODUCTION CONFIGURATION (Smart Defaults)                  │   │
│  │ ──────────────────────────────────────────────────────────────────  │   │
│  │                                                                     │   │
│  │ Based on Production Type + Genre + Concept, AI determines:         │   │
│  │                                                                     │   │
│  │ CHARACTER CONFIGURATION:                                            │   │
│  │ ┌────────────────────────────────────────────────────────────────┐ │   │
│  │ │ ☐ Narrator Voice (omniscient storyteller)                      │ │   │
│  │ │ ☑ Character Dialogue (characters speak to each other)          │ │   │
│  │ │ ☐ First-Person Narration (protagonist tells the story)         │ │   │
│  │ │ ☐ Silent/Visual Only (no dialogue, atmospheric)                │ │   │
│  │ │                                                                 │ │   │
│  │ │ If characters needed:                                          │ │   │
│  │ │ [Auto-Generate Characters from Concept] or [Define Manually]   │ │   │
│  │ └────────────────────────────────────────────────────────────────┘ │   │
│  │                                                                     │   │
│  │ SUGGESTED CHARACTERS (AI-generated from concept):                  │   │
│  │ ┌────────────────────────────────────────────────────────────────┐ │   │
│  │ │ 🤖 Cybdemon                                                     │ │   │
│  │ │    Half-human, half-machine warrior. Glowing circuits under    │ │   │
│  │ │    scarred flesh. Speaks in measured tones.                    │ │   │
│  │ │    [Keep] [Edit] [Remove]                                      │ │   │
│  │ ├────────────────────────────────────────────────────────────────┤ │   │
│  │ │ 🌿 Elder Mossara                                                │ │   │
│  │ │    Ancient tree-being, keeper of Granola's memories. Voice     │ │   │
│  │ │    like rustling leaves.                                       │ │   │
│  │ │    [Keep] [Edit] [Remove]                                      │ │   │
│  │ ├────────────────────────────────────────────────────────────────┤ │   │
│  │ │ ⚫ The Void Speaker                                             │ │   │
│  │ │    Entity of pure shadow. No physical form. Whispers from      │ │   │
│  │ │    everywhere at once.                                          │ │   │
│  │ │    [Keep] [Edit] [Remove]                                      │ │   │
│  │ └────────────────────────────────────────────────────────────────┘ │   │
│  │                                                                     │   │
│  │ Note: Characters can be:                                           │   │
│  │ • Human (realistic, stylized, anime)                               │   │
│  │ • Non-human (robots, aliens, creatures, abstract entities)        │   │
│  │ • Objects (talking sword, sentient AI, haunted item)              │   │
│  │ • Concepts (personified Death, embodied emotions)                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ PHASE 5: SCRIPT GENERATION (Powered by Concept + Characters)        │   │
│  │ ──────────────────────────────────────────────────────────────────  │   │
│  │                                                                     │   │
│  │ The script generation now has FULL CONTEXT:                        │   │
│  │ • Production type (Movie/Series/etc)                               │   │
│  │ • Genre (Crime/Thriller)                                           │   │
│  │ • Style reference (Breaking Bad-STYLE, not Breaking Bad)           │   │
│  │ • Developed concept with title and tone                            │   │
│  │ • Character definitions (who they are, how they speak)             │   │
│  │ • Narrative structure (dialogue vs narration)                      │   │
│  │                                                                     │   │
│  │ Script output includes:                                            │   │
│  │ • Scene-by-scene breakdown with visual descriptions                │   │
│  │ • Character dialogue formatted properly                            │   │
│  │ • Mood/tone markers for each scene                                 │   │
│  │ • Camera/shot suggestions                                          │   │
│  │ • Music/sound mood suggestions                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↓                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ PHASE 6+: STORYBOARD → ANIMATION → ASSEMBLY → EXPORT               │   │
│  │ (Uses existing Prompt Chain Architecture with full context)         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Detailed Implementation Phases

### PHASE 1: PRODUCTION FORMAT (Minimal Technical Setup)
**Goal**: Reduce current bloated platform selection to essential technical specs

#### 1.1 New State Structure
```javascript
state.format = {
    aspectRatio: '16:9',      // '16:9', '9:16', '1:1', '4:5', 'custom'
    resolution: '1080p',       // '720p', '1080p', '4K'
    duration: 60,              // in seconds
    fps: 30,                   // 24, 30, 60
    // Derived from above (auto-calculated)
    width: 1920,
    height: 1080,
    bitrate: '8M'
};
```

#### 1.2 UI: Single Compact Card
```
┌─────────────────────────────────────────────────────┐
│ 🎬 Production Format                                │
├─────────────────────────────────────────────────────┤
│ Aspect Ratio: [▼ 16:9 Widescreen]                  │
│                                                     │
│ Duration: [====●===========] 1:30                  │
│           30s              5min                     │
│                                                     │
│ Quality: ○ HD (1080p)  ● 4K (2160p)               │
│                                                     │
│ Estimated: 9 scenes • ~40 tokens                   │
└─────────────────────────────────────────────────────┘
```

---

### PHASE 2: PRODUCTION TYPE SYSTEM
**Goal**: Let users define WHAT they're creating at a high level

#### 2.1 Production Types Configuration
```javascript
const PRODUCTION_TYPES = {
    'social': {
        id: 'social',
        name: 'Social Content',
        icon: '📱',
        description: 'Short-form content for social platforms',
        subTypes: {
            'viral': { name: 'Viral/Trending', icon: '🔥', characteristics: ['quick-hook', 'shareable', 'trend-based'] },
            'educational-short': { name: 'Quick Explainer', icon: '💡', characteristics: ['informative', 'concise'] },
            'story-short': { name: 'Story Snippet', icon: '📖', characteristics: ['narrative', 'cliffhanger'] },
            'product': { name: 'Product Showcase', icon: '🛍️', characteristics: ['promotional', 'visual'] },
            'lifestyle': { name: 'Lifestyle/Vlog', icon: '🌟', characteristics: ['personal', 'relatable'] },
            'meme': { name: 'Meme/Comedy', icon: '😂', characteristics: ['humorous', 'reference-heavy'] }
        },
        defaultNarration: 'voiceover',
        defaultDuration: { min: 15, max: 180 }
    },

    'movie': {
        id: 'movie',
        name: 'Movie/Film',
        icon: '🎬',
        description: 'Cinematic narrative content',
        subTypes: {
            'action': {
                name: 'Action', icon: '💥',
                visualStyle: 'high-contrast, dynamic angles, kinetic',
                references: ['John Wick', 'Mad Max', 'Mission Impossible'],
                characteristics: ['fast-paced', 'physical', 'high-stakes']
            },
            'drama': {
                name: 'Drama', icon: '🎭',
                visualStyle: 'intimate framing, natural lighting, emotive',
                references: ['Manchester by the Sea', 'Marriage Story'],
                characteristics: ['emotional', 'character-driven', 'dialogue-heavy']
            },
            'thriller': {
                name: 'Thriller/Suspense', icon: '🔮',
                visualStyle: 'shadows, tension-building, paranoia',
                references: ['Gone Girl', 'Prisoners', 'Se7en'],
                characteristics: ['tense', 'mystery', 'psychological']
            },
            'horror': {
                name: 'Horror', icon: '👻',
                visualStyle: 'darkness, negative space, unsettling angles',
                references: ['Hereditary', 'The Conjuring', 'Get Out'],
                characteristics: ['scary', 'atmospheric', 'dread']
            },
            'scifi': {
                name: 'Sci-Fi', icon: '🚀',
                visualStyle: 'futuristic, high-tech, otherworldly',
                references: ['Blade Runner', 'Arrival', 'Interstellar'],
                characteristics: ['speculative', 'technology', 'wonder']
            },
            'fantasy': {
                name: 'Fantasy', icon: '🐉',
                visualStyle: 'magical, epic scale, mythical',
                references: ['Lord of the Rings', 'Game of Thrones'],
                characteristics: ['magical', 'world-building', 'epic']
            },
            'comedy': {
                name: 'Comedy', icon: '😄',
                visualStyle: 'bright, expressive, comedic timing',
                references: ['The Grand Budapest Hotel', 'Superbad'],
                characteristics: ['funny', 'timing', 'absurd']
            },
            'romance': {
                name: 'Romance', icon: '💕',
                visualStyle: 'soft lighting, intimate, warm tones',
                references: ['La La Land', 'The Notebook'],
                characteristics: ['love', 'emotional', 'relationships']
            },
            'animation': {
                name: 'Animation', icon: '🎨',
                visualStyle: 'varies by style',
                subStyles: ['3D Pixar', '2D Anime', 'Stop Motion', 'Stylized'],
                characteristics: ['animated', 'stylized', 'creative']
            },
            'documentary': {
                name: 'Documentary', icon: '📹',
                visualStyle: 'authentic, observational, informative',
                references: ['Planet Earth', 'The Social Dilemma'],
                characteristics: ['real', 'informative', 'journalistic']
            },
            'western': {
                name: 'Western', icon: '🤠',
                visualStyle: 'wide landscapes, dust, golden hour',
                references: ['No Country for Old Men', 'True Grit'],
                characteristics: ['frontier', 'moral', 'landscapes']
            },
            'noir': {
                name: 'Film Noir', icon: '🕵️',
                visualStyle: 'high contrast, shadows, rain, smoke',
                references: ['Sin City', 'Chinatown', 'Blade Runner'],
                characteristics: ['dark', 'cynical', 'mystery']
            }
        },
        defaultNarration: 'dialogue',
        defaultDuration: { min: 300, max: 7200 }  // 5min - 2hrs
    },

    'series': {
        id: 'series',
        name: 'Series/Episodes',
        icon: '📺',
        description: 'Episodic storytelling',
        subTypes: {
            'crime-drama': {
                name: 'Crime/Drama', icon: '🔍',
                visualStyle: 'gritty, realistic, moody',
                references: ['Breaking Bad', 'The Wire', 'True Detective'],
                characteristics: ['serialized', 'complex-characters', 'moral-gray']
            },
            'fantasy-epic': {
                name: 'Fantasy Epic', icon: '⚔️',
                visualStyle: 'epic scale, detailed worlds, magical',
                references: ['Game of Thrones', 'The Witcher'],
                characteristics: ['world-building', 'political', 'epic']
            },
            'scifi-series': {
                name: 'Sci-Fi Series', icon: '🌌',
                visualStyle: 'futuristic, sleek, mysterious',
                references: ['Black Mirror', 'Westworld', 'The Expanse'],
                characteristics: ['speculative', 'technological', 'philosophical']
            },
            'comedy-series': {
                name: 'Comedy Series', icon: '📺',
                visualStyle: 'bright, sitcom or single-camera',
                references: ['The Office', 'Brooklyn Nine-Nine'],
                characteristics: ['episodic', 'character-comedy', 'recurring']
            },
            'anthology': {
                name: 'Anthology', icon: '📚',
                visualStyle: 'varies per episode',
                references: ['Black Mirror', 'American Horror Story'],
                characteristics: ['standalone', 'thematic', 'varied']
            },
            'limited-series': {
                name: 'Limited Series', icon: '🎯',
                visualStyle: 'cinematic, film-like',
                references: ['Chernobyl', 'Band of Brothers'],
                characteristics: ['finite', 'focused', 'complete-arc']
            },
            'anime': {
                name: 'Anime', icon: '🎌',
                visualStyle: 'japanese animation style',
                subStyles: ['Shonen', 'Seinen', 'Slice of Life', 'Mecha'],
                characteristics: ['animated', 'japanese-style', 'manga-influenced']
            },
            'docuseries': {
                name: 'Docuseries', icon: '🎥',
                visualStyle: 'documentary with narrative arc',
                references: ['Making a Murderer', 'Tiger King'],
                characteristics: ['real-events', 'investigative', 'serialized']
            }
        },
        defaultNarration: 'dialogue',
        episodeConfig: true,  // Show episode configuration options
        defaultDuration: { min: 300, max: 3600 }  // 5-60min per episode
    },

    'educational': {
        id: 'educational',
        name: 'Educational',
        icon: '📚',
        description: 'Learning and informative content',
        subTypes: {
            'explainer': {
                name: 'Explainer', icon: '💡',
                visualStyle: 'clean, clear, illustrative',
                references: ['Kurzgesagt', 'Vox', 'TED-Ed'],
                characteristics: ['informative', 'visual-aids', 'accessible']
            },
            'tutorial': {
                name: 'Tutorial/How-To', icon: '🔧',
                visualStyle: 'step-by-step, clear visuals',
                characteristics: ['instructional', 'practical', 'step-by-step']
            },
            'documentary-edu': {
                name: 'Documentary', icon: '🌍',
                visualStyle: 'cinematic documentary',
                references: ['Planet Earth', 'Cosmos'],
                characteristics: ['informative', 'immersive', 'narrative']
            },
            'history': {
                name: 'History/Timeline', icon: '📜',
                visualStyle: 'archival, recreations, maps',
                characteristics: ['historical', 'chronological', 'contextual']
            },
            'science': {
                name: 'Science', icon: '🔬',
                visualStyle: 'diagrams, animations, demonstrations',
                characteristics: ['scientific', 'visual-explanation', 'data']
            },
            'course': {
                name: 'Course/Lesson', icon: '🎓',
                visualStyle: 'structured, academic',
                characteristics: ['structured', 'progressive', 'comprehensive']
            }
        },
        defaultNarration: 'voiceover',
        defaultDuration: { min: 60, max: 1800 }
    },

    'music-video': {
        id: 'music-video',
        name: 'Music Video',
        icon: '🎵',
        description: 'Visual accompaniment to music',
        subTypes: {
            'performance': {
                name: 'Performance', icon: '🎤',
                visualStyle: 'band/artist performing',
                characteristics: ['live-feel', 'energetic', 'artist-focused']
            },
            'narrative': {
                name: 'Narrative', icon: '🎬',
                visualStyle: 'story-driven, cinematic',
                references: ['Michael Jackson Thriller', 'Childish Gambino'],
                characteristics: ['story', 'cinematic', 'conceptual']
            },
            'visual-art': {
                name: 'Visual Art', icon: '🎨',
                visualStyle: 'abstract, artistic, experimental',
                characteristics: ['artistic', 'abstract', 'mood-driven']
            },
            'lyric-video': {
                name: 'Lyric Video', icon: '📝',
                visualStyle: 'typography, motion graphics',
                characteristics: ['text-focused', 'animated', 'simple']
            },
            'animation-mv': {
                name: 'Animated', icon: '✨',
                visualStyle: 'animated, any style',
                characteristics: ['animated', 'creative', 'unlimited']
            }
        },
        defaultNarration: 'none',  // Music videos typically have no narration
        syncToMusic: true,  // Enable music sync features
        defaultDuration: { min: 120, max: 420 }  // 2-7 minutes
    },

    'commercial': {
        id: 'commercial',
        name: 'Commercial/Promo',
        icon: '📢',
        description: 'Promotional and advertising content',
        subTypes: {
            'brand': { name: 'Brand Story', icon: '🏢' },
            'product': { name: 'Product Launch', icon: '📦' },
            'testimonial': { name: 'Testimonial', icon: '💬' },
            'announcement': { name: 'Announcement', icon: '📣' },
            'event': { name: 'Event Promo', icon: '🎪' }
        },
        defaultNarration: 'voiceover',
        defaultDuration: { min: 15, max: 180 }
    }
};
```

---

### PHASE 3: CONCEPT DEVELOPMENT SYSTEM
**Goal**: Generate and refine unique creative concepts before scripting

#### 3.1 Concept Generation Prompt Engineering
```javascript
const CONCEPT_GENERATION_SYSTEM = {

    // Master prompt for generating concepts
    generateConceptsPrompt: (productionType, subType, styleReference, userKeywords) => `
You are a Hollywood creative director developing original concepts.

PRODUCTION TYPE: ${productionType.name} - ${subType.name}
STYLE INSPIRATION: ${styleReference} (use as STYLE reference only, NOT subject matter)
USER CONCEPT KEYWORDS: ${userKeywords}

CRITICAL RULES:
1. Generate COMPLETELY ORIGINAL concepts - never recreate existing IPs
2. Style reference means: "inspired by the VISUAL and NARRATIVE style" NOT "about that content"
3. If user says "Breaking Bad style" → Create original content with moral complexity,
   desert aesthetics, tension building - NOT Walter White or meth labs
4. Each concept must be unique and ownable
5. Characters can be human, non-human, abstract, or conceptual

Generate 5 unique concepts. For each provide:
{
    "title": "The Title",
    "logline": "One compelling sentence describing the concept",
    "expandedSynopsis": "2-3 sentence expansion of the concept",
    "visualMood": "Key visual descriptors",
    "toneWords": ["dark", "hopeful", "intense"],
    "mainCharacterTypes": ["protagonist type", "antagonist type"],
    "settingDescription": "Where and when this takes place",
    "uniqueHook": "What makes this concept stand out"
}
`,

    // Refine selected concept
    refineConceptPrompt: (concept, productionType, modifications) => `
Take this concept and refine it based on user modifications:

ORIGINAL CONCEPT:
${JSON.stringify(concept)}

USER MODIFICATIONS:
${modifications}

PRODUCTION TYPE: ${productionType}

Provide refined version maintaining the core essence while incorporating changes.
Also suggest 3 alternative titles if the original was modified.
`
};
```

#### 3.2 Concept UI Flow
```
Step 1: User inputs keywords/idea
        ↓
Step 2: AI generates 5-8 unique concepts
        ↓
Step 3: User selects one (or requests regeneration)
        ↓
Step 4: Concept refinement interface
        - Edit title
        - Adjust tone
        - Modify setting
        - Add/remove elements
        ↓
Step 5: Finalized concept passed to character generation
```

---

### PHASE 4: INTELLIGENT CHARACTER SYSTEM
**Goal**: Auto-determine character needs based on production type and generate appropriate characters

#### 4.1 Character Determination Logic
```javascript
const CHARACTER_INTELLIGENCE = {

    // Determine what kind of characters/narration this production needs
    determineCharacterNeeds: (productionType, subType, concept) => {

        const needs = {
            hasNarrator: false,
            narratorType: null,  // 'omniscient', 'character', 'documentary'
            hasDialogue: false,
            characterCount: { min: 0, max: 0, suggested: 0 },
            characterTypes: [],  // 'human', 'creature', 'robot', 'abstract', 'object'
            voiceConfiguration: null
        };

        // Music videos typically have no narration
        if (productionType === 'music-video') {
            needs.hasNarrator = false;
            needs.hasDialogue = false;
            needs.characterCount = { min: 0, max: 5, suggested: 1 };
            return needs;
        }

        // Educational content usually has narrator
        if (productionType === 'educational') {
            needs.hasNarrator = true;
            needs.narratorType = 'omniscient';
            needs.hasDialogue = false;
            needs.characterCount = { min: 0, max: 3, suggested: 0 };
            return needs;
        }

        // Movies and series - primarily dialogue
        if (productionType === 'movie' || productionType === 'series') {
            needs.hasNarrator = false;  // Can be enabled optionally
            needs.hasDialogue = true;
            needs.characterCount = { min: 2, max: 10, suggested: 4 };
            needs.characterTypes = determineCharacterTypes(subType, concept);
            return needs;
        }

        // Social content - usually narrator
        if (productionType === 'social') {
            needs.hasNarrator = true;
            needs.narratorType = 'personality';
            needs.hasDialogue = false;
            needs.characterCount = { min: 0, max: 2, suggested: 0 };
            return needs;
        }

        return needs;
    },

    // Determine what TYPES of characters fit this concept
    determineCharacterTypes: (subType, concept) => {
        const types = ['human'];  // Default

        // Sci-fi might have robots, aliens
        if (['scifi', 'scifi-series'].includes(subType)) {
            types.push('robot', 'alien', 'ai');
        }

        // Fantasy might have creatures, magical beings
        if (['fantasy', 'fantasy-epic'].includes(subType)) {
            types.push('creature', 'magical-being', 'mythical');
        }

        // Horror might have entities, monsters
        if (['horror'].includes(subType)) {
            types.push('entity', 'monster', 'supernatural');
        }

        // Animation can have anything
        if (['animation', 'animation-mv', 'anime'].includes(subType)) {
            types.push('anything', 'object', 'abstract', 'animal');
        }

        return types;
    }
};
```

#### 4.2 Character Generation from Concept
```javascript
const CHARACTER_GENERATOR = {

    generateCharactersPrompt: (concept, productionType, characterNeeds) => `
You are a character designer for ${productionType.name} productions.

CONCEPT:
Title: ${concept.title}
Synopsis: ${concept.expandedSynopsis}
Setting: ${concept.settingDescription}
Tone: ${concept.toneWords.join(', ')}

CHARACTER REQUIREMENTS:
- Number needed: ${characterNeeds.characterCount.suggested}
- Types allowed: ${characterNeeds.characterTypes.join(', ')}
- Has dialogue: ${characterNeeds.hasDialogue}
- Narrator needed: ${characterNeeds.hasNarrator}

IMPORTANT:
- Characters do NOT have to be human
- They can be: robots, aliens, creatures, objects, abstract concepts, animals, AI, etc.
- Match character types to the concept and genre
- Give each character a distinct voice/communication style

For each character, provide:
{
    "name": "Character Name",
    "type": "human/robot/creature/etc",
    "role": "protagonist/antagonist/support/mentor",
    "physicalDescription": "Detailed visual description for AI image generation",
    "personality": "Core personality traits",
    "speakingStyle": "How they communicate (formal, slang, mechanical, telepathic, etc)",
    "voiceDescription": "What their voice sounds like for TTS",
    "arc": "Brief character arc for this story",
    "relationships": ["relationship to other characters"]
}
`
};
```

---

### PHASE 5: ENHANCED SCRIPT GENERATION
**Goal**: Use all accumulated context for Hollywood-quality scripts

#### 5.1 Script Generation Context
```javascript
const SCRIPT_CONTEXT = {
    // All this context flows into script generation
    format: {
        aspectRatio: '16:9',
        duration: 180,
        sceneCount: 12
    },
    production: {
        type: 'series',
        subType: 'crime-drama',
        styleReference: 'Breaking Bad-style tension and moral complexity'
    },
    concept: {
        title: 'Cybdemon: The Dark Guardian',
        synopsis: '...',
        tone: ['dark', 'hopeful', 'intense'],
        setting: 'Post-apocalyptic organic realm'
    },
    characters: [
        { name: 'Cybdemon', type: 'cyborg', role: 'protagonist', ... },
        { name: 'Elder Mossara', type: 'tree-being', role: 'mentor', ... }
    ],
    narrativeConfig: {
        hasNarrator: false,
        dialogueOnly: true,
        perspectiveCharacter: 'Cybdemon'
    }
};
```

#### 5.2 Script Generation Master Prompt
```javascript
const SCRIPT_MASTER_PROMPT = `
You are an Emmy-winning screenwriter creating a script.

=== PRODUCTION CONTEXT ===
Type: ${context.production.type} - ${context.production.subType}
Duration: ${context.format.duration} seconds
Scene Count: ${context.format.sceneCount}

=== STYLE REFERENCE ===
"${context.production.styleReference}"
CRITICAL: This means STYLE and TECHNIQUE, not subject matter.
Apply the visual language, pacing, and narrative techniques - NOT the plot or characters.

=== YOUR STORY ===
Title: ${context.concept.title}
Synopsis: ${context.concept.synopsis}
Setting: ${context.concept.setting}
Tone: ${context.concept.tone.join(', ')}

=== CHARACTERS ===
${context.characters.map(c => `
${c.name} (${c.type} - ${c.role})
Physical: ${c.physicalDescription}
Voice: ${c.speakingStyle}
`).join('\n')}

=== NARRATIVE CONFIGURATION ===
Narrator: ${context.narrativeConfig.hasNarrator ? 'Yes - ' + context.narrativeConfig.narratorType : 'No'}
Dialogue: ${context.narrativeConfig.dialogueOnly ? 'Characters speak to each other' : 'Mixed'}

=== OUTPUT FORMAT ===
For each scene provide:
{
    "sceneNumber": 1,
    "location": "INT/EXT. LOCATION - TIME",
    "visualDescription": "Detailed description for AI image generation",
    "mood": "scene mood",
    "characters": ["who appears"],
    "action": "what happens",
    "dialogue": [
        { "character": "NAME", "line": "What they say", "direction": "(how they say it)" }
    ],
    "narration": null or "narrator text",
    "cameraMovement": ["suggested shots"],
    "soundDesign": "ambient sounds, music mood",
    "duration": seconds
}

Write the complete script now.
`;
```

---

## Implementation Roadmap

### Week 1: Foundation
- [ ] Create new state structure for the redesigned wizard
- [ ] Implement PRODUCTION_TYPES configuration
- [ ] Build minimal format selection UI (Phase 1)
- [ ] Build production type selection UI (Phase 2)

### Week 2: Concept Development
- [ ] Implement concept generation cloud function
- [ ] Build concept selection and refinement UI (Phase 3)
- [ ] Create concept storage and editing system
- [ ] Test concept generation quality

### Week 3: Character Intelligence
- [ ] Implement character determination logic
- [ ] Create character generation cloud function
- [ ] Build character management UI (Phase 4)
- [ ] Support for non-human character types

### Week 4: Script Integration
- [ ] Update script generation to use new context
- [ ] Implement style reference parsing (not subject confusion)
- [ ] Update script output format for dialogue-only scenes
- [ ] Test full pipeline

### Week 5: Polish & Testing
- [ ] Full flow testing
- [ ] Edge case handling
- [ ] Performance optimization
- [ ] User testing feedback

---

## Key Success Metrics

1. **No IP Confusion**: "Breaking Bad style" never produces Breaking Bad content
2. **Original Concepts**: Every generated concept is unique and ownable
3. **Appropriate Characters**: Character types match the concept (robots in sci-fi, etc.)
4. **Narrative Flexibility**: Can create narrator-free, dialogue-only content
5. **Hollywood Quality**: Scripts feel professionally written
6. **User Satisfaction**: Users get what they actually wanted

---

## Files to Create/Modify

### New Files
- `frontend/wizard-v2/production-types.js` - Production type configurations
- `frontend/wizard-v2/concept-generator.js` - Concept generation system
- `frontend/wizard-v2/character-intelligence.js` - Character determination
- `functions/conceptGeneration.js` - Cloud functions for concept/character generation

### Modified Files
- `frontend/video-creation-wizard.html` - Complete wizard restructure
- `functions/index.js` - New cloud functions for concept pipeline
- `functions/scriptGeneration.js` - Updated to use full context

---

## Summary

This plan transforms the wizard from a generic content creator into an intelligent Hollywood-grade production system that:

1. **Understands intent**: Knows the difference between "like Breaking Bad" (style) and "about Breaking Bad" (subject)
2. **Develops concepts**: Generates unique, ownable creative ideas before jumping to scripting
3. **Thinks about characters**: Knows when to use humans, robots, creatures, or abstract entities
4. **Adapts narrative**: Can create narrator-driven or dialogue-only content as needed
5. **Maintains quality**: Every step builds on the previous, creating cohesive productions

The result: When a user says "Breaking Bad-style crime series", they get an ORIGINAL crime story with the tension, moral complexity, and visual style of that genre - not a recreation of Walter White's journey.
