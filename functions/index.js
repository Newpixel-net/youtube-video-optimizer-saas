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
    const planLimits = planDoc.data()?.limits || {};

    // Default limits for each tool (fallback if plan doesn't have new tool keys)
    const defaultToolLimit = 2;

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
          limit: planLimits.warpOptimizer?.dailyLimit || defaultToolLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        competitorAnalysis: {
          usedToday: 0,
          limit: planLimits.competitorAnalysis?.dailyLimit || defaultToolLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        trendPredictor: {
          usedToday: 0,
          limit: planLimits.trendPredictor?.dailyLimit || defaultToolLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        thumbnailGenerator: {
          usedToday: 0,
          limit: planLimits.thumbnailGenerator?.dailyLimit || defaultToolLimit,
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

    const planLimits = planDoc.data()?.limits || {};
    const defaultToolLimit = 2;

    // Create complete usage structures for all tools (ensures tools exist even if missing)
    await db.collection('users').doc(userId).update({
      'subscription.plan': targetPlan,
      'subscription.startDate': admin.firestore.FieldValue.serverTimestamp(),
      'usage.warpOptimizer': {
        usedToday: 0,
        limit: planLimits.warpOptimizer?.dailyLimit || defaultToolLimit,
        lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
        cooldownUntil: null
      },
      'usage.competitorAnalysis': {
        usedToday: 0,
        limit: planLimits.competitorAnalysis?.dailyLimit || defaultToolLimit,
        lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
        cooldownUntil: null
      },
      'usage.trendPredictor': {
        usedToday: 0,
        limit: planLimits.trendPredictor?.dailyLimit || defaultToolLimit,
        lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
        cooldownUntil: null
      },
      'usage.thumbnailGenerator': {
        usedToday: 0,
        limit: planLimits.thumbnailGenerator?.dailyLimit || defaultToolLimit,
        lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
        cooldownUntil: null
      }
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
      const planLimits = planDoc.exists ? (planDoc.data()?.limits || {}) : {};
      const defaultToolLimit = 2;

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
            limit: planLimits.warpOptimizer?.dailyLimit || defaultToolLimit,
            lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
            cooldownUntil: null
          },
          competitorAnalysis: {
            usedToday: 0,
            usedTotal: 0,
            limit: planLimits.competitorAnalysis?.dailyLimit || defaultToolLimit,
            lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
            cooldownUntil: null
          },
          trendPredictor: {
            usedToday: 0,
            usedTotal: 0,
            limit: planLimits.trendPredictor?.dailyLimit || defaultToolLimit,
            lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
            cooldownUntil: null
          },
          thumbnailGenerator: {
            usedToday: 0,
            usedTotal: 0,
            limit: planLimits.thumbnailGenerator?.dailyLimit || defaultToolLimit,
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
      const planLimits = planDoc.exists ? (planDoc.data()?.limits || {}) : {};
      const defaultToolLimit = 2;

      updates.usage = {
        warpOptimizer: {
          usedToday: 0,
          usedTotal: 0,
          limit: planLimits.warpOptimizer?.dailyLimit || defaultToolLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        competitorAnalysis: {
          usedToday: 0,
          usedTotal: 0,
          limit: planLimits.competitorAnalysis?.dailyLimit || defaultToolLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        trendPredictor: {
          usedToday: 0,
          usedTotal: 0,
          limit: planLimits.trendPredictor?.dailyLimit || defaultToolLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        thumbnailGenerator: {
          usedToday: 0,
          usedTotal: 0,
          limit: planLimits.thumbnailGenerator?.dailyLimit || defaultToolLimit,
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

    const competitorData = {
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
    };

    // Save to history
    const historyRef = await db.collection('competitorHistory').add({
      userId: uid,
      videoUrl,
      competitor: competitorData,
      analysis,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      historyId: historyRef.id,
      competitor: competitorData,
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

    // Save to history
    const historyRef = await db.collection('trendHistory').add({
      userId: uid,
      niche,
      country,
      analyzedVideos: trendData.length,
      topPerformers: trendData.slice(0, 5),
      predictions,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      historyId: historyRef.id,
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

    // Save to history
    const historyRef = await db.collection('thumbnailHistory').add({
      userId: uid,
      title,
      style: style || 'youtube_thumbnail',
      customPrompt: customPrompt || null,
      prompt: imagePrompt,
      jobId,
      status,
      imageUrl: publicUrl,
      fileName,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      historyId: historyRef.id,
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

// ==============================================
// HISTORY RETRIEVAL & MANAGEMENT FUNCTIONS
// ==============================================

// Get Competitor Analysis History
exports.getCompetitorHistory = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'getCompetitorHistory', 20);

  const { limit = 20, offset = 0 } = data || {};
  const safeLimit = Math.min(Math.max(1, parseInt(limit) || 20), 50);
  const safeOffset = Math.max(0, parseInt(offset) || 0);

  // Safe timestamp handler
  const getTs = (field) => {
    if (!field) return Date.now();
    if (typeof field === 'number') return field;
    if (typeof field.toMillis === 'function') return field.toMillis();
    if (field._seconds) return field._seconds * 1000;
    if (field instanceof Date) return field.getTime();
    return Date.now();
  };

  try {
    const snapshot = await db.collection('competitorHistory')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(safeLimit)
      .offset(safeOffset)
      .get();

    const history = [];
    snapshot.forEach(doc => {
      try {
        const docData = doc.data();
        const timestamp = getTs(docData.createdAt);
        const { createdAt, ...rest } = docData; // Exclude raw createdAt
        history.push({
          id: doc.id,
          ...rest,
          timestamp,
          createdAt: new Date(timestamp).toISOString()
        });
      } catch (e) {
        console.error('Error processing competitor doc:', doc.id, e);
      }
    });

    return { success: true, history, count: history.length };
  } catch (error) {
    console.error('Get competitor history error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to load history.');
  }
});

// Get Trend Predictor History
exports.getTrendHistory = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'getTrendHistory', 20);

  const { limit = 20, offset = 0 } = data || {};
  const safeLimit = Math.min(Math.max(1, parseInt(limit) || 20), 50);
  const safeOffset = Math.max(0, parseInt(offset) || 0);

  // Safe timestamp handler
  const getTs = (field) => {
    if (!field) return Date.now();
    if (typeof field === 'number') return field;
    if (typeof field.toMillis === 'function') return field.toMillis();
    if (field._seconds) return field._seconds * 1000;
    if (field instanceof Date) return field.getTime();
    return Date.now();
  };

  try {
    const snapshot = await db.collection('trendHistory')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(safeLimit)
      .offset(safeOffset)
      .get();

    const history = [];
    snapshot.forEach(doc => {
      try {
        const docData = doc.data();
        const timestamp = getTs(docData.createdAt);
        const { createdAt, ...rest } = docData; // Exclude raw createdAt
        history.push({
          id: doc.id,
          ...rest,
          timestamp,
          createdAt: new Date(timestamp).toISOString()
        });
      } catch (e) {
        console.error('Error processing trend doc:', doc.id, e);
      }
    });

    return { success: true, history, count: history.length };
  } catch (error) {
    console.error('Get trend history error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to load history.');
  }
});

// Get Thumbnail History
exports.getThumbnailHistory = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'getThumbnailHistory', 20);

  const { limit = 20, offset = 0 } = data || {};
  const safeLimit = Math.min(Math.max(1, parseInt(limit) || 20), 50);
  const safeOffset = Math.max(0, parseInt(offset) || 0);

  // Safe timestamp handler
  const getTs = (field) => {
    if (!field) return Date.now();
    if (typeof field === 'number') return field;
    if (typeof field.toMillis === 'function') return field.toMillis();
    if (field._seconds) return field._seconds * 1000;
    if (field instanceof Date) return field.getTime();
    return Date.now();
  };

  try {
    const snapshot = await db.collection('thumbnailHistory')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(safeLimit)
      .offset(safeOffset)
      .get();

    const history = [];
    snapshot.forEach(doc => {
      try {
        const docData = doc.data();
        const timestamp = getTs(docData.createdAt);
        const { createdAt, ...rest } = docData; // Exclude raw createdAt
        history.push({
          id: doc.id,
          ...rest,
          timestamp,
          createdAt: new Date(timestamp).toISOString()
        });
      } catch (e) {
        console.error('Error processing thumbnail doc:', doc.id, e);
      }
    });

    return { success: true, history, count: history.length };
  } catch (error) {
    console.error('Get thumbnail history error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to load history.');
  }
});

// Delete Competitor Analysis
exports.deleteCompetitorAnalysis = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  const { id } = data || {};
  if (!id) {
    throw new functions.https.HttpsError('invalid-argument', 'History ID is required');
  }

  try {
    const doc = await db.collection('competitorHistory').doc(id).get();
    if (!doc.exists || doc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized to delete this item');
    }

    await db.collection('competitorHistory').doc(id).delete();
    return { success: true, message: 'Analysis deleted successfully' };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Delete competitor analysis error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to delete analysis.');
  }
});

// Delete Trend Prediction
exports.deleteTrendPrediction = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  const { id } = data || {};
  if (!id) {
    throw new functions.https.HttpsError('invalid-argument', 'History ID is required');
  }

  try {
    const doc = await db.collection('trendHistory').doc(id).get();
    if (!doc.exists || doc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized to delete this item');
    }

    await db.collection('trendHistory').doc(id).delete();
    return { success: true, message: 'Prediction deleted successfully' };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Delete trend prediction error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to delete prediction.');
  }
});

// Delete Thumbnail (also deletes from Storage)
exports.deleteThumbnail = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  const { id } = data || {};
  if (!id) {
    throw new functions.https.HttpsError('invalid-argument', 'History ID is required');
  }

  try {
    const doc = await db.collection('thumbnailHistory').doc(id).get();
    if (!doc.exists || doc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized to delete this item');
    }

    const thumbnailData = doc.data();

    // Delete from Firebase Storage if file exists
    if (thumbnailData.fileName) {
      try {
        const bucket = admin.storage().bucket();
        await bucket.file(thumbnailData.fileName).delete();
      } catch (storageError) {
        console.log('Storage file may not exist or already deleted:', storageError.message);
      }
    }

    await db.collection('thumbnailHistory').doc(id).delete();
    return { success: true, message: 'Thumbnail deleted successfully' };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Delete thumbnail error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to delete thumbnail.');
  }
});

// Get All History (Unified View)
exports.getAllHistory = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'getAllHistory', 10);

  const { limit = 10 } = data || {};
  const safeLimit = Math.min(Math.max(1, parseInt(limit) || 10), 20);

  try {
    // Fetch from all history collections in parallel
    const [optimizationsSnap, competitorSnap, trendSnap, thumbnailSnap, placementSnap] = await Promise.all([
      db.collection('optimizations')
        .where('userId', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(safeLimit)
        .get(),
      db.collection('competitorHistory')
        .where('userId', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(safeLimit)
        .get(),
      db.collection('trendHistory')
        .where('userId', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(safeLimit)
        .get(),
      db.collection('thumbnailHistory')
        .where('userId', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(safeLimit)
        .get(),
      db.collection('placementFinderHistory')
        .where('userId', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(safeLimit)
        .get()
    ]);

    // Safe timestamp handler - handles various Firestore timestamp formats
    const getTimestamp = (field) => {
      if (!field) return Date.now();
      if (typeof field === 'number') return field;
      if (typeof field.toMillis === 'function') return field.toMillis();
      if (field._seconds) return field._seconds * 1000;
      if (field instanceof Date) return field.getTime();
      return Date.now();
    };

    // Safe serialization - removes non-serializable Firestore objects
    const sanitize = (obj) => {
      if (obj === null || obj === undefined) return null;
      try {
        return JSON.parse(JSON.stringify(obj));
      } catch (e) {
        return null;
      }
    };

    const formatHistory = (snap, type) => {
      const items = [];
      snap.forEach(doc => {
        try {
          const data = doc.data();
          const timestamp = getTimestamp(data.createdAt);

          // Create clean item without raw createdAt (non-serializable)
          const item = {
            id: doc.id,
            type,
            timestamp,
            createdAt: new Date(timestamp).toISOString()
          };

          // Safely copy other fields, excluding raw createdAt
          Object.keys(data).forEach(key => {
            if (key !== 'createdAt') {
              item[key] = sanitize(data[key]) ?? data[key];
            }
          });

          items.push(item);
        } catch (docError) {
          console.error('Error processing history doc:', doc.id, docError);
        }
      });
      return items;
    };

    const allHistory = [
      ...formatHistory(optimizationsSnap, 'optimization'),
      ...formatHistory(competitorSnap, 'competitor'),
      ...formatHistory(trendSnap, 'trend'),
      ...formatHistory(thumbnailSnap, 'thumbnail'),
      ...formatHistory(placementSnap, 'placement')
    ];

    // Sort by timestamp descending
    allHistory.sort((a, b) => b.timestamp - a.timestamp);

    return {
      success: true,
      history: {
        all: allHistory.slice(0, safeLimit * 2),
        optimizations: formatHistory(optimizationsSnap, 'optimization'),
        competitor: formatHistory(competitorSnap, 'competitor'),
        trends: formatHistory(trendSnap, 'trend'),
        thumbnails: formatHistory(thumbnailSnap, 'thumbnail'),
        placements: formatHistory(placementSnap, 'placement')
      },
      counts: {
        optimizations: optimizationsSnap.size,
        competitor: competitorSnap.size,
        trends: trendSnap.size,
        thumbnails: thumbnailSnap.size,
        placements: placementSnap.size
      }
    };
  } catch (error) {
    console.error('Get all history error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to load history.');
  }
});

// ==============================================
// PLACEMENT FINDER - Find YouTube Channels for Google Ads
// ==============================================

/**
 * Extract channel ID from various YouTube channel URL formats
 * Supports: /channel/UCxxx, /@handle, /c/customname, /user/username
 */
function extractChannelInfo(url) {
  const patterns = [
    // Channel ID format: youtube.com/channel/UCxxxxxx
    { regex: /youtube\.com\/channel\/([^\/\?&]+)/, type: 'id' },
    // Handle format: youtube.com/@handle
    { regex: /youtube\.com\/@([^\/\?&]+)/, type: 'handle' },
    // Custom URL: youtube.com/c/customname
    { regex: /youtube\.com\/c\/([^\/\?&]+)/, type: 'custom' },
    // User format: youtube.com/user/username
    { regex: /youtube\.com\/user\/([^\/\?&]+)/, type: 'user' }
  ];

  for (const { regex, type } of patterns) {
    const match = url.match(regex);
    if (match) return { value: match[1], type };
  }

  throw new Error('Invalid YouTube channel URL. Please use a valid channel link.');
}

/**
 * Find Placements - Main function to find YouTube channels for Google Ads
 * Analyzes user's channel and finds similar high-exposure channels
 */
exports.findPlacements = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'findPlacements', 5);
  await checkUsageLimit(uid, 'placementFinder');

  const { channelUrl } = data;
  if (!channelUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Channel URL is required');
  }

  try {
    // Step 1: Extract channel info from URL
    const channelInfo = extractChannelInfo(channelUrl);

    // Step 2: Get channel details from YouTube API
    let channelResponse;
    if (channelInfo.type === 'id') {
      channelResponse = await youtube.channels.list({
        part: 'snippet,statistics,brandingSettings,topicDetails',
        id: channelInfo.value
      });
    } else if (channelInfo.type === 'handle') {
      channelResponse = await youtube.channels.list({
        part: 'snippet,statistics,brandingSettings,topicDetails',
        forHandle: channelInfo.value
      });
    } else {
      // For custom URLs and usernames, search first
      const searchResponse = await youtube.search.list({
        part: 'snippet',
        q: channelInfo.value,
        type: 'channel',
        maxResults: 1
      });

      if (!searchResponse.data.items?.length) {
        throw new functions.https.HttpsError('not-found', 'Channel not found');
      }

      channelResponse = await youtube.channels.list({
        part: 'snippet,statistics,brandingSettings,topicDetails',
        id: searchResponse.data.items[0].snippet.channelId
      });
    }

    if (!channelResponse.data.items?.length) {
      throw new functions.https.HttpsError('not-found', 'Channel not found');
    }

    const userChannel = channelResponse.data.items[0];
    const channelId = userChannel.id;
    const channelName = userChannel.snippet.title;
    const channelDescription = userChannel.snippet.description || '';
    const subscriberCount = parseInt(userChannel.statistics.subscriberCount) || 0;
    const channelThumbnail = userChannel.snippet.thumbnails?.medium?.url || userChannel.snippet.thumbnails?.default?.url;

    // Step 3: Get recent videos to understand content
    const videosResponse = await youtube.search.list({
      part: 'snippet',
      channelId: channelId,
      type: 'video',
      order: 'date',
      maxResults: 15
    });

    const recentVideoTitles = videosResponse.data.items?.map(v => v.snippet.title) || [];
    const topicCategories = userChannel.topicDetails?.topicCategories?.map(t => t.split('/').pop()) || [];

    // Step 4: Use AI to analyze channel and generate search criteria
    const analysisPrompt = `You are a YouTube advertising expert. Analyze this channel to find similar channels for Google Ads Placement targeting.

CHANNEL DATA:
- Name: ${channelName}
- Description: ${channelDescription.substring(0, 500)}
- Subscribers: ${subscriberCount.toLocaleString()}
- Topics: ${topicCategories.join(', ') || 'Not specified'}
- Recent Videos: ${recentVideoTitles.slice(0, 10).join(' | ')}

Respond in this EXACT JSON format:
{
  "niche": "Primary content niche (2-4 words)",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "audienceDescription": "Brief description of the target audience (age, interests, demographics)",
  "searchQueries": ["search query 1", "search query 2", "search query 3"],
  "contentStyle": "Brief description of content style",
  "channelCategories": ["category1", "category2"]
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: analysisPrompt }],
      temperature: 0.7,
      max_tokens: 800
    });

    let analysis;
    try {
      const responseText = aiResponse.choices[0].message.content.trim();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (e) {
      analysis = {
        niche: 'General Content',
        keywords: [channelName],
        audienceDescription: 'General YouTube viewers',
        searchQueries: [channelName, ...topicCategories],
        contentStyle: 'Video content',
        channelCategories: topicCategories
      };
    }

    // Step 5: Search for similar channels using multiple queries
    const allChannelIds = new Set();
    const searchQueries = [...analysis.searchQueries, ...analysis.keywords.slice(0, 2)];

    for (const query of searchQueries.slice(0, 3)) {
      try {
        const searchResponse = await youtube.search.list({
          part: 'snippet',
          q: query,
          type: 'channel',
          maxResults: 15,
          relevanceLanguage: 'en'
        });

        searchResponse.data.items?.forEach(item => {
          if (item.snippet.channelId !== channelId) {
            allChannelIds.add(item.snippet.channelId);
          }
        });
      } catch (e) {
        console.log('Search query failed:', query, e.message);
      }
    }

    // Step 6: Get detailed info for found channels (batch request)
    const channelIds = Array.from(allChannelIds).slice(0, 50);

    if (channelIds.length === 0) {
      throw new functions.https.HttpsError('not-found', 'No similar channels found. Try a different channel.');
    }

    const detailsResponse = await youtube.channels.list({
      part: 'snippet,statistics',
      id: channelIds.join(','),
      maxResults: 50
    });

    // Step 7: Filter and score channels
    const placements = detailsResponse.data.items
      ?.map(ch => {
        const subs = parseInt(ch.statistics.subscriberCount) || 0;
        const views = parseInt(ch.statistics.viewCount) || 0;
        const videos = parseInt(ch.statistics.videoCount) || 0;

        // Calculate relevance score based on engagement metrics
        let score = 50;
        if (subs > 10000) score += 10;
        if (subs > 100000) score += 10;
        if (subs > 1000000) score += 10;
        if (views > 1000000) score += 10;
        if (videos > 50) score += 5;
        if (videos > 200) score += 5;

        return {
          channelId: ch.id,
          channelName: ch.snippet.title,
          channelUrl: `https://www.youtube.com/channel/${ch.id}`,
          handle: ch.snippet.customUrl || null,
          thumbnail: ch.snippet.thumbnails?.medium?.url || ch.snippet.thumbnails?.default?.url,
          description: (ch.snippet.description || '').substring(0, 150),
          subscribers: subs,
          subscribersFormatted: formatNumber(subs),
          totalViews: views,
          videoCount: videos,
          relevanceScore: Math.min(score, 100)
        };
      })
      .filter(ch => ch.subscribers >= 1000) // Minimum 1K subscribers
      .sort((a, b) => b.relevanceScore - a.relevanceScore || b.subscribers - a.subscribers)
      .slice(0, 30);

    if (placements.length === 0) {
      throw new functions.https.HttpsError('not-found', 'No quality channels found. The analyzed channel may be too niche.');
    }

    // Step 8: Save to history
    const historyData = {
      userId: uid,
      channelUrl,
      channelInfo: {
        id: channelId,
        name: channelName,
        subscribers: subscriberCount,
        thumbnail: channelThumbnail,
        description: channelDescription.substring(0, 300)
      },
      analysis: {
        niche: analysis.niche,
        keywords: analysis.keywords,
        audienceDescription: analysis.audienceDescription,
        contentStyle: analysis.contentStyle
      },
      placements,
      totalFound: placements.length,
      searchQueries: searchQueries.slice(0, 5),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const historyRef = await db.collection('placementFinderHistory').add(historyData);

    // Step 9: Update usage
    await incrementUsage(uid, 'placementFinder');
    await logUsage(uid, 'placement_finder', {
      channelId,
      channelName,
      placementsFound: placements.length
    });

    return {
      success: true,
      historyId: historyRef.id,
      channelInfo: historyData.channelInfo,
      analysis: historyData.analysis,
      placements,
      totalFound: placements.length,
      maxAllowed: 50
    };

  } catch (error) {
    console.error('Placement finder error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal',
      sanitizeErrorMessage(error, 'Failed to find placements. Please try again.'));
  }
});

/**
 * Helper to format large numbers (1000 -> 1K, 1000000 -> 1M)
 */
function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

/**
 * Find More Placements - Add 10 more channels to existing search
 */
exports.findMorePlacements = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'findMorePlacements', 10);

  const { historyId } = data;
  if (!historyId) {
    throw new functions.https.HttpsError('invalid-argument', 'History ID is required');
  }

  try {
    // Get existing history entry
    const historyDoc = await db.collection('placementFinderHistory').doc(historyId).get();

    if (!historyDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'History entry not found');
    }

    const historyData = historyDoc.data();

    if (historyData.userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    const currentPlacements = historyData.placements || [];

    if (currentPlacements.length >= 50) {
      throw new functions.https.HttpsError('resource-exhausted', 'Maximum of 50 placements reached');
    }

    // Get IDs of already found channels to exclude
    const existingIds = new Set(currentPlacements.map(p => p.channelId));
    existingIds.add(historyData.channelInfo.id); // Also exclude user's own channel

    // Search for more channels using stored queries
    const searchQueries = historyData.searchQueries || historyData.analysis?.keywords || [];
    const allNewChannelIds = new Set();

    for (const query of searchQueries) {
      try {
        // Use pageToken or different query variations to get different results
        const searchResponse = await youtube.search.list({
          part: 'snippet',
          q: `${query} channel`,
          type: 'channel',
          maxResults: 20,
          relevanceLanguage: 'en'
        });

        searchResponse.data.items?.forEach(item => {
          if (!existingIds.has(item.snippet.channelId)) {
            allNewChannelIds.add(item.snippet.channelId);
          }
        });
      } catch (e) {
        console.log('Search query failed:', query, e.message);
      }
    }

    const newChannelIds = Array.from(allNewChannelIds).slice(0, 15);

    if (newChannelIds.length === 0) {
      return {
        success: true,
        message: 'No more channels found matching your criteria',
        placements: currentPlacements,
        totalFound: currentPlacements.length,
        maxAllowed: 50,
        added: 0
      };
    }

    // Get channel details
    const detailsResponse = await youtube.channels.list({
      part: 'snippet,statistics',
      id: newChannelIds.join(',')
    });

    const newPlacements = detailsResponse.data.items
      ?.map(ch => {
        const subs = parseInt(ch.statistics.subscriberCount) || 0;
        const views = parseInt(ch.statistics.viewCount) || 0;
        const videos = parseInt(ch.statistics.videoCount) || 0;

        let score = 50;
        if (subs > 10000) score += 10;
        if (subs > 100000) score += 10;
        if (subs > 1000000) score += 10;
        if (views > 1000000) score += 10;
        if (videos > 50) score += 5;
        if (videos > 200) score += 5;

        return {
          channelId: ch.id,
          channelName: ch.snippet.title,
          channelUrl: `https://www.youtube.com/channel/${ch.id}`,
          handle: ch.snippet.customUrl || null,
          thumbnail: ch.snippet.thumbnails?.medium?.url || ch.snippet.thumbnails?.default?.url,
          description: (ch.snippet.description || '').substring(0, 150),
          subscribers: subs,
          subscribersFormatted: formatNumber(subs),
          totalViews: views,
          videoCount: videos,
          relevanceScore: Math.min(score, 100)
        };
      })
      .filter(ch => ch.subscribers >= 1000)
      .sort((a, b) => b.relevanceScore - a.relevanceScore || b.subscribers - a.subscribers)
      .slice(0, 10);

    // Combine and limit to 50
    const combinedPlacements = [...currentPlacements, ...newPlacements].slice(0, 50);

    // Update history document
    await db.collection('placementFinderHistory').doc(historyId).update({
      placements: combinedPlacements,
      totalFound: combinedPlacements.length,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await logUsage(uid, 'placement_finder_expand', {
      historyId,
      added: newPlacements.length,
      total: combinedPlacements.length
    });

    return {
      success: true,
      placements: combinedPlacements,
      totalFound: combinedPlacements.length,
      maxAllowed: 50,
      added: newPlacements.length
    };

  } catch (error) {
    console.error('Find more placements error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal',
      sanitizeErrorMessage(error, 'Failed to find more placements.'));
  }
});

/**
 * Get Placement Finder History
 */
exports.getPlacementFinderHistory = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'getPlacementFinderHistory', 20);

  const { limit = 20, offset = 0 } = data || {};
  const safeLimit = Math.min(Math.max(1, parseInt(limit) || 20), 50);
  const safeOffset = Math.max(0, parseInt(offset) || 0);

  // Safe timestamp handler
  const getTs = (field) => {
    if (!field) return Date.now();
    if (typeof field === 'number') return field;
    if (typeof field.toMillis === 'function') return field.toMillis();
    if (field._seconds) return field._seconds * 1000;
    if (field instanceof Date) return field.getTime();
    return Date.now();
  };

  try {
    const snapshot = await db.collection('placementFinderHistory')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(safeLimit)
      .offset(safeOffset)
      .get();

    const history = [];
    snapshot.forEach(doc => {
      try {
        const docData = doc.data();
        const timestamp = getTs(docData.createdAt);
        const { createdAt, updatedAt, ...rest } = docData;
        history.push({
          id: doc.id,
          ...rest,
          timestamp,
          createdAt: new Date(timestamp).toISOString()
        });
      } catch (e) {
        console.error('Error processing placement doc:', doc.id, e);
      }
    });

    return { success: true, history, count: history.length };
  } catch (error) {
    console.error('Get placement finder history error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to load history.');
  }
});

/**
 * Delete Placement Finder Entry
 */
exports.deletePlacementFinder = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  const { id } = data || {};
  if (!id) {
    throw new functions.https.HttpsError('invalid-argument', 'History ID is required');
  }

  try {
    const doc = await db.collection('placementFinderHistory').doc(id).get();
    if (!doc.exists || doc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized to delete this item');
    }

    await db.collection('placementFinderHistory').doc(id).delete();
    return { success: true, message: 'Placement search deleted successfully' };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Delete placement finder error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to delete.');
  }
});

// ==============================================
// CAMPAIGN REPORTS (Admin Feature)
// ==============================================

/**
 * Upload Campaign Report Images
 * Admin uploads screenshots from Google Ads campaigns
 */
exports.uploadReportImages = functions.https.onCall(async (data, context) => {
  const adminId = await requireAdmin(context);
  checkRateLimit(adminId, 'uploadReportImages', 20);

  const { images } = data || {};

  if (!images || !Array.isArray(images) || images.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'At least one image is required');
  }

  if (images.length > 6) {
    throw new functions.https.HttpsError('invalid-argument', 'Maximum 6 images allowed');
  }

  try {
    const bucket = admin.storage().bucket();
    const reportId = db.collection('campaignReports').doc().id;
    const uploadedImages = [];

    for (let i = 0; i < images.length; i++) {
      const imageData = images[i];

      // Validate base64 image data
      if (!imageData.base64 || !imageData.mimeType) {
        throw new functions.https.HttpsError('invalid-argument', `Invalid image data at index ${i}`);
      }

      // Support common image formats
      const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
      if (!allowedTypes.includes(imageData.mimeType)) {
        throw new functions.https.HttpsError('invalid-argument', `Unsupported image type: ${imageData.mimeType}`);
      }

      // Decode base64
      const buffer = Buffer.from(imageData.base64, 'base64');

      // Validate file size (max 10MB per image)
      if (buffer.length > 10 * 1024 * 1024) {
        throw new functions.https.HttpsError('invalid-argument', `Image ${i + 1} exceeds 10MB limit`);
      }

      // Generate filename
      const extension = imageData.mimeType.split('/')[1];
      const fileName = `campaign-reports/${reportId}/image_${i + 1}_${Date.now()}.${extension}`;

      // Upload to Firebase Storage
      const file = bucket.file(fileName);
      await file.save(buffer, {
        metadata: {
          contentType: imageData.mimeType,
          metadata: {
            uploadedBy: adminId,
            reportId: reportId
          }
        }
      });

      // Get signed URL (valid for 7 days)
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000
      });

      uploadedImages.push({
        url: url,
        storageRef: fileName,
        uploadedAt: new Date().toISOString(),
        index: i + 1
      });
    }

    return {
      success: true,
      reportId: reportId,
      images: uploadedImages,
      message: `${uploadedImages.length} images uploaded successfully`
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Upload report images error:', error);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to upload images'));
  }
});

/**
 * Analyze Campaign Report Images with GPT-4 Vision
 * Uses AI to extract metrics and generate recommendations
 */
exports.analyzeReportImages = functions.https.onCall(async (data, context) => {
  const adminId = await requireAdmin(context);
  checkRateLimit(adminId, 'analyzeReportImages', 10);

  const { images, campaignName, additionalContext } = data || {};

  if (!images || !Array.isArray(images) || images.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'At least one image is required');
  }

  try {
    // Build image content for GPT-4 Vision
    const imageContent = images.map((img, index) => ({
      type: 'image_url',
      image_url: {
        url: img.base64 ? `data:${img.mimeType};base64,${img.base64}` : img.url,
        detail: 'high'
      }
    }));

    const systemPrompt = `You are an expert YouTube channel growth strategist and Google Ads analyst. Analyze the provided campaign screenshots and extract all visible data.

Your analysis should be thorough and actionable. The report will be sent to a YouTube creator client, so be professional, encouraging, and focus on helping them grow their channel.

IMPORTANT: Your response MUST be valid JSON with this exact structure:
{
  "campaignType": "Search|Display|Video|Shopping|Performance Max|Discovery",
  "dateRange": "extracted date range from screenshots",
  "youtubeMetrics": {
    "publicViews": "number with commas as shown (e.g., '15,443') or null",
    "impressions": "number with commas as shown (e.g., '19,824') or null",
    "videoTitle": "full video title if visible or null",
    "adType": "ad type like 'Responsive video ad' or null",
    "adGroup": "ad group name if visible or null",
    "status": "Eligible|Paused|etc or null"
  },
  "metrics": {
    "impressions": number or null,
    "clicks": number or null,
    "ctr": "percentage string or null",
    "avgCpc": "currency string or null",
    "cost": "currency string or null",
    "conversions": number or null,
    "conversionRate": "percentage string or null",
    "costPerConversion": "currency string or null",
    "impressionShare": "percentage string or null"
  },
  "performance": {
    "overall": "Excellent|Good|Average|Needs Improvement|Poor",
    "trend": "Improving|Stable|Declining",
    "highlights": ["array of positive points about campaign/channel"],
    "concerns": ["array of areas needing attention"]
  },
  "recommendations": [
    {
      "priority": "High|Medium|Low",
      "category": "Thumbnails|Titles|Descriptions|Content|Posting Schedule|Engagement|SEO|Branding|Analytics",
      "title": "Short recommendation title for YouTube channel improvement",
      "description": "Detailed explanation focused on YouTube channel growth",
      "expectedImpact": "Expected improvement in views, subscribers, or engagement"
    }
  ],
  "summary": "2-3 sentence executive summary of the campaign performance and channel growth potential",
  "nextSteps": "Suggested immediate actions for channel improvement",
  "fiverCTA": "A compelling call-to-action suggesting they purchase professional YouTube optimization services"
}

CRITICAL INSTRUCTIONS:
1. Extract "YouTube public views" metric - this is the MOST IMPORTANT metric. Look for columns labeled "YouTube public views" in the screenshots.
2. Extract "Impr." (Impressions) and "Video" (video title) columns.
3. Look for "Ad type" (e.g., "Responsive video ad") and "Status" (e.g., "Eligible").
4. For recommendations, focus on YOUTUBE CHANNEL IMPROVEMENT, not Google Ads optimization:
   - Thumbnail design and optimization
   - Video title strategies (CTR improvement)
   - Description and tags optimization
   - Content quality and watch time
   - Posting schedule and consistency
   - Audience engagement tactics
   - Channel branding and identity
   - Analytics interpretation
5. Be specific with numbers when visible. If a metric isn't visible, use null.
6. Provide at least 4-6 detailed YouTube growth recommendations.
7. The CTA should focus on professional YouTube channel optimization services.`;

    const userPrompt = `Analyze these Google Ads campaign screenshots${campaignName ? ` for the "${campaignName}" campaign` : ''}.${additionalContext ? `\n\nAdditional context: ${additionalContext}` : ''}

PRIORITY EXTRACTION:
1. Find and extract "YouTube public views" - this is the most important metric for the client
2. Extract impressions, video title, ad type, and status
3. Provide YouTube CHANNEL growth recommendations (thumbnails, titles, content strategy, etc.)

Extract all visible metrics and provide actionable YouTube channel improvement recommendations.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            ...imageContent
          ]
        }
      ],
      max_tokens: 4000,
      temperature: 0.3
    });

    const content = response.choices[0]?.message?.content || '';

    // Try to parse JSON response
    let analysis;
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) ||
                        content.match(/```\s*([\s\S]*?)\s*```/) ||
                        [null, content];
      analysis = JSON.parse(jsonMatch[1] || content);
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON:', parseError);
      // Return raw response if parsing fails
      analysis = {
        rawResponse: content,
        parseError: true,
        summary: 'Analysis completed. Please review the raw response.',
        recommendations: [],
        metrics: {}
      };
    }

    return {
      success: true,
      analysis: analysis,
      analyzedAt: new Date().toISOString()
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Analyze report images error:', error);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to analyze images'));
  }
});

/**
 * Create Campaign Report
 * Save a new campaign report (draft or ready)
 */
exports.createCampaignReport = functions.https.onCall(async (data, context) => {
  const adminId = await requireAdmin(context);
  checkRateLimit(adminId, 'createCampaignReport', 20);

  const { reportId, images, aiAnalysis, editedContent, campaignName, status } = data || {};

  if (!images || images.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'At least one image is required');
  }

  try {
    const docId = reportId || db.collection('campaignReports').doc().id;

    const reportData = {
      adminId: adminId,
      clientId: null,
      status: status || 'draft',
      campaignName: campaignName || 'Campaign Report',
      images: images,
      aiAnalysis: aiAnalysis || null,
      editedContent: editedContent || {
        title: campaignName || 'Campaign Performance Report',
        summary: aiAnalysis?.summary || '',
        metrics: aiAnalysis?.metrics || {},
        performance: aiAnalysis?.performance || {},
        recommendations: aiAnalysis?.recommendations || [],
        callToAction: aiAnalysis?.fiverCTA || ''
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      sentAt: null,
      viewedAt: null,
      clientViewedCount: 0
    };

    await db.collection('campaignReports').doc(docId).set(reportData);

    return {
      success: true,
      reportId: docId,
      message: 'Report created successfully'
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Create campaign report error:', error);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to create report'));
  }
});

/**
 * Update Campaign Report
 * Admin edits report content
 */
exports.updateCampaignReport = functions.https.onCall(async (data, context) => {
  const adminId = await requireAdmin(context);
  checkRateLimit(adminId, 'updateCampaignReport', 30);

  const { reportId, editedContent, campaignName, status } = data || {};

  if (!reportId) {
    throw new functions.https.HttpsError('invalid-argument', 'Report ID is required');
  }

  try {
    const reportRef = db.collection('campaignReports').doc(reportId);
    const reportDoc = await reportRef.get();

    if (!reportDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Report not found');
    }

    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (editedContent) {
      updateData.editedContent = editedContent;
    }
    if (campaignName) {
      updateData.campaignName = campaignName;
    }
    if (status) {
      updateData.status = status;
    }

    await reportRef.update(updateData);

    return {
      success: true,
      message: 'Report updated successfully'
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Update campaign report error:', error);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to update report'));
  }
});

/**
 * Delete Campaign Report
 * Admin deletes a report and its images
 */
exports.deleteCampaignReport = functions.https.onCall(async (data, context) => {
  const adminId = await requireAdmin(context);
  checkRateLimit(adminId, 'deleteCampaignReport', 20);

  const { reportId } = data || {};

  if (!reportId) {
    throw new functions.https.HttpsError('invalid-argument', 'Report ID is required');
  }

  try {
    const reportRef = db.collection('campaignReports').doc(reportId);
    const reportDoc = await reportRef.get();

    if (!reportDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Report not found');
    }

    const reportData = reportDoc.data();

    // Delete images from storage
    const bucket = admin.storage().bucket();
    if (reportData.images && Array.isArray(reportData.images)) {
      for (const image of reportData.images) {
        if (image.storageRef) {
          try {
            await bucket.file(image.storageRef).delete();
          } catch (e) {
            console.log('Image already deleted or not found:', image.storageRef);
          }
        }
      }
    }

    // Delete any notifications related to this report
    const notificationsSnapshot = await db.collection('userNotifications')
      .where('reportId', '==', reportId)
      .get();

    const batch = db.batch();
    notificationsSnapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    batch.delete(reportRef);
    await batch.commit();

    return {
      success: true,
      message: 'Report deleted successfully'
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Delete campaign report error:', error);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to delete report'));
  }
});

/**
 * Send Report to Client
 * Assign report to a user and create notification
 */
exports.sendReportToClient = functions.https.onCall(async (data, context) => {
  const adminId = await requireAdmin(context);
  checkRateLimit(adminId, 'sendReportToClient', 20);

  const { reportId, clientId } = data || {};

  if (!reportId) {
    throw new functions.https.HttpsError('invalid-argument', 'Report ID is required');
  }
  if (!clientId) {
    throw new functions.https.HttpsError('invalid-argument', 'Client ID is required');
  }

  try {
    // Verify client exists
    const clientDoc = await db.collection('users').doc(clientId).get();
    if (!clientDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Client not found');
    }

    // Get report
    const reportRef = db.collection('campaignReports').doc(reportId);
    const reportDoc = await reportRef.get();

    if (!reportDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Report not found');
    }

    const reportData = reportDoc.data();
    const campaignName = reportData.campaignName || 'Campaign Report';

    // Update report with client assignment
    await reportRef.update({
      clientId: clientId,
      status: 'sent',
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Create notification for client
    await db.collection('userNotifications').add({
      userId: clientId,
      type: 'new_report',
      reportId: reportId,
      title: `New Campaign Report: ${campaignName}`,
      message: 'Your campaign performance report is ready to view.',
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      message: `Report sent to ${clientDoc.data().email || 'client'}`
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Send report to client error:', error);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to send report'));
  }
});

/**
 * Get Admin Reports
 * Fetch all campaign reports for admin
 */
exports.getAdminReports = functions.https.onCall(async (data, context) => {
  const adminId = await requireAdmin(context);
  checkRateLimit(adminId, 'getAdminReports', 30);

  const { limit: queryLimit, status } = data || {};

  try {
    let query = db.collection('campaignReports')
      .orderBy('createdAt', 'desc');

    if (status) {
      query = query.where('status', '==', status);
    }

    if (queryLimit) {
      query = query.limit(queryLimit);
    } else {
      query = query.limit(50);
    }

    const snapshot = await query.get();
    const reports = [];

    for (const doc of snapshot.docs) {
      const data = doc.data();

      // Get client info if assigned
      let clientInfo = null;
      if (data.clientId) {
        const clientDoc = await db.collection('users').doc(data.clientId).get();
        if (clientDoc.exists) {
          clientInfo = {
            uid: data.clientId,
            email: clientDoc.data().email
          };
        }
      }

      // Safe timestamp serialization
      const createdAt = data.createdAt;
      const sentAt = data.sentAt;
      const viewedAt = data.viewedAt;

      reports.push({
        id: doc.id,
        ...data,
        createdAt: createdAt ? (createdAt.toDate ? createdAt.toDate().toISOString() : createdAt) : null,
        sentAt: sentAt ? (sentAt.toDate ? sentAt.toDate().toISOString() : sentAt) : null,
        viewedAt: viewedAt ? (viewedAt.toDate ? viewedAt.toDate().toISOString() : viewedAt) : null,
        updatedAt: data.updatedAt ? (data.updatedAt.toDate ? data.updatedAt.toDate().toISOString() : data.updatedAt) : null,
        clientInfo: clientInfo
      });
    }

    return {
      success: true,
      reports: reports,
      count: reports.length
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Get admin reports error:', error);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to load reports'));
  }
});

/**
 * Get Client Reports
 * Fetch reports assigned to a specific client
 */
exports.getClientReports = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'getClientReports', 30);

  try {
    const snapshot = await db.collection('campaignReports')
      .where('clientId', '==', uid)
      .where('status', 'in', ['sent', 'viewed'])
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const reports = snapshot.docs.map(doc => {
      const data = doc.data();
      const createdAt = data.createdAt;
      const sentAt = data.sentAt;

      return {
        id: doc.id,
        campaignName: data.campaignName,
        status: data.status,
        images: data.images,
        editedContent: data.editedContent,
        createdAt: createdAt ? (createdAt.toDate ? createdAt.toDate().toISOString() : createdAt) : null,
        sentAt: sentAt ? (sentAt.toDate ? sentAt.toDate().toISOString() : sentAt) : null
      };
    });

    return {
      success: true,
      reports: reports,
      count: reports.length
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Get client reports error:', error);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to load reports'));
  }
});

/**
 * Mark Report as Viewed
 * Track when a client views their report
 */
exports.markReportViewed = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'markReportViewed', 30);

  const { reportId } = data || {};

  if (!reportId) {
    throw new functions.https.HttpsError('invalid-argument', 'Report ID is required');
  }

  try {
    const reportRef = db.collection('campaignReports').doc(reportId);
    const reportDoc = await reportRef.get();

    if (!reportDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Report not found');
    }

    const reportData = reportDoc.data();

    // Verify user is the assigned client
    if (reportData.clientId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized to view this report');
    }

    // Update view count and status
    const updates = {
      clientViewedCount: admin.firestore.FieldValue.increment(1)
    };

    // Set first view time and status if not already viewed
    if (reportData.status === 'sent') {
      updates.status = 'viewed';
      updates.viewedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await reportRef.update(updates);

    return {
      success: true,
      message: 'Report marked as viewed'
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Mark report viewed error:', error);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to update report'));
  }
});

/**
 * Get Unread Notifications
 * Get notification count and list for a user
 */
exports.getUnreadNotifications = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'getUnreadNotifications', 60);

  try {
    const snapshot = await db.collection('userNotifications')
      .where('userId', '==', uid)
      .where('isRead', '==', false)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    const notifications = snapshot.docs.map(doc => {
      const data = doc.data();
      const createdAt = data.createdAt;

      return {
        id: doc.id,
        type: data.type,
        reportId: data.reportId,
        title: data.title,
        message: data.message,
        isRead: data.isRead,
        createdAt: createdAt ? (createdAt.toDate ? createdAt.toDate().toISOString() : createdAt) : null
      };
    });

    return {
      success: true,
      notifications: notifications,
      unreadCount: notifications.length
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Get unread notifications error:', error);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to load notifications'));
  }
});

/**
 * Mark Notification as Read
 * Clear notification for a user
 */
exports.markNotificationRead = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'markNotificationRead', 60);

  const { notificationId, markAll } = data || {};

  try {
    if (markAll) {
      // Mark all unread notifications as read
      const snapshot = await db.collection('userNotifications')
        .where('userId', '==', uid)
        .where('isRead', '==', false)
        .get();

      const batch = db.batch();
      snapshot.docs.forEach(doc => {
        batch.update(doc.ref, { isRead: true });
      });
      await batch.commit();

      return {
        success: true,
        message: `${snapshot.docs.length} notifications marked as read`
      };
    } else if (notificationId) {
      // Mark specific notification as read
      const notificationRef = db.collection('userNotifications').doc(notificationId);
      const notificationDoc = await notificationRef.get();

      if (!notificationDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Notification not found');
      }

      if (notificationDoc.data().userId !== uid) {
        throw new functions.https.HttpsError('permission-denied', 'Not authorized');
      }

      await notificationRef.update({ isRead: true });

      return {
        success: true,
        message: 'Notification marked as read'
      };
    } else {
      throw new functions.https.HttpsError('invalid-argument', 'Notification ID or markAll flag required');
    }
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Mark notification read error:', error);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to update notification'));
  }
});

/**
 * Get Single Report (for viewing)
 * Get a specific report with full details
 */
exports.getCampaignReport = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'getCampaignReport', 30);

  const { reportId } = data || {};

  if (!reportId) {
    throw new functions.https.HttpsError('invalid-argument', 'Report ID is required');
  }

  try {
    const reportDoc = await db.collection('campaignReports').doc(reportId).get();

    if (!reportDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Report not found');
    }

    const reportData = reportDoc.data();
    const isUserAdmin = await isAdmin(uid);

    // Check authorization
    if (!isUserAdmin && reportData.clientId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized to view this report');
    }

    // Serialize timestamps
    const createdAt = reportData.createdAt;
    const sentAt = reportData.sentAt;
    const viewedAt = reportData.viewedAt;

    return {
      success: true,
      report: {
        id: reportDoc.id,
        ...reportData,
        createdAt: createdAt ? (createdAt.toDate ? createdAt.toDate().toISOString() : createdAt) : null,
        sentAt: sentAt ? (sentAt.toDate ? sentAt.toDate().toISOString() : sentAt) : null,
        viewedAt: viewedAt ? (viewedAt.toDate ? viewedAt.toDate().toISOString() : viewedAt) : null,
        updatedAt: reportData.updatedAt ? (reportData.updatedAt.toDate ? reportData.updatedAt.toDate().toISOString() : reportData.updatedAt) : null
      }
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Get campaign report error:', error);
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to load report'));
  }
});
