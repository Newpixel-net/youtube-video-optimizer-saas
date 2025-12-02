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
const { GoogleGenAI } = require('@google/genai');

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
// Complete YouTube category mapping - Official YouTube Data API v3 categories
const YOUTUBE_CATEGORIES = {
  '1': 'film_animation',
  '2': 'autos_vehicles',
  '10': 'music',
  '15': 'pets_animals',
  '17': 'sports',           // CRITICAL: Sports category (WTT, Olympics, etc.)
  '18': 'short_movies',
  '19': 'travel_events',
  '20': 'gaming',
  '21': 'videoblogging',
  '22': 'vlog',
  '23': 'comedy',
  '24': 'entertainment',
  '25': 'news',
  '26': 'howto',
  '27': 'education',
  '28': 'tech',
  '29': 'nonprofits_activism',
  '30': 'movies',
  '31': 'anime_animation',
  '32': 'action_adventure',
  '33': 'classics',
  '34': 'comedy_film',
  '35': 'documentary',
  '36': 'drama',
  '37': 'family',
  '38': 'foreign',
  '39': 'horror',
  '40': 'scifi_fantasy',
  '41': 'thriller',
  '42': 'shorts',
  '43': 'shows',
  '44': 'trailers'
};

// Non-music categories - used to prevent false music detection
const NON_MUSIC_CATEGORIES = new Set([
  '1', '2', '15', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28',
  '29', '30', '31', '32', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44'
]);

function detectContentType(metadata) {
  const title = (metadata.title || '').toLowerCase();
  const channelTitle = (metadata.channelTitle || '').toLowerCase();
  const description = (metadata.description || '').toLowerCase();
  const tags = (metadata.tags || []).map(t => t.toLowerCase());
  const categoryId = metadata.categoryId || '';

  // ============================================================
  // PRIORITY 1: Definitive high-confidence detection sources
  // These should NEVER be overridden by keyword guessing
  // ============================================================

  // 1a. Auto-generated YouTube music channels ("Artist - Topic") - 100% music
  if (channelTitle.endsWith(' - topic') || channelTitle.includes(' - topic')) {
    return { type: 'music', subtype: 'song', confidence: 'high', source: 'topic_channel' };
  }

  // 1b. YouTube's official categoryId - HIGH CONFIDENCE
  // This takes precedence over ALL keyword-based detection
  if (categoryId && YOUTUBE_CATEGORIES[categoryId]) {
    const categoryType = YOUTUBE_CATEGORIES[categoryId];

    // If it's music category (10), determine subtype
    if (categoryId === '10') {
      const subtype = detectMusicSubtype(title, description, tags);
      return { type: 'music', subtype, confidence: 'high', source: 'category' };
    }

    // For all other categories, return the mapped type
    // This prevents sports videos, gaming videos, etc. from being misclassified as music
    const subtype = detectSubtypeForCategory(categoryType, title, description, tags);
    return { type: categoryType, subtype, confidence: 'high', source: 'category' };
  }

  // ============================================================
  // PRIORITY 2: Keyword-based detection (only when no categoryId)
  // Used as fallback when YouTube doesn't provide category data
  // ============================================================

  // 2a. Strong music indicators (requires multiple signals for confidence)
  const musicResult = detectMusicByKeywords(title, description, tags, channelTitle);
  if (musicResult) {
    return musicResult;
  }

  // 2b. Other content type keywords
  const keywordResult = detectContentByKeywords(title, description, tags);
  if (keywordResult) {
    return keywordResult;
  }

  // ============================================================
  // PRIORITY 3: Default fallback
  // ============================================================
  return { type: 'general', subtype: 'unknown', confidence: 'low', source: 'default' };
}

/**
 * Strict music detection by keywords - requires multiple indicators to avoid false positives
 * Only used when categoryId is not available
 */
function detectMusicByKeywords(title, description, tags, channelTitle) {
  // TIER 1: Very strong music indicators (single match = high confidence)
  // These are ONLY used in actual music content
  const tier1Keywords = [
    'official music video',
    'official lyric video',
    'official audio',
    'official visualizer',
    'lyric video',
    '(lyrics)',
    '[lyrics]',
    'full album stream',
    'album stream'
  ];

  if (tier1Keywords.some(kw => title.includes(kw))) {
    const subtype = detectMusicSubtype(title, description, tags);
    return { type: 'music', subtype, confidence: 'high', source: 'keywords_tier1' };
  }

  // TIER 2: Strong music indicators in TITLE only (not description - too broad)
  const tier2TitleKeywords = [
    'music video',
    'prod. by',
    'prod by',
    'produced by',
    '(prod.',
    '[prod.',
    'feat.',
    'ft.',
    '(remix)',
    '[remix]',
    'official remix',
    '(acoustic)',
    '[acoustic]',
    'acoustic version',
    'unplugged'
  ];

  // Count tier 2 matches in title
  const tier2TitleMatches = tier2TitleKeywords.filter(kw => title.includes(kw)).length;

  // TIER 3: Music genre tags (exact match only)
  const musicGenreTags = [
    'hip hop', 'hiphop', 'rap', 'trap', 'drill',
    'rock', 'metal', 'punk', 'alternative', 'grunge',
    'pop music', 'pop song',
    'jazz', 'blues', 'soul', 'r&b', 'rnb', 'funk', 'gospel',
    'classical music', 'orchestra', 'symphony',
    'electronic music', 'edm', 'house music', 'techno', 'trance', 'dubstep', 'dnb', 'drum and bass',
    'country music', 'folk music', 'bluegrass',
    'reggae', 'dancehall', 'ska',
    'latin music', 'salsa', 'bachata', 'reggaeton',
    'k-pop', 'kpop', 'j-pop', 'jpop',
    'indie music', 'indie rock', 'indie pop'
  ];

  const genreTagMatches = musicGenreTags.filter(genre => tags.includes(genre)).length;

  // TIER 4: Music-related channel indicators
  const musicChannelIndicators = [
    'records', 'music', 'official', 'vevo', 'entertainment'
  ];
  const channelMusicScore = musicChannelIndicators.filter(ind => channelTitle.includes(ind)).length;

  // TIER 5: Additional title patterns that suggest music
  const musicTitlePatterns = [
    /\s-\s.*\(official\)/i,           // "Artist - Song (Official)"
    /\s-\s.*\[official\]/i,           // "Artist - Song [Official]"
    /\sft\.\s/i,                       // " ft. " with spaces
    /\sfeat\.\s/i,                     // " feat. " with spaces
    /\(feat\./i,                       // "(feat."
    /\[feat\./i,                       // "[feat."
    /^\s*[\w\s]+\s-\s[\w\s]+$/,       // Simple "Artist - Song" pattern
  ];

  const patternMatches = musicTitlePatterns.filter(pattern => pattern.test(title)).length;

  // Calculate confidence score
  // Need multiple indicators to classify as music without categoryId
  const totalScore = (tier2TitleMatches * 2) + (genreTagMatches * 2) + channelMusicScore + patternMatches;

  // Require score >= 3 for medium confidence music detection
  // This prevents single generic keyword matches from triggering music classification
  if (totalScore >= 3) {
    const subtype = detectMusicSubtype(title, description, tags);
    return { type: 'music', subtype, confidence: 'medium', source: 'keywords_combined' };
  }

  // Even with lower score, if there are tier 2 title matches AND genre tags, it's likely music
  if (tier2TitleMatches >= 1 && genreTagMatches >= 1) {
    const subtype = detectMusicSubtype(title, description, tags);
    return { type: 'music', subtype, confidence: 'medium', source: 'keywords_combined' };
  }

  return null; // Not confidently music
}

/**
 * Detect other content types by keywords (non-music)
 */
function detectContentByKeywords(title, description, tags) {
  // Sports detection
  const sportsKeywords = ['match', 'game highlights', 'championship', 'tournament', 'vs', 'versus',
    'final', 'semifinal', 'quarterfinal', 'world cup', 'olympics', 'league', 'season', 'playoff',
    'behind the scenes', 'training', 'practice', 'warmup'];
  const sportsTerms = ['football', 'soccer', 'basketball', 'tennis', 'table tennis', 'cricket',
    'baseball', 'hockey', 'golf', 'boxing', 'mma', 'ufc', 'wrestling', 'volleyball', 'rugby',
    'f1', 'formula 1', 'nascar', 'athletics', 'swimming', 'gymnastics', 'skating', 'skiing'];

  if (sportsKeywords.some(kw => title.includes(kw)) &&
      sportsTerms.some(term => title.includes(term) || tags.some(t => t.includes(term)))) {
    return { type: 'sports', subtype: 'event', confidence: 'medium', source: 'keywords' };
  }

  // Tutorial/How-to detection
  if (title.includes('tutorial') || title.includes('how to ') || title.includes('guide to') ||
      title.includes('step by step') || title.includes('learn to') || title.includes('beginner')) {
    return { type: 'tutorial', subtype: 'educational', confidence: 'medium', source: 'keywords' };
  }

  // Review/Unboxing detection
  if (title.includes('review') || title.includes('unboxing') || title.includes('hands on') ||
      title.includes('first look') || title.includes('comparison')) {
    return { type: 'review', subtype: 'product', confidence: 'medium', source: 'keywords' };
  }

  // Gaming detection
  if (title.includes('gameplay') || title.includes('playthrough') || title.includes('let\'s play') ||
      title.includes('walkthrough') || title.includes('speedrun') || title.includes('gaming')) {
    return { type: 'gaming', subtype: 'gameplay', confidence: 'medium', source: 'keywords' };
  }

  // Vlog detection
  if (title.includes('vlog') || title.includes('day in my life') || title.includes('grwm') ||
      title.includes('get ready with me') || title.includes('daily vlog') || title.includes('weekly vlog')) {
    return { type: 'vlog', subtype: 'lifestyle', confidence: 'medium', source: 'keywords' };
  }

  // Podcast/Interview detection
  if (title.includes('podcast') || title.includes('interview with') || title.includes('conversation with') ||
      title.includes('episode') && (title.includes('ep.') || title.includes('ep ') || /ep\s*\d+/i.test(title))) {
    return { type: 'podcast', subtype: 'talk', confidence: 'medium', source: 'keywords' };
  }

  // News detection
  if (title.includes('breaking') || title.includes('news') || title.includes('update') ||
      title.includes('announcement') || title.includes('press conference')) {
    return { type: 'news', subtype: 'current_events', confidence: 'medium', source: 'keywords' };
  }

  // Documentary detection
  if (title.includes('documentary') || title.includes('the story of') || title.includes('history of') ||
      title.includes('investigation') || title.includes('explained')) {
    return { type: 'documentary', subtype: 'informational', confidence: 'medium', source: 'keywords' };
  }

  return null;
}

/**
 * Determine subtype for non-music categories based on title/description
 */
function detectSubtypeForCategory(categoryType, title, description, tags) {
  switch (categoryType) {
    case 'sports':
      if (title.includes('highlight')) return 'highlights';
      if (title.includes('behind the scenes') || title.includes('bts')) return 'behind_the_scenes';
      if (title.includes('interview')) return 'interview';
      if (title.includes('training') || title.includes('practice')) return 'training';
      if (title.includes('final') || title.includes('championship')) return 'championship';
      return 'event';

    case 'gaming':
      if (title.includes('review')) return 'review';
      if (title.includes('walkthrough') || title.includes('playthrough')) return 'walkthrough';
      if (title.includes('speedrun')) return 'speedrun';
      if (title.includes('let\'s play')) return 'lets_play';
      if (title.includes('stream') || title.includes('live')) return 'stream';
      return 'gameplay';

    case 'news':
      if (title.includes('breaking')) return 'breaking';
      if (title.includes('analysis')) return 'analysis';
      if (title.includes('opinion')) return 'opinion';
      return 'report';

    case 'education':
    case 'howto':
      if (title.includes('course') || title.includes('class')) return 'course';
      if (title.includes('tutorial')) return 'tutorial';
      if (title.includes('explained')) return 'explainer';
      return 'educational';

    case 'entertainment':
      if (title.includes('trailer')) return 'trailer';
      if (title.includes('clip')) return 'clip';
      if (title.includes('scene')) return 'scene';
      return 'general';

    case 'travel_events':
      if (title.includes('tour')) return 'tour';
      if (title.includes('travel')) return 'travel';
      if (title.includes('event')) return 'event';
      return 'general';

    default:
      return 'general';
  }
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

  // ============================================================
  // MUSIC CONTENT
  // ============================================================
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

  // ============================================================
  // SPORTS CONTENT
  // ============================================================
  if (type === 'sports') {
    const sportSubtypeContext = {
      highlights: 'match/game highlights',
      behind_the_scenes: 'behind-the-scenes content',
      interview: 'athlete/coach interview',
      training: 'training/practice session',
      championship: 'championship/final match',
      event: 'sports event'
    };
    const contextDesc = sportSubtypeContext[subtype] || 'sports content';

    return {
      titleInstructions: `
SPORTS CONTENT DETECTED - This is ${contextDesc}.
Create SPORTS-appropriate titles:
- Include the sport name, event/competition name, teams/athletes involved
- Use sports terminology: "Highlights", "Match", "Championship", "Final", "vs", etc.
- Highlight key moments: "Amazing Rally", "Championship Point", "Gold Medal", etc.
- Include dates/seasons if relevant (e.g., "2024 Finals")
- DO NOT use music or entertainment terminology`,

      descriptionInstructions: `
SPORTS CONTENT DETECTED - This is ${contextDesc}.
Create a SPORTS description:

Include:
1. 🏆 Event/Competition info (tournament name, round, date)
2. 👥 Teams/Athletes involved with relevant stats or rankings
3. 📍 Venue/Location information
4. ⏱️ Timestamps for key moments (goals, points, highlights)
5. 📊 Match/game results or scores (if applicable)
6. 🔗 Links to official sports channels, league websites
7. Sports-related hashtags (#[Sport] #[Tournament] #[Team/Athlete])

DO NOT include:
- Music-related content (genres, artists, streaming platforms)
- Motivational self-help content
- Unrelated entertainment content`,

      tagsInstructions: `
SPORTS CONTENT DETECTED - Generate SPORTS-specific tags:

1. Primary (5-8): Sport name, event/tournament name, athlete/team names
2. Secondary (8-12): League name, season/year, venue, competition round
3. Long-tail (10-15): "[Athlete] highlights 2024", "[Tournament] finals", "[Sport] best moments"
4. Trending (5-10): Current tournament names, trending athlete names, sports events

DO NOT include music, entertainment, or motivational tags.
Focus on: sport discovery, event coverage, athlete/team names, competition names.`
    };
  }

  // ============================================================
  // GAMING CONTENT
  // ============================================================
  if (type === 'gaming') {
    return {
      titleInstructions: `
GAMING CONTENT DETECTED - This is ${subtype} content.
Create GAMING-appropriate titles:
- Include the game name prominently
- Specify content type: Gameplay, Walkthrough, Review, Let's Play, etc.
- Use gaming hooks: "Epic Win", "Insane Play", "World Record", "Boss Fight", etc.
- Include relevant details: difficulty level, character/class, game mode`,

      descriptionInstructions: `
GAMING CONTENT DETECTED - Create a GAMING description:

Include:
1. 🎮 Game info (name, platform, genre)
2. 📋 Content type (gameplay, walkthrough, review, etc.)
3. ⏱️ Timestamps for key moments, boss fights, achievements
4. 💻 PC specs or console info if relevant
5. 🔗 Links to game store, streamer socials, Discord
6. Gaming hashtags (#[GameName] #Gaming #[Platform])

DO NOT include music or unrelated content.`,

      tagsInstructions: `
GAMING CONTENT - Generate GAMING tags:

1. Primary (5-8): Game name, platform, game genre, content type
2. Secondary (8-12): Game modes, characters, related games
3. Long-tail (10-15): "[Game] gameplay 2024", "[Game] walkthrough", "[Game] review"
4. Trending (5-10): Current gaming trends, popular games, esports terms`
    };
  }

  // ============================================================
  // EDUCATIONAL/TUTORIAL CONTENT
  // ============================================================
  if (type === 'tutorial' || type === 'howto' || type === 'education') {
    return {
      titleInstructions: `
EDUCATIONAL/TUTORIAL CONTENT DETECTED.
Create EDUCATIONAL titles:
- Focus on the problem being solved or skill being taught
- Use "How to", step counts, or clear outcome promises
- Include skill level if relevant (Beginner, Advanced, etc.)
- Be specific about what viewers will learn`,

      descriptionInstructions: `
EDUCATIONAL CONTENT - Create an EDUCATIONAL description:

Include:
1. 📚 Clear problem statement or learning objective
2. 📝 Numbered steps or chapter timestamps
3. 🛠️ Tools, resources, or materials needed
4. 💡 Key takeaways and practical tips
5. 🔗 Links to resources, downloads, related tutorials
6. Educational hashtags (#Tutorial #HowTo #[Topic])`,

      tagsInstructions: `
EDUCATIONAL CONTENT - Generate EDUCATIONAL tags:

1. Primary (5-8): Topic name, skill type, "tutorial", "how to"
2. Secondary (8-12): Related topics, tools mentioned, skill level
3. Long-tail (10-15): "[Topic] tutorial for beginners", "how to [action]", "learn [skill]"
4. Trending (5-10): Current trends in the topic area`
    };
  }

  // ============================================================
  // NEWS CONTENT
  // ============================================================
  if (type === 'news') {
    return {
      titleInstructions: `
NEWS CONTENT DETECTED.
Create NEWS-appropriate titles:
- Be factual and informative
- Include key facts: who, what, when, where
- Use news terminology: "Breaking", "Update", "Report", etc.
- Avoid sensationalism while maintaining engagement`,

      descriptionInstructions: `
NEWS CONTENT - Create a NEWS description:

Include:
1. 📰 Summary of the news story
2. 📅 Date and relevant timeline
3. 👥 Key people/organizations involved
4. 🔗 Links to sources and related coverage
5. News-related hashtags (#News #Breaking #[Topic])`,

      tagsInstructions: `
NEWS CONTENT - Generate NEWS tags:

1. Primary (5-8): Topic, key figures, location
2. Secondary (8-12): Related events, organizations
3. Long-tail (10-15): "[Topic] news 2024", "[Event] update"
4. Trending (5-10): Current news trends, breaking topics`
    };
  }

  // ============================================================
  // VLOG/LIFESTYLE CONTENT
  // ============================================================
  if (type === 'vlog' || type === 'videoblogging') {
    return {
      titleInstructions: `
VLOG/LIFESTYLE CONTENT DETECTED.
Create VLOG-appropriate titles:
- Be personal and relatable
- Include context: location, activity, occasion
- Use vlog hooks: "Day in My Life", "GRWM", "Come With Me", etc.
- Keep it authentic to the creator's style`,

      descriptionInstructions: `
VLOG CONTENT - Create a VLOG description:

Include:
1. 📍 Location and context
2. 📋 Brief summary of what happens
3. ⏱️ Timestamps for different segments
4. 🔗 Links to creator's socials, products mentioned
5. Vlog hashtags (#Vlog #DayInMyLife #[Location])`,

      tagsInstructions: `
VLOG CONTENT - Generate VLOG tags:

1. Primary (5-8): Content type, location, activity
2. Secondary (8-12): Lifestyle topics, brands mentioned
3. Long-tail (10-15): "[Activity] vlog", "day in my life [location]"
4. Trending (5-10): Current lifestyle trends`
    };
  }

  // ============================================================
  // ENTERTAINMENT CONTENT
  // ============================================================
  if (type === 'entertainment' || type === 'comedy') {
    return {
      titleInstructions: `
ENTERTAINMENT CONTENT DETECTED.
Create ENTERTAINMENT-appropriate titles:
- Be engaging and attention-grabbing
- Match the tone of the content (funny, dramatic, etc.)
- Include key performers or show names if relevant`,

      descriptionInstructions: `
ENTERTAINMENT CONTENT - Create an ENTERTAINMENT description:

Include:
1. 🎬 Content summary
2. 👥 Performers/creators involved
3. ⏱️ Timestamps for key moments
4. 🔗 Links to related content, creator socials
5. Entertainment hashtags (#Entertainment #Comedy #[Show])`,

      tagsInstructions: `
ENTERTAINMENT CONTENT - Generate ENTERTAINMENT tags:

1. Primary (5-8): Content type, performers, show name
2. Secondary (8-12): Genre, related content
3. Long-tail (10-15): "[Performer] funny moments", "[Show] clips"
4. Trending (5-10): Current entertainment trends`
    };
  }

  // ============================================================
  // TRAVEL/EVENTS CONTENT
  // ============================================================
  if (type === 'travel_events') {
    return {
      titleInstructions: `
TRAVEL/EVENTS CONTENT DETECTED.
Create TRAVEL-appropriate titles:
- Include destination/event name prominently
- Use travel hooks: "Travel Guide", "Hidden Gems", "Must Visit", etc.
- Be specific about location and experience`,

      descriptionInstructions: `
TRAVEL CONTENT - Create a TRAVEL description:

Include:
1. 📍 Destination/event details
2. 🗓️ Travel dates, event schedule
3. 💰 Budget tips, costs mentioned
4. ⏱️ Timestamps for different locations/activities
5. 🔗 Links to booking sites, travel resources
6. Travel hashtags (#Travel #[Destination] #[Event])`,

      tagsInstructions: `
TRAVEL CONTENT - Generate TRAVEL tags:

1. Primary (5-8): Destination, event name, travel type
2. Secondary (8-12): Activities, attractions, local terms
3. Long-tail (10-15): "[Destination] travel guide", "[Event] vlog"
4. Trending (5-10): Current travel trends, popular destinations`
    };
  }

  // ============================================================
  // DOCUMENTARY CONTENT
  // ============================================================
  if (type === 'documentary' || type === 'film_animation') {
    return {
      titleInstructions: `
DOCUMENTARY/FILM CONTENT DETECTED.
Create appropriate titles:
- Be informative and intriguing
- Include the subject matter clearly
- Use documentary terms if relevant: "The Story of", "Inside", "Exploring", etc.`,

      descriptionInstructions: `
DOCUMENTARY CONTENT - Create a description:

Include:
1. 📽️ Subject/topic overview
2. 🎬 Production details if relevant
3. ⏱️ Chapter timestamps
4. 🔗 Links to related documentaries, sources
5. Relevant hashtags (#Documentary #[Topic])`,

      tagsInstructions: `
DOCUMENTARY CONTENT - Generate tags:

1. Primary (5-8): Subject matter, documentary type
2. Secondary (8-12): Related topics, people featured
3. Long-tail (10-15): "[Subject] documentary", "the story of [topic]"
4. Trending (5-10): Current documentary trends`
    };
  }

  // ============================================================
  // REVIEW/PRODUCT CONTENT
  // ============================================================
  if (type === 'review') {
    return {
      titleInstructions: `
REVIEW CONTENT DETECTED.
Create REVIEW-appropriate titles:
- Include product/item name clearly
- Use review hooks: "Honest Review", "Worth It?", "Unboxing", etc.
- Be specific about what's being reviewed`,

      descriptionInstructions: `
REVIEW CONTENT - Create a REVIEW description:

Include:
1. 📦 Product/item details (name, specs, price)
2. ✅ Pros and cons summary
3. ⭐ Rating or verdict
4. ⏱️ Timestamps for different aspects
5. 🔗 Links to purchase, affiliate links (disclosed)
6. Review hashtags (#Review #Unboxing #[Product])`,

      tagsInstructions: `
REVIEW CONTENT - Generate REVIEW tags:

1. Primary (5-8): Product name, brand, category
2. Secondary (8-12): Specs, features, alternatives
3. Long-tail (10-15): "[Product] review 2024", "[Brand] unboxing"
4. Trending (5-10): Current product trends`
    };
  }

  // ============================================================
  // PODCAST/INTERVIEW CONTENT
  // ============================================================
  if (type === 'podcast') {
    return {
      titleInstructions: `
PODCAST/INTERVIEW CONTENT DETECTED.
Create PODCAST-appropriate titles:
- Include podcast name and episode info
- Feature guest name prominently if applicable
- Highlight the main topic or most interesting point`,

      descriptionInstructions: `
PODCAST CONTENT - Create a PODCAST description:

Include:
1. 🎙️ Podcast name and episode number
2. 👤 Guest introduction and credentials
3. 📋 Topics discussed
4. ⏱️ Timestamps for different topics
5. 🔗 Links to podcast platforms, guest socials
6. Podcast hashtags (#Podcast #[PodcastName] #[Topic])`,

      tagsInstructions: `
PODCAST CONTENT - Generate PODCAST tags:

1. Primary (5-8): Podcast name, guest name, main topic
2. Secondary (8-12): Topics discussed, related podcasts
3. Long-tail (10-15): "[Guest] interview", "[Topic] podcast"
4. Trending (5-10): Current podcast trends, trending topics`
    };
  }

  // ============================================================
  // DEFAULT - GENERAL CONTENT
  // ============================================================
  return {
    titleInstructions: `
Analyze the video content carefully and create titles appropriate for its actual subject matter.
- Match the tone and style to the content
- Be specific about what the video contains
- Avoid generic or mismatched terminology`,

    descriptionInstructions: `
Create a description that accurately represents the video content:
- Summarize the main content/topic
- Include relevant timestamps
- Add appropriate links and hashtags
- Match the description style to the content type`,

    tagsInstructions: `
Create tags relevant to the actual video content:
- Focus on the specific topic/subject
- Include relevant terminology for that niche
- Add trending tags related to the content
- Avoid generic or mismatched tags`
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
    const resetIntervalMs = resetMinutes * 60 * 1000;

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
          warpOptimizer: { usedToday: 0, limit: 3, lastResetAt: admin.firestore.FieldValue.serverTimestamp() },
          competitorAnalysis: { usedToday: 0, limit: 3, lastResetAt: admin.firestore.FieldValue.serverTimestamp() },
          trendPredictor: { usedToday: 0, limit: 3, lastResetAt: admin.firestore.FieldValue.serverTimestamp() },
          thumbnailGenerator: { usedToday: 0, limit: 3, lastResetAt: admin.firestore.FieldValue.serverTimestamp() },
          channelAudit: { usedToday: 0, limit: 3, lastResetAt: admin.firestore.FieldValue.serverTimestamp() }
        }
      };
      await userRef.set(userData);
      // Re-fetch to get the server timestamps
      const newSnap = await userRef.get();
      userData = newSnap.data();
    } else {
      userData = userSnap.data();
    }

    // Build quotaInfo with bonus uses included
    const tools = ['warpOptimizer', 'competitorAnalysis', 'trendPredictor', 'thumbnailGenerator', 'channelAudit'];
    const quotaInfo = {};
    const now = Date.now();

    // Ensure userData.usage has all tool keys (for existing users with old structure)
    if (!userData.usage) {
      userData.usage = {};
    }

    // Track if any updates are needed
    const updates = {};

    for (const tool of tools) {
      // Add default usage data for missing tools
      if (!userData.usage[tool]) {
        userData.usage[tool] = { usedToday: 0, limit: 2 };
        updates[`usage.${tool}.usedToday`] = 0;
        updates[`usage.${tool}.limit`] = 2;
        updates[`usage.${tool}.lastResetAt`] = admin.firestore.FieldValue.serverTimestamp();
      }

      const usage = userData.usage[tool];
      const bonusUses = userData.bonusUses?.[tool] || 0;
      const baseLimit = usage.limit || 2;
      const totalLimit = baseLimit + bonusUses;

      // Calculate last reset time in milliseconds
      let lastResetTime = 0;
      if (usage.lastResetAt) {
        if (usage.lastResetAt.toMillis) {
          lastResetTime = usage.lastResetAt.toMillis();
        } else if (typeof usage.lastResetAt === 'string') {
          lastResetTime = new Date(usage.lastResetAt).getTime();
        } else if (typeof usage.lastResetAt === 'object') {
          lastResetTime = (usage.lastResetAt.seconds || usage.lastResetAt._seconds || 0) * 1000;
        }
      }

      // Check if quota should be reset
      const nextResetMs = lastResetTime + resetIntervalMs;
      let usedToday = usage.usedToday || 0;

      if (lastResetTime > 0 && now >= nextResetMs) {
        // Quota should be reset - update in database
        updates[`usage.${tool}.usedToday`] = 0;
        updates[`usage.${tool}.lastResetAt`] = admin.firestore.FieldValue.serverTimestamp();
        usedToday = 0;
        // New next reset will be from now
        quotaInfo[tool] = {
          baseLimit: baseLimit,
          bonusUses: bonusUses,
          totalLimit: totalLimit,
          usedToday: 0,
          remaining: totalLimit,
          nextResetMs: now + resetIntervalMs
        };
      } else {
        quotaInfo[tool] = {
          baseLimit: baseLimit,
          bonusUses: bonusUses,
          totalLimit: totalLimit,
          usedToday: usedToday,
          remaining: Math.max(0, totalLimit - usedToday),
          nextResetMs: lastResetTime > 0 ? nextResetMs : now + resetIntervalMs
        };
      }
    }

    // Apply any pending updates
    if (Object.keys(updates).length > 0) {
      await userRef.update(updates);
    }

    // Convert Firestore Timestamps to ISO strings for serialization
    if (userData.createdAt?.toDate) userData.createdAt = userData.createdAt.toDate().toISOString();
    if (userData.lastLoginAt?.toDate) userData.lastLoginAt = userData.lastLoginAt.toDate().toISOString();
    if (userData.subscription?.startDate?.toDate) userData.subscription.startDate = userData.subscription.startDate.toDate().toISOString();

    // Convert usage timestamps
    tools.forEach(tool => {
      if (userData.usage?.[tool]?.lastResetAt?.toDate) {
        userData.usage[tool].lastResetAt = userData.usage[tool].lastResetAt.toDate().toISOString();
      }
    });

    return {
      success: true,
      profile: userData,
      quotaInfo: quotaInfo,
      resetTimeMinutes: resetMinutes
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
    const searchQuery = safeData.search || null;
    const verifiedFilter = safeData.verifiedOnly || false;

    let query = db.collection('users').orderBy('createdAt', 'desc').limit(limitCount);
    if (planFilter && planFilter !== 'all') {
      query = query.where('subscription.plan', '==', planFilter);
    }

    const snapshot = await query.get();
    let users = [];

    snapshot.forEach(doc => {
      const userData = doc.data();

      // Calculate subscription status
      let subscriptionStatus = 'free';
      const plan = userData.subscription?.plan || 'free';
      const endDate = userData.subscription?.endDate;

      if (plan !== 'free') {
        if (!endDate) {
          subscriptionStatus = 'lifetime';
        } else {
          const endDateMs = endDate.toDate ? endDate.toDate().getTime() : endDate;
          const now = Date.now();
          const daysLeft = Math.ceil((endDateMs - now) / (1000 * 60 * 60 * 24));

          if (daysLeft < 0) {
            subscriptionStatus = 'expired';
          } else if (daysLeft <= 7) {
            subscriptionStatus = 'expiring';
          } else {
            subscriptionStatus = 'active';
          }
        }
      }

      users.push({
        uid: doc.id,
        email: userData.email || '',
        displayName: userData.displayName || '',
        clientAlias: userData.clientAlias || '',
        isFiverrVerified: userData.isFiverrVerified || false,
        adminNotes: userData.adminNotes || '',
        subscription: {
          ...(userData.subscription || { plan: 'free' }),
          endDate: userData.subscription?.endDate?.toDate?.()?.toISOString() || null,
          startDate: userData.subscription?.startDate?.toDate?.()?.toISOString() || null
        },
        subscriptionStatus,
        usage: userData.usage || {},
        bonusUses: userData.bonusUses || {},
        isAdmin: userData.isAdmin || false,
        createdAt: userData.createdAt?.toDate?.()?.toISOString() || null,
        lastLoginAt: userData.lastLoginAt?.toDate?.()?.toISOString() || null
      });
    });

    // Apply client-side filters (search and verified)
    if (searchQuery && searchQuery.trim()) {
      const search = searchQuery.toLowerCase().trim();
      users = users.filter(u =>
        (u.email && u.email.toLowerCase().includes(search)) ||
        (u.clientAlias && u.clientAlias.toLowerCase().includes(search)) ||
        (u.uid && u.uid.toLowerCase().includes(search))
      );
    }

    if (verifiedFilter) {
      users = users.filter(u => u.isFiverrVerified);
    }

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
// ADMIN: Client Management Functions
// ==============================================

// Update user subscription with duration (calculates endDate)
exports.adminUpdateUserSubscription = functions.https.onCall(async (data, context) => {
  const adminUid = await requireAdmin(context);

  const { userId, plan, duration } = data || {};

  if (!userId) throw new functions.https.HttpsError('invalid-argument', 'User ID required');
  if (!plan) throw new functions.https.HttpsError('invalid-argument', 'Plan required');

  // Validate plan
  const validPlans = ['free', 'lite', 'pro', 'enterprise'];
  if (!validPlans.includes(plan)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid plan');
  }

  // Validate duration
  const validDurations = ['week', 'month', '3months', 'year', 'lifetime', null];
  if (duration && !validDurations.includes(duration)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid duration');
  }

  // Verify user exists
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  // Get plan limits
  const planDoc = await db.collection('subscriptionPlans').doc(plan).get();
  const planLimits = planDoc.exists ? planDoc.data()?.limits || {} : {};
  const defaultToolLimit = 2;

  // Calculate end date based on duration
  let endDate = null;
  const now = new Date();

  if (plan !== 'free' && duration && duration !== 'lifetime') {
    switch (duration) {
      case 'week':
        endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        break;
      case '3months':
        endDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
        break;
      case 'year':
        endDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
        break;
    }
  }

  // Build update object
  const updateData = {
    'subscription.plan': plan,
    'subscription.status': plan === 'free' ? 'free' : 'active',
    'subscription.startDate': admin.firestore.FieldValue.serverTimestamp(),
    'subscription.endDate': endDate ? admin.firestore.Timestamp.fromDate(endDate) : null,
    'subscription.duration': duration || null,
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
  };

  await db.collection('users').doc(userId).update(updateData);

  await logUsage(userId, 'subscription_updated_by_admin', {
    plan,
    duration,
    endDate: endDate ? endDate.toISOString() : null,
    changedBy: adminUid
  });

  return {
    success: true,
    message: `Subscription updated to ${plan}` + (duration ? ` for ${duration}` : ''),
    endDate: endDate ? endDate.toISOString() : null
  };
});

// Set client alias (Fiverr username)
exports.adminSetClientAlias = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const { userId, alias } = data || {};

  if (!userId) throw new functions.https.HttpsError('invalid-argument', 'User ID required');

  // Verify user exists
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  // Sanitize alias (alphanumeric, underscores, max 50 chars)
  const sanitizedAlias = (alias || '').trim().substring(0, 50);

  await db.collection('users').doc(userId).update({
    clientAlias: sanitizedAlias
  });

  return { success: true, message: 'Client alias updated' };
});

// Toggle Fiverr verified status
exports.adminSetFiverrVerified = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const { userId, verified } = data || {};

  if (!userId) throw new functions.https.HttpsError('invalid-argument', 'User ID required');
  if (typeof verified !== 'boolean') throw new functions.https.HttpsError('invalid-argument', 'Verified status must be boolean');

  // Verify user exists
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  await db.collection('users').doc(userId).update({
    isFiverrVerified: verified
  });

  return { success: true, message: verified ? 'User marked as Fiverr verified' : 'Fiverr verification removed' };
});

// Update admin notes for a user
exports.adminUpdateUserNotes = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const { userId, notes } = data || {};

  if (!userId) throw new functions.https.HttpsError('invalid-argument', 'User ID required');

  // Verify user exists
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  // Sanitize notes (max 2000 chars)
  const sanitizedNotes = (notes || '').substring(0, 2000);

  await db.collection('users').doc(userId).update({
    adminNotes: sanitizedNotes
  });

  return { success: true, message: 'Notes updated' };
});

// Extend subscription by duration (quick action)
exports.adminExtendSubscription = functions.https.onCall(async (data, context) => {
  const adminUid = await requireAdmin(context);

  const { userId, extensionDays } = data || {};

  if (!userId) throw new functions.https.HttpsError('invalid-argument', 'User ID required');
  if (!extensionDays || extensionDays < 1 || extensionDays > 365) {
    throw new functions.https.HttpsError('invalid-argument', 'Extension days must be between 1 and 365');
  }

  // Verify user exists
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  const userData = userDoc.data();
  const currentPlan = userData.subscription?.plan || 'free';

  if (currentPlan === 'free') {
    throw new functions.https.HttpsError('failed-precondition', 'Cannot extend free plan. Set a paid plan first.');
  }

  // Calculate new end date
  let baseDate = new Date();
  if (userData.subscription?.endDate) {
    const existingEnd = userData.subscription.endDate.toDate();
    // If existing end date is in the future, extend from there
    if (existingEnd > baseDate) {
      baseDate = existingEnd;
    }
  }

  const newEndDate = new Date(baseDate.getTime() + extensionDays * 24 * 60 * 60 * 1000);

  await db.collection('users').doc(userId).update({
    'subscription.endDate': admin.firestore.Timestamp.fromDate(newEndDate),
    'subscription.status': 'active'
  });

  await logUsage(userId, 'subscription_extended', {
    extensionDays,
    newEndDate: newEndDate.toISOString(),
    extendedBy: adminUid
  });

  return {
    success: true,
    message: `Subscription extended by ${extensionDays} days`,
    newEndDate: newEndDate.toISOString()
  };
});

// Scheduled function: Check expired subscriptions daily and revert to free
// Runs every day at midnight UTC
exports.checkExpiredSubscriptions = functions.pubsub
  .schedule('0 0 * * *')
  .timeZone('UTC')
  .onRun(async (context) => {
    console.log('Running subscription expiry check...');

    const now = admin.firestore.Timestamp.now();
    let expiredCount = 0;
    let expiringCount = 0;

    try {
      // Find users with expired subscriptions (endDate < now and plan != free)
      const expiredSnapshot = await db.collection('users')
        .where('subscription.endDate', '<', now)
        .where('subscription.plan', '!=', 'free')
        .get();

      const batch = db.batch();

      for (const doc of expiredSnapshot.docs) {
        const userData = doc.data();
        const plan = userData.subscription?.plan;

        // Skip if already free
        if (plan === 'free') continue;

        console.log(`Expiring subscription for user: ${doc.id} (was ${plan})`);

        // Revert to free plan
        batch.update(doc.ref, {
          'subscription.plan': 'free',
          'subscription.status': 'expired',
          'subscription.previousPlan': plan,
          'subscription.expiredAt': admin.firestore.FieldValue.serverTimestamp(),
          // Reset usage limits to free tier
          'usage.warpOptimizer.limit': 2,
          'usage.competitorAnalysis.limit': 2,
          'usage.trendPredictor.limit': 2,
          'usage.thumbnailGenerator.limit': 2
        });

        expiredCount++;
      }

      if (expiredCount > 0) {
        await batch.commit();
      }

      // Log results
      console.log(`Subscription expiry check complete. Expired: ${expiredCount}`);

      // Optional: Find users expiring in 7 days for potential notification
      const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const expiringSnapshot = await db.collection('users')
        .where('subscription.endDate', '>', now)
        .where('subscription.endDate', '<', admin.firestore.Timestamp.fromDate(sevenDaysFromNow))
        .where('subscription.plan', '!=', 'free')
        .get();

      expiringCount = expiringSnapshot.size;
      console.log(`Users expiring in 7 days: ${expiringCount}`);

      return { expiredCount, expiringCount };

    } catch (error) {
      console.error('Subscription expiry check error:', error);
      throw error;
    }
  });

// Manual trigger for subscription expiry check (admin only)
exports.adminCheckExpiredSubscriptions = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const now = admin.firestore.Timestamp.now();
  let expiredCount = 0;
  const expiredUsers = [];

  try {
    // Find users with expired subscriptions
    const expiredSnapshot = await db.collection('users')
      .where('subscription.plan', '!=', 'free')
      .get();

    const batch = db.batch();

    for (const doc of expiredSnapshot.docs) {
      const userData = doc.data();
      const endDate = userData.subscription?.endDate;

      // Skip if no end date (lifetime) or end date is in the future
      if (!endDate) continue;
      const endDateMs = endDate.toDate ? endDate.toDate().getTime() : endDate;
      if (endDateMs > now.toMillis()) continue;

      const plan = userData.subscription?.plan;
      if (plan === 'free') continue;

      expiredUsers.push({
        uid: doc.id,
        email: userData.email || '',
        previousPlan: plan,
        expiredAt: endDate.toDate ? endDate.toDate().toISOString() : null
      });

      // Revert to free plan
      batch.update(doc.ref, {
        'subscription.plan': 'free',
        'subscription.status': 'expired',
        'subscription.previousPlan': plan,
        'subscription.expiredAt': admin.firestore.FieldValue.serverTimestamp(),
        'usage.warpOptimizer.limit': 2,
        'usage.competitorAnalysis.limit': 2,
        'usage.trendPredictor.limit': 2,
        'usage.thumbnailGenerator.limit': 2
      });

      expiredCount++;
    }

    if (expiredCount > 0) {
      await batch.commit();
    }

    return {
      success: true,
      message: `Processed ${expiredCount} expired subscriptions`,
      expiredCount,
      expiredUsers
    };

  } catch (error) {
    console.error('Manual expiry check error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to check expired subscriptions');
  }
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

// =============================================
// TOKEN SYSTEM FUNCTIONS
// =============================================

// Get API cost configuration
exports.adminGetApiCosts = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const costsDoc = await db.collection('settings').doc('apiCosts').get();

    // Default API costs if not configured
    const defaultCosts = {
      modules: {
        warpOptimizer: {
          name: 'Warp Optimizer',
          provider: 'OpenAI',
          apiModel: 'gpt-4',
          estimatedCostUSD: 0.035,
          tokenCost: 5,
          markupPercent: 200
        },
        competitorAnalysis: {
          name: 'Competitor Analysis',
          provider: 'OpenAI + YouTube',
          apiModel: 'gpt-4 + YouTube Data API',
          estimatedCostUSD: 0.04,
          tokenCost: 6,
          markupPercent: 200
        },
        trendPredictor: {
          name: 'Trend Predictor',
          provider: 'OpenAI + YouTube',
          apiModel: 'gpt-4 + YouTube Data API',
          estimatedCostUSD: 0.035,
          tokenCost: 5,
          markupPercent: 200
        },
        thumbnailGenerator: {
          name: 'AI Thumbnails',
          provider: 'Google Imagen / OpenAI',
          apiModel: 'Imagen 4 / DALL-E 3',
          estimatedCostUSD: 0.08,
          tokenCost: 10,
          markupPercent: 150
        },
        channelAudit: {
          name: 'Channel Audit',
          provider: 'OpenAI + YouTube',
          apiModel: 'gpt-4 + YouTube Data API',
          estimatedCostUSD: 0.05,
          tokenCost: 8,
          markupPercent: 200
        }
      },
      lastUpdated: null
    };

    if (!costsDoc.exists) {
      return { success: true, costs: defaultCosts };
    }

    return { success: true, costs: { ...defaultCosts, ...costsDoc.data() } };
  } catch (error) {
    console.error('adminGetApiCosts error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to get API costs'));
  }
});

// Update API cost configuration
exports.adminUpdateApiCosts = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const { modules } = data || {};
    if (!modules || typeof modules !== 'object') {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid modules configuration');
    }

    // Validate each module configuration
    const validModules = ['warpOptimizer', 'competitorAnalysis', 'trendPredictor', 'thumbnailGenerator', 'channelAudit'];
    const sanitizedModules = {};

    for (const [moduleId, config] of Object.entries(modules)) {
      if (!validModules.includes(moduleId)) continue;

      sanitizedModules[moduleId] = {
        name: config.name || moduleId,
        provider: config.provider || 'Unknown',
        apiModel: config.apiModel || 'Unknown',
        estimatedCostUSD: parseFloat(config.estimatedCostUSD) || 0,
        tokenCost: parseInt(config.tokenCost) || 1,
        markupPercent: parseInt(config.markupPercent) || 100
      };
    }

    await db.collection('settings').doc('apiCosts').set({
      modules: sanitizedModules,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: context.auth.uid
    }, { merge: true });

    return { success: true, message: 'API costs updated successfully' };
  } catch (error) {
    console.error('adminUpdateApiCosts error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to update API costs'));
  }
});

// Get token configuration for plans
exports.adminGetTokenConfig = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const tokenConfigDoc = await db.collection('settings').doc('tokenConfig').get();

    // Default token allocation per plan
    const defaultConfig = {
      plans: {
        free: { monthlyTokens: 10, rolloverPercent: 0 },
        lite: { monthlyTokens: 50, rolloverPercent: 25 },
        pro: { monthlyTokens: 200, rolloverPercent: 50 },
        enterprise: { monthlyTokens: 1000, rolloverPercent: 100 }
      },
      lastUpdated: null
    };

    if (!tokenConfigDoc.exists) {
      return { success: true, config: defaultConfig };
    }

    return { success: true, config: { ...defaultConfig, ...tokenConfigDoc.data() } };
  } catch (error) {
    console.error('adminGetTokenConfig error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to get token configuration'));
  }
});

// Update token configuration for plans
exports.adminUpdateTokenConfig = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const { plans } = data || {};
    if (!plans || typeof plans !== 'object') {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid plans configuration');
    }

    const validPlans = ['free', 'lite', 'pro', 'enterprise'];
    const sanitizedPlans = {};

    for (const [planId, config] of Object.entries(plans)) {
      if (!validPlans.includes(planId)) continue;

      sanitizedPlans[planId] = {
        monthlyTokens: parseInt(config.monthlyTokens) || 0,
        rolloverPercent: Math.min(100, Math.max(0, parseInt(config.rolloverPercent) || 0))
      };
    }

    await db.collection('settings').doc('tokenConfig').set({
      plans: sanitizedPlans,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: context.auth.uid
    }, { merge: true });

    return { success: true, message: 'Token configuration updated successfully' };
  } catch (error) {
    console.error('adminUpdateTokenConfig error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to update token configuration'));
  }
});

// Add/Remove tokens from a user (manual adjustment)
exports.adminAdjustUserTokens = functions.https.onCall(async (data, context) => {
  try {
    const adminId = await requireAdmin(context);

    const { userId, amount, reason } = data || {};

    if (!userId || typeof userId !== 'string') {
      throw new functions.https.HttpsError('invalid-argument', 'Valid user ID is required');
    }

    const tokenAmount = parseInt(amount);
    if (isNaN(tokenAmount) || tokenAmount === 0) {
      throw new functions.https.HttpsError('invalid-argument', 'Token amount must be a non-zero number');
    }

    // Check if user exists
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User not found');
    }

    const userData = userDoc.data();
    const currentBalance = userData.tokens?.balance || 0;
    const newBalance = Math.max(0, currentBalance + tokenAmount);

    // Update user token balance
    await db.collection('users').doc(userId).set({
      tokens: {
        balance: newBalance,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      }
    }, { merge: true });

    // Log the transaction
    await db.collection('tokenTransactions').add({
      userId,
      type: tokenAmount > 0 ? 'admin_credit' : 'admin_debit',
      amount: tokenAmount,
      balanceAfter: newBalance,
      reason: reason || 'Manual adjustment by admin',
      performedBy: adminId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      message: `${tokenAmount > 0 ? 'Added' : 'Removed'} ${Math.abs(tokenAmount)} tokens`,
      newBalance
    };
  } catch (error) {
    console.error('adminAdjustUserTokens error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to adjust tokens'));
  }
});

// Get user token balance and history
exports.getUserTokenInfo = functions.https.onCall(async (data, context) => {
  try {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }

    const userId = context.auth.uid;
    const userDoc = await db.collection('users').doc(userId).get();

    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User not found');
    }

    const userData = userDoc.data();
    const tokens = userData.tokens || { balance: 0 };

    // Get recent transactions
    const transactionsSnapshot = await db.collection('tokenTransactions')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    const transactions = [];
    transactionsSnapshot.forEach(doc => {
      const data = doc.data();
      transactions.push({
        id: doc.id,
        type: data.type,
        amount: data.amount,
        balanceAfter: data.balanceAfter,
        reason: data.reason,
        createdAt: data.createdAt?.toMillis() || Date.now()
      });
    });

    return {
      success: true,
      tokens: {
        balance: tokens.balance || 0,
        lastRefill: tokens.lastRefillAt?.toMillis() || null,
        rolloverAmount: tokens.rolloverAmount || 0
      },
      transactions
    };
  } catch (error) {
    console.error('getUserTokenInfo error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to get token info'));
  }
});

// Admin get all token transactions (for audit)
exports.adminGetTokenTransactions = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const { limit: queryLimit = 100, userId, type } = data || {};

    // Build query with filters first, then orderBy (Firestore requirement)
    let query = db.collection('tokenTransactions');

    if (userId) {
      query = query.where('userId', '==', userId);
    }
    if (type) {
      query = query.where('type', '==', type);
    }

    // Add orderBy last
    query = query.orderBy('createdAt', 'desc');

    const snapshot = await query.limit(Math.min(queryLimit, 500)).get();

    const transactions = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();

      // Get user email for display
      let userEmail = 'Unknown';
      try {
        const userDoc = await db.collection('users').doc(data.userId).get();
        if (userDoc.exists) {
          userEmail = userDoc.data().email || 'No email';
        }
      } catch (e) { /* ignore */ }

      transactions.push({
        id: doc.id,
        userId: data.userId,
        userEmail,
        type: data.type,
        amount: data.amount,
        balanceAfter: data.balanceAfter,
        reason: data.reason,
        performedBy: data.performedBy,
        createdAt: data.createdAt?.toMillis() || Date.now()
      });
    }

    return { success: true, transactions };
  } catch (error) {
    console.error('adminGetTokenTransactions error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to get transactions'));
  }
});

// =============================================
// PROMO CODE SYSTEM
// =============================================

// Create a promo code
exports.adminCreatePromoCode = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const { code, tokenAmount, maxUses, expiresAt, description } = data || {};

    if (!code || typeof code !== 'string' || code.length < 3) {
      throw new functions.https.HttpsError('invalid-argument', 'Code must be at least 3 characters');
    }

    const tokens = parseInt(tokenAmount);
    if (isNaN(tokens) || tokens < 1) {
      throw new functions.https.HttpsError('invalid-argument', 'Token amount must be at least 1');
    }

    // Check if code already exists
    const existingCode = await db.collection('promoCodes').doc(code.toUpperCase()).get();
    if (existingCode.exists) {
      throw new functions.https.HttpsError('already-exists', 'This promo code already exists');
    }

    await db.collection('promoCodes').doc(code.toUpperCase()).set({
      code: code.toUpperCase(),
      tokenAmount: tokens,
      maxUses: parseInt(maxUses) || 0, // 0 = unlimited
      usedCount: 0,
      usedBy: [],
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      description: description || '',
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: context.auth.uid
    });

    return { success: true, message: `Promo code ${code.toUpperCase()} created` };
  } catch (error) {
    console.error('adminCreatePromoCode error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to create promo code'));
  }
});

// Get all promo codes
exports.adminGetPromoCodes = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const snapshot = await db.collection('promoCodes').orderBy('createdAt', 'desc').get();

    const codes = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      codes.push({
        id: doc.id,
        code: data.code,
        tokenAmount: data.tokenAmount,
        maxUses: data.maxUses,
        usedCount: data.usedCount,
        expiresAt: data.expiresAt?.toMillis() || null,
        description: data.description,
        isActive: data.isActive,
        createdAt: data.createdAt?.toMillis() || Date.now()
      });
    });

    return { success: true, codes };
  } catch (error) {
    console.error('adminGetPromoCodes error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to get promo codes'));
  }
});

// Toggle promo code active status
exports.adminTogglePromoCode = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const { code, isActive } = data || {};
    if (!code) {
      throw new functions.https.HttpsError('invalid-argument', 'Code is required');
    }

    await db.collection('promoCodes').doc(code.toUpperCase()).update({
      isActive: !!isActive,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, message: `Promo code ${isActive ? 'activated' : 'deactivated'}` };
  } catch (error) {
    console.error('adminTogglePromoCode error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to update promo code'));
  }
});

// Redeem a promo code (user function)
exports.redeemPromoCode = functions.https.onCall(async (data, context) => {
  try {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
    }

    const userId = context.auth.uid;
    const { code } = data || {};

    if (!code || typeof code !== 'string') {
      throw new functions.https.HttpsError('invalid-argument', 'Valid promo code is required');
    }

    const codeDoc = await db.collection('promoCodes').doc(code.toUpperCase()).get();

    if (!codeDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Invalid promo code');
    }

    const codeData = codeDoc.data();

    // Validate code
    if (!codeData.isActive) {
      throw new functions.https.HttpsError('failed-precondition', 'This promo code is no longer active');
    }

    if (codeData.expiresAt && codeData.expiresAt.toDate() < new Date()) {
      throw new functions.https.HttpsError('failed-precondition', 'This promo code has expired');
    }

    if (codeData.maxUses > 0 && codeData.usedCount >= codeData.maxUses) {
      throw new functions.https.HttpsError('failed-precondition', 'This promo code has reached its usage limit');
    }

    if (codeData.usedBy && codeData.usedBy.includes(userId)) {
      throw new functions.https.HttpsError('failed-precondition', 'You have already used this promo code');
    }

    // Get current user balance
    const userDoc = await db.collection('users').doc(userId).get();
    const currentBalance = userDoc.exists ? (userDoc.data().tokens?.balance || 0) : 0;
    const newBalance = currentBalance + codeData.tokenAmount;

    // Update user balance
    await db.collection('users').doc(userId).set({
      tokens: {
        balance: newBalance,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      }
    }, { merge: true });

    // Mark code as used
    await db.collection('promoCodes').doc(code.toUpperCase()).update({
      usedCount: admin.firestore.FieldValue.increment(1),
      usedBy: admin.firestore.FieldValue.arrayUnion(userId)
    });

    // Log transaction
    await db.collection('tokenTransactions').add({
      userId,
      type: 'promo_redemption',
      amount: codeData.tokenAmount,
      balanceAfter: newBalance,
      reason: `Redeemed promo code: ${code.toUpperCase()}`,
      promoCode: code.toUpperCase(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      message: `Successfully redeemed ${codeData.tokenAmount} tokens!`,
      tokensAdded: codeData.tokenAmount,
      newBalance
    };
  } catch (error) {
    console.error('redeemPromoCode error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to redeem promo code'));
  }
});

// =============================================
// REVENUE & ANALYTICS
// =============================================

// Get revenue and cost analytics
exports.adminGetAnalytics = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const { period = '30d' } = data || {};

    // Calculate date range
    const now = new Date();
    let startDate;
    switch (period) {
      case '7d': startDate = new Date(now - 7 * 24 * 60 * 60 * 1000); break;
      case '30d': startDate = new Date(now - 30 * 24 * 60 * 60 * 1000); break;
      case '90d': startDate = new Date(now - 90 * 24 * 60 * 60 * 1000); break;
      default: startDate = new Date(now - 30 * 24 * 60 * 60 * 1000);
    }

    // Get API costs config
    const costsDoc = await db.collection('settings').doc('apiCosts').get();
    const apiCosts = costsDoc.exists ? costsDoc.data().modules || {} : {};

    // Get usage logs for the period
    const usageSnapshot = await db.collection('usageLogs')
      .where('timestamp', '>=', startDate)
      .orderBy('timestamp', 'desc')
      .limit(10000)
      .get();

    // Calculate usage by module
    const usageByModule = {};
    const usageByDay = {};
    let totalApiCost = 0;
    let totalTokensUsed = 0;

    usageSnapshot.forEach(doc => {
      const data = doc.data();
      const tool = data.tool || 'unknown';
      const date = data.timestamp?.toDate().toISOString().split('T')[0] || 'unknown';

      // Count by module
      usageByModule[tool] = (usageByModule[tool] || 0) + 1;

      // Count by day
      if (!usageByDay[date]) usageByDay[date] = {};
      usageByDay[date][tool] = (usageByDay[date][tool] || 0) + 1;

      // Calculate costs
      const moduleCost = apiCosts[tool]?.estimatedCostUSD || 0.03;
      const tokenCost = apiCosts[tool]?.tokenCost || 5;
      totalApiCost += moduleCost;
      totalTokensUsed += tokenCost;
    });

    // Get user stats
    const usersSnapshot = await db.collection('users').get();
    let totalUsers = 0;
    let paidUsers = 0;
    const planCounts = { free: 0, lite: 0, pro: 0, enterprise: 0 };

    usersSnapshot.forEach(doc => {
      totalUsers++;
      const plan = doc.data().subscription?.plan || 'free';
      planCounts[plan] = (planCounts[plan] || 0) + 1;
      if (plan !== 'free') paidUsers++;
    });

    // Calculate estimated revenue (based on plan prices)
    const planPrices = { free: 0, lite: 9.99, pro: 19.99, enterprise: 49.99 };
    const estimatedMonthlyRevenue = Object.entries(planCounts)
      .reduce((sum, [plan, count]) => sum + (planPrices[plan] || 0) * count, 0);

    return {
      success: true,
      analytics: {
        period,
        users: {
          total: totalUsers,
          paid: paidUsers,
          byPlan: planCounts
        },
        usage: {
          totalCalls: usageSnapshot.size,
          byModule: usageByModule,
          byDay: usageByDay
        },
        costs: {
          estimatedApiCost: Math.round(totalApiCost * 100) / 100,
          totalTokensUsed
        },
        revenue: {
          estimatedMonthly: Math.round(estimatedMonthlyRevenue * 100) / 100,
          profitMargin: totalApiCost > 0 ?
            Math.round((1 - totalApiCost / estimatedMonthlyRevenue) * 10000) / 100 : 100
        }
      }
    };
  } catch (error) {
    console.error('adminGetAnalytics error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to get analytics'));
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
          thumbnailGenerator: { dailyLimit: 3, cooldownHours: 0 },
          channelAudit: { dailyLimit: 2, cooldownHours: 0 }
        }
      },
      lite: {
        name: 'Lite',
        price: 9.99,
        limits: {
          warpOptimizer: { dailyLimit: 5, cooldownHours: 0 },
          competitorAnalysis: { dailyLimit: 5, cooldownHours: 0 },
          trendPredictor: { dailyLimit: 5, cooldownHours: 0 },
          thumbnailGenerator: { dailyLimit: 5, cooldownHours: 0 },
          channelAudit: { dailyLimit: 5, cooldownHours: 0 }
        }
      },
      pro: {
        name: 'Pro',
        price: 19.99,
        limits: {
          warpOptimizer: { dailyLimit: 10, cooldownHours: 0 },
          competitorAnalysis: { dailyLimit: 10, cooldownHours: 0 },
          trendPredictor: { dailyLimit: 10, cooldownHours: 0 },
          thumbnailGenerator: { dailyLimit: 10, cooldownHours: 0 },
          channelAudit: { dailyLimit: 10, cooldownHours: 0 }
        }
      },
      enterprise: {
        name: 'Enterprise',
        price: 49.99,
        limits: {
          warpOptimizer: { dailyLimit: 35, cooldownHours: 0 },
          competitorAnalysis: { dailyLimit: 35, cooldownHours: 0 },
          trendPredictor: { dailyLimit: 35, cooldownHours: 0 },
          thumbnailGenerator: { dailyLimit: 35, cooldownHours: 0 },
          channelAudit: { dailyLimit: 35, cooldownHours: 0 }
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

// Get all plan settings for admin panel
exports.adminGetPlanSettings = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const plansSnapshot = await db.collection('subscriptionPlans').orderBy('sortOrder').get();
    const plans = [];

    plansSnapshot.forEach(doc => {
      plans.push({
        id: doc.id,
        ...doc.data()
      });
    });

    return {
      success: true,
      plans: plans
    };
  } catch (error) {
    console.error('adminGetPlanSettings error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to get plan settings.'));
  }
});

// Update limits for a specific plan
exports.adminUpdatePlanLimits = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const { planId, limits } = data || {};

    if (!planId) {
      throw new functions.https.HttpsError('invalid-argument', 'Plan ID is required');
    }

    if (!limits || typeof limits !== 'object') {
      throw new functions.https.HttpsError('invalid-argument', 'Limits object is required');
    }

    // Validate the plan exists
    const planRef = db.collection('subscriptionPlans').doc(planId);
    const planDoc = await planRef.get();

    if (!planDoc.exists) {
      throw new functions.https.HttpsError('not-found', `Plan "${planId}" not found`);
    }

    // Validate and sanitize limits
    const validTools = ['warpOptimizer', 'competitorAnalysis', 'trendPredictor', 'thumbnailGenerator', 'channelAudit'];
    const sanitizedLimits = {};

    for (const [tool, config] of Object.entries(limits)) {
      if (!validTools.includes(tool)) continue;

      const dailyLimit = parseInt(config.dailyLimit);
      const cooldownHours = parseInt(config.cooldownHours || 0);

      if (isNaN(dailyLimit) || dailyLimit < 0 || dailyLimit > 1000) {
        throw new functions.https.HttpsError('invalid-argument', `Invalid daily limit for ${tool}. Must be 0-1000.`);
      }

      if (isNaN(cooldownHours) || cooldownHours < 0 || cooldownHours > 720) {
        throw new functions.https.HttpsError('invalid-argument', `Invalid cooldown for ${tool}. Must be 0-720 hours.`);
      }

      sanitizedLimits[tool] = {
        dailyLimit: dailyLimit,
        cooldownHours: cooldownHours
      };
    }

    // Update the plan
    await planRef.update({
      limits: sanitizedLimits,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      message: `Plan "${planId}" limits updated successfully`,
      planId: planId,
      limits: sanitizedLimits
    };
  } catch (error) {
    console.error('adminUpdatePlanLimits error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to update plan limits.'));
  }
});

// Sync new plan limits to all existing users on that plan
exports.adminSyncExistingUsers = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const { planId } = data || {};

    if (!planId) {
      throw new functions.https.HttpsError('invalid-argument', 'Plan ID is required');
    }

    // Get the plan limits
    const planDoc = await db.collection('subscriptionPlans').doc(planId).get();
    if (!planDoc.exists) {
      throw new functions.https.HttpsError('not-found', `Plan "${planId}" not found`);
    }

    const planLimits = planDoc.data()?.limits || {};

    // Find all users on this plan
    const usersSnapshot = await db.collection('users')
      .where('subscription.plan', '==', planId)
      .get();

    if (usersSnapshot.empty) {
      return {
        success: true,
        message: `No users found on plan "${planId}"`,
        usersUpdated: 0
      };
    }

    // Update users in batches (Firestore limit is 500 per batch)
    const batchSize = 500;
    let usersUpdated = 0;
    let batch = db.batch();
    let batchCount = 0;

    for (const userDoc of usersSnapshot.docs) {
      const userRef = db.collection('users').doc(userDoc.id);
      const updateData = {};

      // Update each tool's limit from the plan
      for (const [tool, config] of Object.entries(planLimits)) {
        updateData[`usage.${tool}.limit`] = config.dailyLimit;
      }

      batch.update(userRef, updateData);
      batchCount++;
      usersUpdated++;

      // Commit batch if it reaches the limit
      if (batchCount >= batchSize) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    }

    // Commit any remaining updates
    if (batchCount > 0) {
      await batch.commit();
    }

    return {
      success: true,
      message: `Successfully synced limits to ${usersUpdated} users on plan "${planId}"`,
      usersUpdated: usersUpdated
    };
  } catch (error) {
    console.error('adminSyncExistingUsers error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to sync users.'));
  }
});

// Note: adminGetAnalytics is defined earlier in the file with comprehensive revenue/cost analytics

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

  // Safe query helper - returns empty array if collection/index doesn't exist
  const safeQuery = async (collectionName) => {
    try {
      return await db.collection(collectionName)
        .where('userId', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(safeLimit)
        .get();
    } catch (e) {
      console.warn(`Query failed for ${collectionName}:`, e.message);
      return { forEach: () => {}, size: 0 }; // Return empty mock snapshot
    }
  };

  try {
    // Fetch from all history collections in parallel (including enterprise tools)
    const [
      optimizationsSnap, competitorSnap, trendSnap, thumbnailSnap,
      placementSnap, channelAuditSnap, viralSnap, monetizationSnap, scriptSnap
    ] = await Promise.all([
      safeQuery('optimizations'),
      safeQuery('competitorHistory'),
      safeQuery('trendHistory'),
      safeQuery('thumbnailHistory'),
      safeQuery('placementFinderHistory'),
      safeQuery('channelAuditHistory'),
      // Enterprise tools
      safeQuery('viralPredictorHistory'),
      safeQuery('monetizationHistory'),
      safeQuery('scriptWriterHistory')
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
      ...formatHistory(placementSnap, 'placement'),
      ...formatHistory(channelAuditSnap, 'channelAudit'),
      // Enterprise tools
      ...formatHistory(viralSnap, 'viral'),
      ...formatHistory(monetizationSnap, 'monetization'),
      ...formatHistory(scriptSnap, 'script')
    ];

    // Sort by timestamp descending
    allHistory.sort((a, b) => b.timestamp - a.timestamp);

    return {
      success: true,
      history: {
        all: allHistory.slice(0, safeLimit * 3),
        optimizations: formatHistory(optimizationsSnap, 'optimization'),
        competitor: formatHistory(competitorSnap, 'competitor'),
        trends: formatHistory(trendSnap, 'trend'),
        thumbnails: formatHistory(thumbnailSnap, 'thumbnail'),
        placements: formatHistory(placementSnap, 'placement'),
        channelAudit: formatHistory(channelAuditSnap, 'channelAudit'),
        // Enterprise tools
        viral: formatHistory(viralSnap, 'viral'),
        monetization: formatHistory(monetizationSnap, 'monetization'),
        scripts: formatHistory(scriptSnap, 'script')
      },
      counts: {
        optimizations: optimizationsSnap.size,
        competitor: competitorSnap.size,
        trends: trendSnap.size,
        thumbnails: thumbnailSnap.size,
        placements: placementSnap.size,
        channelAudit: channelAuditSnap.size,
        // Enterprise tools
        viral: viralSnap.size,
        monetization: monetizationSnap.size,
        scripts: scriptSnap.size
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

/**
 * Delete Channel Audit History Item
 */
exports.deleteChannelAudit = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  const { id } = data || {};
  if (!id) {
    throw new functions.https.HttpsError('invalid-argument', 'History ID is required');
  }

  try {
    const doc = await db.collection('channelAuditHistory').doc(id).get();
    if (!doc.exists || doc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized to delete this item');
    }

    await db.collection('channelAuditHistory').doc(id).delete();
    return { success: true, message: 'Channel audit deleted successfully' };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Delete channel audit error:', error);
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

    const systemPrompt = `You are an expert YouTube channel growth strategist and Google Ads analyst creating a professional client report. Your task is to provide COMPREHENSIVE VISUAL ANALYSIS of the provided campaign screenshots.

## YOUR ROLE
You are preparing a detailed report for a YouTube creator client. This report should demonstrate deep expertise by thoroughly analyzing every visual element in the screenshots - not just extracting numbers, but interpreting what the data MEANS and what the visuals SHOW.

## VISUAL ANALYSIS REQUIREMENTS
For EACH screenshot, you must:
1. **Describe what you see**: Layout, columns, charts, graphs, status indicators, color coding, warning icons
2. **Interpret visual trends**: Are graphs going up/down? What colors indicate? What do status badges mean?
3. **Note all visible text**: Campaign names, video titles, ad group names, labels, column headers
4. **Identify data patterns**: Which metrics stand out? Any anomalies? Comparisons between rows?
5. **Describe the dashboard context**: What Google Ads section is this? What time period? What filters are applied?

## RESPONSE FORMAT
Your response MUST be valid JSON with this exact structure:
{
  "screenshotAnalysis": [
    {
      "imageNumber": 1,
      "description": "Detailed 3-5 sentence description of what this screenshot shows visually - the layout, visible data, charts, colors, and notable elements",
      "keyObservations": ["Specific observation 1", "Specific observation 2", "Specific observation 3"],
      "dataExtracted": "Summary of key metrics visible in this specific image"
    }
  ],
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
    "impressions": "number or null",
    "clicks": "number or null",
    "ctr": "percentage string or null",
    "avgCpc": "currency string or null",
    "cost": "currency string or null",
    "conversions": "number or null",
    "conversionRate": "percentage string or null",
    "costPerConversion": "currency string or null",
    "impressionShare": "percentage string or null"
  },
  "performance": {
    "overall": "Excellent|Good|Average|Needs Improvement|Poor",
    "trend": "Improving|Stable|Declining",
    "highlights": ["array of positive points - reference specific visual evidence from screenshots"],
    "concerns": ["array of concerns - reference specific visual evidence from screenshots"]
  },
  "recommendations": [
    {
      "priority": "High|Medium|Low",
      "category": "Thumbnails|Titles|Descriptions|Content|Posting Schedule|Engagement|SEO|Branding|Analytics",
      "title": "Short recommendation title",
      "description": "Detailed explanation that references what you observed in the screenshots. Connect your advice to specific data points you saw.",
      "expectedImpact": "Expected improvement with specific projections based on current metrics",
      "evidenceFromScreenshots": "Quote or reference the specific data from screenshots that supports this recommendation"
    }
  ],
  "narrativeSummary": "A 4-6 sentence professional narrative summary that weaves together observations from ALL screenshots. Reference specific visuals, trends, and data points. This should read like a professional analyst's assessment, not just a list of numbers.",
  "summary": "2-3 sentence executive summary",
  "nextSteps": "Prioritized immediate actions with specific targets based on current metrics",
  "fiverCTA": "A compelling call-to-action for professional YouTube optimization services"
}

## CRITICAL INSTRUCTIONS
1. **SCREENSHOT ANALYSIS IS MANDATORY**: The "screenshotAnalysis" array must have one entry per image. Describe what you LITERALLY SEE.
2. Extract "YouTube public views" metric - look for columns labeled "YouTube public views" in the screenshots.
3. Extract "Impr." (Impressions), "Video" (video title), "Ad type", and "Status" columns.
4. **Connect recommendations to visual evidence**: Every recommendation should reference specific data you observed.
5. **Be descriptive about charts/graphs**: If you see a performance graph, describe if it trends up, down, has spikes, etc.
6. For recommendations, focus on YOUTUBE CHANNEL IMPROVEMENT:
   - Thumbnail design and optimization
   - Video title strategies (CTR improvement)
   - Description and tags optimization
   - Content quality and watch time
   - Posting schedule and consistency
   - Audience engagement tactics
   - Channel branding and identity
7. Provide at least 4-6 detailed, evidence-based YouTube growth recommendations.
8. The narrativeSummary should tell a STORY about what the screenshots reveal.`;

    const userPrompt = `Analyze these ${images.length} Google Ads campaign screenshot(s)${campaignName ? ` for the "${campaignName}" campaign` : ''}.${additionalContext ? `\n\nAdditional context: ${additionalContext}` : ''}

## REQUIRED ANALYSIS

### Step 1: Visual Description (MOST IMPORTANT)
For each screenshot, describe in detail:
- What dashboard/section is shown
- What columns, metrics, and data are visible
- Any charts, graphs, or visual indicators
- Colors, status badges, icons, or warnings
- The overall layout and what it tells us

### Step 2: Data Extraction
- Find "YouTube public views" - the most important metric
- Extract impressions, video title, ad type, status
- Note any other visible performance metrics

### Step 3: Professional Analysis
- What story do these screenshots tell about the campaign?
- What patterns or trends are visible?
- What should the client understand from this data?

### Step 4: Recommendations
- Provide YouTube CHANNEL growth recommendations (thumbnails, titles, content strategy)
- Connect each recommendation to specific data you observed in the screenshots

Remember: Describe what you SEE, not just what numbers say. The client wants to understand their campaign visually.`;

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
      max_tokens: 6000,
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
        youtubeMetrics: aiAnalysis?.youtubeMetrics || {},
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

// ==============================================
// ENTERPRISE SUITE FUNCTIONS
// ==============================================

/**
 * Channel Audit Pro - Comprehensive channel analysis with SEO health scores
 * Analyzes a YouTube channel and provides detailed growth recommendations
 */
exports.auditChannel = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'auditChannel', 5);
  await checkUsageLimit(uid, 'channelAudit');

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
        part: 'snippet,statistics,brandingSettings,topicDetails,contentDetails',
        id: channelInfo.value
      });
    } else if (channelInfo.type === 'handle') {
      channelResponse = await youtube.channels.list({
        part: 'snippet,statistics,brandingSettings,topicDetails,contentDetails',
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
        part: 'snippet,statistics,brandingSettings,topicDetails,contentDetails',
        id: searchResponse.data.items[0].snippet.channelId
      });
    }

    if (!channelResponse.data.items?.length) {
      throw new functions.https.HttpsError('not-found', 'Channel not found');
    }

    const channel = channelResponse.data.items[0];
    const channelId = channel.id;
    const channelName = channel.snippet.title;
    const channelDescription = channel.snippet.description || '';
    const subscriberCount = parseInt(channel.statistics.subscriberCount) || 0;
    const viewCount = parseInt(channel.statistics.viewCount) || 0;
    const videoCount = parseInt(channel.statistics.videoCount) || 0;
    const channelThumbnail = channel.snippet.thumbnails?.medium?.url || channel.snippet.thumbnails?.default?.url;

    // Step 3: Get recent videos to analyze content strategy
    const videosResponse = await youtube.search.list({
      part: 'snippet',
      channelId: channelId,
      type: 'video',
      order: 'date',
      maxResults: 20
    });

    const recentVideoIds = videosResponse.data.items?.map(v => v.id.videoId).filter(Boolean) || [];

    // Get video statistics
    let videoStats = [];
    if (recentVideoIds.length > 0) {
      const videoDetailsResponse = await youtube.videos.list({
        part: 'statistics,snippet,contentDetails',
        id: recentVideoIds.join(',')
      });
      videoStats = videoDetailsResponse.data.items || [];
    }

    // Calculate basic metrics
    const avgViews = videoStats.length > 0
      ? Math.round(videoStats.reduce((sum, v) => sum + parseInt(v.statistics.viewCount || 0), 0) / videoStats.length)
      : 0;
    const avgLikes = videoStats.length > 0
      ? Math.round(videoStats.reduce((sum, v) => sum + parseInt(v.statistics.likeCount || 0), 0) / videoStats.length)
      : 0;
    const avgComments = videoStats.length > 0
      ? Math.round(videoStats.reduce((sum, v) => sum + parseInt(v.statistics.commentCount || 0), 0) / videoStats.length)
      : 0;

    // Calculate engagement rate
    const engagementRate = avgViews > 0 ? ((avgLikes + avgComments) / avgViews * 100).toFixed(2) : 0;

    // Step 4: AI Analysis for comprehensive audit
    const videoTitles = videoStats.slice(0, 10).map(v => v.snippet.title);
    const videoDescriptions = videoStats.slice(0, 5).map(v => (v.snippet.description || '').substring(0, 200));

    const auditPrompt = `You are a YouTube growth expert. Perform a comprehensive channel audit and provide actionable insights.

CHANNEL DATA:
- Name: ${channelName}
- Description: ${channelDescription.substring(0, 500)}
- Subscribers: ${subscriberCount.toLocaleString()}
- Total Views: ${viewCount.toLocaleString()}
- Video Count: ${videoCount}
- Avg Views (recent): ${avgViews.toLocaleString()}
- Avg Likes (recent): ${avgLikes.toLocaleString()}
- Engagement Rate: ${engagementRate}%
- Recent Video Titles: ${videoTitles.join(' | ')}
- Sample Descriptions: ${videoDescriptions.join(' ... ')}

Analyze this channel and respond in this EXACT JSON format:
{
  "scores": {
    "overall": <0-100>,
    "seo": <0-100>,
    "content": <0-100>,
    "engagement": <0-100>,
    "growth": <0-100>
  },
  "analysis": {
    "summary": "2-3 sentence overview of channel health",
    "strengths": ["strength1", "strength2", "strength3"],
    "weaknesses": ["weakness1", "weakness2", "weakness3"]
  },
  "recommendations": [
    {"title": "Action item 1", "description": "Detailed explanation", "priority": "high"},
    {"title": "Action item 2", "description": "Detailed explanation", "priority": "medium"},
    {"title": "Action item 3", "description": "Detailed explanation", "priority": "low"}
  ]
}

Score Guidelines:
- SEO: Title optimization, description quality, tag usage, keyword targeting
- Content: Consistency, video quality indicators, niche focus
- Engagement: Like/comment ratio, community interaction
- Growth: Subscriber trends, view-to-subscriber ratio, potential`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: auditPrompt }],
      temperature: 0.7,
      max_tokens: 1500
    });

    let auditData;
    try {
      const responseText = aiResponse.choices[0].message.content.trim();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      auditData = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (e) {
      // Fallback audit data
      auditData = {
        scores: {
          overall: 65,
          seo: 60,
          content: 70,
          engagement: 65,
          growth: 65
        },
        analysis: {
          summary: `${channelName} has ${subscriberCount.toLocaleString()} subscribers with an average engagement rate of ${engagementRate}%. The channel shows potential for growth with consistent content strategy improvements.`,
          strengths: ['Active content creation', 'Established audience base', 'Consistent posting'],
          weaknesses: ['SEO optimization needed', 'Description could be improved', 'Tag strategy unclear']
        },
        recommendations: [
          { title: 'Optimize video titles for search', description: 'Include target keywords naturally in your titles', priority: 'high' },
          { title: 'Improve description SEO', description: 'Add timestamps, links, and keyword-rich descriptions', priority: 'medium' },
          { title: 'Increase community engagement', description: 'Reply to comments and create community posts', priority: 'low' }
        ]
      };
    }

    // Step 5: Save to history
    const historyData = {
      userId: uid,
      channelUrl,
      channelInfo: {
        id: channelId,
        name: channelName,
        thumbnail: channelThumbnail,
        subscribers: subscriberCount,
        videoCount: videoCount,
        totalViews: viewCount
      },
      scores: auditData.scores,
      analysis: auditData.analysis,
      recommendations: auditData.recommendations,
      metrics: {
        avgViews,
        avgLikes,
        avgComments,
        engagementRate: parseFloat(engagementRate)
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const historyRef = await db.collection('channelAuditHistory').add(historyData);

    // Step 6: Update usage
    await incrementUsage(uid, 'channelAudit');
    await logUsage(uid, 'channel_audit', {
      channelId,
      channelName,
      overallScore: auditData.scores.overall
    });

    return {
      success: true,
      historyId: historyRef.id,
      channelInfo: historyData.channelInfo,
      scores: auditData.scores,
      analysis: auditData.analysis,
      recommendations: auditData.recommendations,
      metrics: historyData.metrics
    };

  } catch (error) {
    console.error('Channel audit error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal',
      sanitizeErrorMessage(error, 'Failed to audit channel. Please try again.'));
  }
});

/**
 * Viral Score Predictor - Predicts viral potential of video content
 * Analyzes title, description, and tags to estimate viral potential
 */
exports.predictViralScore = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'predictViralScore', 10);
  await checkUsageLimit(uid, 'viralPredictor');

  const { title, description, tags } = data;
  if (!title) {
    throw new functions.https.HttpsError('invalid-argument', 'Video title is required');
  }

  try {
    const viralPrompt = `You are a YouTube viral content expert. Analyze this video content and predict its viral potential.

VIDEO CONTENT:
- Title: ${title}
- Description: ${description || 'Not provided'}
- Tags: ${tags || 'Not provided'}

Analyze the viral potential and respond in this EXACT JSON format:
{
  "viralScore": <0-100>,
  "verdict": "One sentence verdict about viral potential",
  "factors": [
    {"name": "Title Appeal", "score": <0-100>},
    {"name": "Emotional Hook", "score": <0-100>},
    {"name": "Clickability", "score": <0-100>},
    {"name": "Shareability", "score": <0-100>},
    {"name": "Trend Alignment", "score": <0-100>}
  ],
  "tips": [
    {"title": "Improvement tip 1", "detail": "Detailed explanation"},
    {"title": "Improvement tip 2", "detail": "Detailed explanation"},
    {"title": "Improvement tip 3", "detail": "Detailed explanation"}
  ]
}

Scoring Guidelines:
- 80-100: High viral potential - strong emotional hook, trending topic, shareable
- 60-79: Moderate potential - good elements but room for improvement
- 40-59: Average potential - needs significant optimization
- 0-39: Low potential - major changes needed`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: viralPrompt }],
      temperature: 0.7,
      max_tokens: 1000
    });

    let viralData;
    try {
      const responseText = aiResponse.choices[0].message.content.trim();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      viralData = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (e) {
      viralData = {
        viralScore: 55,
        verdict: 'Moderate viral potential. Consider optimizing the title for more emotional impact.',
        factors: [
          { name: 'Title Appeal', score: 60 },
          { name: 'Emotional Hook', score: 50 },
          { name: 'Clickability', score: 55 },
          { name: 'Shareability', score: 55 },
          { name: 'Trend Alignment', score: 55 }
        ],
        tips: [
          { title: 'Add emotional triggers', detail: 'Use words that evoke curiosity or excitement' },
          { title: 'Create urgency', detail: 'Include time-sensitive elements when relevant' },
          { title: 'Optimize for sharing', detail: 'Make the content easy to share and discuss' }
        ]
      };
    }

    // Save to history
    const historyData = {
      userId: uid,
      title,
      description: description || '',
      tags: tags || '',
      viralScore: viralData.viralScore,
      verdict: viralData.verdict,
      factors: viralData.factors,
      tips: viralData.tips,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('viralPredictorHistory').add(historyData);

    // Update usage
    await incrementUsage(uid, 'viralPredictor');
    await logUsage(uid, 'viral_predictor', { title, viralScore: viralData.viralScore });

    return {
      success: true,
      viralScore: viralData.viralScore,
      verdict: viralData.verdict,
      factors: viralData.factors,
      tips: viralData.tips
    };

  } catch (error) {
    console.error('Viral prediction error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal',
      sanitizeErrorMessage(error, 'Failed to predict viral score. Please try again.'));
  }
});

/**
 * Monetization Analyzer - Estimates channel earnings and revenue potential
 * Analyzes a YouTube channel and provides monetization insights
 */
exports.analyzeMonetization = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'analyzeMonetization', 5);
  await checkUsageLimit(uid, 'monetizationAnalyzer');

  const { channelUrl } = data;
  if (!channelUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Channel URL is required');
  }

  try {
    // Extract channel info
    const channelInfo = extractChannelInfo(channelUrl);

    // Get channel details
    let channelResponse;
    if (channelInfo.type === 'id') {
      channelResponse = await youtube.channels.list({
        part: 'snippet,statistics,topicDetails',
        id: channelInfo.value
      });
    } else if (channelInfo.type === 'handle') {
      channelResponse = await youtube.channels.list({
        part: 'snippet,statistics,topicDetails',
        forHandle: channelInfo.value
      });
    } else {
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
        part: 'snippet,statistics,topicDetails',
        id: searchResponse.data.items[0].snippet.channelId
      });
    }

    if (!channelResponse.data.items?.length) {
      throw new functions.https.HttpsError('not-found', 'Channel not found');
    }

    const channel = channelResponse.data.items[0];
    const channelId = channel.id;
    const channelName = channel.snippet.title;
    const channelThumbnail = channel.snippet.thumbnails?.medium?.url || channel.snippet.thumbnails?.default?.url;
    const subscriberCount = parseInt(channel.statistics.subscriberCount) || 0;
    const viewCount = parseInt(channel.statistics.viewCount) || 0;
    const videoCount = parseInt(channel.statistics.videoCount) || 0;
    const topicCategories = channel.topicDetails?.topicCategories?.map(t => t.split('/').pop()) || [];

    // Get recent videos for view analysis
    const videosResponse = await youtube.search.list({
      part: 'snippet',
      channelId: channelId,
      type: 'video',
      order: 'date',
      maxResults: 30
    });

    const recentVideoIds = videosResponse.data.items?.map(v => v.id.videoId).filter(Boolean) || [];

    let monthlyViews = 0;
    if (recentVideoIds.length > 0) {
      const videoDetailsResponse = await youtube.videos.list({
        part: 'statistics',
        id: recentVideoIds.slice(0, 20).join(',')
      });

      const recentStats = videoDetailsResponse.data.items || [];
      const totalRecentViews = recentStats.reduce((sum, v) => sum + parseInt(v.statistics.viewCount || 0), 0);
      // Estimate monthly views based on recent video performance
      monthlyViews = Math.round(totalRecentViews / Math.max(recentStats.length, 1) * 4); // Assuming ~4 videos/month
    }

    // CPM estimation based on niche
    const nicheCPM = {
      'Finance': 12,
      'Technology': 8,
      'Gaming': 4,
      'Entertainment': 3,
      'Education': 6,
      'Lifestyle': 5,
      'Music': 2,
      'Sports': 4,
      'News': 5,
      'default': 4
    };

    // Determine niche CPM
    let estimatedCPM = nicheCPM.default;
    for (const topic of topicCategories) {
      for (const [niche, cpm] of Object.entries(nicheCPM)) {
        if (topic.toLowerCase().includes(niche.toLowerCase())) {
          estimatedCPM = Math.max(estimatedCPM, cpm);
        }
      }
    }

    // Calculate earnings (monetized views are typically 40-60% of total)
    const monetizedViewRate = 0.5;
    const monthlyMonetizedViews = monthlyViews * monetizedViewRate;
    const monthlyAdRevenue = (monthlyMonetizedViews / 1000) * estimatedCPM;

    // Estimate other revenue streams based on subscriber count
    const sponsorshipPotential = subscriberCount > 10000 ? subscriberCount * 0.01 : 0;
    const membershipPotential = subscriberCount > 30000 ? subscriberCount * 0.002 : 0;
    const merchandisePotential = subscriberCount > 50000 ? subscriberCount * 0.001 : 0;

    const monthlyEarnings = monthlyAdRevenue + sponsorshipPotential + membershipPotential + merchandisePotential;
    const yearlyEarnings = monthlyEarnings * 12;

    // AI-powered recommendations
    const monetizationPrompt = `You are a YouTube monetization expert. Based on this channel data, provide 5 specific revenue optimization recommendations.

CHANNEL DATA:
- Subscribers: ${subscriberCount.toLocaleString()}
- Monthly Views (estimated): ${monthlyViews.toLocaleString()}
- Video Count: ${videoCount}
- Niche/Topics: ${topicCategories.join(', ') || 'General'}
- Estimated Monthly Revenue: $${monthlyEarnings.toFixed(2)}

Respond with a JSON array of 5 short, actionable recommendations (each under 100 characters):
["recommendation 1", "recommendation 2", "recommendation 3", "recommendation 4", "recommendation 5"]`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: monetizationPrompt }],
      temperature: 0.7,
      max_tokens: 500
    });

    let recommendations;
    try {
      const responseText = aiResponse.choices[0].message.content.trim();
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      recommendations = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (e) {
      recommendations = [
        'Optimize upload schedule for consistent viewer engagement',
        'Add end screens and cards to increase watch time',
        'Consider channel memberships for dedicated fans',
        'Explore brand sponsorship opportunities in your niche',
        'Create merchandise for your most engaged audience'
      ];
    }

    // Save to history
    const historyData = {
      userId: uid,
      channelUrl,
      channelInfo: {
        id: channelId,
        name: channelName,
        thumbnail: channelThumbnail,
        subscribers: subscriberCount,
        videoCount
      },
      earnings: {
        monthly: monthlyEarnings,
        yearly: yearlyEarnings,
        estimatedCPM,
        breakdown: {
          adRevenue: monthlyAdRevenue,
          sponsorships: sponsorshipPotential,
          memberships: membershipPotential,
          merchandise: merchandisePotential
        }
      },
      recommendations,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('monetizationHistory').add(historyData);

    // Update usage
    await incrementUsage(uid, 'monetizationAnalyzer');
    await logUsage(uid, 'monetization_analyzer', { channelId, monthlyEarnings });

    return {
      success: true,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      monthlyEarnings,
      yearlyEarnings,
      estimatedCPM,
      breakdown: {
        adRevenue: monthlyAdRevenue,
        sponsorships: sponsorshipPotential,
        memberships: membershipPotential,
        merchandise: merchandisePotential
      },
      recommendations
    };

  } catch (error) {
    console.error('Monetization analysis error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal',
      sanitizeErrorMessage(error, 'Failed to analyze monetization. Please try again.'));
  }
});

/**
 * Script Writer Pro - AI-powered video script generation
 * Creates engaging video scripts based on topic, style, and duration
 */
exports.generateScript = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'generateScript', 5);
  await checkUsageLimit(uid, 'scriptWriter');

  const { topic, duration, style, keywords } = data;
  if (!topic) {
    throw new functions.https.HttpsError('invalid-argument', 'Video topic is required');
  }

  try {
    // Duration mapping
    const durationMap = {
      'short': { minutes: '3-5', words: '600-900' },
      'medium': { minutes: '8-12', words: '1500-2200' },
      'long': { minutes: '15-20', words: '2800-3800' }
    };

    const targetDuration = durationMap[duration] || durationMap.medium;

    // Style descriptions
    const styleDescriptions = {
      'engaging': 'High energy, attention-grabbing, with strong hooks and calls to action. Use questions and direct audience engagement.',
      'educational': 'Informative, well-structured, with clear explanations. Include examples and step-by-step guidance.',
      'storytelling': 'Narrative-driven, with a clear beginning, middle, and end. Include personal anecdotes and emotional moments.',
      'listicle': 'Organized as a numbered list. Each point should be concise but valuable. Include transitions between points.'
    };

    const styleGuide = styleDescriptions[style] || styleDescriptions.engaging;

    const scriptPrompt = `You are an expert YouTube script writer. Create an engaging video script.

REQUIREMENTS:
- Topic: ${topic}
- Style: ${style || 'engaging'} - ${styleGuide}
- Target Duration: ${targetDuration.minutes} minutes (${targetDuration.words} words)
- Keywords to include: ${keywords || 'none specified'}

SCRIPT STRUCTURE:
1. Hook (first 5-10 seconds) - Grab attention immediately
2. Introduction - Brief overview of what viewers will learn
3. Main Content - Organized sections with clear value
4. Call to Action - Subscribe, like, comment
5. Outro - Wrap up and tease future content

FORMAT YOUR RESPONSE AS JSON:
{
  "title": "Suggested video title (SEO optimized)",
  "script": "The full script with [SECTIONS] marked, including speaking directions in (parentheses)",
  "wordCount": <number>,
  "estimatedDuration": "<X-Y>"
}

IMPORTANT: Write naturally as if speaking to camera. Include:
- Pauses marked as [PAUSE]
- Emphasis marked as *word*
- Visual cues marked as [B-ROLL: description]
- Transitions between sections`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: scriptPrompt }],
      temperature: 0.8,
      max_tokens: 3500
    });

    let scriptData;
    try {
      const responseText = aiResponse.choices[0].message.content.trim();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      scriptData = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (e) {
      // If JSON parsing fails, treat the response as the script itself
      const rawScript = aiResponse.choices[0].message.content.trim();
      const wordCount = rawScript.split(/\s+/).length;
      scriptData = {
        title: topic,
        script: rawScript,
        wordCount: wordCount,
        estimatedDuration: duration === 'short' ? '3-5' : duration === 'long' ? '15-20' : '8-12'
      };
    }

    // Calculate actual word count if not provided
    if (!scriptData.wordCount && scriptData.script) {
      scriptData.wordCount = scriptData.script.split(/\s+/).length;
    }

    // Save to history
    const historyData = {
      userId: uid,
      topic,
      duration: duration || 'medium',
      style: style || 'engaging',
      keywords: keywords || '',
      title: scriptData.title,
      script: scriptData.script,
      wordCount: scriptData.wordCount,
      estimatedDuration: scriptData.estimatedDuration,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('scriptWriterHistory').add(historyData);

    // Update usage
    await incrementUsage(uid, 'scriptWriter');
    await logUsage(uid, 'script_writer', { topic, style, wordCount: scriptData.wordCount });

    return {
      success: true,
      title: scriptData.title,
      script: scriptData.script,
      wordCount: scriptData.wordCount,
      estimatedDuration: scriptData.estimatedDuration
    };

  } catch (error) {
    console.error('Script generation error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal',
      sanitizeErrorMessage(error, 'Failed to generate script. Please try again.'));
  }
});

// ==============================================
// CREATIVE STUDIO - IMAGE GENERATION (NanoBanana API)
// ==============================================

/**
 * Token costs:
 * - Basic: 1 token per image
 * - HD: 2 tokens per image
 * - Ultra: 4 tokens per image
 * - Templates: vary by template (2-3 tokens)
 * - Upscale: 2 tokens
 * - Motion: 3 tokens
 *
 * Token rollover: Unused tokens roll over to next month (max 500)
 */

// Helper: Get monthly token allocation by plan
function getMonthlyAllocation(plan) {
  const allocations = {
    free: 50,
    lite: 200,
    pro: 500,
    business: 1500
  };
  return allocations[plan] || 50;
}

// Get user's creative tokens balance
exports.getCreativeTokens = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  try {
    const tokenDoc = await db.collection('creativeTokens').doc(uid).get();

    if (!tokenDoc.exists) {
      // Initialize new user with free tier tokens
      const now = new Date();
      const initialTokens = {
        balance: 50,
        rollover: 0,
        plan: 'free',
        monthlyAllocation: 50,
        lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      await db.collection('creativeTokens').doc(uid).set(initialTokens);
      // Return serializable data (FieldValue.serverTimestamp() doesn't serialize well)
      return {
        balance: 50,
        rollover: 0,
        plan: 'free',
        monthlyAllocation: 50,
        lastRefresh: now.toISOString(),
        createdAt: now.toISOString()
      };
    }

    const tokenData = tokenDoc.data();

    // Check if monthly refresh is needed
    const now = new Date();
    const lastRefresh = tokenData.lastRefresh?.toDate() || new Date(0);
    const monthsSinceRefresh = (now.getFullYear() - lastRefresh.getFullYear()) * 12 +
                               (now.getMonth() - lastRefresh.getMonth());

    if (monthsSinceRefresh >= 1) {
      // Calculate rollover (max 500 tokens)
      const rollover = Math.min(tokenData.balance, 500);
      const monthlyAllocation = getMonthlyAllocation(tokenData.plan);

      const updatedTokens = {
        balance: monthlyAllocation + rollover,
        rollover: rollover,
        lastRefresh: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection('creativeTokens').doc(uid).update(updatedTokens);

      return {
        ...tokenData,
        ...updatedTokens,
        balance: monthlyAllocation + rollover
      };
    }

    return tokenData;

  } catch (error) {
    console.error('Get creative tokens error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to get token balance');
  }
});

// Deduct creative tokens
exports.deductCreativeTokens = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { amount, reason } = data;

  if (!amount || amount <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid token amount');
  }

  try {
    const tokenRef = db.collection('creativeTokens').doc(uid);

    return await db.runTransaction(async (transaction) => {
      const tokenDoc = await transaction.get(tokenRef);

      if (!tokenDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Token balance not found');
      }

      const currentBalance = tokenDoc.data().balance || 0;

      if (currentBalance < amount) {
        throw new functions.https.HttpsError('resource-exhausted', 'Insufficient tokens');
      }

      const newBalance = currentBalance - amount;
      transaction.update(tokenRef, {
        balance: newBalance,
        lastUsed: admin.firestore.FieldValue.serverTimestamp()
      });

      // Log token usage
      transaction.set(db.collection('creativeTokenUsage').doc(), {
        userId: uid,
        amount: amount,
        reason: reason || 'generation',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return { success: true, newBalance };
    });

  } catch (error) {
    console.error('Deduct tokens error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to deduct tokens');
  }
});

// =====================================================
// DIAGNOSTIC: Test Imagen API Configuration
// This helps debug API key and model availability issues
// =====================================================
exports.testImagenApi = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  // Check if user is admin for full diagnostics
  const userDoc = await db.collection('adminUsers').doc(uid).get();
  const isAdmin = userDoc.exists && userDoc.data().isAdmin === true;

  const results = {
    timestamp: new Date().toISOString(),
    apiKeyConfigured: false,
    apiKeyPrefix: null,
    modelTest: null,
    simpleGenerationTest: null,
    errors: []
  };

  try {
    // Check if API key is configured
    const geminiApiKey = functions.config().gemini?.key;
    results.apiKeyConfigured = !!geminiApiKey;

    if (!geminiApiKey) {
      results.errors.push('Gemini API key is not configured in Firebase. Run: firebase functions:config:set gemini.key="YOUR_API_KEY"');
      return results;
    }

    // Show API key prefix for debugging (safe - only first 8 chars)
    results.apiKeyPrefix = geminiApiKey.substring(0, 8) + '...';

    // Initialize the SDK
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });

    // Test 1: Try to list models (if available)
    try {
      // The SDK might not have listModels, so we'll catch any error
      if (ai.models && typeof ai.models.list === 'function') {
        const modelsList = await ai.models.list();
        results.availableModels = modelsList.models?.map(m => m.name) || [];
      } else {
        results.modelTest = 'listModels not available in this SDK version';
      }
    } catch (listError) {
      results.modelTest = `listModels failed: ${listError.message}`;
    }

    // Test 2: Try a simple image generation with minimal settings
    try {
      console.log('Testing Imagen API with simple generation...');
      const testResponse = await ai.models.generateImages({
        model: 'imagen-4.0-generate-001',
        prompt: 'A simple red circle on white background',
        config: {
          numberOfImages: 1,
          aspectRatio: '1:1'
        }
      });

      if (testResponse.generatedImages && testResponse.generatedImages.length > 0) {
        results.simpleGenerationTest = 'SUCCESS - Imagen API is working!';
        results.imageGenerated = true;
      } else if (testResponse.generatedImages?.length === 0) {
        results.simpleGenerationTest = 'No images returned - might be safety filtered';
        results.imageGenerated = false;
      } else {
        results.simpleGenerationTest = 'Unexpected response format';
        results.rawResponse = JSON.stringify(testResponse).substring(0, 500);
      }
    } catch (genError) {
      results.simpleGenerationTest = 'FAILED';
      results.generationError = {
        message: genError.message,
        code: genError.code,
        status: genError.status,
        details: genError.details
      };

      // Parse specific error types
      const errMsg = genError.message?.toLowerCase() || '';
      if (errMsg.includes('api key')) {
        results.errors.push('API Key Error: Your API key is invalid or not authorized for Imagen. Get a key from https://aistudio.google.com/apikey');
      } else if (errMsg.includes('not found') || errMsg.includes('404')) {
        results.errors.push('Model Not Found: The imagen-4.0-generate-001 model is not accessible. This could mean: (1) Your API key does not have Imagen access, (2) Imagen is not available in your region, or (3) You need to accept terms at https://aistudio.google.com');
      } else if (errMsg.includes('permission') || errMsg.includes('403') || errMsg.includes('denied')) {
        results.errors.push('Permission Denied: Your API key does not have permission to use Imagen. Make sure you created the key at https://aistudio.google.com/apikey and that billing is enabled.');
      } else if (errMsg.includes('billing')) {
        results.errors.push('Billing Required: Imagen requires billing to be enabled. Go to https://aistudio.google.com and set up billing.');
      } else if (errMsg.includes('quota') || errMsg.includes('rate')) {
        results.errors.push('Rate Limited: You have hit the API rate limit. Wait a moment and try again.');
      } else {
        results.errors.push(`Unknown Error: ${genError.message}`);
      }
    }

    // Summary
    if (results.imageGenerated) {
      results.summary = 'All tests passed! Imagen API is working correctly.';
    } else {
      results.summary = 'Imagen API test failed. Check the errors array for details.';
    }

    return results;

  } catch (error) {
    console.error('Diagnostic error:', error);
    results.errors.push(`Diagnostic failed: ${error.message}`);
    return results;
  }
});

// Generate creative image using Google Gemini/Imagen API (NanoBanana)
// Documentation: https://ai.google.dev/gemini-api/docs/imagen
exports.generateCreativeImage = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'generateImage', 10);

  const { prompt, model, quantity, aspectRatio, quality, templateId, templateVariables, negativePrompt, seed, styleReference, characterReference } = data;

  if (!prompt || prompt.trim().length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Prompt is required');
  }

  // Validate prompt length (Imagen has limits)
  if (prompt.length > 2000) {
    throw new functions.https.HttpsError('invalid-argument', 'Prompt too long. Maximum 2000 characters.');
  }

  // Determine the final prompt to use
  let finalPrompt = prompt;
  const userPromptTrimmed = prompt.trim();

  // If a template is selected, fetch the professional prompt from Firestore
  if (templateId) {
    try {
      const templateDoc = await db.collection('promptTemplates').doc(templateId).get();
      if (templateDoc.exists) {
        const templateData = templateDoc.data();
        if (templateData.professionalPrompt) {
          // Use the professional prompt as the base
          finalPrompt = templateData.professionalPrompt;

          // Replace any {{variables}} in the professional prompt with user values
          if (templateVariables && typeof templateVariables === 'object') {
            Object.keys(templateVariables).forEach(key => {
              const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, 'gi');
              finalPrompt = finalPrompt.replace(placeholder, templateVariables[key] || '');
            });
          }

          // IMPORTANT: Replace ALL remaining {{variable}} placeholders with the user's prompt
          // This ensures user input is incorporated even without explicit templateVariables
          if (userPromptTrimmed) {
            // Replace common variable patterns with user's prompt content
            const remainingPlaceholders = finalPrompt.match(/\{\{[^}]+\}\}/g);
            if (remainingPlaceholders && remainingPlaceholders.length > 0) {
              // Replace the first placeholder with the user's main description
              finalPrompt = finalPrompt.replace(remainingPlaceholders[0], userPromptTrimmed);
              // Replace remaining placeholders with empty string or a generic term
              remainingPlaceholders.slice(1).forEach(placeholder => {
                finalPrompt = finalPrompt.replace(placeholder, '');
              });
            }
          }

          // Clean up any double spaces from removed placeholders
          finalPrompt = finalPrompt.replace(/\s{2,}/g, ' ').trim();

          // ALWAYS append user's custom input if they provided meaningful content
          // This ensures their specific requests are included in the generation
          if (userPromptTrimmed && userPromptTrimmed.length > 5) {
            // Don't duplicate if the prompt is already fully in finalPrompt
            if (!finalPrompt.includes(userPromptTrimmed)) {
              finalPrompt = `${finalPrompt}\n\nUser's specific request: ${userPromptTrimmed}`;
            }
          }

          console.log(`Using professional prompt for template: ${templateId}`);
          console.log(`Final prompt length: ${finalPrompt.length} chars`);
        }
      }
    } catch (templateError) {
      console.warn('Could not fetch template, using original prompt:', templateError.message);
    }
  }

  // Calculate token cost
  const qualityCosts = { basic: 1, hd: 2, ultra: 4 };
  const baseCost = qualityCosts[quality] || 2;
  const imageCount = Math.min(Math.max(quantity || 1, 1), 4); // 1-4 images
  const totalCost = baseCost * imageCount;

  // Map aspect ratios to Imagen supported values
  const aspectRatioMap = {
    '1:1': '1:1',
    '16:9': '16:9',
    '9:16': '9:16',
    '4:3': '4:3',
    '3:4': '3:4'
  };
  const validAspectRatio = aspectRatioMap[aspectRatio] || '1:1';

  // Map model selection to AI models
  // Supports: Gemini Image Models, OpenAI DALL-E, and legacy Imagen API

  // Check model type
  const dalleModels = ['dall-e-3', 'dall-e-2', 'dalle-3', 'dalle-2', 'openai'];
  const isDalleModel = dalleModels.includes(model);

  // Gemini Image models (use generateContent API with image output)
  // These models support reference images via multimodal input
  const geminiImageModels = ['nano-banana-pro', 'nano-banana'];
  const isGeminiImageModel = geminiImageModels.includes(model);

  // Gemini Image model mapping (uses generateContent with responseModalities)
  // NOTE: gemini-2.5-flash-image does NOT exist in Google AI Studio
  // Valid models for image generation: gemini-3-pro-image-preview, gemini-2.0-flash-exp
  const geminiImageModelMap = {
    'auto': 'gemini-3-pro-image-preview',
    'nano-banana-pro': 'gemini-3-pro-image-preview',
    'nano-banana': 'gemini-2.0-flash-exp'  // Was gemini-2.5-flash-image which doesn't exist!
  };

  // Imagen model mapping (uses ai.models.generateImages)
  // Auto defaults to Imagen 4 (best working model)
  const imagenModelMap = {
    'auto': 'imagen-4.0-generate-001',
    'imagen-4': 'imagen-4.0-generate-001',
    'imagen-4-ultra': 'imagen-4.0-ultra-generate-001',
    'imagen-3': 'imagen-3.0-generate-001',
    // Legacy keys for backwards compatibility
    'banana1': 'imagen-4.0-generate-001',
    'banana2': 'imagen-4.0-ultra-generate-001'
  };

  // DALL-E model mapping
  const dalleModelMap = {
    'dall-e-3': 'dall-e-3',
    'dalle-3': 'dall-e-3',
    'dall-e-2': 'dall-e-2',
    'dalle-2': 'dall-e-2',
    'openai': 'dall-e-3'
  };

  // Get the model ID based on type [VERIFIED-FIX-2025-12-01]
  const geminiImageModelId = geminiImageModelMap[model] || geminiImageModelMap['auto'];
  const imagenModelId = imagenModelMap[model] || 'imagen-4.0-generate-001'; // Default to Imagen 4 (NOT Imagen 3!)
  const dalleModelId = dalleModelMap[model] || 'dall-e-3';

  try {
    // Verify token balance - initialize if new user
    let tokenDoc = await db.collection('creativeTokens').doc(uid).get();
    let balance = 0;

    if (!tokenDoc.exists) {
      // Initialize new user with free tier tokens
      const initialTokens = {
        balance: 50,
        rollover: 0,
        plan: 'free',
        monthlyAllocation: 50,
        lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      await db.collection('creativeTokens').doc(uid).set(initialTokens);
      // Use the known initial balance directly (avoid re-fetch timing issues)
      balance = 50;
    } else {
      balance = tokenDoc.data().balance || 0;
    }

    if (balance < totalCost) {
      throw new functions.https.HttpsError('resource-exhausted',
        `Insufficient tokens. Need ${totalCost}, have ${balance}`);
    }

    // Process generated images
    const generatedImages = [];
    const storage = admin.storage().bucket();
    const timestamp = Date.now();
    let usedModel = '';

    if (isDalleModel) {
      // ==========================================
      // DALL-E Image Generation (OpenAI)
      // ==========================================
      console.log(`Generating ${imageCount} image(s) with DALL-E ${dalleModelId}, aspect: ${validAspectRatio}`);
      console.log(`Prompt length: ${finalPrompt.length} chars, template: ${templateId || 'none'}`);

      // Map aspect ratios to DALL-E sizes
      const dalleSizeMap = {
        '1:1': '1024x1024',
        '16:9': '1792x1024', // DALL-E 3 only
        '9:16': '1024x1792', // DALL-E 3 only
        '4:3': '1024x1024',  // DALL-E doesn't support 4:3, use 1:1
        '3:4': '1024x1024'   // DALL-E doesn't support 3:4, use 1:1
      };

      // DALL-E 2 only supports 1024x1024, 512x512, 256x256
      const dalleSize = dalleModelId === 'dall-e-3'
        ? (dalleSizeMap[validAspectRatio] || '1024x1024')
        : '1024x1024';

      // DALL-E 3 only supports 1 image per request, DALL-E 2 supports up to 10
      const imagesPerRequest = dalleModelId === 'dall-e-3' ? 1 : Math.min(imageCount, 4);
      const requestsNeeded = dalleModelId === 'dall-e-3' ? imageCount : 1;

      for (let req = 0; req < requestsNeeded; req++) {
        try {
          const dalleResponse = await openai.images.generate({
            model: dalleModelId,
            prompt: finalPrompt,
            n: imagesPerRequest,
            size: dalleSize,
            quality: quality === 'ultra' || quality === 'hd' ? 'hd' : 'standard',
            response_format: 'b64_json'
          });

          if (dalleResponse.data && dalleResponse.data.length > 0) {
            for (let i = 0; i < dalleResponse.data.length; i++) {
              const imageData = dalleResponse.data[i];
              const imageBytes = imageData.b64_json;

              if (!imageBytes) continue;

              // Upload base64 image to Firebase Storage
              const imageIndex = generatedImages.length + 1;
              const fileName = `creative-studio/${uid}/${timestamp}-dalle-${imageIndex}.png`;
              const file = storage.file(fileName);

              const buffer = Buffer.from(imageBytes, 'base64');
              await file.save(buffer, {
                metadata: {
                  contentType: 'image/png',
                  metadata: {
                    userId: uid,
                    prompt: prompt.substring(0, 200),
                    model: dalleModelId,
                    size: dalleSize,
                    revisedPrompt: imageData.revised_prompt || ''
                  }
                }
              });

              // Make file publicly accessible [RESTORED-FIX-2025-12-01]
              await file.makePublic();
              const publicUrl = `https://storage.googleapis.com/${storage.name}/${fileName}`;

              generatedImages.push({
                url: publicUrl,
                fileName: fileName,
                seed: Math.floor(Math.random() * 1000000),
                revisedPrompt: imageData.revised_prompt || null
              });
            }
          }
        } catch (dalleError) {
          console.error(`DALL-E generation error (request ${req + 1}):`, dalleError);
          if (requestsNeeded === 1) {
            // If single request fails, throw error
            throw new functions.https.HttpsError('internal',
              `DALL-E generation failed: ${dalleError.message || 'Unknown error'}`);
          }
          // For multiple requests, continue with remaining
        }
      }

      usedModel = dalleModelId;

    } else if (isGeminiImageModel) {
      // ==========================================
      // Gemini Image Generation (Google AI Studio)
      // Uses generateContent API with image output
      // Supports: gemini-3-pro-image-preview, gemini-2.5-flash-image
      // ==========================================
      const geminiApiKey = functions.config().gemini?.key;
      if (!geminiApiKey) {
        console.error('Gemini API key not configured');
        throw new functions.https.HttpsError('failed-precondition',
          'Image generation service not configured. Please contact support.');
      }

      const ai = new GoogleGenAI({ apiKey: geminiApiKey });

      console.log(`Generating image with Gemini model: ${geminiImageModelId}`);
      console.log(`Prompt length: ${finalPrompt.length} chars, template: ${templateId || 'none'}`);

      // Build the content parts for the request
      const contentParts = [];

      // Add reference images if provided (Gemini supports multimodal input)
      if (styleReference && styleReference.base64) {
        contentParts.push({
          inlineData: {
            mimeType: styleReference.mimeType || 'image/png',
            data: styleReference.base64
          }
        });
        console.log('Adding style reference image as input');
      }

      if (characterReference && characterReference.base64) {
        contentParts.push({
          inlineData: {
            mimeType: characterReference.mimeType || 'image/png',
            data: characterReference.base64
          }
        });
        console.log('Adding character reference image as input');
      }

      // Build the prompt with reference instructions if needed
      let imagePrompt = finalPrompt;
      if (styleReference && styleReference.base64) {
        imagePrompt = `Using the provided image as a style reference, generate a new image with the following description: ${finalPrompt}`;
      }
      if (characterReference && characterReference.base64) {
        imagePrompt = `Using the provided image as a character/face reference to maintain consistency, generate a new image: ${finalPrompt}`;
      }
      if (styleReference && characterReference) {
        imagePrompt = `Using the first image as style reference and the second image as character reference, generate: ${finalPrompt}`;
      }

      // Add negative prompt instruction if provided
      if (negativePrompt && negativePrompt.trim()) {
        imagePrompt += `\n\nIMPORTANT: Avoid the following in the image: ${negativePrompt.trim()}`;
      }

      // Add the text prompt
      contentParts.push({ text: imagePrompt });

      try {
        // Gemini Image Generation using @google/genai SDK
        // Uses ai.models.generateContent() with responseModalities for image output
        // Reference: https://ai.google.dev/gemini-api/docs/image-generation

        // Generate images (Gemini generates one at a time)
        for (let imgIdx = 0; imgIdx < imageCount; imgIdx++) {
          try {
            const result = await ai.models.generateContent({
              model: geminiImageModelId,
              contents: [{ role: 'user', parts: contentParts }],
              config: {
                responseModalities: ['image', 'text']
              }
            });

            // Extract image from response - handle both SDK response structures
            const candidates = result.candidates || (result.response && result.response.candidates);
            if (candidates && candidates.length > 0) {
              const candidate = candidates[0];
              const parts = candidate.content?.parts || candidate.parts || [];
              for (const part of parts) {
                const inlineData = part.inlineData || part.inline_data;
                if (inlineData && (inlineData.data || inlineData.bytesBase64Encoded)) {
                  // Found an image
                  const imageBytes = inlineData.data || inlineData.bytesBase64Encoded;
                  const mimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
                  const extension = mimeType.includes('jpeg') ? 'jpg' : 'png';

                  const fileName = `creative-studio/${uid}/${timestamp}-gemini-${imgIdx + 1}.${extension}`;
                  const file = storage.file(fileName);

                  const buffer = Buffer.from(imageBytes, 'base64');
                  await file.save(buffer, {
                    metadata: {
                      contentType: mimeType,
                      metadata: {
                        prompt: finalPrompt.substring(0, 500),
                        model: geminiImageModelId,
                        generatedAt: new Date().toISOString()
                      }
                    }
                  });

                  // Make file publicly accessible [RESTORED-FIX-2025-12-01]
                  await file.makePublic();
                  const publicUrl = `https://storage.googleapis.com/${storage.name}/${fileName}`;

                  generatedImages.push({
                    url: publicUrl,
                    fileName: fileName,
                    seed: Math.floor(Math.random() * 1000000)
                  });

                  console.log(`Gemini image ${imgIdx + 1} saved: ${fileName}`);
                  break; // Only take first image from this response
                }
              }
            }
          } catch (genError) {
            console.error(`Gemini generation error for image ${imgIdx + 1}:`, genError);
            // Continue with remaining images
          }
        }

        if (generatedImages.length === 0) {
          throw new functions.https.HttpsError('internal',
            'Gemini did not generate any images. The content may have been filtered.');
        }

        usedModel = geminiImageModelId;

      } catch (geminiError) {
        console.error('Gemini image generation error:', geminiError);
        throw new functions.https.HttpsError('internal',
          `Gemini generation failed: ${geminiError.message || 'Unknown error'}`);
      }

    } else {
      // ==========================================
      // Legacy Imagen Image Generation (Google)
      // Uses ai.models.generateImages API
      // ==========================================
      const geminiApiKey = functions.config().gemini?.key;
      if (!geminiApiKey) {
        console.error('Gemini API key not configured');
        throw new functions.https.HttpsError('failed-precondition',
          'Image generation service not configured. Please contact support.');
      }

      const ai = new GoogleGenAI({ apiKey: geminiApiKey });

      console.log(`Generating ${imageCount} image(s) with Imagen model: ${imagenModelId}`);
      console.log(`Prompt length: ${finalPrompt.length} chars, template: ${templateId || 'none'}`);

      // Build config object with optional parameters
      const imagenConfig = {
        numberOfImages: imageCount,
        aspectRatio: validAspectRatio,
        includeRaiReason: true,
        personGeneration: 'allow_adult'
      };

      // Add negative prompt if provided (Imagen supports this)
      if (negativePrompt && negativePrompt.trim()) {
        imagenConfig.negativePrompt = negativePrompt.trim();
        console.log(`Using negative prompt: ${negativePrompt.substring(0, 50)}...`);
      }

      // Add seed if provided (for reproducible results)
      if (seed !== undefined && seed !== null && !isNaN(seed)) {
        imagenConfig.seed = parseInt(seed, 10);
        console.log(`Using seed: ${seed}`);
      }

      // Add reference images if provided (Imagen 3 only)
      // Reference images support style transfer and subject consistency
      if (imagenModelId.includes('imagen-3') && (styleReference || characterReference)) {
        const referenceImages = [];

        // Add style reference
        if (styleReference) {
          if (styleReference.base64) {
            referenceImages.push({
              referenceType: 'STYLE',
              referenceImage: {
                bytesBase64Encoded: styleReference.base64
              }
            });
            console.log('Adding style reference image');
          } else if (styleReference.url) {
            // For URL-based references, we'd need to fetch and convert to base64
            console.log('Style reference URL provided - URL-based references not yet supported');
          }
        }

        // Add character/subject reference
        if (characterReference) {
          if (characterReference.base64) {
            referenceImages.push({
              referenceType: 'SUBJECT',
              referenceImage: {
                bytesBase64Encoded: characterReference.base64
              }
            });
            console.log('Adding character/subject reference image');
          } else if (characterReference.url) {
            console.log('Character reference URL provided - URL-based references not yet supported');
          }
        }

        if (referenceImages.length > 0) {
          imagenConfig.referenceImages = referenceImages;
          console.log(`Using ${referenceImages.length} reference image(s)`);
        }
      } else if ((styleReference || characterReference) && !imagenModelId.includes('imagen-3')) {
        console.log('Reference images only supported with Imagen 3 - ignoring references');
      }

      const response = await ai.models.generateImages({
        model: imagenModelId,
        prompt: finalPrompt,
        config: imagenConfig
      });

      if (response.generatedImages && response.generatedImages.length > 0) {
        for (let i = 0; i < response.generatedImages.length; i++) {
          const genImage = response.generatedImages[i];

          if (genImage.raiFilteredReason) {
            console.warn(`Image ${i + 1} filtered: ${genImage.raiFilteredReason}`);
            continue;
          }

          const imageBytes = genImage.image?.imageBytes;
          if (!imageBytes) continue;

          const fileName = `creative-studio/${uid}/${timestamp}-${i + 1}.png`;
          const file = storage.file(fileName);

          const buffer = Buffer.from(imageBytes, 'base64');
          await file.save(buffer, {
            metadata: {
              contentType: 'image/png',
              metadata: {
                userId: uid,
                prompt: prompt.substring(0, 200),
                model: imagenModelId,
                aspectRatio: validAspectRatio
              }
            }
          });

          // Make file publicly accessible [RESTORED-FIX-2025-12-01]
          await file.makePublic();
          const publicUrl = `https://storage.googleapis.com/${storage.name}/${fileName}`;

          generatedImages.push({
            url: publicUrl,
            fileName: fileName,
            seed: Math.floor(Math.random() * 1000000)
          });
        }
      }

      usedModel = imagenModelId;
    }

    // Check if any images were generated
    if (generatedImages.length === 0) {
      throw new functions.https.HttpsError('internal',
        'No images generated. The prompt may have been filtered for safety. Try a different prompt.');
    }

    // Deduct tokens (only charge for successfully generated images)
    const actualCost = baseCost * generatedImages.length;
    await db.collection('creativeTokens').doc(uid).update({
      balance: admin.firestore.FieldValue.increment(-actualCost),
      lastUsed: admin.firestore.FieldValue.serverTimestamp()
    });
    const historyData = {
      userId: uid,
      prompt: prompt,
      model: usedModel,
      quantity: generatedImages.length,
      aspectRatio: validAspectRatio,
      quality: quality || 'hd',
      templateId: templateId || null,
      images: generatedImages,
      tokenCost: actualCost,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const historyRef = await db.collection('creativeHistory').add(historyData);

    // Log usage
    await logUsage(uid, 'creative_image', {
      prompt: prompt.substring(0, 100),
      quality,
      quantity: generatedImages.length,
      model: usedModel
    });

    // AUTO-SHARE FOR FREE USERS
    // Free users' images are automatically shared to the community gallery
    // Premium users can choose to share or keep private
    let autoSharedToGallery = false;
    let galleryId = null;

    try {
      const tokenDoc = await db.collection('creativeTokens').doc(uid).get();
      const userPlan = tokenDoc.exists ? (tokenDoc.data().plan || 'free') : 'free';
      const isPremium = ['lite', 'pro', 'business', 'enterprise'].includes(userPlan);

      if (!isPremium) {
        // Free user - auto-share to community gallery
        const userDoc = await db.collection('users').doc(uid).get();
        const userData = userDoc.exists ? userDoc.data() : {};

        const galleryData = {
          userId: uid,
          userName: userData.displayName || 'Anonymous',
          userAvatar: (userData.displayName || 'A').substring(0, 2).toUpperCase(),
          historyId: historyRef.id,
          imageUrl: generatedImages[0]?.url || '',
          prompt: prompt,
          isPrivate: false, // Free users can't have private prompts
          promptPrice: 0,
          tool: 'imageCreation',
          likes: 0,
          views: 0,
          autoShared: true, // Flag indicating this was auto-shared
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const galleryRef = await db.collection('creativeGallery').add(galleryData);
        galleryId = galleryRef.id;
        autoSharedToGallery = true;

        // Update history to mark as shared
        await db.collection('creativeHistory').doc(historyRef.id).update({
          sharedToGallery: true,
          galleryId: galleryRef.id,
          autoShared: true
        });

        console.log(`Auto-shared image to gallery for free user ${uid}, galleryId: ${galleryRef.id}`);
      }
    } catch (autoShareError) {
      // Don't fail the whole generation if auto-share fails
      console.error('Auto-share to gallery failed:', autoShareError);
    }

    return {
      success: true,
      historyId: historyRef.id,
      images: generatedImages,
      tokenCost: actualCost,
      remainingBalance: balance - actualCost,
      autoSharedToGallery,
      galleryId
    };

  } catch (error) {
    console.error('Generate image error:', error);
    console.error('Error details:', JSON.stringify({
      message: error.message,
      code: error.code,
      status: error.status,
      statusCode: error.statusCode,
      details: error.details,
      name: error.name,
      stack: error.stack?.substring(0, 500)
    }));

    const errorMsg = error.message || '';
    const errorStr = JSON.stringify(error).toLowerCase();

    // Handle specific Gemini API errors with clear instructions
    if (errorMsg.includes('API key') || errorMsg.includes('API_KEY') || errorMsg.includes('invalid key') || errorMsg.includes('Invalid API key')) {
      throw new functions.https.HttpsError('failed-precondition',
        'Invalid API Key. Please ensure you are using an API key from Google AI Studio (aistudio.google.com/apikey), NOT from Google Cloud Console.');
    }

    // Model not found or not available
    if (errorMsg.includes('not found') || errorMsg.includes('404') || (errorMsg.includes('model') && errorMsg.includes('available'))) {
      throw new functions.https.HttpsError('failed-precondition',
        'Imagen model not accessible. Please ensure your API key is from Google AI Studio (aistudio.google.com/apikey) and has billing enabled.');
    }

    // API not enabled or permission issues
    if (errorMsg.includes('permission') || errorMsg.includes('403') || errorMsg.includes('denied') ||
        errorMsg.includes('enable') || errorMsg.includes('PERMISSION_DENIED')) {
      throw new functions.https.HttpsError('permission-denied',
        'API access denied. Imagen requires an API key from Google AI Studio with billing enabled. Go to aistudio.google.com/apikey to create the correct key type.');
    }

    // Rate limiting or quota
    if (errorMsg.includes('quota') || errorMsg.includes('rate') || errorMsg.includes('429') || errorMsg.includes('RESOURCE_EXHAUSTED')) {
      throw new functions.https.HttpsError('resource-exhausted',
        'Service temporarily busy. Please try again in a moment.');
    }

    // Safety filtering
    if (errorMsg.includes('safety') || errorMsg.includes('blocked') || errorMsg.includes('SAFETY')) {
      throw new functions.https.HttpsError('invalid-argument',
        'Your prompt was blocked for safety reasons. Please try a different prompt.');
    }

    // Invalid request format
    if (errorMsg.includes('invalid') || errorMsg.includes('INVALID_ARGUMENT')) {
      throw new functions.https.HttpsError('invalid-argument',
        'Invalid image generation request. Please check your prompt and settings.');
    }

    // Billing not enabled
    if (errorMsg.includes('billing') || errorStr.includes('billing')) {
      throw new functions.https.HttpsError('failed-precondition',
        'Billing is not enabled for this Google Cloud project. Image generation requires an active billing account.');
    }

    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal',
      sanitizeErrorMessage(error, 'Failed to generate image. Please try again.'));
  }
});

// Get user's creative history
exports.getCreativeHistory = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { limit: queryLimit, offset } = data;

  // Safe timestamp handler - handles various Firestore timestamp formats
  const getTimestamp = (field) => {
    if (!field) return Date.now();
    if (typeof field === 'number') return field;
    if (typeof field.toMillis === 'function') return field.toMillis();
    if (field._seconds) return field._seconds * 1000;
    if (field instanceof Date) return field.getTime();
    return Date.now();
  };

  try {
    let query = db.collection('creativeHistory')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(queryLimit || 50);

    if (offset) {
      const lastDoc = await db.collection('creativeHistory').doc(offset).get();
      if (lastDoc.exists) {
        query = query.startAfter(lastDoc);
      }
    }

    const snapshot = await query.get();
    const history = [];

    snapshot.forEach(doc => {
      const docData = doc.data();
      const timestamp = getTimestamp(docData.createdAt);
      // Create clean object without raw createdAt (non-serializable)
      const { createdAt: rawCreatedAt, ...rest } = docData;
      history.push({
        id: doc.id,
        ...rest,
        timestamp,
        createdAt: new Date(timestamp).toISOString()
      });
    });

    return { success: true, history };

  } catch (error) {
    console.error('Get history error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to get history');
  }
});

// Enhance prompt using AI
exports.enhanceCreativePrompt = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'enhancePrompt', 20); // More lenient rate limit for quick operation

  const { prompt, style } = data;

  if (!prompt || prompt.trim().length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Prompt is required');
  }

  if (prompt.length > 500) {
    throw new functions.https.HttpsError('invalid-argument', 'Prompt too long. Maximum 500 characters for enhancement.');
  }

  try {
    const geminiApiKey = functions.config().gemini?.key;
    if (!geminiApiKey) {
      throw new functions.https.HttpsError('failed-precondition', 'AI service not configured');
    }

    const ai = new GoogleGenAI({ apiKey: geminiApiKey });

    // Style-specific enhancements
    const styleInstructions = {
      'photorealistic': 'Make it suitable for photorealistic image generation with natural lighting and realistic details.',
      'artistic': 'Make it suitable for artistic/creative image generation with expressive and stylized elements.',
      'cinematic': 'Make it suitable for cinematic image generation with dramatic lighting and movie-like composition.',
      'anime': 'Make it suitable for anime/manga style image generation with appropriate visual elements.',
      'fantasy': 'Make it suitable for fantasy art generation with magical and imaginative elements.',
      'default': 'Make it suitable for high-quality AI image generation.'
    };

    const styleGuide = styleInstructions[style] || styleInstructions['default'];

    const systemPrompt = `You are an expert AI image prompt engineer. Your task is to enhance user prompts to get better results from AI image generators like Imagen and DALL-E.

Rules:
1. Keep the core concept and intent of the original prompt
2. Add specific details about composition, lighting, colors, and style
3. Include technical photography/art terms where appropriate
4. ${styleGuide}
5. Keep the enhanced prompt under 200 words
6. Don't add controversial or inappropriate content
7. Output ONLY the enhanced prompt, no explanations or formatting

Original prompt: "${prompt}"

Enhanced prompt:`;

    // Use correct SDK method: ai.models.generateContent() with proper contents format
    const result = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{
        role: 'user',
        parts: [{ text: systemPrompt }]
      }]
    });

    // Handle response - try multiple formats
    let enhancedPrompt = '';
    if (result.text) {
      enhancedPrompt = result.text.trim();
    } else if (result.response && typeof result.response.text === 'function') {
      enhancedPrompt = result.response.text().trim();
    } else if (result.candidates && result.candidates[0]?.content?.parts?.[0]?.text) {
      enhancedPrompt = result.candidates[0].content.parts[0].text.trim();
    } else {
      console.warn('Could not extract text from Gemini response');
      return { success: true, enhancedPrompt: prompt, wasEnhanced: false };
    }

    // Clean up the response (remove quotes if present)
    let cleanedPrompt = enhancedPrompt
      .replace(/^["']|["']$/g, '') // Remove surrounding quotes
      .replace(/^Enhanced prompt:\s*/i, '') // Remove prefix if present
      .trim();

    // Validate the response
    if (cleanedPrompt.length < 10 || cleanedPrompt.length > 2000) {
      console.warn('Enhanced prompt invalid length, returning original');
      return { success: true, enhancedPrompt: prompt, wasEnhanced: false };
    }

    console.log(`Prompt enhanced: ${prompt.substring(0, 50)}... -> ${cleanedPrompt.substring(0, 50)}...`);

    return {
      success: true,
      enhancedPrompt: cleanedPrompt,
      wasEnhanced: true,
      originalLength: prompt.length,
      enhancedLength: cleanedPrompt.length
    };

  } catch (error) {
    console.error('Enhance prompt error:', error);
    // Return original prompt on error instead of failing
    return {
      success: true,
      enhancedPrompt: prompt,
      wasEnhanced: false,
      error: error.message
    };
  }
});

// Delete image from creative history
exports.deleteCreativeHistory = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { historyId } = data;

  if (!historyId) {
    throw new functions.https.HttpsError('invalid-argument', 'History ID is required');
  }

  try {
    // Get the history item to verify ownership and get file info
    const historyDoc = await db.collection('creativeHistory').doc(historyId).get();

    if (!historyDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Image not found');
    }

    const historyData = historyDoc.data();

    // Verify ownership
    if (historyData.userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not your image');
    }

    // Delete from Firebase Storage (if images exist)
    const storage = admin.storage().bucket();
    if (historyData.images && historyData.images.length > 0) {
      for (const image of historyData.images) {
        if (image.fileName) {
          try {
            await storage.file(image.fileName).delete();
            console.log(`Deleted storage file: ${image.fileName}`);
          } catch (storageError) {
            // File might not exist, continue anyway
            console.warn(`Could not delete file ${image.fileName}:`, storageError.message);
          }
        }
      }
    }

    // If shared to gallery, also delete from gallery
    if (historyData.sharedToGallery && historyData.galleryId) {
      try {
        await db.collection('creativeGallery').doc(historyData.galleryId).delete();
        console.log(`Deleted gallery entry: ${historyData.galleryId}`);
      } catch (galleryError) {
        console.warn(`Could not delete gallery entry:`, galleryError.message);
      }
    }

    // Delete the history document
    await db.collection('creativeHistory').doc(historyId).delete();

    console.log(`Deleted creative history ${historyId} for user ${uid}`);

    return { success: true, message: 'Image deleted successfully' };

  } catch (error) {
    console.error('Delete history error:', error);
    if (error.code) {
      throw error; // Re-throw HttpsErrors
    }
    throw new functions.https.HttpsError('internal', 'Failed to delete image');
  }
});

// Share image to community gallery
exports.shareToGallery = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { historyId, makePrivate, promptPrice } = data;

  if (!historyId) {
    throw new functions.https.HttpsError('invalid-argument', 'History ID is required');
  }

  try {
    // Get the history item
    const historyDoc = await db.collection('creativeHistory').doc(historyId).get();

    if (!historyDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Image not found');
    }

    const historyData = historyDoc.data();

    if (historyData.userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not your image');
    }

    // Check if user can make prompt private (needs paid subscription)
    let canMakePrivate = false;
    if (makePrivate) {
      const tokenDoc = await db.collection('creativeTokens').doc(uid).get();
      const plan = tokenDoc.exists ? tokenDoc.data().plan : 'free';
      canMakePrivate = ['lite', 'pro', 'business'].includes(plan);

      if (!canMakePrivate) {
        throw new functions.https.HttpsError('permission-denied',
          'Only paid subscribers can make prompts private');
      }
    }

    // Get user profile for display name
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    // Create gallery entry
    const galleryData = {
      userId: uid,
      userName: userData.displayName || 'Anonymous',
      userAvatar: (userData.displayName || 'A').substring(0, 2).toUpperCase(),
      historyId: historyId,
      imageUrl: historyData.images?.[0]?.url || '',
      prompt: historyData.prompt,
      isPrivate: makePrivate && canMakePrivate,
      promptPrice: (makePrivate && canMakePrivate) ? (promptPrice || 5) : 0,
      tool: 'imageCreation',
      likes: 0,
      views: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const galleryRef = await db.collection('creativeGallery').add(galleryData);

    // Update history to mark as shared
    await db.collection('creativeHistory').doc(historyId).update({
      sharedToGallery: true,
      galleryId: galleryRef.id
    });

    return {
      success: true,
      galleryId: galleryRef.id,
      isPrivate: galleryData.isPrivate
    };

  } catch (error) {
    console.error('Share to gallery error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to share to gallery');
  }
});

// Purchase private prompt from another user
exports.purchasePrompt = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { galleryId } = data;

  if (!galleryId) {
    throw new functions.https.HttpsError('invalid-argument', 'Gallery ID is required');
  }

  try {
    return await db.runTransaction(async (transaction) => {
      // Get gallery item
      const galleryRef = db.collection('creativeGallery').doc(galleryId);
      const galleryDoc = await transaction.get(galleryRef);

      if (!galleryDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Gallery item not found');
      }

      const galleryData = galleryDoc.data();

      if (!galleryData.isPrivate) {
        // Prompt is free, just return it
        return { success: true, prompt: galleryData.prompt, cost: 0 };
      }

      if (galleryData.userId === uid) {
        // User owns this prompt
        return { success: true, prompt: galleryData.prompt, cost: 0 };
      }

      const price = galleryData.promptPrice || 5;

      // Check buyer's balance
      const buyerTokenRef = db.collection('creativeTokens').doc(uid);
      const buyerTokenDoc = await transaction.get(buyerTokenRef);
      const buyerBalance = buyerTokenDoc.exists ? buyerTokenDoc.data().balance : 0;

      if (buyerBalance < price) {
        throw new functions.https.HttpsError('resource-exhausted',
          `Insufficient tokens. Need ${price}, have ${buyerBalance}`);
      }

      // Check if already purchased
      const purchaseQuery = await db.collection('promptPurchases')
        .where('buyerId', '==', uid)
        .where('galleryId', '==', galleryId)
        .limit(1)
        .get();

      if (!purchaseQuery.empty) {
        // Already purchased, return prompt
        return { success: true, prompt: galleryData.prompt, cost: 0, alreadyPurchased: true };
      }

      // Deduct from buyer
      transaction.update(buyerTokenRef, {
        balance: admin.firestore.FieldValue.increment(-price)
      });

      // Add to seller (creator)
      const sellerTokenRef = db.collection('creativeTokens').doc(galleryData.userId);
      transaction.update(sellerTokenRef, {
        balance: admin.firestore.FieldValue.increment(price),
        earnings: admin.firestore.FieldValue.increment(price)
      });

      // Record purchase
      const purchaseRef = db.collection('promptPurchases').doc();
      transaction.set(purchaseRef, {
        buyerId: uid,
        sellerId: galleryData.userId,
        galleryId: galleryId,
        price: price,
        purchasedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        success: true,
        prompt: galleryData.prompt,
        cost: price
      };
    });

  } catch (error) {
    console.error('Purchase prompt error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to purchase prompt');
  }
});

// Get community gallery
exports.getCommunityGallery = functions.https.onCall(async (data, context) => {
  // This can be called without authentication for browsing
  const { sortBy, filter, category, limit: queryLimit, offset } = data || {};

  // Safe timestamp handler - handles various Firestore timestamp formats
  const getTimestamp = (field) => {
    if (!field) return Date.now();
    if (typeof field === 'number') return field;
    if (typeof field.toMillis === 'function') return field.toMillis();
    if (field._seconds) return field._seconds * 1000;
    if (field instanceof Date) return field.getTime();
    return Date.now();
  };

  try {
    let query = db.collection('creativeGallery')
      .orderBy(sortBy === 'newest' ? 'createdAt' : 'likes', 'desc')
      .limit(queryLimit || 50);

    if (filter && filter !== 'all') {
      query = query.where('tool', '==', filter);
    }

    const snapshot = await query.get();
    const items = [];

    snapshot.forEach(doc => {
      const docData = doc.data();
      const timestamp = getTimestamp(docData.createdAt);
      items.push({
        id: doc.id,
        imageUrl: docData.imageUrl,
        prompt: docData.isPrivate ? '[Private Prompt]' : docData.prompt,
        isPrivate: docData.isPrivate,
        promptPrice: docData.promptPrice || 0,
        user: {
          name: docData.userName,
          avatar: docData.userAvatar
        },
        likes: docData.likes || 0,
        tool: docData.tool,
        createdAt: new Date(timestamp).toISOString()
      });
    });

    return { success: true, items };

  } catch (error) {
    console.error('Get gallery error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to get gallery');
  }
});

// Like a gallery item
exports.likeGalleryItem = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { galleryId } = data;

  if (!galleryId) {
    throw new functions.https.HttpsError('invalid-argument', 'Gallery ID is required');
  }

  try {
    // Check if already liked
    const likeId = `${uid}_${galleryId}`;
    const likeDoc = await db.collection('galleryLikes').doc(likeId).get();

    if (likeDoc.exists) {
      // Unlike
      await db.collection('galleryLikes').doc(likeId).delete();
      await db.collection('creativeGallery').doc(galleryId).update({
        likes: admin.firestore.FieldValue.increment(-1)
      });
      return { success: true, liked: false };
    } else {
      // Like
      await db.collection('galleryLikes').doc(likeId).set({
        userId: uid,
        galleryId: galleryId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await db.collection('creativeGallery').doc(galleryId).update({
        likes: admin.firestore.FieldValue.increment(1)
      });
      return { success: true, liked: true };
    }

  } catch (error) {
    console.error('Like gallery error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to like item');
  }
});

// ==========================================
// SEED CREATIVE PROMPTS - Admin only
// Seeds 31 professional prompts from Newimagemoduls.md
// ==========================================
exports.seedCreativePrompts = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  // Professional prompts organized by category
  const professionalPrompts = [
    // PHOTOREALISM & AESTHETICS (6 prompts)
    {
      id: 'business-photo',
      name: 'Professional Business Photo',
      category: 'photorealism',
      description: 'LinkedIn headshots and corporate portraits',
      tokenCost: 2,
      userPrompt: 'Create a professional business portrait of {{subject}}',
      professionalPrompt: 'Create a highly realistic professional headshot portrait suitable for LinkedIn or corporate use. The subject should be photographed from the chest up, with perfect lighting that eliminates harsh shadows. Use a neutral, slightly blurred office or studio background. The subject should have a confident, approachable expression with natural skin tones and textures. Professional attire appropriate for a business setting. Shot with the equivalent of an 85mm lens at f/2.8 for pleasing bokeh. Color grading should be clean and professional with accurate skin tones.',
      isActive: true
    },
    {
      id: 'film-style',
      name: 'Vintage Film Photography',
      category: 'photorealism',
      description: 'Cinematic shots with authentic film grain and classic camera aesthetics',
      tokenCost: 2,
      userPrompt: 'Create a {{film_era}} style photograph of {{subject}}',
      professionalPrompt: 'Generate an image with authentic vintage film photography aesthetics. Include natural film grain characteristic of high ISO film stock, slightly lifted blacks, and the distinctive color rendering of classic film emulsions like Kodak Portra 400 or Fuji Pro 400H. The image should have subtle light leaks at the edges, gentle vignetting, and the organic imperfections that make film photography distinctive. Composition should follow classic photography rules with attention to golden ratio and leading lines. Lighting should appear natural and uncontrived.',
      isActive: true
    },
    {
      id: 'mirror-selfie',
      name: '2000s Mirror Selfie',
      category: 'photorealism',
      description: 'Authentic early 2000s mirror selfie with detailed styling - JSON structured prompt',
      tokenCost: 2,
      userPrompt: 'Create a 2000s-style mirror selfie of {{subject}} in {{setting}}',
      professionalPrompt: `Create a 2000s Mirror Selfie using this detailed specification:

Subject: {{subject}} taking a mirror selfie. The subject should have the following characteristics:
- Age: young adult
- Expression: confident and slightly playful
- Hair: very long, voluminous waves with soft wispy bangs
- Clothing: fitted cropped t-shirt in cream white featuring a large cute anime-style cat face graphic
- Face: preserve original features, natural glam makeup with soft pink dewy blush and glossy red pouty lips

Accessories:
- Gold geometric hoop earrings
- Silver waistchain
- Smartphone with patterned case visible in hand

Photography Style:
- Camera style: early-2000s digital camera aesthetic
- Lighting: harsh super-flash with bright blown-out highlights but subject still visible
- Angle: mirror selfie
- Shot type: tight selfie composition
- Texture: subtle grain, retro highlights, V6 realism, crisp details, soft shadows

Background Setting: {{setting}}
- Nostalgic early-2000s bedroom atmosphere
- Pastel wall tones
- Period elements: chunky wooden dresser, CD player, posters of 2000s pop icons, hanging beaded door curtain, cluttered vanity with lip glosses
- Retro lighting creating authentic 2000s nostalgic vibe`,
      isActive: true
    },
    {
      id: '90s-portrait',
      name: '90s Yearbook Portrait',
      category: 'photorealism',
      description: 'Classic 90s school photo aesthetic with laser backgrounds',
      tokenCost: 2,
      userPrompt: 'Create a 90s yearbook photo of {{subject}}',
      professionalPrompt: 'Create a nostalgic 1990s school yearbook portrait with the iconic laser background or abstract geometric patterns in teal, purple, and pink gradients. The subject should be posed in the classic yearbook style with head slightly tilted, soft studio lighting, and that distinctive early 90s look. Include the characteristic softness and color palette of 90s portrait photography. Hair and styling should reflect the era appropriately.',
      isActive: true
    },
    {
      id: 'vs-fashion',
      name: 'High Fashion Editorial',
      category: 'photorealism',
      description: 'Victoria\'s Secret / high fashion runway aesthetic',
      tokenCost: 3,
      userPrompt: 'Create a high fashion editorial photo of {{subject}} in {{style}}',
      professionalPrompt: 'Generate a stunning high fashion editorial photograph worthy of Vogue or Elle magazine. Professional studio lighting with dramatic rim lights and soft fill. The composition should be dynamic and editorial in nature. Flawless skin with natural texture visible, professional makeup artistry evident. Background should be clean studio or artistically relevant setting. Color grading should be rich and magazine-quality. Capture movement and energy in the pose.',
      isActive: true
    },
    {
      id: 'crowd-composition',
      name: 'Crowd Composite Photo',
      category: 'photorealism',
      description: 'Same person appearing multiple times in one image',
      tokenCost: 3,
      userPrompt: 'Create a crowd scene where {{subject}} appears {{count}} times in different poses',
      professionalPrompt: 'Create a seamless composite photograph showing the same person appearing multiple times within a single image, each in a different position and pose. Ensure consistent lighting across all instances, matching shadows and highlights. Each appearance should have natural variation in pose, expression, and potentially clothing. The background environment should be coherent and realistic. Pay attention to scale consistency based on position in the scene.',
      isActive: true
    },

    // CREATIVE EXPERIMENTS (8 prompts)
    {
      id: 'wheres-waldo',
      name: 'Where\'s Waldo Scene',
      category: 'creative',
      description: 'Detailed crowded scene with hidden subject to find',
      tokenCost: 3,
      userPrompt: 'Create a Where\'s Waldo style scene with {{subject}} hidden among {{setting}}',
      professionalPrompt: 'Generate a highly detailed, densely packed illustration in the iconic Where\'s Waldo (Where\'s Wally) style. Create a busy, chaotic scene filled with hundreds of tiny characters engaged in various activities. Include the target subject cleverly hidden among the crowd, wearing distinctive clothing. The scene should be colorful, whimsical, and filled with visual gags, sight jokes, and interesting details that reward careful observation. Use a bird\'s eye or slightly elevated perspective to show maximum activity.',
      isActive: true
    },
    {
      id: 'aging-effect',
      name: 'Age Progression',
      category: 'creative',
      description: 'Show how a person would look at different ages',
      tokenCost: 3,
      userPrompt: 'Show {{subject}} at age {{age}}',
      professionalPrompt: 'Create a photorealistic age progression image showing how the subject would appear at the specified age. Consider natural aging processes: changes in skin elasticity, hair color and density, facial fat distribution, and bone structure changes. Maintain the subject\'s core identifying features while applying age-appropriate modifications. For older ages, include natural wrinkles, age spots, and changes in skin texture. For younger ages, smooth features and adjust proportions appropriately.',
      isActive: true
    },
    {
      id: 'recursive-image',
      name: 'Droste Effect',
      category: 'creative',
      description: 'Recursive image within image effect',
      tokenCost: 3,
      userPrompt: 'Create a recursive image of {{subject}} holding a picture of themselves',
      professionalPrompt: 'Generate a Droste effect / recursive image where the subject holds or displays a picture of themselves holding the same picture, creating an infinite recursive loop. The recursion should be visible for at least 4-5 iterations, each getting progressively smaller while maintaining detail. The lighting and perspective should be consistent across all recursive levels. The effect should feel natural and seamlessly integrated.',
      isActive: true
    },
    {
      id: 'glitch-art',
      name: 'Digital Glitch Art',
      category: 'creative',
      description: 'Artistic digital corruption and databending effects',
      tokenCost: 2,
      userPrompt: 'Create glitch art of {{subject}} with {{intensity}} distortion',
      professionalPrompt: 'Create a striking digital glitch art image with artistic data corruption effects. Include horizontal scan line displacement, RGB channel separation, pixel sorting regions, and compression artifact aesthetics. The glitch effects should be visually interesting and intentional-looking rather than randomly destructive. Balance between recognizable subject matter and abstract corruption. Use the glitch elements to create visual rhythm and draw attention to key areas.',
      isActive: true
    },
    {
      id: 'miniature-world',
      name: 'Tilt-Shift Miniature',
      category: 'creative',
      description: 'Real scenes that look like tiny models',
      tokenCost: 2,
      userPrompt: 'Create a tilt-shift miniature effect of {{scene}}',
      professionalPrompt: 'Generate an image with convincing tilt-shift miniature/fake miniature effect that makes a real-world scene appear to be a tiny scale model or diorama. Apply selective focus with a very narrow depth of field band. Increase color saturation and contrast slightly to enhance the toy-like appearance. The viewing angle should ideally be from above. Subjects in the scene should have the slightly static quality of miniature figures.',
      isActive: true
    },
    {
      id: 'impossible-geometry',
      name: 'Impossible Architecture',
      category: 'creative',
      description: 'Escher-style impossible geometric structures',
      tokenCost: 3,
      userPrompt: 'Create an impossible {{structure}} in the style of {{artist}}',
      professionalPrompt: 'Create a visually convincing impossible object or architecture inspired by M.C. Escher\'s impossible constructions. The structure should appear physically plausible at first glance but contain geometric paradoxes upon closer inspection - such as impossible staircases, paradoxical perspectives, or gravity-defying architecture. Use clean lines and professional architectural rendering style. The lighting should be consistent even when the geometry is not.',
      isActive: true
    },
    {
      id: 'style-fusion',
      name: 'Art Style Fusion',
      category: 'creative',
      description: 'Combine two distinct art styles into one image',
      tokenCost: 3,
      userPrompt: 'Create {{subject}} combining {{style1}} and {{style2}} art styles',
      professionalPrompt: 'Generate an artwork that seamlessly blends two distinct artistic styles into a cohesive composition. The fusion should feel intentional and harmonious rather than jarring. Find common elements between the styles that can serve as bridges. The subject matter should be rendered in a way that honors both influences equally. Consider how color palettes, brushwork techniques, and compositional approaches from each style can complement each other.',
      isActive: true
    },
    {
      id: 'coordinates-art',
      name: 'Geographic Coordinates Art',
      category: 'creative',
      description: 'Artistic interpretation of a location\'s coordinates',
      tokenCost: 3,
      userPrompt: 'Create an artistic interpretation of coordinates {{lat}}, {{long}}',
      professionalPrompt: 'Create an artistic visualization inspired by geographic coordinates. Generate an abstract or representational artwork that captures the essence, culture, landscape, or spirit of the location at these coordinates. Consider the geography, climate, local culture, and notable features of the region. The piece should evoke a sense of place while maintaining artistic interpretation and creativity.',
      isActive: true
    },

    // EDUCATION & KNOWLEDGE (1 prompt)
    {
      id: 'infographic-edu',
      name: 'Educational Infographic',
      category: 'education',
      description: 'Clear visual explanations of complex topics',
      tokenCost: 3,
      userPrompt: 'Create an educational infographic about {{topic}}',
      professionalPrompt: 'Design a clear, professional educational infographic that explains a complex topic in an accessible visual format. Use a clean, organized layout with clear visual hierarchy. Include icons, diagrams, and illustrations that aid understanding. Use a cohesive color scheme with good contrast for readability. Break information into digestible chunks with clear headings. Include relevant statistics or data visualized in charts or graphs where appropriate.',
      isActive: true
    },

    // E-COMMERCE & VIRTUAL STUDIO (2 prompts)
    {
      id: 'virtual-tryon',
      name: 'Virtual Try-On',
      category: 'ecommerce',
      description: 'See how clothes or accessories would look when worn',
      tokenCost: 3,
      userPrompt: 'Show {{person}} wearing {{item}} in a try-on visualization',
      professionalPrompt: 'Create a photorealistic virtual try-on visualization showing the specified clothing item or accessory on the subject. The garment should conform naturally to the body shape with realistic fabric draping, wrinkles, and shadows. Lighting should match between the subject and the garment. Show the item from an angle that best displays its features. Include natural fabric texture and material properties.',
      isActive: true
    },
    {
      id: 'product-studio',
      name: 'Product Photography',
      category: 'ecommerce',
      description: 'Professional e-commerce product shots',
      tokenCost: 2,
      userPrompt: 'Create a professional product photo of {{product}} on {{background}}',
      professionalPrompt: 'Identify the main product in the uploaded photo. Isolate it from its original background and place it in a professional e-commerce photography setting. Use a clean studio gradient background with soft shadows. Apply professional product photography lighting: main light at 45 degrees, fill light for shadow detail, and rim light for separation. Ensure the product is sharp, well-exposed, and presented at its most appealing angle. Clean up any imperfections while maintaining realistic appearance.',
      isActive: true
    },

    // WORKPLACE & PRODUCTIVITY (3 prompts)
    {
      id: 'flowchart',
      name: 'Process Flowchart',
      category: 'workplace',
      description: 'Professional flowcharts and process diagrams',
      tokenCost: 2,
      userPrompt: 'Create a flowchart showing {{process}}',
      professionalPrompt: 'Generate a clean, professional flowchart that visually maps out the specified process or workflow. Use standard flowchart symbols: ovals for start/end, rectangles for processes, diamonds for decisions, parallelograms for I/O. Maintain consistent spacing and alignment. Use a limited, professional color palette to indicate different types of steps or departments. Include clear labels and directional arrows. The layout should follow top-to-bottom or left-to-right flow.',
      isActive: true
    },
    {
      id: 'ui-sketch',
      name: 'UI Wireframe Sketch',
      category: 'workplace',
      description: 'Hand-drawn style app wireframes and mockups',
      tokenCost: 2,
      userPrompt: 'Create a hand-drawn UI sketch for {{app_type}} showing {{screens}}',
      professionalPrompt: 'Generate a hand-drawn style UI wireframe sketch that looks like it was created with markers on paper or whiteboard. Include rough but recognizable UI elements: navigation bars, buttons, text placeholders, image areas. Use a sketchy, slightly imperfect line quality that suggests rapid ideation. Add annotations and arrows pointing to key features. Include multiple screen states or flow if relevant. The style should be professional yet approachable.',
      isActive: true
    },
    {
      id: 'magazine-layout',
      name: 'Magazine Page Layout',
      category: 'workplace',
      description: 'Professional magazine spread designs',
      tokenCost: 3,
      userPrompt: 'Design a magazine spread about {{topic}} in {{magazine}} style',
      professionalPrompt: 'Create a professional magazine page layout or spread design. Include sophisticated typography with hierarchy between headlines, subheads, body copy, and captions. Integrate photography or illustrations with dynamic cropping and placement. Use pull quotes, sidebars, or info boxes as design elements. The layout should have visual rhythm with balanced white space. Follow contemporary editorial design principles with attention to grid systems and alignment.',
      isActive: true
    },

    // PHOTO EDITING & RESTORATION (2 prompts)
    {
      id: 'outpainting',
      name: 'Image Outpainting',
      category: 'photoediting',
      description: 'Extend images beyond their original borders',
      tokenCost: 2,
      userPrompt: 'Expand this image to the {{direction}} while maintaining style',
      professionalPrompt: 'Extend the provided image beyond its original borders in the specified direction(s). The generated content must seamlessly blend with the original: match the lighting direction and quality, continue any visible patterns or textures naturally, maintain consistent perspective and scale. The extension should feel like it was always part of the original photograph. Pay special attention to edge blending and tonal consistency.',
      isActive: true
    },
    {
      id: 'crowd-removal',
      name: 'Crowd/Object Removal',
      category: 'photoediting',
      description: 'Remove unwanted people or objects from photos',
      tokenCost: 2,
      userPrompt: 'Remove crowds/people from this {{location}} photo',
      professionalPrompt: 'Intelligently remove crowds, tourists, or unwanted people from the photograph while reconstructing the background naturally. Fill the removed areas with contextually appropriate content that matches the surrounding architecture, landscape, or environment. Maintain consistent lighting, shadows, and perspective. The result should look like the scene was photographed empty, with no artifacts or obvious manipulation.',
      isActive: true
    },

    // INTERIOR DESIGN (1 prompt)
    {
      id: 'floor-plan-3d',
      name: 'Floor Plan to 3D',
      category: 'interior',
      description: 'Transform 2D floor plans into 3D visualizations',
      tokenCost: 3,
      userPrompt: 'Convert this floor plan into a 3D {{style}} interior visualization',
      professionalPrompt: 'Transform the 2D floor plan into a photorealistic 3D interior visualization. Interpret the room dimensions and layout from the plan. Add appropriate furniture placement based on room functions. Apply the specified interior design style with matching materials, colors, and decor. Include realistic lighting from windows and artificial sources. Render with architectural visualization quality including accurate materials and atmospheric effects.',
      isActive: true
    },

    // SOCIAL MEDIA & MARKETING (2 prompts)
    {
      id: 'viral-thumbnail',
      name: 'Viral YouTube Thumbnail',
      category: 'social',
      description: 'Eye-catching thumbnails optimized for clicks',
      tokenCost: 2,
      userPrompt: 'Create a viral thumbnail for a video about {{topic}}',
      professionalPrompt: 'Design an attention-grabbing YouTube thumbnail optimized for maximum click-through rate. Include a human face with exaggerated, expressive emotion (shock, excitement, curiosity). Use bold, contrasting colors that pop against YouTube\'s interface. Leave strategic space for large, readable text overlay. Create visual contrast and focal points that draw the eye. The composition should be readable even at small sizes.',
      isActive: true
    },
    {
      id: 'event-poster',
      name: 'Event Promotional Poster',
      category: 'social',
      description: 'Professional event and concert posters',
      tokenCost: 2,
      userPrompt: 'Design an event poster for {{event}} in {{style}} aesthetic',
      professionalPrompt: 'Create a compelling event promotional poster with strong visual impact. Establish clear visual hierarchy: event name prominent, date/time/location clearly readable, supporting imagery that sets the tone. Use typography that matches the event\'s personality. Include appropriate imagery or graphics that convey the event type and atmosphere. Consider print requirements: bleed areas, safe zones for text, and scalability.',
      isActive: true
    },

    // DAILY LIFE & TRANSLATION (2 prompts)
    {
      id: 'menu-translation',
      name: 'Visual Menu Translation',
      category: 'daily',
      description: 'Translate and visualize foreign language menus',
      tokenCost: 2,
      userPrompt: 'Translate this {{language}} menu to {{target_language}} with food images',
      professionalPrompt: 'Analyze the menu image and create a visual translation guide. Identify each menu item, translate the name and description accurately, and generate an appetizing photograph of what each dish looks like. Present in a clean, organized format that shows: original text, translation, and representative food image side by side. Include any relevant dietary information or common allergens if identifiable.',
      isActive: true
    },
    {
      id: 'comic-localization',
      name: 'Comic/Manga Localization',
      category: 'daily',
      description: 'Translate comics while preserving art style',
      tokenCost: 3,
      userPrompt: 'Translate this comic to {{language}} while keeping the original art style',
      professionalPrompt: 'Localize the comic panel(s) by replacing text with accurate translations while perfectly preserving the original art style. Match the original font style, weight, and character as closely as possible. Adjust text bubble sizes if necessary while maintaining composition. Ensure translated text fits naturally within speech bubbles and text areas. Preserve all visual elements, effects, and sound effects with appropriate localized equivalents.',
      isActive: true
    },

    // SOCIAL NETWORKING & AVATARS (2 prompts)
    {
      id: '3d-avatar',
      name: '3D Character Avatar',
      category: 'avatars',
      description: 'Custom 3D avatars for social media and gaming',
      tokenCost: 3,
      userPrompt: 'Create a 3D avatar based on {{description}} in {{style}} style',
      professionalPrompt: 'Generate a stylized 3D character avatar suitable for social media profiles or gaming. The design should capture the specified characteristics while maintaining appealing stylization. Use clean topology and pleasant proportions. Include customizable elements like hairstyle, accessories, and expression. Render with soft, flattering lighting. The style should be modern and professional while maintaining personality.',
      isActive: true
    },
    {
      id: 'pet-meme',
      name: 'Pet Meme Generator',
      category: 'avatars',
      description: 'Transform pet photos into shareable memes',
      tokenCost: 2,
      userPrompt: 'Turn this pet into a meme with {{expression}} expression',
      professionalPrompt: 'Transform the pet photograph into a meme-worthy image. Enhance or adjust the pet\'s expression to match the desired emotion while keeping it recognizable. Position the image to leave appropriate space for text captions above and/or below. Adjust lighting and color for maximum visual impact. The result should be shareable and engaging while maintaining the pet\'s recognizable features.',
      isActive: true
    },

    // NEW ADDITIONS (4 prompts)
    {
      id: 'memory-palace',
      name: 'Memory Palace Visualization',
      category: 'new',
      description: 'Visual memory aids using the method of loci',
      tokenCost: 3,
      userPrompt: 'Create a memory palace to remember {{items}} using {{location}}',
      professionalPrompt: 'Create a visual memory palace illustration using the method of loci technique. Design a clearly navigable physical space (room, building, path) with distinct locations. Place memorable, exaggerated visual representations of each item to remember at specific points along the route. The items should be interacting with their locations in bizarre, memorable ways. Include visual pathway markers to guide the mental journey through the space.',
      isActive: true
    },
    {
      id: 'googly-eyes',
      name: 'Googly Eyes Addition',
      category: 'new',
      description: 'Add fun googly eyes to any subject',
      tokenCost: 1,
      userPrompt: 'Add googly eyes to {{subject}}',
      professionalPrompt: 'Add photorealistic googly eyes to the subject in a humorous way. The googly eyes should be properly scaled and positioned to replace or enhance existing eyes. Each eye should be pointing in a slightly different direction for comedic effect. Include appropriate shadows and reflections to integrate the googly eyes naturally into the image while maintaining their obviously silly appearance.',
      isActive: true
    },
    {
      id: 'data-infographic',
      name: 'Data Visualization Infographic',
      category: 'new',
      description: 'Transform data into beautiful visual stories',
      tokenCost: 3,
      userPrompt: 'Create a data visualization infographic for {{data}} in {{style}} style',
      professionalPrompt: 'Design a compelling data visualization infographic that tells a story with numbers. Choose appropriate chart types for the data: bar, line, pie, area, scatter, or custom graphics. Use a cohesive color scheme that aids comprehension. Include clear labels, legends, and scale indicators. Create visual hierarchy that guides the viewer through the key insights. Add contextual annotations to highlight important data points.',
      isActive: true
    },
    {
      id: 'weather-card',
      name: 'Stylized Weather Card',
      category: 'new',
      description: 'Beautiful weather forecast visualizations',
      tokenCost: 2,
      userPrompt: 'Create a stylish weather card for {{location}} showing {{conditions}}',
      professionalPrompt: 'Design a beautiful, stylized weather card or widget visualization. Include location name, current temperature, weather condition icon, and relevant metrics (humidity, wind, UV index). Use atmospheric illustration that reflects the weather conditions: sunny scenes should feel warm and bright, rainy scenes should feel moody and wet. Apply a cohesive design language with attention to typography and iconography.',
      isActive: true
    },

    // STRUCTURED SCRIPTS (JSON) - 4 prompts
    {
      id: 'script-2000s-selfie',
      name: '2000s Mirror Selfie Script',
      category: 'scripts',
      description: 'Detailed JSON-structured script for authentic 2000s selfie with precise control',
      tokenCost: 3,
      userPrompt: 'Create a 2000s Mirror Selfie with detailed JSON specification for {{subject}}',
      professionalPrompt: `Create a 2000s Mirror Selfie using this detailed specification:

Subject: {{subject}} taking a mirror selfie. The subject should have the following characteristics:
- Age: young adult
- Expression: confident and slightly playful
- Hair: very long, voluminous waves with soft wispy bangs
- Clothing: fitted cropped t-shirt in cream white featuring a cute graphic
- Face: preserve original features, natural glam makeup with soft pink dewy blush and glossy lips

Accessories:
- Gold geometric hoop earrings
- Smartphone with patterned case visible in hand

Photography Style:
- Camera style: early-2000s digital camera aesthetic
- Lighting: harsh super-flash with bright blown-out highlights but subject still visible
- Angle: mirror selfie
- Shot type: tight selfie composition
- Texture: subtle grain, retro highlights, crisp details, soft shadows

Background Setting:
- Nostalgic early-2000s bedroom atmosphere
- Pastel wall tones
- Period elements: posters of 2000s pop icons, cluttered vanity
- Retro lighting creating authentic 2000s nostalgic vibe`,
      isActive: true
    },
    {
      id: 'script-fashion-shoot',
      name: 'Fashion Photoshoot Script',
      category: 'scripts',
      description: 'Structured script for professional fashion photography with complete styling',
      tokenCost: 3,
      userPrompt: 'Create a fashion photoshoot with detailed specification for {{model}}',
      professionalPrompt: `Create a high-fashion photoshoot using this detailed specification:

Model: {{model}}
- Pose: dynamic editorial stance with confident expression
- Hair: styled professionally, can be flowing or structured
- Makeup: high-fashion editorial makeup, flawless skin

Wardrobe:
- Garment type: specify designer-style piece
- Colors: bold or sophisticated palette
- Accessories: statement jewelry, designer bag or shoes

Photography Setup:
- Lighting: professional three-point studio lighting with dramatic shadows
- Camera: shot on professional medium format, 85mm equivalent
- Background: seamless gradient or styled editorial set
- Post-processing: high-end retouching, skin detail preserved

Mood & Style:
- Editorial fashion magazine quality
- Aspirational and polished
- Strong visual impact`,
      isActive: true
    },
    {
      id: 'script-product-hero',
      name: 'Product Hero Shot Script',
      category: 'scripts',
      description: 'Structured script for hero product photography with precise control',
      tokenCost: 3,
      userPrompt: 'Create a product hero shot with detailed specification for {{product}}',
      professionalPrompt: `Create a professional product hero shot using this detailed specification:

Product: {{product}}
- Position: hero angle showcasing the best features
- Condition: pristine, brand new appearance
- Details: all logos, textures, materials clearly visible

Lighting Setup:
- Key light: soft box at 45 degrees, creating subtle highlight
- Fill light: reducing shadows without flattening
- Rim light: separating product from background
- Reflector: bouncing light into shadow areas

Background & Environment:
- Style: clean gradient or contextual lifestyle setting
- Color: complementary to product colors
- Props: minimal, supporting the hero product

Technical Specifications:
- Lens: macro or 100mm for product detail
- Depth of field: sharp product, subtle background blur
- Post-production: color-accurate, enhanced sharpness`,
      isActive: true
    },
    {
      id: 'script-character',
      name: 'Character Portrait Script',
      category: 'scripts',
      description: 'Detailed character specification for consistent portraits and character design',
      tokenCost: 3,
      userPrompt: 'Create a character portrait with detailed specification for {{character}}',
      professionalPrompt: `Create a detailed character portrait using this specification:

Character: {{character}}

Physical Attributes:
- Face shape: define the face structure
- Eyes: color, shape, expression
- Hair: color, length, style, texture
- Skin tone: natural and realistic
- Age range: approximate visual age
- Build: body type if visible

Expression & Personality:
- Facial expression: specific emotion or mood
- Personality traits: visible in the pose and expression
- Eye contact: direct, avoiding, or looking elsewhere

Attire & Accessories:
- Clothing style: period, culture, or fantasy genre
- Color palette: primary and accent colors
- Accessories: jewelry, glasses, hats, etc.

Artistic Style:
- Rendering: photorealistic, painterly, or stylized
- Lighting: dramatic, soft, or natural
- Background: simple, environmental, or abstract`,
      isActive: true
    }
  ];

  try {
    const batch = db.batch();
    let count = 0;

    for (const prompt of professionalPrompts) {
      const docRef = db.collection('promptTemplates').doc(prompt.id);
      batch.set(docRef, {
        ...prompt,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      count++;
    }

    await batch.commit();

    console.log(`Seeded ${count} prompt templates`);

    return {
      success: true,
      count: count,
      message: `Successfully seeded ${count} prompt templates`
    };

  } catch (error) {
    console.error('Seed prompts error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to seed prompts: ' + error.message);
  }
});

// Get prompt templates (public, for Creative Studio)
exports.getPromptTemplates = functions.https.onCall(async (data, context) => {
  const { category, activeOnly } = data || {};

  try {
    let query = db.collection('promptTemplates');

    if (category && category !== 'all') {
      query = query.where('category', '==', category);
    }

    if (activeOnly !== false) {
      query = query.where('isActive', '==', true);
    }

    const snapshot = await query.orderBy('category').orderBy('name').get();
    const templates = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      templates.push({
        id: doc.id,
        name: data.name,
        category: data.category,
        description: data.description,
        tokenCost: data.tokenCost,
        userPrompt: data.userPrompt,
        // Note: professionalPrompt is sent to client but only used on backend for generation
        professionalPrompt: data.professionalPrompt,
        isActive: data.isActive
      });
    });

    return { success: true, templates };

  } catch (error) {
    console.error('Get templates error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to get templates');
  }
});

// =====================================================
// ADMIN: Fix Storage URLs and Make Files Public
// Run this once to migrate existing images
// =====================================================
exports.adminFixStorageUrls = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const { folder, dryRun } = data || {};
  const targetFolder = folder || 'creative-studio';
  const isDryRun = dryRun !== false; // Default to dry run for safety

  const results = {
    folder: targetFolder,
    dryRun: isDryRun,
    filesProcessed: 0,
    filesMadePublic: 0,
    urlsUpdated: 0,
    errors: []
  };

  try {
    const bucket = admin.storage().bucket();

    // List all files in the folder
    const [files] = await bucket.getFiles({ prefix: targetFolder + '/' });
    console.log(`Found ${files.length} files in ${targetFolder}/`);
    results.filesProcessed = files.length;

    if (!isDryRun) {
      // Make each file public
      for (const file of files) {
        try {
          await file.makePublic();
          results.filesMadePublic++;
        } catch (err) {
          results.errors.push(`Failed to make public: ${file.name} - ${err.message}`);
        }
      }
    }

    // Update URLs in Firestore collections
    const collections = ['creativeHistory', 'creativeGallery', 'promptTemplates'];

    for (const collectionName of collections) {
      const snapshot = await db.collection(collectionName).get();

      for (const doc of snapshot.docs) {
        const docData = doc.data();
        let needsUpdate = false;
        const updates = {};

        // Check for firebasestorage URLs and convert them
        const oldUrlPattern = 'firebasestorage.googleapis.com';
        const bucketName = bucket.name;

        // Handle images array (creativeHistory)
        if (docData.images && Array.isArray(docData.images)) {
          const newImages = docData.images.map(img => {
            if (img.url && img.url.includes(oldUrlPattern)) {
              needsUpdate = true;
              // Extract fileName from the encoded URL
              const fileName = img.fileName || decodeURIComponent(
                img.url.split('/o/')[1]?.split('?')[0] || ''
              );
              return {
                ...img,
                url: `https://storage.googleapis.com/${bucketName}/${fileName}`
              };
            }
            return img;
          });
          if (needsUpdate) {
            updates.images = newImages;
          }
        }

        // Handle single imageUrl field (creativeGallery, some history)
        if (docData.imageUrl && docData.imageUrl.includes(oldUrlPattern)) {
          needsUpdate = true;
          const fileName = decodeURIComponent(
            docData.imageUrl.split('/o/')[1]?.split('?')[0] || ''
          );
          updates.imageUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
        }

        // Handle coverImage field (promptTemplates)
        if (docData.coverImage && docData.coverImage.includes(oldUrlPattern)) {
          needsUpdate = true;
          const fileName = decodeURIComponent(
            docData.coverImage.split('/o/')[1]?.split('?')[0] || ''
          );
          updates.coverImage = `https://storage.googleapis.com/${bucketName}/${fileName}`;
        }

        if (needsUpdate && !isDryRun) {
          await db.collection(collectionName).doc(doc.id).update(updates);
          results.urlsUpdated++;
        } else if (needsUpdate) {
          results.urlsUpdated++; // Count for dry run
        }
      }
    }

    results.message = isDryRun
      ? `DRY RUN: Would make ${files.length} files public and update ${results.urlsUpdated} URLs`
      : `Made ${results.filesMadePublic} files public and updated ${results.urlsUpdated} URLs`;

    return results;

  } catch (error) {
    console.error('Fix storage URLs error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to fix storage URLs: ' + error.message);
  }
});

// Make a specific file public (for RunPod thumbnails after upload completes)
exports.makeFilePublic = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { fileName } = data;

  if (!fileName) {
    throw new functions.https.HttpsError('invalid-argument', 'fileName is required');
  }

  // Security: Only allow users to make their own files public
  if (!fileName.includes(`/${uid}/`)) {
    throw new functions.https.HttpsError('permission-denied', 'Cannot access this file');
  }

  try {
    const bucket = admin.storage().bucket();
    const file = bucket.file(fileName);

    // Check if file exists
    const [exists] = await file.exists();
    if (!exists) {
      return { success: false, message: 'File not found - may still be uploading' };
    }

    await file.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

    return {
      success: true,
      publicUrl,
      message: 'File is now public'
    };

  } catch (error) {
    console.error('Make file public error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to make file public');
  }
});

// =====================================================
// ADMIN: Set CORS Configuration on Storage Bucket
// Run this ONCE after deployment to enable cross-origin access
// Call from browser console: firebase.functions().httpsCallable('adminSetBucketCors')()
// Added: 2025-12-02 - Fixes CORS errors for images on custom domain
// =====================================================
exports.adminSetBucketCors = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  try {
    const bucket = admin.storage().bucket();

    // Define CORS configuration
    const corsConfiguration = [
      {
        origin: [
          'https://ytseo.siteuo.com',
          'https://ytseo-6d1b0.web.app',
          'https://ytseo-6d1b0.firebaseapp.com',
          'http://localhost:5000',
          'http://localhost:5001',
          'http://127.0.0.1:5000',
          'http://127.0.0.1:5001'
        ],
        method: ['GET', 'HEAD', 'OPTIONS'],
        maxAgeSeconds: 3600,
        responseHeader: [
          'Content-Type',
          'Access-Control-Allow-Origin',
          'Access-Control-Allow-Methods',
          'Access-Control-Allow-Headers',
          'Content-Length',
          'Content-Encoding'
        ]
      }
    ];

    // Set CORS on the bucket
    await bucket.setCorsConfiguration(corsConfiguration);

    // Verify it was set
    const [metadata] = await bucket.getMetadata();

    return {
      success: true,
      message: 'CORS configuration applied successfully!',
      bucketName: bucket.name,
      corsConfig: metadata.cors || 'Configuration applied'
    };

  } catch (error) {
    console.error('Set CORS error:', error);
    throw new functions.https.HttpsError('internal',
      'Failed to set CORS: ' + error.message);
  }
});

// =====================================================
// FEATURE 1: CLIENT ACTIVITY TIMELINE / HISTORY LOG
// =====================================================

// Helper function to log user activity (called internally)
async function logUserActivity(userId, activityType, details, adminId = null) {
  try {
    const activityRef = db.collection('users').doc(userId).collection('activityLog');
    await activityRef.add({
      type: activityType,
      details: details,
      adminId: adminId,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error('Error logging activity:', error);
  }
}

// Get user activity history
exports.adminGetUserActivity = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const { userId, limit: queryLimit = 50 } = data || {};
  if (!userId) throw new functions.https.HttpsError('invalid-argument', 'User ID required');

  try {
    const activityRef = db.collection('users').doc(userId).collection('activityLog');
    const snapshot = await activityRef.orderBy('timestamp', 'desc').limit(Math.min(queryLimit, 100)).get();
    const activities = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      activities.push({
        id: doc.id,
        type: d.type,
        details: d.details,
        adminId: d.adminId,
        timestamp: d.timestamp?.toDate?.()?.toISOString() || null
      });
    });
    return { success: true, activities };
  } catch (error) {
    throw new functions.https.HttpsError('internal', 'Failed to get activity: ' + error.message);
  }
});

// Track user login
exports.trackUserLogin = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  try {
    await db.collection('users').doc(uid).update({ lastLoginAt: admin.firestore.FieldValue.serverTimestamp() });
    await logUserActivity(uid, 'login', { source: data?.source || 'web' });
    return { success: true };
  } catch (error) {
    return { success: false };
  }
});

// =====================================================
// FEATURE 2: BULK OPERATIONS
// =====================================================

// Bulk extend subscriptions
exports.adminBulkExtendSubscriptions = functions.https.onCall(async (data, context) => {
  const adminUid = await requireAdmin(context);
  const { userIds, days } = data || {};

  if (!userIds || !Array.isArray(userIds) || userIds.length === 0) throw new functions.https.HttpsError('invalid-argument', 'User IDs array required');
  if (!days || days < 1 || days > 365) throw new functions.https.HttpsError('invalid-argument', 'Days must be 1-365');
  if (userIds.length > 100) throw new functions.https.HttpsError('invalid-argument', 'Max 100 users per batch');

  const results = { success: 0, failed: 0, errors: [] };

  for (const userId of userIds) {
    try {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();
      if (!userDoc.exists) { results.failed++; continue; }

      const userData = userDoc.data();
      const currentEnd = userData.subscription?.endDate?.toDate?.() || new Date();
      const baseDate = currentEnd > new Date() ? currentEnd : new Date();
      const newEndDate = new Date(baseDate);
      newEndDate.setDate(newEndDate.getDate() + days);

      await userRef.update({ 'subscription.endDate': admin.firestore.Timestamp.fromDate(newEndDate) });
      await logUserActivity(userId, 'subscription_change', { action: 'bulk_extend', days, newEndDate: newEndDate.toISOString() }, adminUid);
      results.success++;
    } catch (error) {
      results.failed++;
      results.errors.push({ userId, error: error.message });
    }
  }
  return { success: true, message: `Extended ${results.success} subscriptions by ${days} days`, results };
});

// Bulk set plan
exports.adminBulkSetPlan = functions.https.onCall(async (data, context) => {
  const adminUid = await requireAdmin(context);
  const { userIds, plan, duration } = data || {};

  const validPlans = ['free', 'lite', 'pro', 'enterprise'];
  if (!validPlans.includes(plan)) throw new functions.https.HttpsError('invalid-argument', 'Invalid plan');
  if (!userIds || !Array.isArray(userIds) || userIds.length === 0) throw new functions.https.HttpsError('invalid-argument', 'User IDs required');
  if (userIds.length > 100) throw new functions.https.HttpsError('invalid-argument', 'Max 100 users');

  const durationDays = { 'week': 7, 'month': 30, '3months': 90, 'year': 365, 'lifetime': null };
  const days = durationDays[duration || 'month'];
  const results = { success: 0, failed: 0, errors: [] };

  const planDoc = await db.collection('plans').doc(plan).get();
  const planLimits = planDoc.exists ? planDoc.data() : {};

  for (const userId of userIds) {
    try {
      const userRef = db.collection('users').doc(userId);
      const userDoc = await userRef.get();
      if (!userDoc.exists) { results.failed++; continue; }

      const now = new Date();
      const endDate = days === null ? null : new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

      const updateData = {
        'subscription.plan': plan,
        'subscription.startDate': admin.firestore.Timestamp.fromDate(now),
        'subscription.updatedAt': admin.firestore.FieldValue.serverTimestamp()
      };
      if (endDate) {
        updateData['subscription.endDate'] = admin.firestore.Timestamp.fromDate(endDate);
      } else {
        updateData['subscription.endDate'] = null;
        updateData['subscription.isLifetime'] = true;
      }
      if (planLimits.warpOptimizer !== undefined) updateData['usage.warpOptimizer.limit'] = planLimits.warpOptimizer;
      if (planLimits.competitorAnalysis !== undefined) updateData['usage.competitorAnalysis.limit'] = planLimits.competitorAnalysis;

      await userRef.update(updateData);
      await logUserActivity(userId, 'subscription_change', { action: 'bulk_set_plan', plan, duration: duration || 'month' }, adminUid);
      results.success++;
    } catch (error) {
      results.failed++;
    }
  }
  return { success: true, message: `Set ${results.success} users to ${plan.toUpperCase()}`, results };
});

// Export users data
exports.adminExportUsers = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const { format = 'json', filters = {} } = data || {};

  try {
    const snapshot = await db.collection('users').get();
    const users = [];

    snapshot.forEach(doc => {
      const userData = doc.data();
      const plan = userData.subscription?.plan || 'free';
      if (filters.plan && plan !== filters.plan) return;
      if (filters.verified && !userData.isFiverrVerified) return;
      if (filters.hasTag && (!userData.tags || !userData.tags.includes(filters.hasTag))) return;

      users.push({
        uid: doc.id,
        email: userData.email || '',
        displayName: userData.displayName || '',
        clientAlias: userData.clientAlias || '',
        isFiverrVerified: userData.isFiverrVerified || false,
        tags: userData.tags || [],
        plan,
        subscriptionEnd: userData.subscription?.endDate?.toDate?.()?.toISOString() || null,
        lastLoginAt: userData.lastLoginAt?.toDate?.()?.toISOString() || null,
        adminNotes: userData.adminNotes || ''
      });
    });

    if (format === 'csv') {
      const headers = ['Email', 'Client Alias', 'Fiverr Verified', 'Tags', 'Plan', 'Subscription End', 'Last Login', 'Admin Notes'];
      const csvRows = [headers.join(',')];
      users.forEach(u => {
        csvRows.push([
          `"${u.email}"`, `"${u.clientAlias}"`, u.isFiverrVerified ? 'Yes' : 'No',
          `"${(u.tags || []).join('; ')}"`, u.plan, u.subscriptionEnd || '', u.lastLoginAt || '',
          `"${(u.adminNotes || '').replace(/"/g, '""')}"`
        ].join(','));
      });
      return { success: true, format: 'csv', data: csvRows.join('\n'), count: users.length };
    }
    return { success: true, format: 'json', data: users, count: users.length };
  } catch (error) {
    throw new functions.https.HttpsError('internal', 'Failed to export: ' + error.message);
  }
});

// =====================================================
// FEATURE 3: CLIENT TAGS SYSTEM
// =====================================================

// Get all available tags
exports.adminGetTags = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  try {
    const tagsDoc = await db.collection('settings').doc('tags').get();
    const tagsData = tagsDoc.exists ? tagsDoc.data() : {};
    return { success: true, tags: tagsData.list || [], autoTagRules: tagsData.autoTagRules || [] };
  } catch (error) {
    throw new functions.https.HttpsError('internal', 'Failed to get tags: ' + error.message);
  }
});

// Create a new tag
exports.adminCreateTag = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const { name, color = '#6b7280' } = data || {};
  if (!name || name.trim().length === 0) throw new functions.https.HttpsError('invalid-argument', 'Tag name required');

  const tagName = name.trim().substring(0, 30);
  const tagId = tagName.toLowerCase().replace(/[^a-z0-9]/g, '_');

  try {
    const tagsRef = db.collection('settings').doc('tags');
    const tagsDoc = await tagsRef.get();
    const currentTags = tagsDoc.exists ? (tagsDoc.data().list || []) : [];
    if (currentTags.some(t => t.id === tagId)) throw new functions.https.HttpsError('already-exists', 'Tag exists');

    const newTag = { id: tagId, name: tagName, color, createdAt: new Date().toISOString() };
    currentTags.push(newTag);
    await tagsRef.set({ list: currentTags }, { merge: true });
    return { success: true, tag: newTag };
  } catch (error) {
    if (error.code) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to create tag: ' + error.message);
  }
});

// Delete a tag
exports.adminDeleteTag = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const { tagId } = data || {};
  if (!tagId) throw new functions.https.HttpsError('invalid-argument', 'Tag ID required');

  try {
    const tagsRef = db.collection('settings').doc('tags');
    const tagsDoc = await tagsRef.get();
    const currentTags = tagsDoc.exists ? (tagsDoc.data().list || []) : [];
    await tagsRef.update({ list: currentTags.filter(t => t.id !== tagId) });

    const usersSnapshot = await db.collection('users').where('tags', 'array-contains', tagId).get();
    const batch = db.batch();
    usersSnapshot.forEach(doc => batch.update(doc.ref, { tags: admin.firestore.FieldValue.arrayRemove(tagId) }));
    await batch.commit();
    return { success: true, message: 'Tag deleted' };
  } catch (error) {
    throw new functions.https.HttpsError('internal', 'Failed to delete tag: ' + error.message);
  }
});

// Add tag to user
exports.adminAddUserTag = functions.https.onCall(async (data, context) => {
  const adminUid = await requireAdmin(context);
  const { userId, tagId } = data || {};
  if (!userId || !tagId) throw new functions.https.HttpsError('invalid-argument', 'User ID and Tag ID required');

  try {
    await db.collection('users').doc(userId).update({ tags: admin.firestore.FieldValue.arrayUnion(tagId) });
    await logUserActivity(userId, 'tag_change', { action: 'add', tagId }, adminUid);
    return { success: true };
  } catch (error) {
    throw new functions.https.HttpsError('internal', 'Failed to add tag: ' + error.message);
  }
});

// Remove tag from user
exports.adminRemoveUserTag = functions.https.onCall(async (data, context) => {
  const adminUid = await requireAdmin(context);
  const { userId, tagId } = data || {};
  if (!userId || !tagId) throw new functions.https.HttpsError('invalid-argument', 'User ID and Tag ID required');

  try {
    await db.collection('users').doc(userId).update({ tags: admin.firestore.FieldValue.arrayRemove(tagId) });
    await logUserActivity(userId, 'tag_change', { action: 'remove', tagId }, adminUid);
    return { success: true };
  } catch (error) {
    throw new functions.https.HttpsError('internal', 'Failed to remove tag: ' + error.message);
  }
});

// Set auto-tag rules
exports.adminSetAutoTagRules = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const { rules } = data || {};
  if (!rules || !Array.isArray(rules)) throw new functions.https.HttpsError('invalid-argument', 'Rules array required');

  const validRules = rules.filter(r => r.tagId && r.condition).map(r => ({
    tagId: r.tagId, condition: r.condition, value: r.value, enabled: r.enabled !== false
  }));

  try {
    await db.collection('settings').doc('tags').set({ autoTagRules: validRules }, { merge: true });
    return { success: true, rules: validRules };
  } catch (error) {
    throw new functions.https.HttpsError('internal', 'Failed to save rules: ' + error.message);
  }
});

// Run auto-tag rules manually
exports.adminRunAutoTagRules = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  try {
    const tagsDoc = await db.collection('settings').doc('tags').get();
    const rules = tagsDoc.exists ? (tagsDoc.data().autoTagRules || []) : [];
    if (rules.length === 0) return { success: true, tagged: 0 };

    const usersSnapshot = await db.collection('users').get();
    let taggedCount = 0;

    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();
      const userTags = userData.tags || [];
      const tagsToAdd = [];

      for (const rule of rules) {
        if (!rule.enabled || userTags.includes(rule.tagId)) continue;
        let shouldTag = false;

        if (rule.condition === 'usage_above') {
          const used = userData.usage?.warpOptimizer?.usedToday || 0;
          const limit = userData.usage?.warpOptimizer?.limit || 1;
          shouldTag = (used / limit) * 100 >= rule.value;
        } else if (rule.condition === 'inactive_days') {
          const lastLogin = userData.lastLoginAt?.toDate?.();
          if (lastLogin) {
            const days = Math.floor((Date.now() - lastLogin.getTime()) / (1000 * 60 * 60 * 24));
            shouldTag = days >= rule.value;
          }
        } else if (rule.condition === 'plan_is') {
          shouldTag = (userData.subscription?.plan || 'free') === rule.value;
        }
        if (shouldTag) tagsToAdd.push(rule.tagId);
      }

      if (tagsToAdd.length > 0) {
        await userDoc.ref.update({ tags: admin.firestore.FieldValue.arrayUnion(...tagsToAdd) });
        taggedCount++;
      }
    }
    return { success: true, tagged: taggedCount };
  } catch (error) {
    throw new functions.https.HttpsError('internal', 'Failed to run rules: ' + error.message);
  }
});

// =====================================================
// FEATURE 4: NOTIFICATIONS SYSTEM
// =====================================================

// Get notification settings
exports.adminGetNotificationSettings = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  try {
    const doc = await db.collection('settings').doc('notifications').get();
    const s = doc.exists ? doc.data() : {};
    return {
      success: true,
      settings: {
        expiringDays: s.expiringDays || 3,
        inactiveDays: s.inactiveDays || 7,
        highUsagePercent: s.highUsagePercent || 80,
        emailEnabled: s.emailEnabled || false,
        adminEmail: s.adminEmail || ''
      }
    };
  } catch (error) {
    throw new functions.https.HttpsError('internal', 'Failed to get settings: ' + error.message);
  }
});

// Set notification settings
exports.adminSetNotificationSettings = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const { expiringDays, inactiveDays, highUsagePercent, emailEnabled, adminEmail } = data || {};

  try {
    await db.collection('settings').doc('notifications').set({
      expiringDays: Math.max(1, Math.min(30, expiringDays || 3)),
      inactiveDays: Math.max(1, Math.min(90, inactiveDays || 7)),
      highUsagePercent: Math.max(50, Math.min(100, highUsagePercent || 80)),
      emailEnabled: !!emailEnabled,
      adminEmail: (adminEmail || '').trim().substring(0, 100),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { success: true };
  } catch (error) {
    throw new functions.https.HttpsError('internal', 'Failed to save: ' + error.message);
  }
});

// Get notifications
exports.adminGetNotifications = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  try {
    const snapshot = await db.collection('adminNotifications')
      .where('dismissed', '==', false)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const notifications = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      notifications.push({
        id: doc.id, type: d.type, title: d.title, message: d.message,
        userId: d.userId, userEmail: d.userEmail, priority: d.priority || 'normal',
        createdAt: d.createdAt?.toDate?.()?.toISOString() || null
      });
    });
    return { success: true, notifications };
  } catch (error) {
    throw new functions.https.HttpsError('internal', 'Failed to get notifications: ' + error.message);
  }
});

// Dismiss notification
exports.adminDismissNotification = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const { notificationId, dismissAll = false } = data || {};

  try {
    if (dismissAll) {
      const snapshot = await db.collection('adminNotifications').where('dismissed', '==', false).get();
      const batch = db.batch();
      snapshot.forEach(doc => batch.update(doc.ref, { dismissed: true, dismissedAt: admin.firestore.FieldValue.serverTimestamp() }));
      await batch.commit();
      return { success: true, message: 'All dismissed' };
    }
    if (!notificationId) throw new functions.https.HttpsError('invalid-argument', 'ID required');
    await db.collection('adminNotifications').doc(notificationId).update({ dismissed: true, dismissedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { success: true };
  } catch (error) {
    throw new functions.https.HttpsError('internal', 'Failed: ' + error.message);
  }
});

// Check and create notifications (scheduled daily at 8 AM UTC)
exports.checkAndCreateNotifications = functions.pubsub.schedule('0 8 * * *').timeZone('UTC').onRun(async (context) => {
  try {
    const settingsDoc = await db.collection('settings').doc('notifications').get();
    const s = settingsDoc.exists ? settingsDoc.data() : {};
    const expiringDays = s.expiringDays || 3;
    const inactiveDays = s.inactiveDays || 7;
    const highUsagePercent = s.highUsagePercent || 80;

    const now = new Date();
    const expiringThreshold = new Date(now.getTime() + expiringDays * 24 * 60 * 60 * 1000);
    const inactiveThreshold = new Date(now.getTime() - inactiveDays * 24 * 60 * 60 * 1000);

    const usersSnapshot = await db.collection('users').get();
    const existingSnapshot = await db.collection('adminNotifications').where('dismissed', '==', false).get();
    const existingKeys = new Set();
    existingSnapshot.forEach(doc => {
      const d = doc.data();
      if (d.userId && d.type) existingKeys.add(`${d.userId}_${d.type}`);
    });

    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();
      const userId = userDoc.id;
      const email = userData.clientAlias || userData.email || 'Unknown';
      const plan = userData.subscription?.plan || 'free';

      // Expiring subscriptions
      const endDate = userData.subscription?.endDate?.toDate?.();
      if (endDate && endDate <= expiringThreshold && endDate > now && !existingKeys.has(`${userId}_expiring_subscription`)) {
        const daysLeft = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
        await db.collection('adminNotifications').add({
          type: 'expiring_subscription', title: 'Subscription Expiring',
          message: `${email}'s subscription expires in ${daysLeft} day(s)`,
          userId, userEmail: userData.email, priority: daysLeft <= 1 ? 'high' : 'normal',
          dismissed: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // Inactive paid users
      if (plan !== 'free') {
        const lastLogin = userData.lastLoginAt?.toDate?.();
        if (lastLogin && lastLogin < inactiveThreshold && !existingKeys.has(`${userId}_inactive_user`)) {
          const daysSince = Math.floor((now - lastLogin) / (1000 * 60 * 60 * 24));
          await db.collection('adminNotifications').add({
            type: 'inactive_user', title: 'Inactive Paid User',
            message: `${email} hasn't logged in for ${daysSince} days`,
            userId, userEmail: userData.email, priority: 'low',
            dismissed: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      }

      // High usage
      const used = userData.usage?.warpOptimizer?.usedToday || 0;
      const limit = userData.usage?.warpOptimizer?.limit || 1;
      const pct = (used / limit) * 100;
      if (pct >= highUsagePercent && plan !== 'enterprise' && !existingKeys.has(`${userId}_high_usage`)) {
        await db.collection('adminNotifications').add({
          type: 'high_usage', title: 'High Usage - Upsell Opportunity',
          message: `${email} using ${Math.round(pct)}% of quota`,
          userId, userEmail: userData.email, priority: 'normal',
          dismissed: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    }
    return null;
  } catch (error) {
    console.error('Notification check error:', error);
    return null;
  }
});

// Manual notification check
exports.adminCheckNotifications = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  try {
    const settingsDoc = await db.collection('settings').doc('notifications').get();
    const s = settingsDoc.exists ? settingsDoc.data() : {};
    const expiringDays = s.expiringDays || 3;
    const inactiveDays = s.inactiveDays || 7;
    const highUsagePercent = s.highUsagePercent || 80;

    const now = new Date();
    const expiringThreshold = new Date(now.getTime() + expiringDays * 24 * 60 * 60 * 1000);
    const inactiveThreshold = new Date(now.getTime() - inactiveDays * 24 * 60 * 60 * 1000);

    const usersSnapshot = await db.collection('users').get();
    const existingSnapshot = await db.collection('adminNotifications').where('dismissed', '==', false).get();
    const existingKeys = new Set();
    existingSnapshot.forEach(doc => {
      const d = doc.data();
      if (d.userId && d.type) existingKeys.add(`${d.userId}_${d.type}`);
    });

    let created = 0;

    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();
      const userId = userDoc.id;
      const email = userData.clientAlias || userData.email || 'Unknown';
      const plan = userData.subscription?.plan || 'free';

      const endDate = userData.subscription?.endDate?.toDate?.();
      if (endDate && endDate <= expiringThreshold && endDate > now && !existingKeys.has(`${userId}_expiring_subscription`)) {
        const daysLeft = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
        await db.collection('adminNotifications').add({
          type: 'expiring_subscription', title: 'Subscription Expiring',
          message: `${email}'s subscription expires in ${daysLeft} day(s)`,
          userId, userEmail: userData.email, priority: daysLeft <= 1 ? 'high' : 'normal',
          dismissed: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        created++;
      }

      if (plan !== 'free') {
        const lastLogin = userData.lastLoginAt?.toDate?.();
        if (lastLogin && lastLogin < inactiveThreshold && !existingKeys.has(`${userId}_inactive_user`)) {
          const daysSince = Math.floor((now - lastLogin) / (1000 * 60 * 60 * 24));
          await db.collection('adminNotifications').add({
            type: 'inactive_user', title: 'Inactive Paid User',
            message: `${email} hasn't logged in for ${daysSince} days`,
            userId, userEmail: userData.email, priority: 'low',
            dismissed: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          created++;
        }
      }

      const used = userData.usage?.warpOptimizer?.usedToday || 0;
      const limit = userData.usage?.warpOptimizer?.limit || 1;
      const pct = (used / limit) * 100;
      if (pct >= highUsagePercent && plan !== 'enterprise' && !existingKeys.has(`${userId}_high_usage`)) {
        await db.collection('adminNotifications').add({
          type: 'high_usage', title: 'High Usage - Upsell',
          message: `${email} using ${Math.round(pct)}% of quota`,
          userId, userEmail: userData.email, priority: 'normal',
          dismissed: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        created++;
      }
    }
    return { success: true, created };
  } catch (error) {
    throw new functions.https.HttpsError('internal', 'Failed: ' + error.message);
  }
});
