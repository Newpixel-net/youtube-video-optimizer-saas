/**
 * Caption Renderer
 * Generates styled captions using Whisper for transcription and ASS subtitles
 */

import OpenAI from 'openai';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// Lazy-initialize OpenAI client (only when needed)
let openai = null;

function getOpenAIClient() {
  if (!openai && process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }
  return openai;
}

// Map frontend style IDs to backend style IDs
// Frontend uses different IDs than backend for some styles
const STYLE_ALIASES = {
  beasty: 'bold',       // Frontend 'beasty' (MrBeast) -> backend 'bold'
  deepdiver: 'minimal', // Frontend 'deepdiver' (Minimal) -> backend 'minimal'
  podp: 'podcast',      // Frontend 'podp' (Podcast) -> backend 'podcast'
  glow: 'ali'           // In case 'glow' is ever sent, map to 'ali'
};

/**
 * Main function to generate captions for a video
 * @param {Object} params
 * @param {string} params.jobId - Job ID for logging
 * @param {string} params.videoFile - Path to video file
 * @param {string} params.workDir - Working directory
 * @param {string} params.captionStyle - Caption style (karaoke, bold, hormozi, etc.)
 * @param {Object} params.customStyle - Custom style options
 * @param {string} params.captionPosition - Position: 'bottom', 'middle', 'top' (default: 'bottom')
 * @param {number} params.captionSize - Size multiplier: 0.5 to 2.0 (default: 1.0)
 * @param {Array} params.scenes - Optional array of scenes with narration text (for fallback)
 * @returns {Promise<string|null>} Path to ASS subtitle file, or null if captions disabled
 */
export async function generateCaptions({ jobId, videoFile, workDir, captionStyle, customStyle, captionPosition, captionSize, scenes }) {
  console.log(`[${jobId}] ========== CAPTION GENERATION ==========`);
  console.log(`[${jobId}] Caption style requested: "${captionStyle}"`);
  console.log(`[${jobId}] Caption position: "${captionPosition || 'bottom'}"`);
  console.log(`[${jobId}] Caption size multiplier: ${captionSize || 1.0}`);
  console.log(`[${jobId}] Video file: ${videoFile}`);
  console.log(`[${jobId}] Work directory: ${workDir}`);
  console.log(`[${jobId}] Custom style: ${customStyle ? JSON.stringify(customStyle) : 'none'}`);
  console.log(`[${jobId}] Scenes with narration provided: ${scenes?.length || 0}`);

  // Normalize style ID using aliases
  const normalizedStyle = STYLE_ALIASES[captionStyle] || captionStyle;
  if (normalizedStyle !== captionStyle) {
    console.log(`[${jobId}] Style ID mapped: "${captionStyle}" -> "${normalizedStyle}"`);
  }

  // Skip if no captions requested
  if (!captionStyle || captionStyle === 'none') {
    console.log(`[${jobId}] No captions requested (style is "${captionStyle}"), skipping`);
    console.log(`[${jobId}] ========================================`);
    return null;
  }

  console.log(`[${jobId}] Generating captions with normalized style: ${normalizedStyle}`);

  try {
    let transcription = null;

    // Step 1: Try Whisper transcription first (if API key is available)
    const hasWhisperKey = !!process.env.OPENAI_API_KEY;
    console.log(`[${jobId}] Whisper API key available: ${hasWhisperKey}`);

    if (hasWhisperKey) {
      try {
        // Extract audio from video
        const audioFile = path.join(workDir, 'audio.wav');
        await extractAudio(jobId, videoFile, audioFile);

        // Transcribe with Whisper (word-level timestamps)
        transcription = await transcribeWithWhisper(jobId, audioFile);

        if (transcription && transcription.words && transcription.words.length > 0) {
          console.log(`[${jobId}] ✓ Whisper transcription successful: ${transcription.words.length} words`);
        } else {
          console.log(`[${jobId}] ✗ Whisper returned empty transcription`);
          transcription = null;
        }
      } catch (whisperError) {
        console.error(`[${jobId}] ✗ Whisper transcription failed:`, whisperError.message);
        transcription = null;
      }
    }

    // Step 2: Fallback to scene narration if Whisper failed or unavailable
    if (!transcription && scenes && scenes.length > 0) {
      console.log(`[${jobId}] Using FALLBACK: Generating captions from scene narration text`);
      transcription = generateCaptionsFromNarration(jobId, scenes);

      if (transcription && transcription.words && transcription.words.length > 0) {
        console.log(`[${jobId}] ✓ Fallback captions generated: ${transcription.words.length} words from ${scenes.length} scenes`);
      } else {
        console.log(`[${jobId}] ✗ Fallback caption generation returned no words`);
      }
    }

    // No captions available from any source
    if (!transcription || !transcription.words || transcription.words.length === 0) {
      console.log(`[${jobId}] ✗ No captions available from any source (Whisper or narration fallback)`);
      console.log(`[${jobId}] ========================================`);
      return null;
    }

    // Step 3: Generate ASS subtitle file with selected style
    const assFile = path.join(workDir, 'captions.ass');
    await generateASSFile(jobId, transcription.words, normalizedStyle, customStyle, assFile, captionPosition, captionSize);

    // Verify the ASS file was created
    if (fs.existsSync(assFile)) {
      const assSize = fs.statSync(assFile).size;
      console.log(`[${jobId}] Caption file created: ${assFile} (${assSize} bytes)`);
      console.log(`[${jobId}] Caption generation SUCCESS`);
      console.log(`[${jobId}] ========================================`);
      return assFile;
    } else {
      console.error(`[${jobId}] Caption file was not created at: ${assFile}`);
      console.log(`[${jobId}] ========================================`);
      return null;
    }

  } catch (error) {
    console.error(`[${jobId}] Caption generation FAILED:`, error.message);
    console.error(`[${jobId}] Stack:`, error.stack);
    console.log(`[${jobId}] ========================================`);
    // Don't fail the whole job, just skip captions
    return null;
  }
}

/**
 * Generate word-level timestamps from scene narration text
 * This is a fallback when Whisper API is unavailable
 * Accounts for voiceoverOffset to sync captions with actual audio timing
 *
 * @param {string} jobId - Job ID for logging
 * @param {Array} scenes - Array of scenes with narration, duration, and voiceoverOffset
 * @returns {Object} Transcription object with words array
 */
function generateCaptionsFromNarration(jobId, scenes) {
  const words = [];
  let currentTime = 0;

  console.log(`[${jobId}] Generating fallback captions with voiceoverOffset support`);

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const narration = scene.narration || '';
    const duration = scene.duration || 8;
    const voiceoverOffset = scene.voiceoverOffset || 0;

    if (!narration.trim()) {
      // No narration for this scene, just advance time
      currentTime += duration;
      continue;
    }

    // Split narration into words
    const sceneWords = narration.trim().split(/\s+/);
    if (sceneWords.length === 0) {
      currentTime += duration;
      continue;
    }

    // Calculate effective duration for voiceover (scene duration minus offset)
    const effectiveVoiceDuration = duration - voiceoverOffset;

    // Apply padding at start and end of voiceover
    const padding = 0.15; // 150ms padding
    const availableDuration = Math.max(effectiveVoiceDuration - (padding * 2), effectiveVoiceDuration * 0.8);
    const timePerWord = availableDuration / sceneWords.length;

    // Start words AFTER the voiceoverOffset + padding
    let wordTime = currentTime + voiceoverOffset + padding;

    if (voiceoverOffset > 0) {
      console.log(`[${jobId}]   Scene ${i + 1}: offset=${voiceoverOffset.toFixed(2)}s, words start at ${wordTime.toFixed(2)}s`);
    }

    for (const word of sceneWords) {
      words.push({
        word: word,
        start: wordTime,
        end: wordTime + timePerWord
      });
      wordTime += timePerWord;
    }

    currentTime += duration;
  }

  console.log(`[${jobId}] Fallback: Generated ${words.length} words from narration across ${scenes.length} scenes`);

  // Log first few words for debugging
  if (words.length > 0) {
    console.log(`[${jobId}] First 5 words from fallback:`);
    words.slice(0, 5).forEach((w, i) => {
      console.log(`[${jobId}]   ${i + 1}. "${w.word}" (${w.start.toFixed(2)}s - ${w.end.toFixed(2)}s)`);
    });
  }

  return {
    text: scenes.map(s => s.narration || '').join(' '),
    words,
    source: 'narration_fallback'
  };
}

/**
 * Extract audio from video file
 */
async function extractAudio(jobId, videoFile, audioFile) {
  console.log(`[${jobId}] Extracting audio...`);

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', videoFile,
      '-vn',                    // No video
      '-acodec', 'pcm_s16le',   // PCM format for Whisper
      '-ar', '16000',           // 16kHz sample rate
      '-ac', '1',               // Mono
      '-y',                     // Overwrite
      audioFile
    ]);

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log(`[${jobId}] Audio extracted: ${audioFile}`);
        resolve();
      } else {
        reject(new Error(`Audio extraction failed with code ${code}`));
      }
    });

    ffmpeg.on('error', reject);
  });
}

/**
 * Transcribe audio using OpenAI Whisper API with word timestamps
 */
async function transcribeWithWhisper(jobId, audioFile) {
  console.log(`[${jobId}] Transcribing with Whisper...`);

  // Check if OpenAI API key is available
  const client = getOpenAIClient();
  if (!client) {
    console.error(`[${jobId}] CRITICAL: OPENAI_API_KEY environment variable not set - captions will be disabled`);
    console.error(`[${jobId}] To enable captions, set OPENAI_API_KEY in Cloud Run environment variables`);
    return null;
  }

  try {
    // Use fs.createReadStream for Node.js (not browser File API)
    const response = await client.audio.transcriptions.create({
      file: fs.createReadStream(audioFile),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word']
    });

    console.log(`[${jobId}] Transcription complete: ${response.words?.length || 0} words`);
    console.log(`[${jobId}] Transcription text preview: "${(response.text || '').substring(0, 200)}..."`);

    // Log first few words with timestamps for debugging
    if (response.words && response.words.length > 0) {
      console.log(`[${jobId}] First 5 words with timestamps:`);
      response.words.slice(0, 5).forEach((w, i) => {
        console.log(`[${jobId}]   ${i + 1}. "${w.word}" (${w.start?.toFixed(2)}s - ${w.end?.toFixed(2)}s)`);
      });
    }

    return {
      text: response.text,
      words: response.words || []
    };

  } catch (error) {
    console.error(`[${jobId}] Whisper API error:`, error.message);
    throw error;
  }
}

/**
 * Generate ASS subtitle file with styled captions
 * @param {string} jobId - Job ID for logging
 * @param {Array} words - Array of word objects with timestamps
 * @param {string} captionStyle - Normalized caption style
 * @param {Object} customStyle - Custom style options
 * @param {string} outputFile - Output ASS file path
 * @param {string} captionPosition - Position: 'bottom', 'middle', 'top'
 * @param {number} captionSize - Size multiplier: 0.5 to 2.0
 */
async function generateASSFile(jobId, words, captionStyle, customStyle, outputFile, captionPosition, captionSize) {
  console.log(`[${jobId}] Generating ASS file with style: ${captionStyle}`);
  console.log(`[${jobId}] Position: ${captionPosition || 'bottom'}, Size: ${captionSize || 1.0}`);

  // Get style configuration with position and size adjustments
  const styleConfig = getStyleConfig(captionStyle, customStyle, captionPosition, captionSize);
  console.log(`[${jobId}] Style config: ${styleConfig.styleName}, alignment: ${styleConfig.alignment}, marginV: ${styleConfig.marginV}`);

  // ASS file header - include extra styles if needed (e.g., HormoziBox for keyword highlights)
  let stylesSection = styleConfig.styleLine;
  if (styleConfig.extraStyles) {
    stylesSection += '\n' + styleConfig.extraStyles;
  }

  let assContent = `[Script Info]
Title: Generated Captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${stylesSection}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Group words into phrases (roughly 3-5 words per line)
  const phrases = groupWordsIntoPhrases(words, styleConfig.wordsPerLine || 4);

  // Generate dialogue lines
  if (styleConfig.highlightKeywords) {
    // Hormozi style: word-by-word box highlighting
    // KEY INSIGHT: Position ALL elements (base text + box) using the SAME calculations
    // This ensures perfect alignment regardless of libass rendering differences
    //
    // Layers:
    // Layer 0: Shadow rectangle (for depth effect)
    // Layer 1: Green rounded rectangle background
    // Layer 2: Base text words (white, positioned with \pos)
    // Layer 3: Highlighted word text (white, on top of box)

    // Video dimensions (from PlayRes)
    const videoWidth = 1080;
    const videoHeight = 1920;

    const fontSize = styleConfig.fontSize || 68;

    // Box padding around the highlighted word
    const boxPaddingX = 14;
    const boxPaddingY = 8;
    const cornerRadius = 10;

    // Calculate Y position based on alignment and marginV
    let posY;
    if (styleConfig.alignment >= 7) {
      posY = styleConfig.marginV + fontSize;
    } else if (styleConfig.alignment >= 4) {
      posY = videoHeight / 2;
    } else {
      posY = videoHeight - styleConfig.marginV - fontSize / 2;
    }

    for (const phrase of phrases) {
      const phraseStart = formatASSTime(phrase.start);
      const phraseEnd = formatASSTime(phrase.end);
      const allWords = phrase.words.map(w => w.word).join(' ');

      // Calculate total phrase width
      const phraseWidth = calculateTextWidth(allWords, fontSize);
      const phraseStartX = (videoWidth - phraseWidth) / 2;

      // Pre-calculate ALL word positions
      const wordPositions = [];
      let currentX = phraseStartX;
      for (const word of phrase.words) {
        const wordWidth = calculateTextWidth(word.word, fontSize);
        wordPositions.push({
          word: word.word,
          start: word.start,
          end: word.end,
          x: currentX,
          width: wordWidth,
          centerX: Math.round(currentX + wordWidth / 2)
        });
        currentX += wordWidth + (fontSize * 0.36); // word width + space
      }

      // Layer 2: Position EACH base word using \pos (same calculation as box)
      // This ensures base text and box use identical positioning
      for (const wp of wordPositions) {
        assContent += `Dialogue: 2,${phraseStart},${phraseEnd},${styleConfig.styleName},,0,0,0,,{\\an5\\pos(${wp.centerX},${Math.round(posY)})}${wp.word}\n`;
      }

      // Layers 0, 1, 3: Box shadow, box, and highlighted text for each word
      for (const wp of wordPositions) {
        const wordStart = formatASSTime(wp.start);
        const wordEnd = formatASSTime(wp.end);

        // Calculate box dimensions
        const boxLeft = Math.round(wp.x - boxPaddingX);
        const boxTop = Math.round(posY - fontSize / 2 - boxPaddingY);
        const boxWidth = Math.round(wp.width + boxPaddingX * 2);
        const boxHeight = Math.round(fontSize + boxPaddingY * 2);

        // Generate rounded rectangle
        const r = Math.min(cornerRadius, boxWidth / 4, boxHeight / 4);
        const drawingCommands = generateRoundedRectDrawing(boxWidth, boxHeight, r);

        // Layer 0: Shadow rectangle (dark green, offset for depth)
        assContent += `Dialogue: 0,${wordStart},${wordEnd},HormoziBox,,0,0,0,,{\\an7\\pos(${boxLeft + 4},${boxTop + 4})\\p1\\bord0\\shad0\\1c&H00166534&}${drawingCommands}{\\p0}\n`;

        // Layer 1: Green rounded rectangle
        assContent += `Dialogue: 1,${wordStart},${wordEnd},HormoziBox,,0,0,0,,{\\an7\\pos(${boxLeft},${boxTop})\\p1\\bord0\\shad0\\1c&H0022C55E&}${drawingCommands}{\\p0}\n`;

        // Layer 3: Highlighted word text (on top of box)
        assContent += `Dialogue: 3,${wordStart},${wordEnd},HormoziBox,,0,0,0,,{\\an5\\pos(${wp.centerX},${Math.round(posY)})\\bord0\\shad0\\1c&H00FFFFFF&}${wp.word}\n`;
      }
    }
  } else {
    // Standard styles: single layer with formatted text
    for (const phrase of phrases) {
      const startTime = formatASSTime(phrase.start);
      const endTime = formatASSTime(phrase.end);
      const text = formatTextWithStyle(phrase.words, captionStyle, styleConfig);

      assContent += `Dialogue: 0,${startTime},${endTime},${styleConfig.styleName},,0,0,0,,${text}\n`;
    }
  }

  fs.writeFileSync(outputFile, assContent);
  console.log(`[${jobId}] ASS file written: ${outputFile}`);

  // Log a preview of the ASS content for debugging
  const lines = assContent.split('\n');
  console.log(`[${jobId}] ASS file preview (first 10 lines):`);
  lines.slice(0, 10).forEach((line, i) => {
    console.log(`[${jobId}]   ${i + 1}: ${line}`);
  });
  console.log(`[${jobId}] Total lines in ASS file: ${lines.length}`);
}

/**
 * Get style configuration for caption style
 * @param {string} captionStyle - Already normalized caption style
 * @param {Object} customStyle - Custom style options
 * @param {string} captionPosition - Position: 'bottom', 'middle', 'top'
 * @param {number} captionSize - Size multiplier: 0.5 to 2.0
 */
function getStyleConfig(captionStyle, customStyle, captionPosition, captionSize) {
  // Calculate position-based values for ASS
  // ASS Alignment: 1-3 = bottom, 4-6 = middle, 7-9 = top (center is 2, 5, 8)
  // MarginV: distance from edge (higher = further from edge for bottom/top)
  const position = captionPosition || customStyle?.position || 'bottom';
  const size = captionSize || customStyle?.fontSize || 1.0;

  let alignment, marginV;
  switch (position) {
    case 'top':
      alignment = 8;    // Top center
      marginV = 80;     // Distance from top
      break;
    case 'middle':
      alignment = 5;    // Middle center
      marginV = 0;      // Centered vertically
      break;
    case 'bottom':
    default:
      alignment = 2;    // Bottom center
      marginV = 120;    // Distance from bottom
      break;
  }

  // Base font sizes for each style (will be multiplied by size)
  const baseSizes = {
    karaoke: 72,
    bold: 80,
    hormozi: 68,
    ali: 64,
    podcast: 60,
    minimal: 48,
    custom: 64
  };

  const baseSize = baseSizes[captionStyle] || 64;
  const fontSize = Math.round(baseSize * size);

  const styles = {
    // Karaoke style - word-by-word highlight
    // Colors: Primary=Green (highlighted/spoken), Secondary=White (before speaking)
    // This creates the effect where words turn green as they're spoken
    karaoke: {
      styleName: 'Karaoke',
      styleLine: `Style: Karaoke,Arial,${fontSize},&H0022C55E,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,2,${alignment},50,50,${marginV},1`,
      wordsPerLine: 4,
      useKaraoke: true,
      highlightColor: '&H0022C55E', // Green (BGR format - #5EC522)
      alignment,
      marginV
    },

    // MrBeast/Bold style - big bold text with background
    bold: {
      styleName: 'Bold',
      styleLine: `Style: Bold,Impact,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,3,6,3,${alignment},50,50,${marginV},1`,
      wordsPerLine: 3,
      useKaraoke: false,
      uppercase: true,
      alignment,
      marginV
    },

    // Hormozi style - clean with keyword highlights (green background BOX with depth)
    // Main style: normal white text with outline
    // Extra style "HormoziBox": uses BorderStyle 3 (opaque box) for solid green background
    // Shadow adds depth effect to match preview appearance
    hormozi: {
      styleName: 'Hormozi',
      styleLine: `Style: Hormozi,Arial,${fontSize},&H00FFFFFF,&H0022C55E,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,2,${alignment},50,50,${marginV},1`,
      // HormoziBox style: BorderStyle=3 (opaque box), OutlineColour=green (box color)
      // BackColour=dark green for shadow, Shadow=4 for depth offset
      extraStyles: `Style: HormoziBox,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H0022C55E,&H00166534,1,0,0,0,100,100,0,0,3,12,4,${alignment},50,50,${marginV},1`,
      wordsPerLine: 4,
      useKaraoke: false,
      highlightKeywords: true,
      highlightColor: '&H0022C55E', // Green (#22C55E in BGR format)
      fontSize,  // Include fontSize for position calculations
      alignment,
      marginV
    },

    // Ali Abdaal style - soft glow
    ali: {
      styleName: 'Ali',
      styleLine: `Style: Ali,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00FFCCAA,&H40000000,0,0,0,0,100,100,0,0,1,5,4,${alignment},50,50,${marginV},1`,
      wordsPerLine: 5,
      useKaraoke: false,
      alignment,
      marginV
    },

    // Podcast style - simple clean
    podcast: {
      styleName: 'Podcast',
      styleLine: `Style: Podcast,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,2,${alignment},50,50,${marginV},1`,
      wordsPerLine: 5,
      useKaraoke: false,
      alignment,
      marginV
    },

    // Minimal style - small and subtle
    minimal: {
      styleName: 'Minimal',
      styleLine: `Style: Minimal,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H60000000,0,0,0,0,100,100,0,0,1,2,1,${alignment},50,50,${marginV},1`,
      wordsPerLine: 6,
      useKaraoke: false,
      alignment,
      marginV
    },

    // Custom style
    custom: {
      styleName: 'Custom',
      styleLine: buildCustomStyleLine(customStyle, fontSize, alignment, marginV),
      wordsPerLine: 4,
      useKaraoke: customStyle?.karaoke || false,
      alignment,
      marginV
    }
  };

  // Default to karaoke if style not found
  const selectedStyle = styles[captionStyle] || styles.karaoke;

  // Log which style was selected for debugging
  console.log(`[getStyleConfig] Selected style: ${captionStyle} -> ${selectedStyle.styleName}`);

  return selectedStyle;
}

/**
 * Build custom style line from user options
 * @param {Object} customStyle - Custom style options
 * @param {number} fontSize - Calculated font size
 * @param {number} alignment - ASS alignment value
 * @param {number} marginV - Vertical margin
 */
function buildCustomStyleLine(customStyle, fontSize, alignment, marginV) {
  const fontName = customStyle?.fontFamily || 'Arial';
  const color = hexToASS(customStyle?.color || '#ffffff');
  const bgColor = customStyle?.background ? '&H80000000' : '&H00000000';
  const bold = customStyle?.bold ? 1 : 0;
  const outline = customStyle?.outline ? 3 : 0;
  const shadow = customStyle?.shadow ? 2 : 0;

  return `Style: Custom,${fontName},${fontSize},${color},${color},&H00000000,${bgColor},${bold},0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},50,50,${marginV},1`;
}

/**
 * Convert hex color to ASS format (&HAABBGGRR)
 */
function hexToASS(hex) {
  const clean = hex.replace('#', '');
  const r = clean.substring(0, 2);
  const g = clean.substring(2, 4);
  const b = clean.substring(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

/**
 * Generate ASS drawing commands for a rounded rectangle
 * Uses bezier curves for smooth rounded corners
 * @param {number} width - Rectangle width
 * @param {number} height - Rectangle height
 * @param {number} radius - Corner radius
 * @returns {string} ASS drawing commands
 */
function generateRoundedRectDrawing(width, height, radius) {
  const r = radius;
  const w = width;
  const h = height;

  // Control point offset for bezier curves (approximates circular arc)
  // Using 0.55 factor for good circular approximation
  const c = r * 0.55;

  // Drawing commands: m=move, l=line, b=bezier curve
  // Start at top-left after the corner radius, go clockwise
  return [
    `m ${r} 0`,                                    // Move to start (after top-left corner)
    `l ${w - r} 0`,                                // Top edge
    `b ${w - r + c} 0 ${w} ${c} ${w} ${r}`,        // Top-right corner (bezier)
    `l ${w} ${h - r}`,                             // Right edge
    `b ${w} ${h - r + c} ${w - c} ${h} ${w - r} ${h}`, // Bottom-right corner
    `l ${r} ${h}`,                                 // Bottom edge
    `b ${c} ${h} 0 ${h - c} 0 ${h - r}`,           // Bottom-left corner
    `l 0 ${r}`,                                    // Left edge
    `b 0 ${c} ${c} 0 ${r} 0`                       // Top-left corner (back to start)
  ].join(' ');
}

/**
 * Arial Bold character width ratios (relative to fontSize)
 * Calibrated for libass rendering - values are slightly larger to match actual rendering
 * Values are approximate width as fraction of em-square
 */
const ARIAL_BOLD_CHAR_WIDTHS = {
  // Very narrow characters
  'i': 0.33, 'l': 0.33, 'I': 0.33, '1': 0.56, '!': 0.39, '|': 0.33,
  "'": 0.28, '.': 0.33, ',': 0.33, ':': 0.39, ';': 0.39,

  // Narrow characters
  'j': 0.33, 'f': 0.39, 't': 0.44, 'r': 0.44, 'J': 0.61,

  // Medium-narrow characters
  'a': 0.61, 'c': 0.61, 'e': 0.61, 's': 0.61, 'z': 0.56,

  // Medium characters (most lowercase)
  'b': 0.67, 'd': 0.67, 'g': 0.67, 'h': 0.67, 'k': 0.61,
  'n': 0.67, 'o': 0.67, 'p': 0.67, 'q': 0.67, 'u': 0.67,
  'v': 0.61, 'x': 0.61, 'y': 0.61,

  // Wide characters
  'm': 0.94, 'w': 0.83,

  // Capital letters - narrow
  'E': 0.72, 'F': 0.67, 'L': 0.61, 'P': 0.72, 'S': 0.72,

  // Capital letters - medium
  'A': 0.78, 'B': 0.78, 'C': 0.78, 'D': 0.83, 'G': 0.83,
  'H': 0.83, 'K': 0.78, 'N': 0.83, 'O': 0.83, 'Q': 0.83,
  'R': 0.78, 'T': 0.67, 'U': 0.83, 'V': 0.78, 'X': 0.78,
  'Y': 0.72, 'Z': 0.67,

  // Capital letters - wide
  'M': 0.94, 'W': 1.06,

  // Numbers
  '0': 0.61, '2': 0.61, '3': 0.61, '4': 0.61, '5': 0.61,
  '6': 0.61, '7': 0.61, '8': 0.61, '9': 0.61,

  // Space - critical for word positioning (increased for accuracy)
  ' ': 0.36,

  // Common punctuation
  '-': 0.39, '–': 0.61, '—': 1.06, '"': 0.56, '"': 0.56,
  "'": 0.33, "'": 0.33, '?': 0.67, '/': 0.33, '(': 0.44,
  ')': 0.44, '[': 0.39, ']': 0.39
};

// Default width for unknown characters
const DEFAULT_CHAR_WIDTH = 0.64;

/**
 * Calculate text width using character-specific widths for Arial Bold
 * @param {string} text - The text to measure
 * @param {number} fontSize - Font size in pixels
 * @returns {number} Estimated width in pixels
 */
function calculateTextWidth(text, fontSize) {
  let width = 0;
  for (const char of text) {
    const charWidth = ARIAL_BOLD_CHAR_WIDTHS[char] || DEFAULT_CHAR_WIDTH;
    width += fontSize * charWidth;
  }
  return width;
}

/**
 * Group words into display phrases
 */
function groupWordsIntoPhrases(words, wordsPerLine) {
  const phrases = [];
  let currentPhrase = { words: [], start: 0, end: 0 };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    if (currentPhrase.words.length === 0) {
      currentPhrase.start = word.start;
    }

    currentPhrase.words.push(word);
    currentPhrase.end = word.end;

    // Start new phrase after wordsPerLine words or at sentence end
    const isEndOfSentence = /[.!?]$/.test(word.word);
    if (currentPhrase.words.length >= wordsPerLine || isEndOfSentence) {
      phrases.push({ ...currentPhrase });
      currentPhrase = { words: [], start: 0, end: 0 };
    }
  }

  // Add remaining words
  if (currentPhrase.words.length > 0) {
    phrases.push(currentPhrase);
  }

  return phrases;
}

/**
 * Format time for ASS format (H:MM:SS.cc)
 */
function formatASSTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Format text with style-specific effects
 */
function formatTextWithStyle(words, captionStyle, styleConfig) {
  let text = '';

  if (styleConfig.useKaraoke) {
    // Karaoke effect: highlight each word as it's spoken
    for (const word of words) {
      const duration = Math.round((word.end - word.start) * 100); // centiseconds
      text += `{\\k${duration}}${word.word} `;
    }
  } else if (styleConfig.uppercase) {
    // Uppercase all text
    text = words.map(w => w.word.toUpperCase()).join(' ');
  } else {
    // Note: highlightKeywords (Hormozi) is handled directly in generateASSFile
    // using a two-layer approach for proper word-by-word highlighting
    // Simple text
    text = words.map(w => w.word).join(' ');
  }

  return text.trim();
}

export default { generateCaptions };
