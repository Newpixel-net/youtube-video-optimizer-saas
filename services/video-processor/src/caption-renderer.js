/**
 * Caption Renderer
 * Generates styled captions using Whisper for transcription and ASS subtitles
 */

import OpenAI from 'openai';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Main function to generate captions for a video
 * @param {Object} params
 * @param {string} params.jobId - Job ID for logging
 * @param {string} params.videoFile - Path to video file
 * @param {string} params.workDir - Working directory
 * @param {string} params.captionStyle - Caption style (karaoke, bold, hormozi, etc.)
 * @param {Object} params.customStyle - Custom style options
 * @returns {Promise<string|null>} Path to ASS subtitle file, or null if captions disabled
 */
export async function generateCaptions({ jobId, videoFile, workDir, captionStyle, customStyle }) {
  // Skip if no captions requested
  if (!captionStyle || captionStyle === 'none') {
    console.log(`[${jobId}] No captions requested, skipping`);
    return null;
  }

  console.log(`[${jobId}] Generating captions with style: ${captionStyle}`);

  try {
    // Step 1: Extract audio from video
    const audioFile = path.join(workDir, 'audio.wav');
    await extractAudio(jobId, videoFile, audioFile);

    // Step 2: Transcribe with Whisper (word-level timestamps)
    const transcription = await transcribeWithWhisper(jobId, audioFile);

    if (!transcription || !transcription.words || transcription.words.length === 0) {
      console.log(`[${jobId}] No words transcribed, skipping captions`);
      return null;
    }

    // Step 3: Generate ASS subtitle file with selected style
    const assFile = path.join(workDir, 'captions.ass');
    await generateASSFile(jobId, transcription.words, captionStyle, customStyle, assFile);

    console.log(`[${jobId}] Captions generated: ${assFile}`);
    return assFile;

  } catch (error) {
    console.error(`[${jobId}] Caption generation failed:`, error.message);
    // Don't fail the whole job, just skip captions
    return null;
  }
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
  if (!process.env.OPENAI_API_KEY) {
    console.log(`[${jobId}] OPENAI_API_KEY not set, skipping transcription`);
    return null;
  }

  try {
    const audioBuffer = fs.readFileSync(audioFile);

    // Create a File object from the buffer
    const file = new File([audioBuffer], 'audio.wav', { type: 'audio/wav' });

    const response = await openai.audio.transcriptions.create({
      file: file,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word']
    });

    console.log(`[${jobId}] Transcription complete: ${response.words?.length || 0} words`);

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
 */
async function generateASSFile(jobId, words, captionStyle, customStyle, outputFile) {
  console.log(`[${jobId}] Generating ASS file with style: ${captionStyle}`);

  // Get style configuration
  const styleConfig = getStyleConfig(captionStyle, customStyle);

  // ASS file header
  let assContent = `[Script Info]
Title: Generated Captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleConfig.styleLine}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Group words into phrases (roughly 3-5 words per line)
  const phrases = groupWordsIntoPhrases(words, styleConfig.wordsPerLine || 4);

  // Generate dialogue lines
  for (const phrase of phrases) {
    const startTime = formatASSTime(phrase.start);
    const endTime = formatASSTime(phrase.end);
    const text = formatTextWithStyle(phrase.words, captionStyle, styleConfig);

    assContent += `Dialogue: 0,${startTime},${endTime},${styleConfig.styleName},,0,0,0,,${text}\n`;
  }

  fs.writeFileSync(outputFile, assContent);
  console.log(`[${jobId}] ASS file written: ${outputFile}`);
}

/**
 * Get style configuration for caption style
 */
function getStyleConfig(captionStyle, customStyle) {
  const styles = {
    // Karaoke style - word-by-word highlight
    karaoke: {
      styleName: 'Karaoke',
      styleLine: 'Style: Karaoke,Arial,72,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,2,2,50,50,120,1',
      wordsPerLine: 4,
      useKaraoke: true,
      highlightColor: '&H00FFFF00' // Yellow
    },

    // MrBeast/Bold style - big bold text with background
    bold: {
      styleName: 'Bold',
      styleLine: 'Style: Bold,Impact,80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,3,6,3,2,50,50,120,1',
      wordsPerLine: 3,
      useKaraoke: false,
      uppercase: true
    },

    // Hormozi style - clean with keyword highlights
    hormozi: {
      styleName: 'Hormozi',
      styleLine: 'Style: Hormozi,Arial,68,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,4,2,2,50,50,120,1',
      wordsPerLine: 4,
      useKaraoke: false,
      highlightKeywords: true,
      highlightColor: '&H0000FFFF' // Yellow
    },

    // Ali Abdaal style - soft glow
    ali: {
      styleName: 'Ali',
      styleLine: 'Style: Ali,Arial,64,&H00FFFFFF,&H00FFFFFF,&H00FFCCAA,&H40000000,0,0,0,0,100,100,0,0,1,5,4,2,50,50,120,1',
      wordsPerLine: 5,
      useKaraoke: false
    },

    // Podcast style - simple clean
    podcast: {
      styleName: 'Podcast',
      styleLine: 'Style: Podcast,Arial,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,2,2,50,50,120,1',
      wordsPerLine: 5,
      useKaraoke: false
    },

    // Minimal style - small and subtle
    minimal: {
      styleName: 'Minimal',
      styleLine: 'Style: Minimal,Arial,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H60000000,0,0,0,0,100,100,0,0,1,2,1,2,50,50,100,1',
      wordsPerLine: 6,
      useKaraoke: false
    },

    // Custom style
    custom: {
      styleName: 'Custom',
      styleLine: buildCustomStyleLine(customStyle),
      wordsPerLine: 4,
      useKaraoke: customStyle?.karaoke || false
    }
  };

  return styles[captionStyle] || styles.podcast;
}

/**
 * Build custom style line from user options
 */
function buildCustomStyleLine(customStyle) {
  const fontName = customStyle?.fontFamily || 'Arial';
  const fontSize = Math.round((customStyle?.fontSize || 1) * 64);
  const color = hexToASS(customStyle?.color || '#ffffff');
  const bgColor = customStyle?.background ? '&H80000000' : '&H00000000';
  const bold = customStyle?.bold ? 1 : 0;

  return `Style: Custom,${fontName},${fontSize},${color},${color},&H00000000,${bgColor},${bold},0,0,0,100,100,0,0,1,3,2,2,50,50,120,1`;
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
  } else if (styleConfig.highlightKeywords) {
    // Highlight important words (simple heuristic: longer words, starts with capital)
    text = words.map(w => {
      const isKeyword = w.word.length > 5 || /^[A-Z]/.test(w.word);
      if (isKeyword) {
        return `{\\c${styleConfig.highlightColor}}${w.word}{\\c&H00FFFFFF}`;
      }
      return w.word;
    }).join(' ');
  } else {
    // Simple text
    text = words.map(w => w.word).join(' ');
  }

  return text.trim();
}

export default { generateCaptions };
