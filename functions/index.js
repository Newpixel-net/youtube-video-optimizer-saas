/**
 * YouTube Tools - Complete SaaS Backend
 * 20+ Cloud Functions with Authentication, Usage Limits, and Admin Panel
 *
 * SECURITY NOTES:
 * - All user-facing functions require authentication via verifyAuth()
 * - Admin functions require admin status via requireAdmin()
 * - Error messages are sanitized via sanitizeErrorMessage() to prevent info disclosure
 * - Rate limiting is implemented via quota system + burst protection
 *
 * RATE LIMITING RECOMMENDATIONS:
 * For production, consider implementing:
 * 1. Firebase App Check - https://firebase.google.com/docs/app-check
 * 2. Cloud Armor - for DDoS protection
 * 3. API Gateway rate limiting
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { google } = require('googleapis');
const axios = require('axios');

// Explicit initialization with project ID and storage bucket
admin.initializeApp({
  projectId: 'ytseo-6d1b0',
  storageBucket: 'ytseo-6d1b0.firebasestorage.app'
});
const db = admin.firestore();

// ==============================================
// RATE LIMITING - Burst Protection
// ==============================================

/**
 * Simple in-memory rate limiter for burst protection
 * Note: This resets on each function cold start, so it's only for burst protection.
 * For persistent rate limiting, use the quota system in Firestore.
 */
const rateLimitStore = new Map();

function checkRateLimit(userId, action, maxRequestsPerMinute = 10) {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window

  // Get or create entry
  let entry = rateLimitStore.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    entry = { windowStart: now, count: 0 };
  }

  entry.count++;
  rateLimitStore.set(key, entry);

  // Clean old entries periodically (simple cleanup)
  if (rateLimitStore.size > 10000) {
    const cutoff = now - windowMs;
    for (const [k, v] of rateLimitStore.entries()) {
      if (v.windowStart < cutoff) rateLimitStore.delete(k);
    }
  }

  if (entry.count > maxRequestsPerMinute) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      'Too many requests. Please wait a moment and try again.'
    );
  }

  return true;
}

const openai = new OpenAI({
  apiKey: functions.config().openai?.key || process.env.OPENAI_API_KEY
});

const youtube = google.youtube({
  version: 'v3',
  auth: functions.config().youtube?.key || process.env.YOUTUBE_API_KEY
});

// ==============================================
// AUTH HELPERS
// ==============================================

async function verifyAuth(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
  }
  return context.auth.uid;
}

async function isAdmin(uid) {
  const adminDoc = await db.collection('adminUsers').doc(uid).get();
  return adminDoc.exists;
}

async function requireAdmin(context) {
  const uid = await verifyAuth(context);
  const isUserAdmin = await isAdmin(uid);
  if (!isUserAdmin) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access required');
  }
  return uid;
}

async function getUser(uid) {
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists) {
    // Auto-create user profile if missing
    console.log('User document not found, creating profile for:', uid);
    const defaultPlan = 'free';
    const defaultLimits = {
      warpOptimizer: { dailyLimit: 3 },
      competitorAnalysis: { dailyLimit: 3 },
      trendPredictor: { dailyLimit: 3 },
      thumbnailGenerator: { dailyLimit: 3 }
    };

    // Use serverTimestamp for Firestore storage
    const newUserData = {
      uid: uid,
      email: '',
      displayName: '',
      photoURL: '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
      isActive: true,
      isAdmin: false,
      subscription: {
        plan: defaultPlan,
        status: 'active',
        startDate: admin.firestore.FieldValue.serverTimestamp(),
        endDate: null,
        autoRenew: false
      },
      usage: {
        warpOptimizer: {
          usedToday: 0,
          limit: defaultLimits.warpOptimizer.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        competitorAnalysis: {
          usedToday: 0,
          limit: defaultLimits.competitorAnalysis.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        trendPredictor: {
          usedToday: 0,
          limit: defaultLimits.trendPredictor.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        thumbnailGenerator: {
          usedToday: 0,
          limit: defaultLimits.thumbnailGenerator.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        }
      },
      notes: '',
      customLimits: {}
    };

    await db.collection('users').doc(uid).set(newUserData);
    console.log('User profile created successfully');

    // Re-read the document to get actual timestamp values (not sentinel objects)
    const createdDoc = await db.collection('users').doc(uid).get();
    return createdDoc.data();
  }
  return userDoc.data();
}

async function checkUsageLimit(uid, toolType) {
  const userDoc = await db.collection('users').doc(uid).get();
  const user = userDoc.data();
  if (!user) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  let usage = user.usage?.[toolType];

  // Auto-create usage data for new tools if missing (for existing users)
  if (!usage) {
    const defaultLimit = 2; // Free plan default
    const newUsageData = {
      usedToday: 0,
      limit: defaultLimit,
      lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
      cooldownUntil: null
    };

    // Create the missing tool usage in Firestore
    await db.collection('users').doc(uid).update({
      [`usage.${toolType}`]: newUsageData
    });

    // Use default values for this request (serverTimestamp won't be resolved yet)
    usage = {
      usedToday: 0,
      limit: defaultLimit,
      lastResetAt: admin.firestore.Timestamp.now()
    };
  }

  const now = admin.firestore.Timestamp.now();
  const nowMs = now.toMillis();

  // Get custom reset time from settings (default 1440 minutes = 24 hours)
  let resetMinutes = 1440;
  try {
    const settingsDoc = await db.collection('settings').doc('quotaSettings').get();
    if (settingsDoc.exists && settingsDoc.data().resetTimeMinutes) {
      resetMinutes = settingsDoc.data().resetTimeMinutes;
    }
  } catch (e) {
    console.log('Using default reset time');
  }

  // Check if reset is due based on custom reset time
  const lastResetMs = usage.lastResetAt ? usage.lastResetAt.toMillis() : 0;
  const resetIntervalMs = resetMinutes * 60 * 1000;
  const nextResetMs = lastResetMs + resetIntervalMs;

  if (nowMs >= nextResetMs) {
    // Time to reset
    await db.collection('users').doc(uid).update({
      [`usage.${toolType}.usedToday`]: 0,
      [`usage.${toolType}.lastResetAt`]: admin.firestore.FieldValue.serverTimestamp()
    });
    usage.usedToday = 0;
  }

  // Calculate total available uses (regular limit + bonus)
  const bonusUses = user.bonusUses?.[toolType] || 0;
  const totalLimit = usage.limit + bonusUses;

  if (usage.usedToday >= totalLimit) {
    // Calculate time until next reset
    const currentLastReset = usage.lastResetAt ? usage.lastResetAt.toMillis() : nowMs;
    const resetAtMs = currentLastReset + resetIntervalMs;
    const remainingMs = Math.max(0, resetAtMs - nowMs);
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    const remainingMinutes = Math.ceil(remainingSeconds / 60);

    throw new functions.https.HttpsError(
      'resource-exhausted',
      `Quota exhausted (${usage.usedToday}/${totalLimit}). Resets in ${remainingMinutes} minutes.`,
      {
        limit: totalLimit,
        used: usage.usedToday,
        bonusUses: bonusUses,
        resetAtMs: resetAtMs,
        remainingMs: remainingMs,
        remainingSeconds: remainingSeconds,
        remainingMinutes: remainingMinutes
      }
    );
  }

  return {
    allowed: true,
    remaining: totalLimit - usage.usedToday - 1,
    limit: totalLimit,
    bonusUses: bonusUses
  };
}

async function incrementUsage(uid, toolType) {
  await db.collection('users').doc(uid).update({
    [`usage.${toolType}.usedToday`]: admin.firestore.FieldValue.increment(1)
  });
}

async function logUsage(uid, action, metadata = {}) {
  await db.collection('usageLogs').add({
    userId: uid,
    action,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    metadata
  });
}

/**
 * SECURITY: Sanitize error messages to prevent information disclosure
 * Removes sensitive details like file paths, API keys, and internal structure
 */
function sanitizeErrorMessage(error, defaultMessage = 'An error occurred. Please try again.') {
  if (!error) return defaultMessage;

  const message = error.message || String(error);

  // Patterns that indicate sensitive information
  const sensitivePatterns = [
    /\/home\/[^\s]+/gi,              // File paths
    /\/var\/[^\s]+/gi,               // System paths
    /node_modules/gi,                 // Node internals
    /at\s+[^\s]+\s+\([^)]+\)/gi,     // Stack trace lines
    /sk-[a-zA-Z0-9]+/gi,             // OpenAI API keys
    /AIza[a-zA-Z0-9_-]+/gi,          // Google API keys
    /Bearer\s+[^\s]+/gi,             // Bearer tokens
    /password|secret|credential/gi,   // Sensitive terms
    /ECONNREFUSED|ETIMEDOUT/gi,      // Network internals
  ];

  // Check if the message contains sensitive info
  for (const pattern of sensitivePatterns) {
    if (pattern.test(message)) {
      console.error('Sanitized error (original logged):', message);
      return defaultMessage;
    }
  }

  // Known safe error messages that can be passed through
  const safeErrorPrefixes = [
    'Video not found',
    'Channel not found',
    'User not found',
    'Invalid YouTube URL',
    'Video URL is required',
    'Quota exhausted',
    'User must be logged in',
    'Admin access required',
    'Permission denied',
    'Invalid argument',
  ];

  for (const prefix of safeErrorPrefixes) {
    if (message.startsWith(prefix) || message.includes(prefix)) {
      return message;
    }
  }

  // If the message is short and doesn't look like a stack trace, allow it
  if (message.length < 100 && !message.includes('\n') && !message.includes('    at ')) {
    return message;
  }

  // Default: return generic message and log the original
  console.error('Sanitized error (original logged):', message);
  return defaultMessage;
}

// ==============================================
// USER LIFECYCLE
// ==============================================

exports.onUserCreate = functions.auth.user().onCreate(async (user) => {
  try {
    const settingsDoc = await db.collection('adminSettings').doc('config').get();
    const defaultPlan = settingsDoc.data()?.defaultPlan || 'free';
    const planDoc = await db.collection('subscriptionPlans').doc(defaultPlan).get();
    const planLimits = planDoc.data().limits;
    
    await db.collection('users').doc(user.uid).set({
      uid: user.uid,
      email: user.email,
      displayName: user.displayName || '',
      photoURL: user.photoURL || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
      isActive: true,
      isAdmin: false,
      subscription: {
        plan: defaultPlan,
        status: 'active',
        startDate: admin.firestore.FieldValue.serverTimestamp(),
        endDate: null,
        autoRenew: false
      },
      usage: {
        warpOptimizer: {
          usedToday: 0,
          limit: planLimits.warpOptimizer.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        competitorAnalysis: {
          usedToday: 0,
          limit: planLimits.competitorAnalysis.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        trendPredictor: {
          usedToday: 0,
          limit: planLimits.trendPredictor.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        thumbnailGenerator: {
          usedToday: 0,
          limit: planLimits.thumbnailGenerator.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        }
      },
      notes: '',
      customLimits: {}
    });

    await logUsage(user.uid, 'user_created', { email: user.email });
    console.log(`User created: ${user.email}`);
  } catch (error) {
    console.error('Error creating user:', error);
  }
});

exports.updateLastLogin = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  await db.collection('users').doc(uid).update({
    lastLoginAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { success: true };
});

// ==============================================
// VIDEO HELPERS
// ==============================================

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  throw new Error('Invalid YouTube URL');
}

async function getVideoTranscript(videoId) {
  try {
    const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`);
    const html = response.data;
    const captionsRegex = /"captions":(\{.*?\}),"videoDetails"/;
    const match = html.match(captionsRegex);
    if (!match) return { segments: [], fullText: 'Transcript not available.' };
    
    const captionsData = JSON.parse(match[1]);
    const captionTracks = captionsData?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks || captionTracks.length === 0) {
      return { segments: [], fullText: 'No captions available.' };
    }
    
    const captionUrl = captionTracks[0].baseUrl;
    const transcriptResponse = await axios.get(captionUrl);
    const transcriptXml = transcriptResponse.data;
    const segments = [];
    const textMatches = transcriptXml.matchAll(/<text start="([^"]*)"[^>]*>(.*?)<\/text>/g);
    
    for (const match of textMatches) {
      const timestamp = parseFloat(match[1]);
      const text = match[2]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n/g, ' ')
        .trim();
      if (text) segments.push({ timestamp, text });
    }
    
    return { segments, fullText: segments.map(s => s.text).join(' ') };
  } catch (error) {
    return { segments: [], fullText: 'Transcript not available.' };
  }
}

async function getVideoMetadata(videoId) {
  try {
    const response = await youtube.videos.list({
      part: ['snippet', 'statistics', 'contentDetails'],
      id: [videoId]
    });

    if (!response.data.items || response.data.items.length === 0) {
      throw new functions.https.HttpsError('not-found', 'Video not found. Please check the URL and try again.');
    }

    const video = response.data.items[0];
    const snippet = video.snippet || {};
    const statistics = video.statistics || {};
    const contentDetails = video.contentDetails || {};

    // Parse duration to human-readable format
    const rawDuration = contentDetails.duration || 'PT0S';
    const durationMatch = rawDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    let duration = 'Unknown';
    if (durationMatch) {
      const hours = parseInt(durationMatch[1] || 0);
      const minutes = parseInt(durationMatch[2] || 0);
      const seconds = parseInt(durationMatch[3] || 0);
      if (hours > 0) {
        duration = `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
      } else {
        duration = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      }
    }

    // Return object with field names matching what optimizeVideo expects
    // All fields have default values to prevent Firestore undefined errors
    return {
      videoId: videoId || '',
      title: snippet.title || 'Untitled',
      description: snippet.description || '',
      channelTitle: snippet.channelTitle || 'Unknown Channel',
      channelId: snippet.channelId || '',
      publishedAt: snippet.publishedAt || null,
      thumbnail: (snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url) || '',
      tags: snippet.tags || [],
      categoryId: snippet.categoryId || '',
      viewCount: parseInt(statistics.viewCount) || 0,
      likeCount: parseInt(statistics.likeCount) || 0,
      commentCount: parseInt(statistics.commentCount) || 0,
      duration: duration,
      rawDuration: rawDuration,
      defaultLanguage: snippet.defaultLanguage || 'en'
    };
  } catch (error) {
    // Check for specific YouTube API errors
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }

    const errorMessage = error.message || '';
    const errorCode = error.code || error.response?.status;

    // YouTube API not enabled
    if (errorMessage.includes('API') && errorMessage.includes('not been used') ||
        errorMessage.includes('accessNotConfigured') ||
        errorMessage.includes('YouTube Data API v3 has not been enabled')) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'YouTube API not enabled. Please enable YouTube Data API v3 in Google Cloud Console.'
      );
    }

    // API key issues
    if (errorMessage.includes('API key') || errorMessage.includes('invalid key') || errorCode === 400) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'YouTube API key is invalid or missing. Please check the API configuration.'
      );
    }

    // Quota exceeded
    if (errorMessage.includes('quota') || errorCode === 403) {
      throw new functions.https.HttpsError(
        'resource-exhausted',
        'YouTube API quota exceeded. Please try again later or upgrade the API quota.'
      );
    }

    // Network or other errors
    throw new functions.https.HttpsError(
      'internal',
      'Failed to fetch video data: ' + errorMessage
    );
  }
}

function parseDuration(duration) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0);
  const minutes = parseInt(match[2] || 0);
  const seconds = parseInt(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function formatTimestamp(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

// ==============================================
// CONTENT TYPE DETECTION
// ==============================================

// YouTube Category IDs: 10 = Music, 20 = Gaming, 22 = People & Blogs, 24 = Entertainment,
// 25 = News & Politics, 26 = Howto & Style, 27 = Education, 28 = Science & Technology
const YOUTUBE_CATEGORIES = {
  '10': 'music',
  '20': 'gaming',
  '22': 'vlog',
  '23': 'comedy',
  '24': 'entertainment',
  '25': 'news',
  '26': 'howto',
  '27': 'education',
  '28': 'tech'
};

function detectContentType(metadata) {
  const title = (metadata.title || '').toLowerCase();
  const channelTitle = (metadata.channelTitle || '').toLowerCase();
  const description = (metadata.description || '').toLowerCase();
  const tags = (metadata.tags || []).map(t => t.toLowerCase());
  const categoryId = metadata.categoryId || '';

  // 1. Check for auto-generated YouTube music channels ("Artist - Topic")
  if (channelTitle.endsWith(' - topic') || channelTitle.includes('- topic')) {
    return { type: 'music', subtype: 'song', confidence: 'high', source: 'topic_channel' };
  }

  // 2. Check YouTube category ID
  if (categoryId === '10') {
    // Music category - determine subtype
    const subtype = detectMusicSubtype(title, description, tags);
    return { type: 'music', subtype, confidence: 'high', source: 'category' };
  }

  // 3. Music keywords detection
  const musicKeywords = ['official audio', 'official video', 'music video', 'official music',
    'lyric video', 'lyrics', 'ft.', 'feat.', 'prod.', 'remix', 'cover', 'acoustic version',
    'official visualizer', 'audio', 'full album', 'ep', 'single', '(official)', '[official]'];
  const musicGenres = ['hip hop', 'rap', 'rock', 'pop', 'jazz', 'classical', 'electronic',
    'edm', 'r&b', 'rnb', 'country', 'metal', 'punk', 'indie', 'soul', 'funk', 'reggae',
    'house', 'techno', 'trap', 'drill', 'dubstep', 'dnb', 'drum and bass'];

  if (musicKeywords.some(kw => title.includes(kw) || description.includes(kw)) ||
      musicGenres.some(genre => tags.includes(genre))) {
    const subtype = detectMusicSubtype(title, description, tags);
    return { type: 'music', subtype, confidence: 'medium', source: 'keywords' };
  }

  // 4. Check for other content types
  if (categoryId && YOUTUBE_CATEGORIES[categoryId]) {
    return { type: YOUTUBE_CATEGORIES[categoryId], subtype: 'general', confidence: 'high', source: 'category' };
  }

  // 5. Keyword-based detection for other types
  if (title.includes('tutorial') || title.includes('how to') || title.includes('guide')) {
    return { type: 'tutorial', subtype: 'educational', confidence: 'medium', source: 'keywords' };
  }
  if (title.includes('review') || title.includes('unboxing')) {
    return { type: 'review', subtype: 'product', confidence: 'medium', source: 'keywords' };
  }
  if (title.includes('gameplay') || title.includes('playthrough') || title.includes('let\'s play')) {
    return { type: 'gaming', subtype: 'gameplay', confidence: 'medium', source: 'keywords' };
  }
  if (title.includes('vlog') || title.includes('day in my life') || title.includes('grwm')) {
    return { type: 'vlog', subtype: 'lifestyle', confidence: 'medium', source: 'keywords' };
  }
  if (title.includes('podcast') || title.includes('interview') || title.includes('conversation')) {
    return { type: 'podcast', subtype: 'talk', confidence: 'medium', source: 'keywords' };
  }

  // Default
  return { type: 'general', subtype: 'unknown', confidence: 'low', source: 'default' };
}

function detectMusicSubtype(title, description, tags) {
  const titleLower = title.toLowerCase();

  if (titleLower.includes('full album') || titleLower.includes('album')) return 'album';
  if (titleLower.includes('playlist') || titleLower.includes('mix')) return 'playlist';
  if (titleLower.includes('remix')) return 'remix';
  if (titleLower.includes('cover')) return 'cover';
  if (titleLower.includes('live') || titleLower.includes('concert')) return 'live';
  if (titleLower.includes('lyric') || titleLower.includes('lyrics')) return 'lyric_video';
  if (titleLower.includes('music video') || titleLower.includes('official video')) return 'music_video';
  if (titleLower.includes('visualizer')) return 'visualizer';

  return 'song'; // Default music subtype
}

function getContentTypeContext(contentType) {
  const { type, subtype } = contentType;

  if (type === 'music') {
    return {
      titleInstructions: `
MUSIC CONTENT DETECTED - This is a ${subtype === 'song' ? 'song/track' : subtype}.
DO NOT create motivational or educational titles. Create MUSIC-appropriate titles:
- Include artist name and track title
- Use music-related terms: "Official Audio", "Lyrics", "Full Track", etc.
- Highlight genre, mood, or musical elements
- For remixes: mention original artist and remixer
- Keep it authentic to music industry standards`,

      descriptionInstructions: `
MUSIC CONTENT DETECTED - This is a ${subtype === 'song' ? 'song/track' : subtype}.
DO NOT create educational or motivational descriptions. Create a MUSIC description:

Include:
1. 🎵 Song/Track info (artist, title, album if applicable)
2. 🎧 Genre and musical style
3. 📀 Release info (if available)
4. 🎤 Credits (producers, features, writers if known)
5. ⏱️ Simple timestamp if multiple sections exist
6. 🔗 Links section for: Spotify, Apple Music, streaming platforms
7. Music-related hashtags (#NewMusic #[Genre] #[ArtistName])

DO NOT include:
- Motivational hooks or life advice
- Educational key points or bullet lists
- Call-to-actions about "achieving goals"
- Non-music related content`,

      tagsInstructions: `
MUSIC CONTENT DETECTED - Generate MUSIC-specific tags:

1. Primary (5-8): Artist name, song title, genre, album name
2. Secondary (8-12): Related artists, music style, mood tags, record label
3. Long-tail (10-15): "[Artist] new song 2024", "[Genre] music", "best [genre] songs"
4. Trending (5-10): Current music trends, viral sounds, playlist names

DO NOT include tags about motivation, self-help, productivity, or educational content.
Focus on: artist discovery, genre, mood, similar artists, music platform names.`
    };
  }

  if (type === 'gaming') {
    return {
      titleInstructions: `GAMING CONTENT - Include game name, type of content (gameplay, review, guide), and gaming-specific hooks.`,
      descriptionInstructions: `GAMING CONTENT - Include game info, platform, gameplay timestamps, and gaming community links.`,
      tagsInstructions: `GAMING CONTENT - Focus on game name, platform, game genre, gaming terms, esports if relevant.`
    };
  }

  if (type === 'tutorial' || type === 'howto' || type === 'education') {
    return {
      titleInstructions: `EDUCATIONAL/TUTORIAL CONTENT - Focus on the problem being solved, include "How to", step counts, or results promises.`,
      descriptionInstructions: `EDUCATIONAL CONTENT - Include clear problem statement, numbered steps, resources, and practical takeaways.`,
      tagsInstructions: `EDUCATIONAL CONTENT - Focus on topic keywords, skill levels, related topics, and problem-solution phrases.`
    };
  }

  // Default for general content
  return {
    titleInstructions: `Create engaging titles appropriate for the video's actual content and subject matter.`,
    descriptionInstructions: `Create a description that accurately represents the video content with relevant sections.`,
    tagsInstructions: `Create tags relevant to the actual video content and subject matter.`
  };
}

async function generateTitlesInternal(metadata, transcript) {
  const transcriptText = transcript.fullText || '';

  // Detect content type using metadata
  const contentType = detectContentType(metadata);
  const context = getContentTypeContext(contentType);

  const titlePrompt = `Generate 3 YouTube titles for this video.

=== VIDEO METADATA ===
Title: ${metadata.title}
Channel: ${metadata.channelTitle}
Category ID: ${metadata.categoryId || 'Unknown'}
Tags: ${(metadata.tags || []).slice(0, 10).join(', ')}
Description: ${metadata.description?.substring(0, 500) || ''}
Transcript: ${transcriptText.substring(0, 1500)}

=== DETECTED CONTENT TYPE ===
Type: ${contentType.type} (${contentType.subtype})
Confidence: ${contentType.confidence}
Detection Source: ${contentType.source}

=== CRITICAL INSTRUCTIONS ===
${context.titleInstructions}

Create 3 titles (60-70 chars each) appropriate for ${contentType.type.toUpperCase()} content:
1. ATTENTION-GRABBING: Eye-catching but relevant to ${contentType.type}
2. SEO-OPTIMIZED: Keyword-rich for ${contentType.type} discovery
3. DESCRIPTIVE: Clear about what the content actually is

Return ONLY valid JSON:
{
  "clickbait": "title",
  "seo": "title",
  "question": "title",
  "detectedType": "${contentType.type}"
}`;

  const systemPrompt = contentType.type === 'music'
    ? 'You are a music industry expert. Create titles appropriate for music content. Never create motivational or self-help titles for songs. Return only valid JSON.'
    : 'Create engaging YouTube titles appropriate for the detected content type. Return only valid JSON.';

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: titlePrompt }
    ],
    temperature: 0.8,
    max_tokens: 400
  });

  try {
    const responseText = completion.choices[0].message.content.trim();
    const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(cleanJson);
    result.detectedType = contentType.type; // Ensure we use our detected type
    return result;
  } catch (error) {
    return {
      clickbait: metadata.title,
      seo: metadata.title,
      question: metadata.title,
      detectedType: contentType.type
    };
  }
}

async function generateDescriptionInternal(metadata, transcript) {
  const transcriptText = transcript.fullText || '';
  const durationSeconds = parseDuration(metadata.duration);

  // Detect content type using metadata
  const contentType = detectContentType(metadata);
  const context = getContentTypeContext(contentType);

  const descriptionPrompt = `Create a YouTube description for this video.

=== VIDEO METADATA ===
Title: ${metadata.title}
Channel: ${metadata.channelTitle}
Category ID: ${metadata.categoryId || 'Unknown'}
Duration: ${formatTimestamp(durationSeconds)}
Tags: ${(metadata.tags || []).slice(0, 10).join(', ')}
Transcript: ${transcriptText.substring(0, 2500)}

=== DETECTED CONTENT TYPE ===
Type: ${contentType.type} (${contentType.subtype})
Confidence: ${contentType.confidence}
Detection Source: ${contentType.source}

=== CRITICAL INSTRUCTIONS ===
${context.descriptionInstructions}

Create a description that is SPECIFICALLY appropriate for ${contentType.type.toUpperCase()} content.`;

  const systemPrompt = contentType.type === 'music'
    ? `You are a music industry professional writing descriptions for music releases.
NEVER write motivational or self-help content for songs.
Focus on: artist info, track details, genre, streaming links, credits.
Write in the style of official music channel descriptions.`
    : `Create engaging YouTube descriptions appropriate for ${contentType.type} content.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: descriptionPrompt }
    ],
    temperature: 0.7,
    max_tokens: 1000
  });

  return completion.choices[0].message.content.trim();
}

async function generateTagsInternal(metadata, transcript) {
  const transcriptText = transcript.fullText || '';

  // Detect content type using metadata
  const contentType = detectContentType(metadata);
  const context = getContentTypeContext(contentType);

  const tagsPrompt = `Generate YouTube tags for this video.

=== VIDEO METADATA ===
Title: ${metadata.title}
Channel: ${metadata.channelTitle}
Category ID: ${metadata.categoryId || 'Unknown'}
Existing Tags: ${(metadata.tags || []).join(', ')}
Transcript: ${transcriptText.substring(0, 1500)}

=== DETECTED CONTENT TYPE ===
Type: ${contentType.type} (${contentType.subtype})
Confidence: ${contentType.confidence}
Detection Source: ${contentType.source}

=== CRITICAL INSTRUCTIONS ===
${context.tagsInstructions}

Generate 30-50 tags SPECIFICALLY for ${contentType.type.toUpperCase()} content in these categories:
1. Primary (5-8): Core ${contentType.type} tags
2. Secondary (8-12): Related ${contentType.type} tags
3. Long-tail (10-15): Specific search phrases for ${contentType.type}
4. Trending (5-10): Current trends in ${contentType.type}

Return ONLY valid JSON:
{
  "primary": ["tag1"],
  "secondary": ["tag2"],
  "longTail": ["phrase"],
  "trending": ["trend"]
}`;

  const systemPrompt = contentType.type === 'music'
    ? `You are a music SEO expert. Generate tags for music discovery.
Focus on: artist names, song titles, genres, moods, similar artists, music platforms.
NEVER include motivational, self-help, or productivity tags for music content.
Return only valid JSON.`
    : `Generate YouTube tags appropriate for ${contentType.type} content. Return only valid JSON.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: tagsPrompt }
    ],
    temperature: 0.7,
    max_tokens: 800
  });

  try {
    const responseText = completion.choices[0].message.content.trim();
    const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleanJson);
  } catch (error) {
    return { primary: [], secondary: [], longTail: [], trending: [] };
  }
}

// ==============================================
// VIDEO OPTIMIZER (WITH AUTH & LIMITS)
// ==============================================

exports.optimizeVideo = functions.https.onCall(async (data, context) => {
  try {
    const uid = await verifyAuth(context);

    // SECURITY: Burst rate limiting (max 5 optimization requests per minute)
    checkRateLimit(uid, 'optimizeVideo', 5);

    const usageCheck = await checkUsageLimit(uid, 'warpOptimizer');

    const { videoUrl } = data;
    if (!videoUrl) throw new functions.https.HttpsError('invalid-argument', 'Video URL required');

    const startTime = Date.now();
    const videoId = extractVideoId(videoUrl);
    const metadata = await getVideoMetadata(videoId);
    const transcript = await getVideoTranscript(videoId);

    const [titlesResult, description, tagsResult] = await Promise.all([
      generateTitlesInternal(metadata, transcript),
      generateDescriptionInternal(metadata, transcript),
      generateTagsInternal(metadata, transcript)
    ]);

    // Convert titles object to array for frontend
    const titlesArray = [
      titlesResult.clickbait || metadata.title,
      titlesResult.seo || metadata.title,
      titlesResult.question || metadata.title
    ].filter(Boolean);

    // Flatten tags object to array for frontend
    const tagsArray = [
      ...(tagsResult.primary || []),
      ...(tagsResult.secondary || []),
      ...(tagsResult.longTail || []),
      ...(tagsResult.trending || [])
    ];

    const processingTime = Math.round((Date.now() - startTime) / 1000);

    // Calculate SEO score using the arrays
    const seoScore = Math.min(100, Math.round(
      (titlesArray.length * 10) +
      (description && description.length > 200 ? 20 : 10) +
      (Math.min(tagsArray.length, 30) * 1.5) +
      (metadata.viewCount > 10000 ? 15 : 5)
    ));

    const seoRecommendations = [];
    if (titlesArray.length < 3) seoRecommendations.push('Consider adding more title variations');
    if (!description || description.length < 200) seoRecommendations.push('Description could be more detailed');
    if (tagsArray.length < 15) seoRecommendations.push('Add more relevant tags for better discoverability');
    if (tagsArray.length > 0 && tagsArray.length < 30) seoRecommendations.push('Try to use 30-50 tags for maximum reach');

    const seoAnalysis = {
      score: seoScore,
      recommendations: seoRecommendations
    };

    // Prepare data for Firestore (ensure no undefined values)
    const videoInfo = {
      title: metadata.title || '',
      channelTitle: metadata.channelTitle || '',
      viewCount: metadata.viewCount || 0,
      duration: metadata.duration || '',
      thumbnail: metadata.thumbnail || ''
    };

    // Save to optimizations collection (for history)
    const optimizationRef = await db.collection('optimizations').add({
      userId: uid,
      videoUrl: videoUrl || '',
      videoInfo,
      titles: titlesArray,
      description: description || '',
      tags: tagsArray,
      seoAnalysis,
      timestamp: Date.now(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await incrementUsage(uid, 'warpOptimizer');
    await logUsage(uid, 'warp_optimizer_used', { videoId, processingTime });

    return {
      success: true,
      optimizationId: optimizationRef.id,
      videoInfo,
      titles: titlesArray,
      description: description || '',
      tags: tagsArray,
      seoAnalysis,
      usageRemaining: usageCheck.remaining
    };
  } catch (error) {
    if (context.auth) {
      await logUsage(context.auth.uid, 'warp_optimizer_failed', { error: error.message });
    }
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Video optimization failed. Please try again.'));
  }
});

// Title generator - uses warpOptimizer quota (included in Warp Optimizer tool)
exports.generateTitles = functions.https.onCall(async (data, context) => {
  try {
    const uid = await verifyAuth(context);
    checkRateLimit(uid, 'generateTitles', 10);
    // Uses warpOptimizer quota since this is part of the optimization suite
    const usageCheck = await checkUsageLimit(uid, 'warpOptimizer');
    const { videoUrl } = data;
    if (!videoUrl) throw new functions.https.HttpsError('invalid-argument', 'Video URL required');

    const videoId = extractVideoId(videoUrl);
    const metadata = await getVideoMetadata(videoId);
    const transcript = await getVideoTranscript(videoId);
    const titles = await generateTitlesInternal(metadata, transcript);

    await incrementUsage(uid, 'warpOptimizer');
    await logUsage(uid, 'title_generator_used', { videoId });

    return { success: true, videoData: metadata, titles, usageRemaining: usageCheck.remaining };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Title generation failed. Please try again.'));
  }
});

// Description generator - uses warpOptimizer quota (included in Warp Optimizer tool)
exports.generateDescription = functions.https.onCall(async (data, context) => {
  try {
    const uid = await verifyAuth(context);
    checkRateLimit(uid, 'generateDescription', 10);
    // Uses warpOptimizer quota since this is part of the optimization suite
    const usageCheck = await checkUsageLimit(uid, 'warpOptimizer');
    const { videoUrl } = data;
    if (!videoUrl) throw new functions.https.HttpsError('invalid-argument', 'Video URL required');

    const videoId = extractVideoId(videoUrl);
    const metadata = await getVideoMetadata(videoId);
    const transcript = await getVideoTranscript(videoId);
    const description = await generateDescriptionInternal(metadata, transcript);

    await incrementUsage(uid, 'warpOptimizer');
    await logUsage(uid, 'description_generator_used', { videoId });

    return { success: true, videoData: metadata, description, usageRemaining: usageCheck.remaining };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Description generation failed. Please try again.'));
  }
});

// Tag generator - uses warpOptimizer quota (included in Warp Optimizer tool)
exports.generateTags = functions.https.onCall(async (data, context) => {
  try {
    const uid = await verifyAuth(context);
    checkRateLimit(uid, 'generateTags', 10);
    // Uses warpOptimizer quota since this is part of the optimization suite
    const usageCheck = await checkUsageLimit(uid, 'warpOptimizer');
    const { videoUrl } = data;
    if (!videoUrl) throw new functions.https.HttpsError('invalid-argument', 'Video URL required');

    const videoId = extractVideoId(videoUrl);
    const metadata = await getVideoMetadata(videoId);
    const transcript = await getVideoTranscript(videoId);
    const tags = await generateTagsInternal(metadata, transcript);

    await incrementUsage(uid, 'warpOptimizer');
    await logUsage(uid, 'tag_generator_used', { videoId });

    return { success: true, videoData: metadata, tags, usageRemaining: usageCheck.remaining };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Tag generation failed. Please try again.'));
  }
});

// ==============================================
// USER DASHBOARD
// ==============================================

exports.getUserProfile = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
  }

  const uid = context.auth.uid;

  try {
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();

    let userData;

    if (!userSnap.exists) {
      // Create new user with default free plan
      userData = {
        uid: uid,
        email: context.auth.token?.email || '',
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
        isActive: true,
        isAdmin: false,
        subscription: { plan: 'free', status: 'active' },
        usage: {
          warpOptimizer: { usedToday: 0, limit: 3, lastResetAt: new Date().toISOString() },
          competitorAnalysis: { usedToday: 0, limit: 3, lastResetAt: new Date().toISOString() },
          trendPredictor: { usedToday: 0, limit: 3, lastResetAt: new Date().toISOString() },
          thumbnailGenerator: { usedToday: 0, limit: 3, lastResetAt: new Date().toISOString() }
        }
      };
      await userRef.set(userData);
    } else {
      userData = userSnap.data();

      // Convert Firestore Timestamps to ISO strings for serialization
      if (userData.createdAt?.toDate) userData.createdAt = userData.createdAt.toDate().toISOString();
      if (userData.lastLoginAt?.toDate) userData.lastLoginAt = userData.lastLoginAt.toDate().toISOString();
      if (userData.subscription?.startDate?.toDate) userData.subscription.startDate = userData.subscription.startDate.toDate().toISOString();

      // Convert usage timestamps
      ['warpOptimizer', 'competitorAnalysis', 'trendPredictor', 'thumbnailGenerator'].forEach(tool => {
        if (userData.usage?.[tool]?.lastResetAt?.toDate) {
          userData.usage[tool].lastResetAt = userData.usage[tool].lastResetAt.toDate().toISOString();
        }
      });
    }

    // Build quotaInfo with bonus uses included
    const tools = ['warpOptimizer', 'competitorAnalysis', 'trendPredictor', 'thumbnailGenerator'];
    const quotaInfo = {};
    const resetIntervalMs = 24 * 60 * 60 * 1000; // 24 hours in ms
    const now = Date.now();

    // Ensure userData.usage has all tool keys (for existing users with old structure)
    if (!userData.usage) {
      userData.usage = {};
    }

    for (const tool of tools) {
      // Add default usage data for missing tools
      if (!userData.usage[tool]) {
        userData.usage[tool] = { usedToday: 0, limit: 2, lastResetAt: new Date().toISOString() };
      }
      const usage = userData.usage[tool];
      const bonusUses = userData.bonusUses?.[tool] || 0;
      const baseLimit = usage.limit || 2;
      const totalLimit = baseLimit + bonusUses;

      // Calculate next reset time
      let lastResetTime = usage.lastResetAt;
      if (typeof lastResetTime === 'string') {
        lastResetTime = new Date(lastResetTime).getTime();
      } else if (lastResetTime && typeof lastResetTime === 'object') {
        lastResetTime = (lastResetTime.seconds || lastResetTime._seconds || 0) * 1000;
      }
      const nextResetMs = (lastResetTime || now) + resetIntervalMs;

      quotaInfo[tool] = {
        baseLimit: baseLimit,
        bonusUses: bonusUses,
        totalLimit: totalLimit,
        usedToday: usage.usedToday || 0,
        remaining: Math.max(0, totalLimit - (usage.usedToday || 0)),
        nextResetMs: nextResetMs
      };
    }

    return {
      success: true,
      profile: userData,
      quotaInfo: quotaInfo,
      resetTimeMinutes: 1440
    };

  } catch (error) {
    console.error('getUserProfile error:', error.message);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to load profile. Please try again.'));
  }
});

exports.getHistory = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'getHistory', 20);

  const { limit = 20, offset = 0 } = data || {};

  // SECURITY: Bound limit and offset to prevent resource exhaustion
  const safeLimit = Math.min(Math.max(1, parseInt(limit) || 20), 100);
  const safeOffset = Math.max(0, parseInt(offset) || 0);

  const snapshot = await db.collection('optimizations')
    .where('userId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(safeLimit)
    .offset(safeOffset)
    .get();

  const history = [];
  snapshot.forEach(doc => {
    history.push({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate().toISOString()
    });
  });

  return { success: true, history, count: history.length };
});

exports.deleteOptimization = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { optimizationId } = data;
  
  const doc = await db.collection('optimizations').doc(optimizationId).get();
  if (!doc.exists || doc.data().userId !== uid) {
    throw new functions.https.HttpsError('permission-denied', 'Not authorized');
  }
  
  await db.collection('optimizations').doc(optimizationId).delete();
  return { success: true };
});

// ==============================================
// ADMIN DASHBOARD
// ==============================================

exports.adminGetUsers = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    // Handle case where data might be null/undefined
    const safeData = data || {};
    const limitCount = safeData.limit || 100;
    const planFilter = safeData.plan || null;

    let query = db.collection('users').orderBy('createdAt', 'desc').limit(limitCount);
    if (planFilter) {
      query = query.where('subscription.plan', '==', planFilter);
    }

    const snapshot = await query.get();
    const users = [];

    snapshot.forEach(doc => {
      const userData = doc.data();
      users.push({
        uid: doc.id,
        email: userData.email || '',
        subscription: userData.subscription || { plan: 'free' },
        usage: userData.usage || {},
        bonusUses: userData.bonusUses || {},  // Include bonus uses for display
        isAdmin: userData.isAdmin || false,
        createdAt: userData.createdAt?.toDate?.()?.toISOString() || null,
        lastLoginAt: userData.lastLoginAt?.toDate?.()?.toISOString() || null
      });
    });

    return { success: true, users, count: users.length };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to fetch users. Please try again.'));
  }
});

exports.adminUpdateUserPlan = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);
    const { userId, plan, newPlan } = data || {};
    const targetPlan = plan || newPlan; // Accept both 'plan' and 'newPlan'

    if (!userId) throw new functions.https.HttpsError('invalid-argument', 'User ID required');
    if (!targetPlan) throw new functions.https.HttpsError('invalid-argument', 'Plan required');

    const planDoc = await db.collection('subscriptionPlans').doc(targetPlan).get();
    if (!planDoc.exists) throw new functions.https.HttpsError('invalid-argument', 'Invalid plan: ' + targetPlan);

    const planLimits = planDoc.data().limits;
    await db.collection('users').doc(userId).update({
      'subscription.plan': targetPlan,
      'subscription.startDate': admin.firestore.FieldValue.serverTimestamp(),
      'usage.warpOptimizer.limit': planLimits.warpOptimizer.dailyLimit,
      'usage.warpOptimizer.usedToday': 0,
      'usage.warpOptimizer.cooldownUntil': null,
      'usage.competitorAnalysis.limit': planLimits.competitorAnalysis.dailyLimit,
      'usage.competitorAnalysis.usedToday': 0,
      'usage.trendPredictor.limit': planLimits.trendPredictor.dailyLimit,
      'usage.trendPredictor.usedToday': 0,
      'usage.thumbnailGenerator.limit': planLimits.thumbnailGenerator.dailyLimit,
      'usage.thumbnailGenerator.usedToday': 0
    });

    await logUsage(userId, 'plan_changed_by_admin', { plan: targetPlan, changedBy: context.auth.uid });
    return { success: true, message: 'User plan updated to ' + targetPlan };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to update user plan. Please try again.'));
  }
});

exports.adminSetCustomLimits = functions.https.onCall(async (data, context) => {
  const adminUid = await requireAdmin(context);

  const { userId, tool, limit, cooldownHours } = data || {};

  // SECURITY FIX: Validate all inputs
  if (!userId || typeof userId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Valid user ID is required');
  }

  if (!tool || typeof tool !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'Tool name is required');
  }

  // Validate tool is one of the allowed values to prevent field injection
  const validTools = ['warpOptimizer', 'competitorAnalysis', 'trendPredictor', 'thumbnailGenerator'];
  if (!validTools.includes(tool)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      `Invalid tool: ${tool}. Must be one of: ${validTools.join(', ')}`
    );
  }

  // Validate limit is a positive number
  const safeLimit = parseInt(limit);
  if (isNaN(safeLimit) || safeLimit < 0 || safeLimit > 10000) {
    throw new functions.https.HttpsError('invalid-argument', 'Limit must be a number between 0 and 10000');
  }

  // Validate cooldownHours is a non-negative number
  const safeCooldown = parseInt(cooldownHours) || 0;
  if (safeCooldown < 0 || safeCooldown > 720) {
    throw new functions.https.HttpsError('invalid-argument', 'Cooldown hours must be between 0 and 720');
  }

  // Verify user exists
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  await db.collection('users').doc(userId).update({
    [`usage.${tool}.limit`]: safeLimit,
    [`customLimits.${tool}`]: { limit: safeLimit, cooldownHours: safeCooldown }
  });

  await logUsage(userId, 'custom_limits_set', {
    tool,
    limit: safeLimit,
    cooldownHours: safeCooldown,
    setBy: adminUid
  });

  return { success: true, message: `Custom limits set for ${tool}` };
});

// ==============================================
// QUOTA SETTINGS (Admin)
// ==============================================

exports.adminGetQuotaSettings = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const settingsDoc = await db.collection('settings').doc('quotaSettings').get();
    if (!settingsDoc.exists) {
      // Return defaults
      return {
        success: true,
        settings: {
          resetTimeMinutes: 1440 // 24 hours default
        }
      };
    }
    return {
      success: true,
      settings: settingsDoc.data()
    };
  } catch (error) {
    console.error('adminGetQuotaSettings error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to get quota settings. Please try again.'));
  }
});

exports.adminSetQuotaSettings = functions.https.onCall(async (data, context) => {
  // SECURITY: Don't log full request data - only log safe operation info

  try {
    // Verify admin status
    const adminId = await requireAdmin(context);

    const { resetTimeMinutes } = data || {};

    if (!resetTimeMinutes || resetTimeMinutes < 1) {
      throw new functions.https.HttpsError('invalid-argument', 'Reset time must be at least 1 minute');
    }

    const resetValue = parseInt(resetTimeMinutes);

    await db.collection('settings').doc('quotaSettings').set({
      resetTimeMinutes: resetValue,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: context.auth.uid
    }, { merge: true });

    console.log('Quota settings updated by admin:', adminId.substring(0, 8) + '...');

    return {
      success: true,
      message: `Quota reset time set to ${resetValue} minutes`
    };
  } catch (error) {
    console.error('adminSetQuotaSettings error:', error);
    console.error('Error stack:', error.stack);

    if (error instanceof functions.https.HttpsError) {
      throw error;
    }

    // Provide more specific error message
    let errorMessage = 'Failed to update quota settings';
    if (error.code === 'permission-denied' || error.message?.includes('permission')) {
      errorMessage = 'Permission denied. Check Firestore security rules for "settings" collection.';
    } else if (error.message) {
      errorMessage = error.message;
    }

    throw new functions.https.HttpsError('internal', errorMessage);
  }
});

exports.adminGrantBonusUses = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const { userId, tool, bonusAmount } = data || {};

    if (!userId) throw new functions.https.HttpsError('invalid-argument', 'User ID required');
    if (!tool) throw new functions.https.HttpsError('invalid-argument', 'Tool name required');
    if (!bonusAmount || bonusAmount < 1) throw new functions.https.HttpsError('invalid-argument', 'Bonus amount must be at least 1');

    const validTools = ['warpOptimizer', 'competitorAnalysis', 'trendPredictor', 'thumbnailGenerator'];
    if (!validTools.includes(tool)) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid tool: ' + tool);
    }

    // Check if user exists
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User not found');
    }

    const userData = userDoc.data();
    const currentBonus = userData.bonusUses?.[tool] || 0;
    const newBonus = currentBonus + parseInt(bonusAmount);

    // Use set with merge to ensure bonusUses map exists
    await db.collection('users').doc(userId).set({
      bonusUses: {
        [tool]: newBonus
      }
    }, { merge: true });

    // Log this action
    await logUsage(userId, 'bonus_uses_granted', {
      tool,
      amount: bonusAmount,
      grantedBy: context.auth.uid
    });

    return {
      success: true,
      message: `Granted ${bonusAmount} bonus uses for ${tool} to user`,
      newTotal: newBonus
    };
  } catch (error) {
    console.error('adminGrantBonusUses error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to grant bonus uses. Please try again.'));
  }
});

// Initialize/Update subscription plans with correct limits
exports.adminInitPlans = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const plans = {
      free: {
        name: 'Free',
        price: 0,
        limits: {
          warpOptimizer: { dailyLimit: 3, cooldownHours: 0 },
          competitorAnalysis: { dailyLimit: 3, cooldownHours: 0 },
          trendPredictor: { dailyLimit: 3, cooldownHours: 0 },
          thumbnailGenerator: { dailyLimit: 3, cooldownHours: 0 }
        }
      },
      lite: {
        name: 'Lite',
        price: 9.99,
        limits: {
          warpOptimizer: { dailyLimit: 5, cooldownHours: 0 },
          competitorAnalysis: { dailyLimit: 5, cooldownHours: 0 },
          trendPredictor: { dailyLimit: 5, cooldownHours: 0 },
          thumbnailGenerator: { dailyLimit: 5, cooldownHours: 0 }
        }
      },
      pro: {
        name: 'Pro',
        price: 19.99,
        limits: {
          warpOptimizer: { dailyLimit: 10, cooldownHours: 0 },
          competitorAnalysis: { dailyLimit: 10, cooldownHours: 0 },
          trendPredictor: { dailyLimit: 10, cooldownHours: 0 },
          thumbnailGenerator: { dailyLimit: 10, cooldownHours: 0 }
        }
      },
      enterprise: {
        name: 'Enterprise',
        price: 49.99,
        limits: {
          warpOptimizer: { dailyLimit: 50, cooldownHours: 0 },
          competitorAnalysis: { dailyLimit: 50, cooldownHours: 0 },
          trendPredictor: { dailyLimit: 50, cooldownHours: 0 },
          thumbnailGenerator: { dailyLimit: 50, cooldownHours: 0 }
        }
      }
    };

    const batch = db.batch();

    for (const [planId, planData] of Object.entries(plans)) {
      const planRef = db.collection('subscriptionPlans').doc(planId);
      batch.set(planRef, planData, { merge: true });
    }

    await batch.commit();

    return {
      success: true,
      message: 'Subscription plans initialized/updated successfully',
      plans: Object.keys(plans)
    };
  } catch (error) {
    console.error('adminInitPlans error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to initialize plans. Please try again.'));
  }
});

exports.adminGetAnalytics = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const usersSnapshot = await db.collection('users').get();
  const totalUsers = usersSnapshot.size;
  
  const usageSnapshot = await db.collection('usageLogs')
    .where('timestamp', '>=', admin.firestore.Timestamp.fromDate(today))
    .get();
  const todayUsage = usageSnapshot.size;
  
  const planCounts = {};
  usersSnapshot.forEach(doc => {
    const plan = doc.data().subscription.plan;
    planCounts[plan] = (planCounts[plan] || 0) + 1;
  });
  
  return { success: true, analytics: { totalUsers, todayUsage, planCounts } };
});

// ==============================================
// SUBSCRIPTION MANAGEMENT
// ==============================================

exports.getSubscriptionPlans = functions.https.onCall(async (data, context) => {
  const snapshot = await db.collection('subscriptionPlans')
    .where('isActive', '==', true)
    .orderBy('sortOrder')
    .get();
  
  const plans = [];
  snapshot.forEach(doc => {
    plans.push({ id: doc.id, ...doc.data() });
  });
  
  return { success: true, plans };
});

// ==============================================
// ADS TOOL (LEGACY - NOW SECURED WITH AUTH)
// ==============================================

exports.analyzeVideo = functions.https.onCall(async (data, context) => {
  // SECURITY FIX: Require authentication
  const uid = await verifyAuth(context);

  try {
    const { videoUrl } = data;
    if (!videoUrl) {
      throw new functions.https.HttpsError('invalid-argument', 'Video URL is required');
    }

    const videoId = extractVideoId(videoUrl);
    const metadata = await getVideoMetadata(videoId);
    const transcript = await getVideoTranscript(videoId);

    const analysisPrompt = `Analyze for advertising: ${metadata.title}

Provide:
1. Target audience
2. 30 keywords
3. Competitor suggestions
4. Budget recommendations
5. Campaign strategy`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Analyze YouTube videos for ads.' },
        { role: 'user', content: analysisPrompt }
      ],
      temperature: 0.7,
      max_tokens: 2000
    });

    await logUsage(uid, 'analyze_video_legacy', { videoId });

    return {
      success: true,
      videoData: metadata,
      analysis: completion.choices[0].message.content,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Analysis failed. Please try again.');
  }
});

exports.generateComments = functions.https.onCall(async (data, context) => {
  // SECURITY FIX: Require authentication
  const uid = await verifyAuth(context);

  try {
    const { videoUrl, count = 50 } = data;
    if (!videoUrl) {
      throw new functions.https.HttpsError('invalid-argument', 'Video URL is required');
    }
    // Limit count to prevent abuse
    const safeCount = Math.min(Math.max(1, count), 100);

    const videoId = extractVideoId(videoUrl);
    const metadata = await getVideoMetadata(videoId);
    const transcript = await getVideoTranscript(videoId);

    const commentsPrompt = `Generate ${safeCount} YouTube comments.

Video: ${metadata.title}
Transcript: ${transcript.fullText.substring(0, 2000)}

6 personas: Analyzer, Storyteller, Question Asker, Emotional, Expert, Casual

30%+ MUST be 115-125 chars
Return JSON array: [{text, persona, length}]`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Generate natural YouTube comments.' },
        { role: 'user', content: commentsPrompt }
      ],
      temperature: 0.95,
      max_tokens: 3000
    });

    const responseText = completion.choices[0].message.content.trim();
    const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const comments = JSON.parse(cleanJson);

    await logUsage(uid, 'generate_comments_legacy', { videoId, count: safeCount });

    return {
      success: true,
      comments,
      videoData: metadata,
      count: comments.length,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Comment generation failed. Please try again.');
  }
});

exports.optimizeCampaign = functions.https.onCall(async (data, context) => {
  // SECURITY FIX: Require authentication
  const uid = await verifyAuth(context);

  try {
    const { videoUrl, budget, targetAudience } = data;
    if (!videoUrl) {
      throw new functions.https.HttpsError('invalid-argument', 'Video URL is required');
    }

    const videoId = extractVideoId(videoUrl);
    const metadata = await getVideoMetadata(videoId);

    const campaignPrompt = `Create campaign strategy.
Video: ${metadata.title}
Budget: $${budget || 'Not specified'}
Target: ${targetAudience || 'General audience'}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Create YouTube ad campaign strategies.' },
        { role: 'user', content: campaignPrompt }
      ],
      temperature: 0.7,
      max_tokens: 2000
    });

    await logUsage(uid, 'optimize_campaign_legacy', { videoId });

    return {
      success: true,
      strategy: completion.choices[0].message.content,
      videoData: metadata,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Campaign optimization failed. Please try again.');
  }
});

exports.saveAnalysis = functions.https.onCall(async (data, context) => {
  // SECURITY FIX: Require authentication and track ownership
  const uid = await verifyAuth(context);

  const { videoUrl, analysis, comments } = data;
  if (!videoUrl || !analysis) {
    throw new functions.https.HttpsError('invalid-argument', 'Video URL and analysis are required');
  }

  const docRef = await db.collection('analyses').add({
    userId: uid,  // SECURITY FIX: Track ownership
    videoUrl,
    analysis,
    comments: comments || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await logUsage(uid, 'save_analysis_legacy', { analysisId: docRef.id });

  return { success: true, id: docRef.id };
});

exports.analyzeCompetitors = functions.https.onCall(async (data, context) => {
  // SECURITY FIX: Require authentication
  const uid = await verifyAuth(context);

  try {
    const { channelName } = data;
    if (!channelName) {
      throw new functions.https.HttpsError('invalid-argument', 'Channel name is required');
    }

    const searchResponse = await youtube.search.list({
      part: ['snippet'],
      q: channelName,
      type: ['channel'],
      maxResults: 1
    });

    if (!searchResponse.data.items || searchResponse.data.items.length === 0) {
      throw new functions.https.HttpsError('not-found', 'Channel not found');
    }

    const channelId = searchResponse.data.items[0].snippet.channelId;
    const videosResponse = await youtube.search.list({
      part: ['snippet'],
      channelId: channelId,
      order: 'viewCount',
      maxResults: 10,
      type: ['video']
    });

    const videos = videosResponse.data.items.map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      publishedAt: item.snippet.publishedAt,
      thumbnail: item.snippet.thumbnails.medium.url
    }));

    await logUsage(uid, 'analyze_competitors_legacy', { channelName, channelId });

    return { success: true, channelId, videos, count: videos.length };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Competitor analysis failed. Please try again.');
  }
});

exports.searchHistory = functions.https.onCall(async (data, context) => {
  // SECURITY FIX: Require authentication and only return user's own data
  const uid = await verifyAuth(context);

  const { limit = 10 } = data || {};
  // Limit the maximum to prevent abuse
  const safeLimit = Math.min(Math.max(1, limit), 50);

  const snapshot = await db.collection('analyses')
    .where('userId', '==', uid)  // SECURITY FIX: Only return user's own analyses
    .orderBy('createdAt', 'desc')
    .limit(safeLimit)
    .get();

  const results = [];
  snapshot.forEach(doc => {
    results.push({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate().toISOString()
    });
  });

  return { success: true, results, count: results.length };
});

exports.deleteAnalysis = functions.https.onCall(async (data, context) => {
  // SECURITY FIX: Require authentication and verify ownership
  const uid = await verifyAuth(context);

  const { id } = data || {};
  if (!id) {
    throw new functions.https.HttpsError('invalid-argument', 'Analysis ID is required');
  }

  // SECURITY FIX: Check ownership before deleting
  const doc = await db.collection('analyses').doc(id).get();

  if (!doc.exists) {
    throw new functions.https.HttpsError('not-found', 'Analysis not found');
  }

  const docData = doc.data();

  // Allow deletion if user owns the record OR if it's a legacy record without userId (admin can delete)
  // For legacy records without userId, check if user is admin
  if (docData.userId && docData.userId !== uid) {
    // Has userId but doesn't match - check if admin
    const isUserAdmin = await isAdmin(uid);
    if (!isUserAdmin) {
      throw new functions.https.HttpsError('permission-denied', 'You can only delete your own analyses');
    }
  } else if (!docData.userId) {
    // Legacy record without userId - only admins can delete
    const isUserAdmin = await isAdmin(uid);
    if (!isUserAdmin) {
      throw new functions.https.HttpsError('permission-denied', 'Legacy analyses can only be deleted by administrators');
    }
  }

  await db.collection('analyses').doc(id).delete();
  await logUsage(uid, 'delete_analysis_legacy', { analysisId: id });

  return { success: true };
});

// ==============================================
// OPTIMIZATION HISTORY
// ==============================================

exports.getOptimizationHistory = functions.https.onCall(async (data, context) => {
  // Verify authentication
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'User must be authenticated to view history'
    );
  }

  const userId = context.auth.uid;

  // Helper function to sanitize any value to plain JSON
  const sanitize = (obj) => {
    if (obj === null || obj === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (e) {
      return null;
    }
  };

  // Helper to safely get timestamp as number
  const getTimestamp = (field) => {
    if (!field) return Date.now();
    if (typeof field === 'number') return field;
    if (typeof field.toMillis === 'function') return field.toMillis();
    if (field._seconds) return field._seconds * 1000;
    if (field instanceof Date) return field.getTime();
    return Date.now();
  };

  try {
    // Simple query without orderBy to avoid index issues
    const snapshot = await db.collection('optimizations')
      .where('userId', '==', userId)
      .limit(50)
      .get();

    const history = [];

    snapshot.forEach(doc => {
      try {
        const docData = doc.data();

        // Extract and sanitize each field individually
        const item = {
          id: String(doc.id),
          videoUrl: String(docData.videoUrl || ''),
          videoInfo: sanitize(docData.videoInfo),
          titles: Array.isArray(docData.titles) ? docData.titles.map(t => String(t)) : [],
          description: String(docData.description || ''),
          tags: Array.isArray(docData.tags) ? docData.tags.map(t => String(t)) : [],
          seoAnalysis: sanitize(docData.seoAnalysis),
          timestamp: getTimestamp(docData.createdAt)
        };

        history.push(item);
      } catch (docError) {
        console.error('Error processing doc:', doc.id, docError);
      }
    });

    // Sort by timestamp descending
    history.sort((a, b) => b.timestamp - a.timestamp);

    return {
      success: true,
      history: history,
      count: history.length
    };

  } catch (error) {
    console.error('Error fetching optimization history:', error);
    return {
      success: true,
      history: [],
      count: 0
    };
  }
});

// ==============================================
// BONUS HISTORY
// ==============================================

exports.getBonusHistory = functions.https.onCall(async (data, context) => {
  // Verify authentication
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'User must be authenticated to view bonus history'
    );
  }

  const userId = context.auth.uid;

  // Helper to safely get timestamp as number
  const getTimestamp = (field) => {
    if (!field) return Date.now();
    if (typeof field === 'number') return field;
    if (typeof field.toMillis === 'function') return field.toMillis();
    if (field._seconds) return field._seconds * 1000;
    if (field instanceof Date) return field.getTime();
    return Date.now();
  };

  try {
    // Query usageLogs for bonus_uses_granted actions for this user
    const snapshot = await db.collection('usageLogs')
      .where('userId', '==', userId)
      .where('action', '==', 'bonus_uses_granted')
      .limit(50)
      .get();

    const history = [];

    snapshot.forEach(doc => {
      try {
        const docData = doc.data();
        const metadata = docData.metadata || {};

        history.push({
          id: String(doc.id),
          tool: String(metadata.tool || 'unknown'),
          amount: parseInt(metadata.amount) || 0,
          grantedBy: String(metadata.grantedBy || 'admin'),
          timestamp: getTimestamp(docData.timestamp)
        });
      } catch (docError) {
        console.error('Error processing bonus log:', doc.id, docError);
      }
    });

    // Sort by timestamp descending (most recent first)
    history.sort((a, b) => b.timestamp - a.timestamp);

    return {
      success: true,
      history: history,
      count: history.length
    };

  } catch (error) {
    console.error('Error fetching bonus history:', error);
    return {
      success: true,
      history: [],
      count: 0
    };
  }
});

// ==============================================
// SETUP ADMIN USER (One-time setup - ONLY when no admins exist)
// ==============================================

exports.setupAdmin = functions.https.onCall(async (data, context) => {
  // Must be authenticated
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'You must be logged in to set up admin access'
    );
  }

  const userId = context.auth.uid;
  const userEmail = context.auth.token.email;

  try {
    // Check if user is already admin
    const adminDoc = await db.collection('adminUsers')
      .doc(userId)
      .get();

    if (adminDoc.exists) {
      return {
        success: true,
        message: 'You are already an admin!',
        email: userEmail
      };
    }

    // SECURITY FIX: Check if ANY admins exist in the system
    // If admins exist, this endpoint cannot be used for self-promotion
    const existingAdmins = await db.collection('adminUsers').limit(1).get();

    if (!existingAdmins.empty) {
      // Admins already exist - reject self-promotion attempt
      console.warn(`Security: User ${userEmail} (${userId}) attempted unauthorized admin setup`);
      throw new functions.https.HttpsError(
        'permission-denied',
        'Admin access can only be granted by an existing administrator. Please contact your system administrator.'
      );
    }

    // No admins exist - this is first-time setup, allow it
    console.log(`First-time admin setup by ${userEmail}`);

    await db.collection('adminUsers')
      .doc(userId)
      .set({
        uid: userId,
        email: userEmail,
        isAdmin: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: 'first-time-setup'
      });

    // Also update user profile
    await db.collection('users')
      .doc(userId)
      .update({
        isAdmin: true
      });

    await logUsage(userId, 'first_admin_setup', { email: userEmail });

    return {
      success: true,
      message: 'You are now the first admin! Additional admins must be added through the admin panel.',
      email: userEmail,
      userId: userId
    };

  } catch (error) {
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    console.error('Error setting up admin:', error);
    throw new functions.https.HttpsError(
      'internal',
      'Failed to set up admin access'
    );
  }
});

// ==============================================
// FIX USER PROFILE (Diagnostic Tool)
// ==============================================

exports.fixUserProfile = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const userId = context.auth.uid;
  const userEmail = context.auth.token.email;

  try {
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      console.log(`Creating user profile for ${userEmail}`);
      
      const settingsDoc = await db.collection('adminSettings').doc('config').get();
      const defaultPlan = settingsDoc.exists ? settingsDoc.data()?.defaultPlan || 'free' : 'free';
      
      const planDoc = await db.collection('subscriptionPlans').doc(defaultPlan).get();
      const planLimits = planDoc.exists ? planDoc.data().limits : {
        warpOptimizer: { dailyLimit: 5 },
        competitorAnalysis: { dailyLimit: 5 },
        trendPredictor: { dailyLimit: 5 },
        thumbnailGenerator: { dailyLimit: 5 }
      };

      await db.collection('users').doc(userId).set({
        uid: userId,
        email: userEmail,
        displayName: context.auth.token.name || '',
        photoURL: context.auth.token.picture || '',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
        isActive: true,
        isAdmin: false,
        subscription: {
          plan: defaultPlan,
          status: 'active',
          startDate: admin.firestore.FieldValue.serverTimestamp(),
          endDate: null,
          autoRenew: false
        },
        usage: {
          warpOptimizer: {
            usedToday: 0,
            usedTotal: 0,
            limit: planLimits.warpOptimizer.dailyLimit,
            lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
            cooldownUntil: null
          },
          competitorAnalysis: {
            usedToday: 0,
            usedTotal: 0,
            limit: planLimits.competitorAnalysis.dailyLimit,
            lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
            cooldownUntil: null
          },
          trendPredictor: {
            usedToday: 0,
            usedTotal: 0,
            limit: planLimits.trendPredictor.dailyLimit,
            lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
            cooldownUntil: null
          },
          thumbnailGenerator: {
            usedToday: 0,
            usedTotal: 0,
            limit: planLimits.thumbnailGenerator.dailyLimit,
            lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
            cooldownUntil: null
          }
        },
        notes: '',
        customLimits: {}
      });

      return {
        success: true,
        action: 'created',
        message: 'User profile created successfully!',
        userId: userId,
        email: userEmail
      };
    }

    const userData = userDoc.data();
    let needsUpdate = false;
    const updates = {};

    if (!userData.usage || !userData.usage.warpOptimizer) {
      needsUpdate = true;

      const planDoc = await db.collection('subscriptionPlans').doc(userData.subscription?.plan || 'free').get();
      const planLimits = planDoc.exists ? planDoc.data().limits : {
        warpOptimizer: { dailyLimit: 5 },
        competitorAnalysis: { dailyLimit: 5 },
        trendPredictor: { dailyLimit: 5 },
        thumbnailGenerator: { dailyLimit: 5 }
      };

      updates.usage = {
        warpOptimizer: {
          usedToday: 0,
          usedTotal: 0,
          limit: planLimits.warpOptimizer.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        competitorAnalysis: {
          usedToday: 0,
          usedTotal: 0,
          limit: planLimits.competitorAnalysis.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        trendPredictor: {
          usedToday: 0,
          usedTotal: 0,
          limit: planLimits.trendPredictor.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        thumbnailGenerator: {
          usedToday: 0,
          usedTotal: 0,
          limit: planLimits.thumbnailGenerator.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        }
      };
    }

    if (needsUpdate) {
      await db.collection('users').doc(userId).update(updates);
      return {
        success: true,
        action: 'updated',
        message: 'User profile updated with usage structure!',
        userId: userId,
        email: userEmail
      };
    }

    return {
      success: true,
      action: 'verified',
      message: 'User profile is correct!',
      userId: userId,
      email: userEmail,
      usage: userData.usage
    };

  } catch (error) {
    console.error('Error fixing user profile:', error);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to fix user profile. Please try again.'));
  }
});

// ==============================================
// NEW FEATURE: COMPETITOR ANALYSIS
// ==============================================

exports.analyzeCompetitor = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'analyzeCompetitor', 10);
  await checkUsageLimit(uid, 'competitorAnalysis');

  const { videoUrl } = data;
  if (!videoUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Video URL is required');
  }

  try {
    const videoId = extractVideoId(videoUrl);

    // Get competitor video data
    const videoResponse = await youtube.videos.list({
      part: 'snippet,statistics,contentDetails',
      id: videoId
    });

    if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
      throw new functions.https.HttpsError('not-found', 'Competitor video not found');
    }

    const video = videoResponse.data.items[0];
    const snippet = video.snippet;
    const stats = video.statistics;

    // Get channel data
    const channelResponse = await youtube.channels.list({
      part: 'snippet,statistics',
      id: snippet.channelId
    });

    const channel = channelResponse.data.items?.[0];

    // Analyze with AI
    const analysisPrompt = `You are a YouTube SEO expert. Analyze this competitor's video and provide actionable insights to BEAT their performance.

COMPETITOR VIDEO DATA:
- Title: ${snippet.title}
- Description: ${snippet.description?.substring(0, 500) || 'No description'}
- Tags: ${snippet.tags?.join(', ') || 'No visible tags'}
- Views: ${parseInt(stats.viewCount || 0).toLocaleString()}
- Likes: ${parseInt(stats.likeCount || 0).toLocaleString()}
- Comments: ${parseInt(stats.commentCount || 0).toLocaleString()}
- Channel: ${snippet.channelTitle}
- Channel Subscribers: ${channel?.statistics?.subscriberCount ? parseInt(channel.statistics.subscriberCount).toLocaleString() : 'Hidden'}
- Published: ${snippet.publishedAt}

Provide your analysis in this EXACT JSON format:
{
  "seoScore": <number 0-100>,
  "strengths": ["strength1", "strength2", "strength3"],
  "weaknesses": ["weakness1", "weakness2", "weakness3"],
  "opportunities": ["opportunity1", "opportunity2", "opportunity3"],
  "betterTitles": ["title1", "title2", "title3"],
  "betterTags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "contentGaps": ["gap1", "gap2"],
  "engagementTips": ["tip1", "tip2", "tip3"],
  "estimatedDifficulty": "<easy|medium|hard>",
  "summary": "2-3 sentence summary of how to beat this competitor"
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: analysisPrompt }],
      temperature: 0.7,
      max_tokens: 1500
    });

    let analysis;
    try {
      const responseText = aiResponse.choices[0].message.content.trim();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (e) {
      analysis = {
        seoScore: 70,
        strengths: ['Unable to parse full analysis'],
        weaknesses: [],
        opportunities: [],
        betterTitles: [],
        betterTags: [],
        contentGaps: [],
        engagementTips: [],
        estimatedDifficulty: 'medium',
        summary: aiResponse.choices[0].message.content
      };
    }

    await incrementUsage(uid, 'competitorAnalysis');
    await logUsage(uid, 'competitor_analysis', { videoId, competitorChannel: snippet.channelTitle });

    return {
      success: true,
      competitor: {
        videoId,
        title: snippet.title,
        channelTitle: snippet.channelTitle,
        channelId: snippet.channelId,
        thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url,
        viewCount: parseInt(stats.viewCount || 0),
        likeCount: parseInt(stats.likeCount || 0),
        commentCount: parseInt(stats.commentCount || 0),
        publishedAt: snippet.publishedAt,
        tags: snippet.tags || [],
        channelSubscribers: channel?.statistics?.subscriberCount ? parseInt(channel.statistics.subscriberCount) : null
      },
      analysis
    };

  } catch (error) {
    console.error('Competitor analysis error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Competitor analysis failed. Please try again.'));
  }
});

// ==============================================
// NEW FEATURE: TREND PREDICTOR
// ==============================================

exports.predictTrends = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'predictTrends', 10);
  await checkUsageLimit(uid, 'trendPredictor');

  const { niche, country = 'US' } = data;
  if (!niche) {
    throw new functions.https.HttpsError('invalid-argument', 'Niche/topic is required');
  }

  try {
    // Get trending videos in the niche
    const searchResponse = await youtube.search.list({
      part: 'snippet',
      q: niche,
      type: 'video',
      order: 'viewCount',
      publishedAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // Last 7 days
      maxResults: 15,
      regionCode: country
    });

    const trendingVideos = searchResponse.data.items || [];

    // Get video statistics
    const videoIds = trendingVideos.map(v => v.id.videoId).filter(Boolean);
    let videoStats = [];

    if (videoIds.length > 0) {
      const statsResponse = await youtube.videos.list({
        part: 'statistics,snippet',
        id: videoIds.join(',')
      });
      videoStats = statsResponse.data.items || [];
    }

    // Prepare data for AI analysis
    const trendData = videoStats.map(v => ({
      title: v.snippet.title,
      views: parseInt(v.statistics.viewCount || 0),
      likes: parseInt(v.statistics.likeCount || 0),
      channel: v.snippet.channelTitle,
      published: v.snippet.publishedAt
    }));

    const trendPrompt = `You are a YouTube trend analyst and viral content predictor. Based on this recent trending data in the "${niche}" niche, predict upcoming trends.

RECENT TRENDING VIDEOS (last 7 days):
${trendData.map((v, i) => `${i+1}. "${v.title}" - ${v.views.toLocaleString()} views by ${v.channel}`).join('\n')}

Analyze patterns and predict what will trend next. Provide in this EXACT JSON format:
{
  "currentTrends": [
    {"topic": "topic1", "description": "why it's trending", "growthRate": "rising|stable|declining"},
    {"topic": "topic2", "description": "why it's trending", "growthRate": "rising|stable|declining"},
    {"topic": "topic3", "description": "why it's trending", "growthRate": "rising|stable|declining"}
  ],
  "predictedTrends": [
    {"topic": "predicted1", "reasoning": "why this will trend", "confidence": "high|medium|low", "timeframe": "1-2 weeks|2-4 weeks|1-2 months"},
    {"topic": "predicted2", "reasoning": "why this will trend", "confidence": "high|medium|low", "timeframe": "1-2 weeks|2-4 weeks|1-2 months"},
    {"topic": "predicted3", "reasoning": "why this will trend", "confidence": "high|medium|low", "timeframe": "1-2 weeks|2-4 weeks|1-2 months"}
  ],
  "videoIdeas": [
    {"title": "Suggested video title 1", "description": "Brief description of content", "estimatedViews": "10K-50K|50K-100K|100K-500K|500K+"},
    {"title": "Suggested video title 2", "description": "Brief description of content", "estimatedViews": "10K-50K|50K-100K|100K-500K|500K+"},
    {"title": "Suggested video title 3", "description": "Brief description of content", "estimatedViews": "10K-50K|50K-100K|100K-500K|500K+"},
    {"title": "Suggested video title 4", "description": "Brief description of content", "estimatedViews": "10K-50K|50K-100K|100K-500K|500K+"},
    {"title": "Suggested video title 5", "description": "Brief description of content", "estimatedViews": "10K-50K|50K-100K|100K-500K|500K+"}
  ],
  "bestUploadTimes": ["Day time1", "Day time2", "Day time3"],
  "hashtagsToUse": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
  "summary": "2-3 sentence summary of the trend landscape in this niche"
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: trendPrompt }],
      temperature: 0.8,
      max_tokens: 2000
    });

    let predictions;
    try {
      const responseText = aiResponse.choices[0].message.content.trim();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      predictions = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (e) {
      predictions = {
        currentTrends: [],
        predictedTrends: [],
        videoIdeas: [],
        bestUploadTimes: [],
        hashtagsToUse: [],
        summary: aiResponse.choices[0].message.content
      };
    }

    await incrementUsage(uid, 'trendPredictor');
    await logUsage(uid, 'trend_prediction', { niche, country });

    return {
      success: true,
      niche,
      country,
      analyzedVideos: trendData.length,
      topPerformers: trendData.slice(0, 5),
      predictions
    };

  } catch (error) {
    console.error('Trend prediction error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Trend prediction failed. Please try again.'));
  }
});

// ==============================================
// NEW FEATURE: AI THUMBNAIL GENERATOR (RunPod)
// ==============================================

exports.generateThumbnail = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'generateThumbnail', 3); // Lower limit for expensive AI operation
  await checkUsageLimit(uid, 'thumbnailGenerator');

  const { title, style = 'youtube_thumbnail', customPrompt } = data;
  if (!title) {
    throw new functions.https.HttpsError('invalid-argument', 'Video title is required');
  }

  const runpodKey = functions.config().runpod?.key;
  if (!runpodKey) {
    throw new functions.https.HttpsError('failed-precondition', 'RunPod API key not configured. Please set it with: firebase functions:config:set runpod.key="YOUR_KEY"');
  }

  try {
    // Generate optimized prompt for thumbnail using OpenAI
    let imagePrompt;
    try {
      const promptGeneratorResponse = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{
          role: 'user',
          content: `Create a detailed image generation prompt for a YouTube thumbnail. The video title is: "${title}"

Style guidelines:
- Eye-catching and click-worthy
- Bold colors and high contrast
- Professional YouTube thumbnail aesthetic
- Should include relevant visual elements
- Text overlay areas should be considered

${customPrompt ? `Additional requirements: ${customPrompt}` : ''}

Provide ONLY the image generation prompt, no explanations. Make it detailed and specific for best results.`
        }],
        temperature: 0.7,
        max_tokens: 300
      });

      imagePrompt = promptGeneratorResponse?.choices?.[0]?.message?.content?.trim();
    } catch (openaiError) {
      console.error('OpenAI prompt generation failed:', openaiError);
      // Fallback: create a direct prompt from title and style
      imagePrompt = `Professional YouTube thumbnail for video titled "${title}". ${customPrompt || 'Eye-catching, high contrast, vibrant colors, professional quality, 4K resolution, dramatic lighting.'}`;
    }

    // Validate imagePrompt is not empty
    if (!imagePrompt || imagePrompt.length < 10) {
      console.log('Generated empty or too short prompt, using fallback');
      imagePrompt = `Professional YouTube thumbnail for video titled "${title}". Eye-catching design with bold colors, high contrast, dramatic lighting, clean composition, suitable for YouTube, 4K quality.`;
    }

    console.log('Generated image prompt:', imagePrompt.substring(0, 100) + '...');
    const negativePrompt = "blurry, low quality, ugly, distorted, watermark, nsfw, text overlay";
    const seed = Math.floor(Math.random() * 999999999999);

    // Generate a signed URL for Firebase Storage upload
    // Use the configured default bucket (ytseo-6d1b0.firebasestorage.app)
    const fileName = `thumbnails/${uid}/${Date.now()}_${seed}.png`;
    const bucket = admin.storage().bucket();
    let uploadUrl;

    console.log('Using storage bucket:', bucket.name);

    try {
      const file = bucket.file(fileName);
      const [signedUrl] = await file.getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + 30 * 60 * 1000, // 30 minutes
        contentType: 'application/octet-stream',
      });
      uploadUrl = signedUrl;
      console.log('Successfully generated signed URL for bucket:', bucket.name);
    } catch (signError) {
      console.error(`Failed to generate signed URL:`, signError.message);
      if (signError.message.includes('iam.serviceAccounts.signBlob') ||
          signError.message.includes('Permission') ||
          signError.message.includes('denied')) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Firebase Storage permission not configured. Please grant "Service Account Token Creator" role to your Cloud Functions service account in Google Cloud Console > IAM.'
        );
      }
      throw new functions.https.HttpsError('internal', 'Failed to prepare storage: ' + signError.message);
    }

    const file = bucket.file(fileName);

    // Call RunPod API - HiDream text-to-image
    const runpodEndpoint = 'https://api.runpod.ai/v2/rgq0go2nkcfx4h/run';

    // Build input object with all required parameters
    const runpodInput = {
      positive_prompt: imagePrompt,
      negative_prompt: negativePrompt,
      width: 1280,
      height: 720,
      batch_size: 1,
      shift: 3.0,
      seed: seed,
      steps: 35,
      cfg: 5,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1,
      image_upload_url: uploadUrl
    };

    // SECURITY: Log sanitized request info only (no sensitive data)
    console.log('RunPod request:', {
      width: runpodInput.width,
      height: runpodInput.height,
      steps: runpodInput.steps,
      promptLength: runpodInput.positive_prompt?.length || 0
    });

    // Send request to RunPod
    let runpodResponse;
    try {
      runpodResponse = await axios.post(runpodEndpoint, {
        input: runpodInput
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${runpodKey}`
        },
        timeout: 30000
      });
    } catch (runpodError) {
      // SECURITY: Log error internally but return sanitized message
      console.error('RunPod API call failed:', runpodError.message);
      throw new functions.https.HttpsError(
        'internal',
        'Image generation service unavailable. Please try again later.'
      );
    }

    const jobId = runpodResponse.data.id;
    const status = runpodResponse.data.status;
    console.log('RunPod job started:', { jobId, status });

    // Generate public URL for the uploaded image using Firebase Storage download URL format
    // The .firebasestorage.app bucket format requires this specific URL structure
    const encodedFileName = encodeURIComponent(fileName);
    const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedFileName}?alt=media`;

    await incrementUsage(uid, 'thumbnailGenerator');
    await logUsage(uid, 'thumbnail_generation', { title, jobId, fileName });

    return {
      success: true,
      jobId,
      status,
      prompt: imagePrompt,
      imageUrl: publicUrl,
      fileName: fileName,
      message: 'Thumbnail generation started. Image will be available at imageUrl when complete.',
      checkEndpoint: `https://api.runpod.ai/v2/rgq0go2nkcfx4h/status/${jobId}`
    };

  } catch (error) {
    console.error('Thumbnail generation error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Thumbnail generation failed. Please try again.'));
  }
});

// Check thumbnail generation status
exports.checkThumbnailStatus = functions.https.onCall(async (data, context) => {
  await verifyAuth(context);

  const { jobId } = data;
  if (!jobId) {
    throw new functions.https.HttpsError('invalid-argument', 'Job ID is required');
  }

  const runpodKey = functions.config().runpod?.key;
  if (!runpodKey) {
    throw new functions.https.HttpsError('failed-precondition', 'RunPod API key not configured');
  }

  try {
    const statusResponse = await axios.get(
      `https://api.runpod.ai/v2/rgq0go2nkcfx4h/status/${jobId}`,
      {
        headers: {
          'Authorization': `Bearer ${runpodKey}`
        },
        timeout: 10000
      }
    );

    const result = statusResponse.data;

    return {
      success: true,
      jobId,
      status: result.status,
      output: result.output || null,
      error: result.error || null
    };

  } catch (error) {
    console.error('Check thumbnail status error:', error);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to check thumbnail status. Please try again.'));
  }
});
