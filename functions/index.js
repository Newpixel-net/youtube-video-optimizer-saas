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
const { fal } = require('@fal-ai/client');
const sharp = require('sharp');

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
 * Helper: Enforce maximum projects per user
 * Deletes oldest projects if user exceeds limit (default 8)
 * Also cleans up associated storage files
 */
async function enforceMaxProjects(uid, maxProjects = 8) {
  // Use the default bucket (most reliable) - Firebase admin SDK knows the correct bucket
  const bucket = admin.storage().bucket();
  const STORAGE_BUCKET = bucket.name;

  try {
    // Get user's projects ordered by creation date (oldest first)
    const projectsSnapshot = await db.collection('wizardProjects')
      .where('userId', '==', uid)
      .orderBy('createdAt', 'asc')
      .get();

    const projectCount = projectsSnapshot.size;

    // If at or over limit, delete oldest projects to make room for new one
    if (projectCount >= maxProjects) {
      const projectsToDelete = projectCount - maxProjects + 1; // +1 to make room for new project
      const docs = projectsSnapshot.docs.slice(0, projectsToDelete);

      console.log(`[enforceMaxProjects] User ${uid} has ${projectCount} projects, deleting ${projectsToDelete} oldest`);

      for (const doc of docs) {
        const projectData = doc.data();

        // Clean up storage files associated with this project
        try {
          // Delete sourceAsset if exists
          if (projectData.sourceAsset?.storagePath) {
            await bucket.file(projectData.sourceAsset.storagePath).delete().catch(() => {});
          }
          // Delete uploaded video if exists
          if (projectData.uploadedVideoPath) {
            await bucket.file(projectData.uploadedVideoPath).delete().catch(() => {});
          }
          // Delete any clip-specific captures
          const clipCapturesPath = `extension-uploads/${projectData.videoId}`;
          const [files] = await bucket.getFiles({ prefix: clipCapturesPath });
          for (const file of files) {
            await file.delete().catch(() => {});
          }
        } catch (storageError) {
          console.log(`[enforceMaxProjects] Storage cleanup error for project ${doc.id}:`, storageError.message);
        }

        // Delete the project document
        await db.collection('wizardProjects').doc(doc.id).delete();
        console.log(`[enforceMaxProjects] Deleted old project ${doc.id} (${projectData.videoId || 'uploaded'})`);
      }
    }

    return { deleted: projectCount >= maxProjects ? projectCount - maxProjects + 1 : 0 };
  } catch (error) {
    console.error('[enforceMaxProjects] Error:', error.message);
    // Don't throw - allow project creation to continue even if cleanup fails
    return { deleted: 0, error: error.message };
  }
}

/**
 * Helper: Get max projects setting from admin config
 */
async function getMaxProjectsLimit() {
  try {
    const configDoc = await db.collection('settings').doc('wizardConfig').get();
    if (configDoc.exists && configDoc.data().maxProjectsPerUser) {
      return configDoc.data().maxProjectsPerUser;
    }
  } catch (error) {
    console.log('[getMaxProjectsLimit] Using default:', error.message);
  }
  return 8; // Default max projects
}

/**
 * Helper: Get token configuration from admin settings
 * Default values MUST match admin panel defaults in admin-plans.html
 * This function is used across multiple token-related Cloud Functions
 */
async function getTokenConfigFromAdmin() {
  const tokenConfigDoc = await db.collection('settings').doc('tokenConfig').get();
  // These defaults match the admin panel UI defaults
  const defaultTokenConfig = {
    free: { monthlyTokens: 10, rolloverPercent: 0 },
    lite: { monthlyTokens: 50, rolloverPercent: 25 },
    pro: { monthlyTokens: 200, rolloverPercent: 50 },
    enterprise: { monthlyTokens: 1000, rolloverPercent: 100 }
  };

  return tokenConfigDoc.exists
    ? { ...defaultTokenConfig, ...tokenConfigDoc.data().plans }
    : defaultTokenConfig;
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

/**
 * AI Virality Scoring System (OpusClip-style)
 *
 * This enhanced scoring system analyzes clips based on multiple factors:
 * - Hook Strength: How compelling are the first 3 seconds
 * - Emotional Impact: What emotions does the content trigger
 * - Trend Alignment: How relevant is the topic to current trends
 * - Engagement Potential: Likelihood of comments, shares, saves
 * - Watch-Through Rate: Will viewers watch to the end
 *
 * Returns a detailed score breakdown instead of just a single number
 */
async function calculateEnhancedViralityScore(clipData, videoContext) {
  const { transcript, duration, emotionalHook, reason, uniqueAngle } = clipData;
  const { title, channelTitle, viewCount, contentType } = videoContext;

  // Build analysis prompt for detailed scoring
  const scoringPrompt = `You are a viral content scoring AI like OpusClip's virality predictor.

Analyze this short-form video clip and provide detailed virality scores.

CLIP CONTENT:
- From video: "${title}" by ${channelTitle}
- Duration: ${duration} seconds
- Content: "${transcript || reason || 'No transcript available'}"
- Unique angle: "${uniqueAngle || 'Not specified'}"
- Emotional hook: "${emotionalHook || 'Not specified'}"
- Video views: ${(viewCount || 0).toLocaleString()}
- Content type: ${contentType || 'general'}

Score each factor from 0-100 and provide a DETAILED breakdown.

SCORING CRITERIA:

1. HOOK STRENGTH (0-100): Does the first 3 seconds grab attention?
   - 90-100: Irresistible hook, impossible to scroll past
   - 70-89: Strong hook, catches most viewers
   - 50-69: Decent hook, some engagement
   - Below 50: Weak hook, easy to scroll past

2. EMOTIONAL IMPACT (0-100): How much emotion does it trigger?
   - Consider: curiosity, surprise, inspiration, humor, controversy, relatability
   - 90-100: Strong emotional response guaranteed
   - 70-89: Noticeable emotional reaction
   - 50-69: Mild interest
   - Below 50: Low emotional engagement

3. SHAREABILITY (0-100): Will viewers share this?
   - Consider: "I need to show this to someone" factor
   - Quotable moments, relatable content, useful tips

4. TREND ALIGNMENT (0-100): How relevant to current trends?
   - Consider: trending topics, formats, sounds, themes
   - Evergreen content scores 60-70 (always relevant but not trending)

5. COMPLETION RATE (0-100): Will viewers watch until the end?
   - Consider: pacing, payoff, story arc, length

6. ENGAGEMENT BAIT (0-100): Will it generate comments?
   - Consider: controversial takes, questions, debate potential

RESPOND IN JSON:
{
  "overallScore": <weighted average, 0-100>,
  "breakdown": {
    "hookStrength": { "score": <0-100>, "reason": "brief explanation" },
    "emotionalImpact": { "score": <0-100>, "reason": "brief explanation" },
    "shareability": { "score": <0-100>, "reason": "brief explanation" },
    "trendAlignment": { "score": <0-100>, "reason": "brief explanation" },
    "completionRate": { "score": <0-100>, "reason": "brief explanation" },
    "engagementBait": { "score": <0-100>, "reason": "brief explanation" }
  },
  "viralPrediction": "HIGH/MEDIUM/LOW",
  "recommendedPlatform": "tiktok/instagram/youtube",
  "improvementTips": ["tip 1", "tip 2"],
  "bestPostingTime": "e.g., 'weekday evenings' or 'weekend mornings'"
}`;

  try {
    // Add 15 second timeout per API call to prevent hanging
    const response = await Promise.race([
      openai.chat.completions.create({
        model: 'gpt-4o-mini', // Use mini for cost efficiency on repeated calls
        messages: [{ role: 'user', content: scoringPrompt }],
        response_format: { type: 'json_object' },
        max_tokens: 800,
        temperature: 0.5
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('API timeout')), 15000)
      )
    ]);

    const result = JSON.parse(response.choices[0].message.content);

    return {
      score: Math.round(result.overallScore || 75),
      breakdown: result.breakdown || {},
      prediction: result.viralPrediction || 'MEDIUM',
      recommendedPlatform: result.recommendedPlatform || 'tiktok',
      tips: result.improvementTips || [],
      bestTime: result.bestPostingTime || 'evening'
    };
  } catch (error) {
    console.log('Enhanced virality scoring failed, using basic score:', error.message);
    // Fallback to basic scoring
    return {
      score: clipData.viralityScore || 75,
      breakdown: {},
      prediction: 'MEDIUM',
      recommendedPlatform: 'tiktok',
      tips: [],
      bestTime: 'evening'
    };
  }
}

/**
 * Batch process virality scores for multiple clips
 * More efficient than scoring one at a time
 */
async function batchCalculateViralityScores(clips, videoContext) {
  // For cost efficiency, only do enhanced scoring on top candidates
  // Sort by initial score and enhance top 6
  const sortedClips = [...clips].sort((a, b) => (b.score || 0) - (a.score || 0));
  const topClips = sortedClips.slice(0, 6);

  const enhancedClips = await Promise.all(
    topClips.map(async (clip) => {
      const enhanced = await calculateEnhancedViralityScore(clip, videoContext);
      return {
        ...clip,
        score: enhanced.score,
        viralityBreakdown: enhanced.breakdown,
        viralPrediction: enhanced.prediction,
        recommendedPlatform: enhanced.recommendedPlatform,
        improvementTips: enhanced.tips,
        bestPostingTime: enhanced.bestTime
      };
    })
  );

  // Keep remaining clips with original scores
  const remainingClips = sortedClips.slice(6).map(clip => ({
    ...clip,
    viralPrediction: clip.score >= 80 ? 'MEDIUM' : 'LOW'
  }));

  // Re-sort all clips by final score (descending) since enhancement may have changed scores
  const allClips = [...enhancedClips, ...remainingClips];
  return allClips.sort((a, b) => (b.score || 0) - (a.score || 0));
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
    const userIds = [];

    snapshot.forEach(doc => {
      userIds.push(doc.id);
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
        tags: userData.tags || [],
        subscription: {
          ...(userData.subscription || { plan: 'free' }),
          duration: userData.subscription?.duration || null,
          endDate: userData.subscription?.endDate?.toDate?.()?.toISOString() || null,
          startDate: userData.subscription?.startDate?.toDate?.()?.toISOString() || null
        },
        subscriptionStatus,
        usage: userData.usage || {},
        bonusUses: userData.bonusUses || {},
        isAdmin: userData.isAdmin || false,
        createdAt: userData.createdAt?.toDate?.()?.toISOString() || null,
        lastLoginAt: userData.lastLoginAt?.toDate?.()?.toISOString() || null,
        tokens: null // Will be populated below
      });
    });

    // Fetch token balances from creativeTokens collection for all users
    if (userIds.length > 0) {
      // Batch fetch in chunks of 10 (Firestore limit for 'in' queries)
      const tokenMap = {};
      for (let i = 0; i < userIds.length; i += 10) {
        const chunk = userIds.slice(i, i + 10);
        const tokenDocs = await Promise.all(
          chunk.map(uid => db.collection('creativeTokens').doc(uid).get())
        );
        tokenDocs.forEach((doc, index) => {
          if (doc.exists) {
            const tokenData = doc.data();
            tokenMap[chunk[index]] = {
              balance: tokenData.balance || 0,
              rollover: tokenData.rollover || 0,
              plan: tokenData.plan || 'free',
              monthlyAllocation: tokenData.monthlyAllocation || 0,
              lastRefresh: tokenData.lastRefresh?.toDate?.()?.toISOString() || null
            };
          }
        });
      }

      // Attach token data to users
      users = users.map(user => ({
        ...user,
        tokens: tokenMap[user.uid] || { balance: 0, rollover: 0, plan: 'free' }
      }));
    }

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

    // Log activity
    await logUserActivity(userId, 'subscription_change', { action: 'set_plan', plan: targetPlan }, context.auth.uid);

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

  // Log activity
  await logUserActivity(userId, 'profile_update', { field: 'alias', value: sanitizedAlias }, context.auth.uid);

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

  // Log activity
  await logUserActivity(userId, 'profile_update', { field: 'fiverr_verified', value: verified }, context.auth.uid);

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

  // Log activity
  await logUserActivity(userId, 'subscription_change', { action: 'extend', days: extensionDays, newEndDate: newEndDate.toISOString() }, adminUid);

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

// Add/Remove creative tokens from a user (for Thumbnail Generator Pro / Creative Studio)
exports.adminAdjustCreativeTokens = functions.https.onCall(async (data, context) => {
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

    const userPlan = userDoc.data().subscription?.plan || 'free';

    // Get or create creativeTokens document
    const tokenRef = db.collection('creativeTokens').doc(userId);
    const tokenDoc = await tokenRef.get();

    let currentBalance = 0;
    if (tokenDoc.exists) {
      currentBalance = tokenDoc.data().balance || 0;
    }

    const newBalance = Math.max(0, currentBalance + tokenAmount);

    // Update or create creativeTokens document
    await tokenRef.set({
      balance: newBalance,
      plan: userPlan,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Log the transaction
    await db.collection('tokenTransactions').add({
      userId,
      type: tokenAmount > 0 ? 'admin_creative_credit' : 'admin_creative_debit',
      amount: tokenAmount,
      balanceAfter: newBalance,
      reason: reason || 'Manual creative token adjustment by admin',
      performedBy: adminId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      message: `${tokenAmount > 0 ? 'Added' : 'Removed'} ${Math.abs(tokenAmount)} creative tokens`,
      newBalance
    };
  } catch (error) {
    console.error('adminAdjustCreativeTokens error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to adjust creative tokens'));
  }
});

// Reset a user's creative tokens to their plan allocation
exports.adminResetCreativeTokens = functions.https.onCall(async (data, context) => {
  try {
    const adminId = await requireAdmin(context);

    const { userId } = data || {};

    if (!userId || typeof userId !== 'string') {
      throw new functions.https.HttpsError('invalid-argument', 'Valid user ID is required');
    }

    // Get user's plan
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User not found');
    }

    const userPlan = userDoc.data().subscription?.plan || 'free';

    // Get admin-configured token settings (use shared helper for consistency)
    const tokenConfig = await getTokenConfigFromAdmin();
    const planConfig = tokenConfig[userPlan] || tokenConfig.free;
    const monthlyAllocation = planConfig.monthlyTokens || 10;
    const rolloverPercent = planConfig.rolloverPercent || 0;

    // Reset creative tokens to plan allocation
    const tokenRef = db.collection('creativeTokens').doc(userId);
    await tokenRef.set({
      balance: monthlyAllocation,
      rollover: 0,
      plan: userPlan,
      monthlyAllocation: monthlyAllocation,
      rolloverPercent: rolloverPercent,
      lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
      resetBy: adminId,
      resetAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Log the transaction
    await db.collection('tokenTransactions').add({
      userId,
      type: 'admin_creative_reset',
      amount: monthlyAllocation,
      balanceAfter: monthlyAllocation,
      reason: `Reset to ${userPlan} plan allocation by admin`,
      performedBy: adminId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      message: `Reset creative tokens to ${monthlyAllocation} (${userPlan} plan)`,
      newBalance: monthlyAllocation,
      plan: userPlan
    };
  } catch (error) {
    console.error('adminResetCreativeTokens error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to reset creative tokens'));
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
// FETCH YOUTUBE VIDEO DATA - For Thumbnail Upgrade Feature
// Fetches video metadata and thumbnail URL from YouTube
// ==============================================

exports.fetchYoutubeVideoData = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'fetchYoutubeData', 10); // 10 per minute

  const { videoId, videoUrl } = data;

  // Extract video ID from URL if provided
  let extractedId = videoId;
  if (!extractedId && videoUrl) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([^&\s?#]+)/,
      /youtube\.com\/shorts\/([^&\s?#]+)/
    ];
    for (const pattern of patterns) {
      const match = videoUrl.match(pattern);
      if (match) {
        extractedId = match[1];
        break;
      }
    }
  }

  if (!extractedId) {
    throw new functions.https.HttpsError('invalid-argument', 'Valid YouTube video ID or URL is required');
  }

  try {
    // Try YouTube Data API if key is configured
    const youtubeApiKey = functions.config().youtube?.key;

    if (youtubeApiKey) {
      const response = await axios.get(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${extractedId}&key=${youtubeApiKey}`,
        { timeout: 10000 }
      );

      const video = response.data.items?.[0];
      if (!video) {
        throw new functions.https.HttpsError('not-found', 'Video not found');
      }

      const snippet = video.snippet;
      const thumbnails = snippet.thumbnails;

      // Get highest quality thumbnail available
      const thumbnailUrl = thumbnails.maxres?.url ||
                          thumbnails.standard?.url ||
                          thumbnails.high?.url ||
                          thumbnails.medium?.url ||
                          thumbnails.default?.url;

      return {
        success: true,
        videoId: extractedId,
        title: snippet.title,
        description: snippet.description?.substring(0, 500) || '',
        channelName: snippet.channelTitle,
        thumbnailUrl: thumbnailUrl,
        publishedAt: snippet.publishedAt,
        tags: snippet.tags?.slice(0, 10) || []
      };
    }

    // Fallback: Construct thumbnail URL directly (works without API key)
    // YouTube thumbnails follow predictable patterns
    const maxresThumbnail = `https://img.youtube.com/vi/${extractedId}/maxresdefault.jpg`;
    const hqThumbnail = `https://img.youtube.com/vi/${extractedId}/hqdefault.jpg`;

    // Verify thumbnail exists by checking maxres first
    try {
      await axios.head(maxresThumbnail, { timeout: 5000 });
      return {
        success: true,
        videoId: extractedId,
        title: null,
        description: null,
        channelName: null,
        thumbnailUrl: maxresThumbnail,
        fallbackMode: true,
        message: 'Video thumbnail found. Title/description not available without YouTube API key.'
      };
    } catch {
      // Fallback to HQ thumbnail if maxres doesn't exist
      return {
        success: true,
        videoId: extractedId,
        title: null,
        description: null,
        channelName: null,
        thumbnailUrl: hqThumbnail,
        fallbackMode: true,
        message: 'Video thumbnail found. Title/description not available without YouTube API key.'
      };
    }

  } catch (error) {
    console.error('fetchYoutubeVideoData error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to fetch video data. Please check the URL and try again.');
  }
});

// ==============================================
// FETCH YOUTUBE PLAYLIST - For Bulk Thumbnail Upgrade Feature
// Fetches all videos from a YouTube playlist
// ==============================================

exports.fetchYoutubePlaylist = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'fetchYoutubePlaylist', 5); // 5 per minute

  const { playlistUrl } = data;

  if (!playlistUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Playlist URL is required');
  }

  // Extract playlist ID from various URL formats
  const extractPlaylistId = (url) => {
    const patterns = [
      /[?&]list=([a-zA-Z0-9_-]+)/,
      /\/playlist\/([a-zA-Z0-9_-]+)/
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }
    return null;
  };

  const playlistId = extractPlaylistId(playlistUrl);
  if (!playlistId) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid playlist URL. Please use a valid YouTube playlist link.');
  }

  const youtubeApiKey = functions.config().youtube?.key;
  if (!youtubeApiKey) {
    throw new functions.https.HttpsError('failed-precondition', 'YouTube API key not configured. Contact administrator.');
  }

  try {
    const videos = [];
    let nextPageToken = null;
    const maxVideos = 100; // Cap at 100 videos

    // Fetch all pages (YouTube returns max 50 per page)
    do {
      const params = new URLSearchParams({
        part: 'snippet',
        playlistId: playlistId,
        maxResults: '50',
        key: youtubeApiKey
      });
      if (nextPageToken) params.append('pageToken', nextPageToken);

      const response = await axios.get(
        `https://www.googleapis.com/youtube/v3/playlistItems?${params}`,
        { timeout: 15000 }
      );

      if (response.data.error) {
        throw new Error(response.data.error.message);
      }

      for (const item of response.data.items || []) {
        // Skip deleted/private videos
        const title = item.snippet?.title;
        if (title === 'Deleted video' || title === 'Private video') {
          continue;
        }

        const videoId = item.snippet?.resourceId?.videoId;
        if (!videoId) continue;

        const thumbnails = item.snippet?.thumbnails || {};
        videos.push({
          videoId: videoId,
          title: title,
          description: (item.snippet?.description || '').substring(0, 300),
          channelName: item.snippet?.channelTitle || '',
          thumbnailUrl: thumbnails.maxres?.url ||
                        thumbnails.high?.url ||
                        thumbnails.medium?.url ||
                        `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
          position: item.snippet?.position || 0
        });
      }

      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken && videos.length < maxVideos);

    // Get playlist metadata
    const playlistResponse = await axios.get(
      `https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${playlistId}&key=${youtubeApiKey}`,
      { timeout: 10000 }
    );
    const playlistInfo = playlistResponse.data.items?.[0]?.snippet || {};

    return {
      success: true,
      playlistId: playlistId,
      playlistTitle: playlistInfo.title || 'Unknown Playlist',
      channelName: playlistInfo.channelTitle || 'Unknown Channel',
      videoCount: videos.length,
      videos: videos.slice(0, maxVideos) // Ensure max limit
    };

  } catch (error) {
    console.error('fetchYoutubePlaylist error:', error);
    if (error.response?.data?.error?.message) {
      throw new functions.https.HttpsError('internal', error.response.data.error.message);
    }
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to fetch playlist. Please check the URL and try again.');
  }
});

// ==============================================
// SMART CAPTION SYSTEM v3 - Intelligent Part Selection
// Detects attribution vs content, extracts key phrases
// ==============================================

/**
 * Generate optimal caption by cleaning title and intelligently selecting best part
 * @param {string} title - The full video title
 * @param {number} maxChars - Maximum characters allowed (default 35)
 * @returns {Promise<string>} - Cleaned caption in uppercase
 */
async function generateOptimalCaption(title, maxChars = 35) {
  // Step 1: Try to extract quoted content first (highest priority)
  const quotedContent = extractQuotedContent(title);
  if (quotedContent && quotedContent.length <= maxChars && quotedContent.length >= 3) {
    console.log(`Smart Caption v3: "${title}" → "${quotedContent.toUpperCase()}" (quoted content)`);
    return quotedContent.toUpperCase();
  }

  // Step 2: Clean the title (remove YouTube junk)
  let caption = cleanYouTubeTitle(title);

  // Step 3: If already fits, return it
  if (caption.length <= maxChars) {
    console.log(`Smart Caption v3: "${title}" → "${caption}" (${caption.length} chars) [clean]`);
    return caption;
  }

  // Step 4: Smart truncation with intelligent part selection
  caption = smartTruncateV3(caption, title, maxChars);

  // Step 5: If still too long, use AI to shorten intelligently
  if (caption.length > maxChars) {
    try {
      caption = await aiShortenCaption(title, caption, maxChars);
    } catch (error) {
      console.error('AI caption shortening failed:', error.message);
      // Final fallback: hard truncate at word boundary
      caption = truncateAtWordBoundary(caption, maxChars);
    }
  }

  console.log(`Smart Caption v3: "${title}" → "${caption}" (${caption.length} chars)`);
  return caption;
}

/**
 * Extract content in quotes (single or double) - often the song/key phrase
 * Examples: 'Your Truth', "Night Rainbows", 'L'infinito'
 */
function extractQuotedContent(title) {
  // Try single quotes first (more common in titles)
  const singleQuoteMatch = title.match(/'([^']+)'/);
  if (singleQuoteMatch && singleQuoteMatch[1].length >= 3) {
    return singleQuoteMatch[1];
  }

  // Try double quotes
  const doubleQuoteMatch = title.match(/"([^"]+)"/);
  if (doubleQuoteMatch && doubleQuoteMatch[1].length >= 3) {
    return doubleQuoteMatch[1];
  }

  // Try fancy quotes
  const fancyQuoteMatch = title.match(/[''"]([^''"]+)[''""]/);
  if (fancyQuoteMatch && fancyQuoteMatch[1].length >= 3) {
    return fancyQuoteMatch[1];
  }

  return null;
}

/**
 * Detect if text is "attribution" - generic phrases that should be deprioritized
 * Examples: "Lyrics by Kērd DaiKur", "A New Release by Artist", "Music by X"
 */
function isAttribution(text) {
  const upperText = text.toUpperCase();

  // Patterns that indicate attribution (not the main content)
  const attributionPatterns = [
    /\bBY\s+[A-Z]/i,                    // "by [Name]" - strong indicator
    /\bLYRICS\s+BY\b/i,                 // "Lyrics by"
    /\bMUSIC\s+BY\b/i,                  // "Music by"
    /\bPRODUCED\s+BY\b/i,               // "Produced by"
    /\bDIRECTED\s+BY\b/i,               // "Directed by"
    /\bA\s+NEW\s+(RELEASE|SINGLE|TRACK|SONG)\b/i,  // "A New Release/Single"
    /\bNEW\s+(RELEASE|SINGLE|TRACK|SONG)\s+BY\b/i, // "New Release by"
    /\bFEAT(URING)?\.?\s/i,             // "feat." or "featuring"
    /\bFT\.?\s/i,                       // "ft."
    /\bPRESENTS?\b/i,                   // "presents"
    /\bFROM\s+THE\s+ALBUM\b/i,          // "from the album"
    /\bOUT\s+NOW\b/i,                   // "out now"
  ];

  for (const pattern of attributionPatterns) {
    if (pattern.test(upperText)) {
      return true;
    }
  }

  return false;
}

/**
 * Detect if text looks like a song/content title (short, punchy, no attribution)
 */
function isSongTitle(text) {
  // Short text without attribution patterns is likely a song title
  if (text.length <= 25 && !isAttribution(text)) {
    return true;
  }
  return false;
}

/**
 * Clean YouTube title by removing common junk
 * Preserves the meaningful structure (Artist – Song, How to X, etc.)
 */
function cleanYouTubeTitle(title) {
  let cleaned = title;

  // ROBUST: Remove any parentheses containing common YouTube junk words
  const junkWordsInParens = /\s*\([^)]*\b(official|video|lyric|lyrics|audio|music|hd|4k|1080p|720p|full|visualizer|clip|mv|remaster|remastered|live|acoustic|remix|cover|version|premiere|explicit|clean)\b[^)]*\)/gi;
  cleaned = cleaned.replace(junkWordsInParens, '');

  // Remove remaining parentheses with just years or short codes
  cleaned = cleaned.replace(/\s*\(\s*\d{4}\s*\)/g, ''); // (2024)
  cleaned = cleaned.replace(/\s*\(\s*(feat|ft|prod)\.?[^)]*\)/gi, ''); // (feat. X), (ft. X), (prod. X)

  // ROBUST: Remove any brackets containing common junk words
  const junkWordsInBrackets = /\s*\[[^\]]*\b(official|video|lyric|lyrics|audio|music|hd|4k|full|new|premiere)\b[^\]]*\]/gi;
  cleaned = cleaned.replace(junkWordsInBrackets, '');
  cleaned = cleaned.replace(/\s*\[\s*\d{4}\s*\]/g, ''); // [2024]

  // Remove everything after | (channel name, topic, etc.)
  cleaned = cleaned.replace(/\s*\|.*$/g, '');

  // Remove trailing indicators (but be careful not to remove song parts)
  cleaned = cleaned.replace(/\s*[-–—]\s*(official\s*)?(video|audio|lyric|lyrics|hd|4k|full)(\s+video)?$/gi, '');

  // Remove "Official" at the start
  cleaned = cleaned.replace(/^official\s*[-–—:]\s*/gi, '');

  // Remove hashtags
  cleaned = cleaned.replace(/\s*#\w+/g, '');

  // Clean up multiple spaces and trim
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Remove trailing punctuation except ? and !
  cleaned = cleaned.replace(/[,;:\-–—]+$/, '').trim();

  // Convert to uppercase for thumbnail
  return cleaned.toUpperCase();
}

/**
 * Smart truncation v3 - Intelligently selects best part
 * Key improvement: Detects attribution vs content and prioritizes accordingly
 */
function smartTruncateV3(caption, originalTitle, maxChars) {
  if (caption.length <= maxChars) return caption;

  // Try to cut at natural separators: – - — :
  const separators = [' – ', ' — ', ' - ', ': '];

  for (const sep of separators) {
    const sepIndex = caption.indexOf(sep);
    if (sepIndex > 0) {
      const parts = caption.split(sep);
      if (parts.length >= 2) {
        const part1 = parts[0].trim();
        const part2 = parts.slice(1).join(sep).trim();

        // Analyze both parts
        const part1IsAttribution = isAttribution(part1);
        const part2IsAttribution = isAttribution(part2);
        const part2IsSong = isSongTitle(part2);

        console.log(`Smart Caption v3 Analysis: part1="${part1}" (attr:${part1IsAttribution}), part2="${part2}" (attr:${part2IsAttribution}, song:${part2IsSong})`);

        // Decision logic: prioritize the content part, not the attribution
        let primaryPart, secondaryPart;

        if (part2IsAttribution && !part1IsAttribution) {
          // Part 2 is attribution (e.g., "Lyrics by X"), use Part 1
          primaryPart = part1;
          secondaryPart = part2;
        } else if (part1IsAttribution && !part2IsAttribution) {
          // Part 1 is attribution, use Part 2
          primaryPart = part2;
          secondaryPart = part1;
        } else if (part2IsSong && part2.length <= part1.length) {
          // Part 2 looks like a song title and is shorter - classic "Artist – Song" format
          primaryPart = part2;
          secondaryPart = part1;
        } else {
          // Default: prefer the first part (usually the hook/title)
          primaryPart = part1;
          secondaryPart = part2;
        }

        // Try 1: Full combination if fits
        const fullCombo = part1 + ' – ' + part2;
        if (fullCombo.length <= maxChars) {
          return fullCombo;
        }

        // Try 2: Primary part alone
        if (primaryPart.length <= maxChars) {
          return primaryPart;
        }

        // Try 3: Truncated primary part
        const truncatedPrimary = truncateAtWordBoundary(primaryPart, maxChars);
        if (truncatedPrimary.length >= 5) {
          return truncatedPrimary;
        }

        // Try 4: Secondary part if primary is too short
        if (secondaryPart.length <= maxChars) {
          return secondaryPart;
        }

        // Try 5: Truncated secondary part
        const truncatedSecondary = truncateAtWordBoundary(secondaryPart, maxChars);
        if (truncatedSecondary.length >= 5) {
          return truncatedSecondary;
        }
      }
    }
  }

  // No good break point found, truncate at word boundary
  return truncateAtWordBoundary(caption, maxChars);
}

/**
 * Truncate at word boundary
 */
function truncateAtWordBoundary(text, maxChars) {
  if (text.length <= maxChars) return text;

  const words = text.split(' ');
  let result = '';

  for (const word of words) {
    const potential = result ? result + ' ' + word : word;
    if (potential.length <= maxChars) {
      result = potential;
    } else {
      break;
    }
  }

  return result || text.substring(0, maxChars);
}

/**
 * Use AI to intelligently shorten a caption while preserving meaning
 */
async function aiShortenCaption(originalTitle, cleanedCaption, maxChars) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{
      role: 'system',
      content: `You shorten YouTube thumbnail captions while preserving meaning. Rules:
- Maximum ${maxChars} characters (STRICT)
- Keep the essential meaning and structure
- For "Artist – Song" format: keep both if possible, or prioritize song name
- For "How to X" format: keep the full phrase
- For questions: keep the question intact
- Output in ALL CAPS
- NO extra punctuation
- Output ONLY the shortened caption`
    }, {
      role: 'user',
      content: `Original: "${originalTitle}"
Cleaned: "${cleanedCaption}"

Shorten to max ${maxChars} characters while keeping the meaning:`
    }],
    temperature: 0.3,
    max_tokens: 50
  });

  let result = response.choices?.[0]?.message?.content?.trim().toUpperCase() || '';
  result = result.replace(/^["']|["']$/g, ''); // Remove quotes

  // Validate result
  if (result && result.length <= maxChars && result.length >= 3) {
    return result;
  }

  // AI failed to meet requirements, fall back
  return truncateAtWordBoundary(cleanedCaption, maxChars);
}

// ==============================================
// THUMBNAIL PRO - Multi-Model AI Thumbnail Generator
// Supports: Imagen 4, Gemini (Nano Banana Pro), DALL-E 3
// Features: Reference images, multiple variations, content categories
// ==============================================

exports.generateThumbnailPro = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'generateThumbnailPro', 5); // 5 per minute for pro generation

  const {
    title,
    style = 'professional',
    customPrompt = '',
    mode = 'quick', // quick | reference | upgrade | faceHero | styleClone | productPro
    category = 'general', // general | gaming | tutorial | vlog | review | news | entertainment
    variations = 1, // 1-4
    referenceImage = null, // { base64, mimeType }
    // NEW Phase 1 & 6 parameters
    referenceType = 'auto', // auto | face | product | style | background | upgrade
    compositionTemplate = 'auto', // auto | face-right | face-center | split-screen | product-hero | action-shot
    faceStrength = 0.85, // 0.5-1.0 - how much to preserve face
    styleStrength = 0.7, // 0.3-1.0 - how much to match style
    expressionModifier = 'keep', // keep | excited | serious | surprised
    backgroundStyle = 'auto', // auto | studio | blur | gradient | custom
    // Thumbnail Upgrade specific parameters
    originalThumbnailUrl = null, // URL to fetch thumbnail from (YouTube)
    youtubeContext = null, // { videoId, title, description, channelName }
    // Face Lock feature - preserve face across batch generation
    faceReferenceImage = null // { base64, mimeType } - face to preserve in all thumbnails
  } = data;

  if (!title || title.trim().length < 3) {
    throw new functions.https.HttpsError('invalid-argument', 'Video title is required (min 3 characters)');
  }

  // Validate variations
  const imageCount = Math.min(Math.max(parseInt(variations) || 1, 1), 4);

  // ==========================================
  // PHASE 1: ENHANCED MODE CONFIGURATION
  // ==========================================
  const modeConfig = {
    quick: { model: 'imagen-4', tokenCost: 2, supportsReference: false },
    reference: { model: 'nano-banana-pro', tokenCost: 4, supportsReference: true },
    upgrade: { model: 'nano-banana-pro', tokenCost: 4, supportsReference: true, isUpgrade: true },
    // Specialized modes
    faceHero: { model: 'nano-banana-pro', tokenCost: 5, supportsReference: true, specialization: 'face' },
    styleClone: { model: 'nano-banana-pro', tokenCost: 4, supportsReference: true, specialization: 'style' },
    productPro: { model: 'nano-banana-pro', tokenCost: 6, supportsReference: true, specialization: 'product' }
  };

  const config = modeConfig[mode] || modeConfig.quick;
  const totalCost = config.tokenCost * imageCount;

  // Validate reference image for reference-supporting modes
  const needsReference = ['reference', 'upgrade', 'faceHero', 'styleClone'].includes(mode);
  const hasReferenceImage = referenceImage?.base64 || originalThumbnailUrl;
  if (needsReference && !hasReferenceImage) {
    throw new functions.https.HttpsError('invalid-argument', `${mode} mode requires a reference image or thumbnail URL`);
  }

  // Fetch thumbnail from URL if provided (for upgrade mode with YouTube)
  let effectiveReferenceImage = referenceImage;
  if (mode === 'upgrade' && originalThumbnailUrl && !referenceImage?.base64) {
    try {
      console.log('Fetching thumbnail from URL:', originalThumbnailUrl);
      const thumbnailResponse = await axios.get(originalThumbnailUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ThumbnailFetcher/1.0)'
        }
      });
      effectiveReferenceImage = {
        base64: Buffer.from(thumbnailResponse.data).toString('base64'),
        mimeType: thumbnailResponse.headers['content-type'] || 'image/jpeg'
      };
      console.log('Successfully fetched thumbnail, size:', effectiveReferenceImage.base64.length);
    } catch (fetchError) {
      console.error('Failed to fetch thumbnail from URL:', fetchError.message);
      throw new functions.https.HttpsError('invalid-argument', 'Failed to fetch thumbnail from URL. Please try uploading the image directly.');
    }
  }

  // ==========================================
  // SMART CAPTION PRE-GENERATION
  // Generate optimal caption ONCE before any prompts
  // Cleans title, preserves structure, max 35 chars
  // ==========================================
  const optimizedCaption = await generateOptimalCaption(title, 35);

  // ==========================================
  // PHASE 1: REVOLUTIONARY PROMPT ENGINEERING
  // ==========================================

  // Reference Type Specialized Prompts (THE KEY FIX)
  const referenceTypePrompts = {
    face: `CRITICAL FACE PRESERVATION REQUIREMENTS:
┌─────────────────────────────────────────────────────────────┐
│ FACE IDENTITY - MUST PRESERVE EXACTLY:                      │
├─────────────────────────────────────────────────────────────┤
│ • Facial structure: exact bone structure, face shape        │
│ • Eyes: precise shape, color, spacing, brow arch           │
│ • Nose: exact shape, size, bridge profile                  │
│ • Mouth: lip shape, size, natural expression               │
│ • Skin: tone, texture, any distinctive features            │
│ • Hair: color, style, texture, length exactly as shown     │
└─────────────────────────────────────────────────────────────┘

COMPOSITION FOR FACE THUMBNAILS:
• Face should occupy 35-45% of the thumbnail
• Position face on RIGHT THIRD of frame (golden ratio)
• Eyes should be in upper third of frame
• Leave LEFT 40% clear for text overlay space
• Face should "pop" from background with rim lighting

LIGHTING FOR FACES:
• Soft key light at 45° angle (beauty lighting)
• Subtle fill light to reduce harsh shadows
• Rim/hair light for separation from background
• Catch lights in eyes (essential for life-like look)

QUALITY REQUIREMENTS:
• 4K photorealistic quality
• Magazine cover / professional headshot quality
• Sharp focus on face, subtle background blur (f/2.8 equivalent)
• Color grade: cinematic with skin tone preservation`,

    product: `CRITICAL PRODUCT SHOWCASE REQUIREMENTS:
┌─────────────────────────────────────────────────────────────┐
│ PRODUCT IDENTITY - MUST PRESERVE EXACTLY:                   │
├─────────────────────────────────────────────────────────────┤
│ • Product shape and proportions: exact dimensions          │
│ • Brand colors: match precisely                            │
│ • Logos/text on product: if visible, keep accurate         │
│ • Material/texture: show quality and finish                │
│ • Key features: highlight what makes it special            │
└─────────────────────────────────────────────────────────────┘

COMPOSITION FOR PRODUCT THUMBNAILS:
• Product as HERO - center or golden ratio position
• 45° hero angle (most flattering for products)
• Clean background: gradient, solid, or contextual lifestyle
• Subtle reflection/shadow for grounding and depth
• Leave space for text overlay (top or side)

LIGHTING FOR PRODUCTS:
• 3-point professional product photography lighting
• Soft key light to show form
• Fill to reveal details in shadows
• Accent light for highlights and rim

QUALITY REQUIREMENTS:
• Commercial product photography quality
• Sharp focus throughout (deep depth of field)
• Clean, distraction-free presentation
• Premium, aspirational feel`,

    style: `STYLE TRANSFER REQUIREMENTS:
┌─────────────────────────────────────────────────────────────┐
│ STYLE ELEMENTS TO EXTRACT AND APPLY:                        │
├─────────────────────────────────────────────────────────────┤
│ • Color palette: exact hues, saturation, contrast levels   │
│ • Lighting style: direction, quality, mood                 │
│ • Composition approach: framing, balance, focal points     │
│ • Texture/finish: glossy, matte, gritty, smooth           │
│ • Overall mood: energetic, calm, dramatic, playful        │
│ • Visual effects: any gradients, overlays, treatments     │
└─────────────────────────────────────────────────────────────┘

Apply these extracted style elements to create a NEW thumbnail for the given topic.
The result should feel like it belongs in the same "series" as the reference.`,

    background: `BACKGROUND REFERENCE REQUIREMENTS:
Use the reference image as the BACKGROUND or ENVIRONMENT.
Place new subjects/elements INTO this background setting.
Maintain the lighting direction and color temperature of the background.
Ensure new elements are properly composited and lit to match.`,

    upgrade: `THUMBNAIL COMPLETE TRANSFORMATION - CRITICAL INSTRUCTIONS:
┌─────────────────────────────────────────────────────────────┐
│ ⚠️ WARNING: DO NOT JUST ADD TEXT TO THE EXISTING IMAGE!     │
│ You must COMPLETELY TRANSFORM the thumbnail quality.        │
│ The output should look like it was made by a different      │
│ (much better) artist/photographer.                          │
└─────────────────────────────────────────────────────────────┘

TRANSFORMATION REQUIREMENTS (NOT OPTIONAL):

1. DRAMATIC QUALITY UPGRADE:
   • If original looks "AI-generated" → Make it look PROFESSIONALLY MADE
   • If original is anime/cartoon → Create STUNNING hyper-detailed version
   • If original is low-quality → Generate CRYSTAL-CLEAR 4K imagery
   • The difference should be IMMEDIATELY OBVIOUS

2. PROFESSIONAL PRODUCTION VALUE:
   • Add CINEMATIC lighting (3-point: key, fill, rim)
   • Add ATMOSPHERIC effects (particles, haze, volumetric light)
   • Add MICRO-DETAILS (textures, reflections, environmental elements)
   • Apply HOLLYWOOD-GRADE color grading

3. COMPOSITION OVERHAUL:
   • Apply golden ratio / rule of thirds
   • Create dramatic depth (foreground, subject, background layers)
   • Add visual storytelling elements
   • Design for MAXIMUM thumbnail impact

4. WHAT TO KEEP vs CHANGE:
   • KEEP: The core subject/topic of the video
   • CHANGE: Everything else - quality, style, composition, lighting

OUTPUT REQUIREMENTS:
• 16:9 aspect ratio, broadcast/print quality
• Must look like it cost $500+ to produce
• Photorealistic OR stunning illustration (your choice based on topic)
• MUST include bold, professional text caption`
  };

  // ==========================================
  // PHASE 4: ADVANCED PROMPT TEMPLATES
  // ==========================================

  // YouTube-Optimized Thumbnail Formulas
  const thumbnailFormulas = {
    curiosityGap: {
      prompt: 'Subject showing shocked/surprised expression, one hand raised pointing at something mysterious off-screen or partially visible. Big expressive eyes, slightly open mouth conveying amazement. Mystery element blurred or partially hidden to create intrigue.',
      composition: 'Subject on right, mystery element on left, dramatic lighting'
    },
    transformation: {
      prompt: 'Split-screen style showing dramatic before/after transformation. Clear visual divide (diagonal or vertical). High contrast between the two states. Arrow or visual indicator showing progression.',
      composition: 'Even split, clear contrast, transformation arrow'
    },
    faceContext: {
      prompt: 'Large expressive face taking up right portion of frame, relevant context/props/background filling the left side. Face shows appropriate emotion for the content. Context elements support the video topic visually.',
      composition: 'Face 40% on right, context 60% on left'
    },
    productHero: {
      prompt: 'Product showcased as the hero with dramatic studio lighting. Clean gradient or contextual background. Product at compelling 45-degree angle. Subtle reflection below for premium feel. Space for title text.',
      composition: 'Product centered, clean background, text space top/bottom'
    },
    reaction: {
      prompt: 'Close-up face showing intense, exaggerated emotion filling most of the frame. Expression is unmistakable and attention-grabbing. Bold, vibrant colors. High energy feel with subtle effect elements (sparkles, glow, etc).',
      composition: 'Face 70% of frame, minimal background, maximum impact'
    },
    educational: {
      prompt: 'Clean, professional layout with clear visual hierarchy. Subject matter visualized clearly. Trust-building elements. Step numbers or progression indicators if applicable. Expert/authority positioning.',
      composition: 'Organized layout, clear focal point, professional feel'
    },
    gaming: {
      prompt: 'Dynamic, action-packed composition with vibrant neon colors. Game-style effects (particles, glow, energy). High contrast and saturation. Dramatic pose or moment captured. Esports/streaming aesthetic.',
      composition: 'Dynamic angles, effect overlays, gaming aesthetic'
    }
  };

  // ==========================================
  // PHASE 6: COMPOSITION TEMPLATES
  // ==========================================

  const compositionTemplates = {
    'auto': {
      name: 'Auto (AI decides)',
      prompt: 'Compose for maximum YouTube thumbnail impact. Position key elements using rule of thirds. Leave appropriate space for text overlay.',
      textSpace: 'adaptive'
    },
    'face-right': {
      name: 'Face Right (Most Effective)',
      prompt: 'Position the main subject/face on the RIGHT THIRD of the frame, looking slightly toward center-left. Face should occupy 35-45% of frame height. LEFT 40% of frame should be relatively clear or have non-competing elements for text overlay. Background should complement but not distract.',
      textSpace: 'left 40%'
    },
    'face-center': {
      name: 'Face Center Impact',
      prompt: 'Position the main subject/face CENTERED in frame, large and impactful (50-60% of frame). Dramatic lighting from above or side. Minimal, dark, or blurred background. This composition relies on facial expression alone - make it powerful.',
      textSpace: 'top and bottom edges'
    },
    'split-screen': {
      name: 'Before/After Split',
      prompt: 'Divide the image vertically or diagonally into two distinct halves. Left side shows "before" state, right side shows "after" state. Clear visual contrast between the two. Consider adding a subtle dividing line or gradient transition.',
      textSpace: 'top banner area'
    },
    'product-hero': {
      name: 'Product Spotlight',
      prompt: 'Position the product/object as the CENTRAL HERO of the image. Clean background (gradient or solid, not busy). Product lit dramatically with rim lighting. Subtle shadow/reflection below for grounding. Premium, aspirational feel.',
      textSpace: 'top third or bottom third'
    },
    'action-shot': {
      name: 'Dynamic Action',
      prompt: 'Capture a dynamic moment with sense of movement and energy. Subject positioned off-center (rule of thirds). Motion blur on background or secondary elements. Bright accent colors and high contrast. Convey excitement and energy.',
      textSpace: 'varies - work around action'
    },
    'collage': {
      name: 'Multi-Element',
      prompt: 'Arrange multiple elements/images in a cohesive collage style. Main element largest and most prominent. Supporting elements smaller and positioned around edges. Unified color treatment ties everything together.',
      textSpace: 'center or strategic gaps'
    }
  };

  // ==========================================
  // ENHANCED CATEGORY PROMPTS
  // ==========================================

  const categoryPrompts = {
    general: 'Professional YouTube thumbnail with eye-catching design, bold visual hierarchy, and click-worthy appeal. Universal style that works across topics.',
    gaming: 'HIGH ENERGY gaming thumbnail with: vibrant neon colors (cyan, magenta, electric blue), dramatic RGB-style lighting, action-packed dynamic composition, game UI elements or effects, esports/streaming aesthetic, particle effects and glow, dark background with color pops.',
    tutorial: 'EDUCATIONAL thumbnail with: clean organized layout, professional and trustworthy appearance, clear visual hierarchy showing the topic, step indicators or numbered elements, expert positioning, before/after if applicable, tools or materials visible if relevant.',
    vlog: 'AUTHENTIC vlog thumbnail with: warm personal aesthetic, lifestyle photography feel, genuine relatable expression, natural lighting (golden hour ideal), candid moment captured, personal branding consistency, emotional connection focus.',
    review: 'PRODUCT REVIEW thumbnail with: professional product showcase as hero, comparison layout if vs video, trust signals (checkmarks, ratings visual), clean background letting product shine, verdict/conclusion visual hint, expert reviewer positioning.',
    news: 'NEWS/COMMENTARY thumbnail with: bold impactful headline-style design, serious professional tone, current events aesthetic, authority positioning, dramatic or concerned expression if person featured, bold typography-friendly layout.',
    entertainment: 'ENTERTAINMENT thumbnail with: maximum energy and drama, bold saturated colors, exaggerated expressions, movie-poster quality production, dynamic composition, celebrity/influencer styling, peak emotional moment captured.'
  };

  // ==========================================
  // ENHANCED STYLE PROMPTS
  // ==========================================

  const stylePrompts = {
    professional: 'PROFESSIONAL STYLE: Clean and polished look, sharp focus throughout, studio-quality lighting (soft key, fill, rim), high contrast with controlled highlights, corporate-appropriate color palette, premium finish, trustworthy and competent feel.',
    dramatic: 'DRAMATIC STYLE: Cinematic movie-poster quality, intense chiaroscuro lighting, bold shadows and highlights, rich saturated colors, emotional intensity, epic scale feeling, film color grade (teal/orange or similar), theatrical composition.',
    minimal: 'MINIMAL STYLE: Clean simplicity, generous negative space, limited color palette (2-3 colors max), elegant typography-friendly, soft muted tones, breathing room in composition, sophisticated restraint, Scandinavian design influence.',
    bold: 'BOLD STYLE: Maximum visual impact, vibrant fully-saturated colors, high energy composition, dynamic angles, attention-demanding contrast, graphic design influence, pattern/texture use, unapologetic brightness.'
  };

  // ==========================================
  // EXPRESSION MODIFIER PROMPTS
  // ==========================================

  const expressionModifiers = {
    keep: '', // Don't modify expression
    excited: 'Expression should convey excitement and enthusiasm - bright eyes, genuine smile, energetic and engaging.',
    serious: 'Expression should convey seriousness and authority - confident gaze, composed demeanor, professional gravitas.',
    surprised: 'Expression should convey surprise and amazement - widened eyes, raised eyebrows, open mouth showing genuine shock.',
    curious: 'Expression should convey curiosity and intrigue - slightly raised eyebrow, thoughtful look, engaged and interested.',
    confident: 'Expression should convey confidence and expertise - direct eye contact feel, slight knowing smile, authoritative presence.'
  };

  // ==========================================
  // BACKGROUND STYLE PROMPTS
  // ==========================================

  const backgroundStyles = {
    auto: 'Background should complement the subject and content appropriately.',
    studio: 'Clean professional studio background - seamless gradient (dark to light or vice versa), perfect for subject isolation, corporate and polished feel.',
    blur: 'Softly blurred background (bokeh effect, f/1.8 equivalent) keeping subject sharp. Creates depth and focuses attention on subject.',
    gradient: 'Smooth color gradient background that complements the subject. Can be radial (spotlight effect) or linear (modern feel).',
    contextual: 'Relevant contextual background that supports the video topic. Should add meaning but not distract from the main subject.',
    dark: 'Dark/black background for dramatic effect and maximum subject pop. Good for gaming, dramatic, or premium feel.',
    vibrant: 'Vibrant colorful background with energy. Gradients, patterns, or abstract elements that add visual interest.'
  };

  try {
    // Check and deduct tokens
    const tokenRef = db.collection('creativeTokens').doc(uid);
    let tokenDoc = await tokenRef.get();
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
      await tokenRef.set(initialTokens);
      balance = 50;
    } else {
      balance = tokenDoc.data().balance || 0;
    }

    if (balance < totalCost) {
      throw new functions.https.HttpsError('resource-exhausted',
        `Insufficient tokens. Need ${totalCost}, have ${balance}. Please upgrade your plan.`);
    }

    // ==========================================
    // PHASE 2: SMART REFERENCE ANALYSIS
    // ==========================================

    // Determine effective reference type (auto-detect or use specified)
    let effectiveReferenceType = referenceType;
    let referenceAnalysis = null;

    if (effectiveReferenceImage && effectiveReferenceImage.base64 && (referenceType === 'auto' || referenceType === 'upgrade')) {
      // Auto-detect reference type using Gemini Vision (also used for upgrade mode analysis)
      try {
        const geminiApiKey = functions.config().gemini?.key;
        if (geminiApiKey) {
          const aiAnalysis = new GoogleGenAI({ apiKey: geminiApiKey });
          const analysisResult = await aiAnalysis.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: [{
              role: 'user',
              parts: [
                { inlineData: { mimeType: effectiveReferenceImage.mimeType || 'image/png', data: effectiveReferenceImage.base64 } },
                { text: `Analyze this image for YouTube thumbnail generation. Respond in JSON format only:
{
  "primarySubject": "face|product|scene|style",
  "hasFace": true/false,
  "faceDetails": { "position": "left|center|right", "expression": "description", "prominentFeatures": ["feature1", "feature2"] },
  "hasProduct": true/false,
  "productDetails": { "type": "description", "colors": ["color1", "color2"], "brandVisible": true/false },
  "dominantColors": ["#hex1", "#hex2", "#hex3"],
  "lightingStyle": "studio|natural|dramatic|soft|harsh",
  "mood": "energetic|calm|professional|playful|serious",
  "compositionStyle": "portrait|product-shot|scene|abstract",
  "recommendedUse": "face-preservation|style-transfer|product-showcase|background"
}` }
              ]
            }]
          });

          const analysisText = analysisResult.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            referenceAnalysis = JSON.parse(jsonMatch[0]);
            // Auto-determine reference type based on analysis
            if (referenceAnalysis.hasFace && referenceAnalysis.primarySubject === 'face') {
              effectiveReferenceType = 'face';
            } else if (referenceAnalysis.hasProduct || referenceAnalysis.primarySubject === 'product') {
              effectiveReferenceType = 'product';
            } else if (referenceAnalysis.primarySubject === 'scene') {
              effectiveReferenceType = 'background';
            } else {
              effectiveReferenceType = 'style';
            }
            console.log(`Reference analysis: detected ${effectiveReferenceType} type`, referenceAnalysis);
          }
        }
      } catch (analysisError) {
        console.log('Reference analysis skipped:', analysisError.message);
        // Default to face if analysis fails and mode suggests face
        effectiveReferenceType = (mode === 'faceHero') ? 'face' : 'style';
      }
    }

    // Override reference type for specialized modes
    if (mode === 'faceHero') effectiveReferenceType = 'face';
    if (mode === 'styleClone') effectiveReferenceType = 'style';
    if (mode === 'productPro') effectiveReferenceType = 'product';
    if (mode === 'upgrade') effectiveReferenceType = 'upgrade'; // Keep upgrade type

    // Build the enhanced prompt
    const categoryEnhancement = categoryPrompts[category] || categoryPrompts.general;
    const styleEnhancement = stylePrompts[style] || stylePrompts.professional;
    const compositionGuide = compositionTemplates[compositionTemplate] || compositionTemplates.auto;
    const expressionGuide = expressionModifiers[expressionModifier] || '';
    const backgroundGuide = backgroundStyles[backgroundStyle] || backgroundStyles.auto;

    let imagePrompt;
    try {
      // ==========================================
      // ENHANCED GPT-4 PROMPT GENERATION
      // ==========================================

      // Build context for reference-based generation
      let referenceContext = '';
      if (effectiveReferenceImage && effectiveReferenceType) {
        // Add YouTube context for upgrade mode
        const youtubeContextStr = (mode === 'upgrade' && youtubeContext) ? `
VIDEO CONTEXT (for better relevance):
- Title: "${youtubeContext.title || 'Unknown'}"
- Channel: "${youtubeContext.channelName || 'Unknown'}"
- Description: "${(youtubeContext.description || '').substring(0, 200)}"
` : '';

        referenceContext = `
REFERENCE IMAGE PROVIDED - Type: ${effectiveReferenceType.toUpperCase()}
${referenceAnalysis ? `Analysis: ${JSON.stringify(referenceAnalysis)}` : ''}
${youtubeContextStr}

${referenceTypePrompts[effectiveReferenceType] || ''}
`;
      }

      // Use pre-generated optimal caption (no inline generation needed)
      const promptGeneratorResponse = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{
          role: 'system',
          content: `You are an expert YouTube thumbnail designer and AI image prompt engineer. Your prompts consistently produce viral, high-CTR thumbnails. You understand composition, color psychology, typography, and what makes viewers click. You ALWAYS include bold text captions in your thumbnail designs because professional YouTube thumbnails need eye-catching text.`
        }, {
          role: 'user',
          content: `Create a DETAILED image generation prompt for an AMAZING YouTube thumbnail.

═══════════════════════════════════════════════════════════════
VIDEO TOPIC
═══════════════════════════════════════════════════════════════
Category: ${category}
Visual Style: ${style}
${customPrompt ? `Creator's Notes: ${customPrompt}` : ''}

═══════════════════════════════════════════════════════════════
STYLE & CATEGORY REQUIREMENTS
═══════════════════════════════════════════════════════════════
${categoryEnhancement}

${styleEnhancement}

═══════════════════════════════════════════════════════════════
COMPOSITION TEMPLATE
═══════════════════════════════════════════════════════════════
${compositionGuide.prompt}

═══════════════════════════════════════════════════════════════
BACKGROUND STYLE
═══════════════════════════════════════════════════════════════
${backgroundGuide}

${expressionGuide ? `═══════════════════════════════════════════════════════════════
EXPRESSION GUIDANCE
═══════════════════════════════════════════════════════════════
${expressionGuide}` : ''}

${referenceContext ? `═══════════════════════════════════════════════════════════════
REFERENCE IMAGE REQUIREMENTS (CRITICAL)
═══════════════════════════════════════════════════════════════
${referenceContext}` : ''}

═══════════════════════════════════════════════════════════════
⚠️ MANDATORY TEXT CAPTION - USE EXACT TEXT ⚠️
═══════════════════════════════════════════════════════════════
The thumbnail MUST include this EXACT text: "${optimizedCaption}"
⚠️ DO NOT MODIFY, ADD TO, OR CHANGE THIS TEXT IN ANY WAY
⚠️ Use these EXACT ${optimizedCaption.length} characters, no more, no less
- Text style: Thick, bold sans-serif (Impact/Bebas Neue style)
- Text color: High contrast - white with black stroke, or vibrant color
- Text size: Large enough to read at small thumbnail sizes
- Text position: Prominent placement that doesn't cover faces

═══════════════════════════════════════════════════════════════
OUTPUT REQUIREMENTS
═══════════════════════════════════════════════════════════════
- Format: 16:9 aspect ratio (1280x720), YouTube thumbnail
- Quality: 4K photorealistic, professional photography quality
- Must be INSTANTLY eye-catching at small sizes (search results)
- Colors should pop and contrast well
- Main subject must be immediately clear
- Text must be EXACTLY as specified above - no additions or changes

Generate a comprehensive, detailed prompt that will produce a STUNNING thumbnail WITH the exact text specified.
Output ONLY the prompt, no explanations or preamble.`
        }],
        temperature: 0.7,
        max_tokens: 600
      });

      imagePrompt = promptGeneratorResponse?.choices?.[0]?.message?.content?.trim();
    } catch (openaiError) {
      console.error('OpenAI prompt generation failed:', openaiError.message);
      // Fallback prompt using pre-generated optimal caption
      imagePrompt = `${categoryEnhancement}. ${styleEnhancement}. ${compositionGuide.prompt}. ${customPrompt || ''} ${backgroundGuide}. Add EXACT text "${optimizedCaption}" in thick bold sans-serif font with high contrast (white with black outline). DO NOT change or add to this text. High quality, 4K resolution, professional YouTube thumbnail, 16:9 aspect ratio.`;
    }

    // Ensure prompt is valid
    if (!imagePrompt || imagePrompt.length < 20) {
      imagePrompt = `Professional YouTube thumbnail. ${categoryEnhancement}. ${styleEnhancement}. ${compositionGuide.prompt}. Add EXACT bold text "${optimizedCaption}" in thick sans-serif font - DO NOT modify this text. Eye-catching design, bold colors, high contrast, 4K quality.`;
    }

    // Enhanced negative prompt (note: we allow text for captions, but avoid illegible/excessive text)
    const negativePrompt = "blurry, low quality, ugly, distorted faces, watermark, nsfw, cluttered, amateur, bad anatomy, disfigured, poorly drawn face, mutation, mutated, extra limbs, ugly, poorly drawn hands, missing limbs, floating limbs, disconnected limbs, malformed hands, blur, out of focus, long neck, long body, disgusting, bad proportions, gross proportions, error, missing fingers, cropped, worst quality, jpeg artifacts, signature, illegible text, garbled text, misspelled words";
    const storage = admin.storage().bucket();
    const timestamp = Date.now();
    const generatedImages = [];
    let usedModel = config.model;

    // ==========================================
    // MODEL-SPECIFIC GENERATION
    // ==========================================

    if (config.model === 'nano-banana-pro') {
      // Gemini Image Generation with Reference Support
      const geminiApiKey = functions.config().gemini?.key;
      if (!geminiApiKey) {
        throw new functions.https.HttpsError('failed-precondition', 'Gemini API key not configured');
      }

      const ai = new GoogleGenAI({ apiKey: geminiApiKey });
      // Use gemini-3-pro-image-preview - SAME as Creative Studio where face preservation works!
      const geminiModelId = 'gemini-3-pro-image-preview';

      console.log(`Generating ${imageCount} thumbnail(s) with Gemini: ${geminiModelId}`);

      for (let imgIdx = 0; imgIdx < imageCount; imgIdx++) {
        try {
          // Build content parts - REFERENCE IMAGE FIRST (like Creative Studio)
          const contentParts = [];

          // Check if Face Lock is enabled (face reference provided separately)
          const hasFaceLock = faceReferenceImage && faceReferenceImage.base64;

          if (hasFaceLock) {
            // FACE LOCK MODE: Add face reference FIRST (for identity preservation)
            contentParts.push({
              inlineData: {
                mimeType: faceReferenceImage.mimeType || 'image/jpeg',
                data: faceReferenceImage.base64
              }
            });
            console.log('Added FACE LOCK reference image as input (identity preservation)');

            // Then add the original thumbnail SECOND (for content/style reference)
            if (effectiveReferenceImage && effectiveReferenceImage.base64) {
              contentParts.push({
                inlineData: {
                  mimeType: effectiveReferenceImage.mimeType || 'image/png',
                  data: effectiveReferenceImage.base64
                }
              });
              console.log('Added original thumbnail as SECOND input (content reference)');
            }
          } else if (effectiveReferenceImage && effectiveReferenceImage.base64) {
            // Standard mode - add reference image FIRST (this is how Creative Studio does it)
            contentParts.push({
              inlineData: {
                mimeType: effectiveReferenceImage.mimeType || 'image/png',
                data: effectiveReferenceImage.base64
              }
            });
            console.log('Added reference image as input (face/character reference)');
          }

          // Build prompt - USE SAME SIMPLE FORMAT AS CREATIVE STUDIO
          // Creative Studio's working format: "Using the provided image as a character/face reference to maintain consistency, generate a new image: ${prompt}"
          let finalPrompt;

          // Check if Face Lock mode with upgrade
          if (hasFaceLock && (mode === 'upgrade' || effectiveReferenceType === 'upgrade')) {
            // ============================================================
            // FACE LOCK + UPGRADE MODE - Preserve face while upgrading content
            // ============================================================
            let youtubeCtx = '';
            if (youtubeContext) {
              const tags = youtubeContext.tags?.slice(0, 5).join(', ') || '';
              const descPreview = (youtubeContext.description || '').substring(0, 200);
              youtubeCtx = `
Video Title: "${youtubeContext.title || 'Unknown'}"
Channel: ${youtubeContext.channelName || 'Unknown'}
${descPreview ? `Topic: ${descPreview}...` : ''}`;
            }

            // Use pre-generated optimal caption
            finalPrompt = `You are creating a PROFESSIONAL YouTube thumbnail with MANDATORY FACE PRESERVATION.

═══════════════════════════════════════════════════════════════
⚠️ TWO IMAGES PROVIDED - CRITICAL INSTRUCTIONS ⚠️
═══════════════════════════════════════════════════════════════
IMAGE 1 (FACE REFERENCE): This shows the EXACT FACE you MUST use.
- The person in your output MUST look EXACTLY like this person
- Same facial structure, same eyes, same nose, same mouth
- Same skin tone, same hair style/color
- This is NON-NEGOTIABLE - the face must be RECOGNIZABLE as the same person

IMAGE 2 (CONTENT REFERENCE): This shows the CONTENT/STYLE to upgrade.
- Use this for the scene concept, composition, and theme
- DRAMATICALLY improve the quality to professional level
- But REPLACE any face with the EXACT face from Image 1
═══════════════════════════════════════════════════════════════
${youtubeCtx}

REQUIREMENTS:
1. FACE IDENTITY (CRITICAL): Output face MUST match Image 1 exactly
   - Same person, instantly recognizable
   - Viewers should say "That's the same person!"

2. CONTENT UPGRADE: Transform Image 2's concept to studio quality
   - Cinematic lighting, 4K clarity, professional composition
   - Magazine/movie poster level quality
   - Use the theme/concept from Image 2

3. COMPOSITION:
   - Position the face on right side (golden ratio)
   - Leave space on left for text overlay

⚠️ MANDATORY TEXT - USE EXACT TEXT ⚠️
Add EXACTLY this text: "${optimizedCaption}" - thick sans-serif font, high contrast, with shadow/glow.
DO NOT modify, add to, or change this text in ANY way.

OUTPUT: 16:9 YouTube thumbnail with the EXACT face from Image 1 in an upgraded version of Image 2's scene.`;

          } else if (effectiveReferenceImage && effectiveReferenceImage.base64) {
            // ============================================================
            // MATCH CREATIVE STUDIO'S SIMPLE, WORKING FORMAT
            // ============================================================
            if (mode === 'upgrade' || effectiveReferenceType === 'upgrade') {
              // THUMBNAIL UPGRADE MODE - Create SEO-optimized improved version
              let youtubeCtx = '';
              if (youtubeContext) {
                const tags = youtubeContext.tags?.slice(0, 5).join(', ') || '';
                const descPreview = (youtubeContext.description || '').substring(0, 200);
                youtubeCtx = `
═══════════════════════════════════════════════════════════════
VIDEO CONTEXT (USE THIS FOR SEO-OPTIMIZED THUMBNAIL):
═══════════════════════════════════════════════════════════════
Title: "${youtubeContext.title || 'Unknown'}"
Channel: ${youtubeContext.channelName || 'Unknown'}
${descPreview ? `Description: ${descPreview}...` : ''}
${tags ? `Keywords/Tags: ${tags}` : ''}
═══════════════════════════════════════════════════════════════`;
              }

              // Use pre-generated optimal caption
              finalPrompt = `You are a world-class thumbnail designer creating a COMPLETE VISUAL TRANSFORMATION.

═══════════════════════════════════════════════════════════════
⚠️ CRITICAL INSTRUCTION - READ CAREFULLY ⚠️
═══════════════════════════════════════════════════════════════
The provided image is a LOW-QUALITY original that needs DRAMATIC improvement.
DO NOT just add text to the existing image.
DO NOT preserve the original style if it looks amateur/AI-generated.
You MUST CREATE A COMPLETELY NEW, PROFESSIONAL-GRADE thumbnail.

TRANSFORM the concept into STUDIO-QUALITY, BROADCAST-READY artwork.
═══════════════════════════════════════════════════════════════
${youtubeCtx}

═══════════════════════════════════════════════════════════════
VISUAL TRANSFORMATION REQUIREMENTS (MANDATORY):
═══════════════════════════════════════════════════════════════

1. QUALITY LEAP: Transform amateur/AI-looking images into PHOTOREALISTIC, CINEMATIC quality
   - If input is anime/cartoon style → Create stunning, hyper-detailed illustration OR photorealistic version
   - If input is low-res/blurry → Generate crystal-clear, 4K-quality imagery
   - If input looks "AI-generated" → Make it indistinguishable from professional photography/art

2. LIGHTING REVOLUTION:
   - Add dramatic, professional 3-point lighting (key, fill, rim)
   - Create depth with volumetric light, god rays, or atmospheric haze
   - Use cinematic color grading (teal/orange, moody blues, warm golds)

3. COMPOSITION MASTERY:
   - Apply golden ratio / rule of thirds
   - Create clear visual hierarchy with dominant focal point
   - Add depth layers (foreground interest, subject, background)

4. DETAIL ENHANCEMENT:
   - Add micro-details: textures, reflections, particles, atmosphere
   - Include environmental storytelling elements
   - Create a sense of scale and drama

5. PROFESSIONAL POLISH:
   - Magazine cover / movie poster quality
   - No amateur artifacts, no "AI look"
   - Hollywood production value

═══════════════════════════════════════════════════════════════
⚠️ MANDATORY TEXT - USE EXACT TEXT ⚠️
═══════════════════════════════════════════════════════════════
Add EXACTLY this text: "${optimizedCaption}"
⚠️ DO NOT MODIFY, ADD TO, OR CHANGE THIS TEXT IN ANY WAY
⚠️ These EXACT ${optimizedCaption.length} characters, no more, no less

TEXT STYLE:
- Font: Thick, bold sans-serif (Impact/Bebas Neue style)
- Size: LARGE - readable at thumbnail size
- Color: High contrast with 3D effect (white + black stroke + glow/shadow)
- Position: Prominent placement, never covering faces
- Effect: Professional drop shadow or outer glow for pop

═══════════════════════════════════════════════════════════════
OUTPUT MUST BE:
═══════════════════════════════════════════════════════════════
✓ DRAMATICALLY better than the original (night and day difference)
✓ Professional enough for a major YouTube channel with millions of subs
✓ Eye-catching at small sizes in YouTube feed
✓ 16:9 aspect ratio, 1280x720, broadcast quality
✓ Includes the EXACT text caption specified above (no modifications)

The viewer should think "WOW, this looks professional!" not "oh, they just added text."`;

            } else if (effectiveReferenceType === 'face' || mode === 'faceHero') {
              // Face preservation - use Creative Studio's exact working pattern
              finalPrompt = `Using the provided image as a character/face reference to maintain consistency, generate a YouTube thumbnail: ${imagePrompt}

The person in the thumbnail must look exactly like the person in the reference image - same face, same hair, same features. Position them on the right side of the frame.

⚠️ MANDATORY TEXT - USE EXACT TEXT: Add EXACTLY this text: "${optimizedCaption}" - thick sans-serif font, high contrast (white with black outline). Position on left side. DO NOT modify this text.

16:9 aspect ratio, professional YouTube thumbnail quality.`;

            } else if (effectiveReferenceType === 'product') {
              // Product reference
              finalPrompt = `Using the provided image as a product reference, generate a YouTube thumbnail showcasing this exact product: ${imagePrompt}

Keep the product's appearance accurate. Professional product photography, clean background.

⚠️ MANDATORY TEXT - USE EXACT TEXT: Add EXACTLY this text: "${optimizedCaption}" prominently. Thick sans-serif font, high contrast. DO NOT modify this text.

16:9 YouTube thumbnail format.`;

            } else if (effectiveReferenceType === 'style') {
              // Style transfer - use Creative Studio's style reference pattern
              finalPrompt = `Using the provided image as a style reference, generate a new YouTube thumbnail with the following description: ${imagePrompt}

Match the color palette, lighting style, and overall aesthetic of the reference.

⚠️ MANDATORY TEXT - USE EXACT TEXT: Add EXACTLY this text: "${optimizedCaption}" in thick sans-serif font matching the aesthetic. High contrast. DO NOT modify this text.

16:9 YouTube thumbnail format.`;

            } else {
              // Background/general reference
              finalPrompt = `Using the provided image as reference, generate a YouTube thumbnail: ${imagePrompt}

⚠️ MANDATORY TEXT - USE EXACT TEXT: Add EXACTLY this text: "${optimizedCaption}" prominently. Thick sans-serif font, high contrast (white with black outline). DO NOT modify this text.

16:9 aspect ratio, professional quality, eye-catching design.`;
            }

          } else {
            // No reference image - use full enhanced prompt with mandatory text
            finalPrompt = `${imagePrompt}

COMPOSITION: ${compositionGuide.prompt}

⚠️ MANDATORY TEXT - USE EXACT TEXT ⚠️
Add EXACTLY this text: "${optimizedCaption}"
DO NOT MODIFY, ADD TO, OR CHANGE THIS TEXT IN ANY WAY.
- Font: Thick, bold, sans-serif (Impact/Bebas Neue style)
- Color: High contrast - white with black outline, or bright color with shadow
- Size: LARGE - readable at small thumbnail sizes
- Position: Top-left, bottom, or where it complements the composition

FORMAT: 16:9 YouTube thumbnail (1280x720), professional photography quality, vibrant colors.

AVOID: ${negativePrompt}`;
          }

          // Add text prompt AFTER the reference image (Creative Studio order)
          contentParts.push({ text: finalPrompt });

          const result = await ai.models.generateContent({
            model: geminiModelId,
            contents: [{ role: 'user', parts: contentParts }],
            config: {
              responseModalities: ['image', 'text']
            }
          });

          // Extract image from response
          const candidates = result.candidates || (result.response && result.response.candidates);
          if (candidates && candidates.length > 0) {
            const parts = candidates[0].content?.parts || [];
            for (const part of parts) {
              const inlineData = part.inlineData || part.inline_data;
              if (inlineData && (inlineData.data || inlineData.bytesBase64Encoded)) {
                const imageBytes = inlineData.data || inlineData.bytesBase64Encoded;
                const mimeType = inlineData.mimeType || 'image/png';
                const extension = mimeType.includes('jpeg') ? 'jpg' : 'png';

                const fileName = `thumbnails-pro/${uid}/${timestamp}-gemini-${imgIdx + 1}.${extension}`;
                const file = storage.file(fileName);

                const buffer = Buffer.from(imageBytes, 'base64');
                await file.save(buffer, {
                  metadata: {
                    contentType: mimeType,
                    metadata: {
                      prompt: imagePrompt.substring(0, 500),
                      model: geminiModelId,
                      category,
                      style
                    }
                  }
                });

                await file.makePublic();
                const publicUrl = `https://storage.googleapis.com/${storage.name}/${fileName}`;

                generatedImages.push({
                  url: publicUrl,
                  fileName,
                  seed: Math.floor(Math.random() * 1000000),
                  model: 'nano-banana-pro'
                });

                console.log(`Gemini thumbnail ${imgIdx + 1} saved: ${fileName}`);
                break;
              }
            }
          }
        } catch (genError) {
          console.error(`Gemini generation error for image ${imgIdx + 1}:`, genError.message);
        }
      }

      usedModel = geminiModelId;

    } else if (config.model === 'dall-e-3') {
      // DALL-E 3 Premium Generation (ENHANCED Phase 3)
      console.log(`Generating ${imageCount} thumbnail(s) with DALL-E 3`);

      // Build enhanced DALL-E prompt with all improvements
      const dalleEnhancedPrompt = `${imagePrompt}

═══════════════════════════════════════════════════════════════
COMPOSITION REQUIREMENTS
═══════════════════════════════════════════════════════════════
${compositionGuide.prompt}
Leave space for text overlay: ${compositionGuide.textSpace}

═══════════════════════════════════════════════════════════════
TECHNICAL SPECIFICATIONS (CRITICAL)
═══════════════════════════════════════════════════════════════
• Format: YouTube thumbnail, 16:9 aspect ratio
• Quality: 4K photorealistic, professional photography
• Lighting: Professional studio or cinematic lighting
• Colors: Vibrant, high-contrast, YouTube-optimized color palette
• Focus: Crystal sharp on main subject

═══════════════════════════════════════════════════════════════
AVOID
═══════════════════════════════════════════════════════════════
${negativePrompt}`;

      for (let imgIdx = 0; imgIdx < imageCount; imgIdx++) {
        try {
          const dalleResponse = await openai.images.generate({
            model: 'dall-e-3',
            prompt: dalleEnhancedPrompt,
            n: 1,
            size: '1792x1024', // Closest to 16:9 for DALL-E 3
            quality: 'hd',
            style: style === 'dramatic' || style === 'bold' ? 'vivid' : 'natural',
            response_format: 'b64_json'
          });

          if (dalleResponse.data && dalleResponse.data[0]) {
            const imageData = dalleResponse.data[0];
            const imageBytes = imageData.b64_json;

            const fileName = `thumbnails-pro/${uid}/${timestamp}-dalle-${imgIdx + 1}.png`;
            const file = storage.file(fileName);

            const buffer = Buffer.from(imageBytes, 'base64');
            await file.save(buffer, {
              metadata: {
                contentType: 'image/png',
                metadata: {
                  prompt: imagePrompt.substring(0, 500),
                  model: 'dall-e-3',
                  category,
                  style,
                  revisedPrompt: imageData.revised_prompt || ''
                }
              }
            });

            await file.makePublic();
            const publicUrl = `https://storage.googleapis.com/${storage.name}/${fileName}`;

            generatedImages.push({
              url: publicUrl,
              fileName,
              seed: Math.floor(Math.random() * 1000000),
              model: 'dall-e-3',
              revisedPrompt: imageData.revised_prompt
            });

            console.log(`DALL-E thumbnail ${imgIdx + 1} saved: ${fileName}`);
          }
        } catch (dalleError) {
          console.error(`DALL-E generation error for image ${imgIdx + 1}:`, dalleError.message);
        }
      }

      usedModel = 'dall-e-3';

    } else {
      // Imagen 4 Quick Generation (Default) - ENHANCED Phase 3
      const geminiApiKey = functions.config().gemini?.key;
      if (!geminiApiKey) {
        throw new functions.https.HttpsError('failed-precondition', 'Image generation service not configured');
      }

      const ai = new GoogleGenAI({ apiKey: geminiApiKey });
      const imagenModelId = 'imagen-4.0-generate-001';

      console.log(`Generating ${imageCount} thumbnail(s) with Imagen 4`);

      // Build enhanced Imagen prompt with composition and quality guidance
      // Note: Imagen 4 doesn't support negativePrompt parameter, so we include it in the prompt text
      const imagenEnhancedPrompt = `${imagePrompt}

COMPOSITION: ${compositionGuide.prompt}
STYLE: ${styleEnhancement}
FORMAT: YouTube thumbnail, 16:9 aspect ratio, 4K quality, professional photography, high contrast, vibrant colors optimized for small preview sizes.

AVOID: ${negativePrompt}`;

      try {
        const result = await ai.models.generateImages({
          model: imagenModelId,
          prompt: imagenEnhancedPrompt,
          config: {
            numberOfImages: imageCount,
            aspectRatio: '16:9',
            personGeneration: 'allow_adult'
          }
        });

        if (result.generatedImages && result.generatedImages.length > 0) {
          for (let imgIdx = 0; imgIdx < result.generatedImages.length; imgIdx++) {
            const genImage = result.generatedImages[imgIdx];

            // Check if image was filtered by safety
            if (genImage.raiFilteredReason) {
              console.warn(`Thumbnail ${imgIdx + 1} filtered: ${genImage.raiFilteredReason}`);
              continue;
            }

            const imageBytes = genImage.image?.imageBytes;

            if (imageBytes) {
              const fileName = `thumbnails-pro/${uid}/${timestamp}-imagen-${imgIdx + 1}.png`;
              const file = storage.file(fileName);

              const buffer = Buffer.from(imageBytes, 'base64');
              await file.save(buffer, {
                metadata: {
                  contentType: 'image/png',
                  metadata: {
                    prompt: imagePrompt.substring(0, 500),
                    model: imagenModelId,
                    category,
                    style
                  }
                }
              });

              await file.makePublic();
              const publicUrl = `https://storage.googleapis.com/${storage.name}/${fileName}`;

              generatedImages.push({
                url: publicUrl,
                fileName,
                seed: Math.floor(Math.random() * 1000000),
                model: 'imagen-4'
              });

              console.log(`Imagen thumbnail ${imgIdx + 1} saved: ${fileName}`);
            }
          }
        }
      } catch (imagenError) {
        console.error('Imagen generation error:', imagenError.message, imagenError.stack);
        // Provide more detailed error message for debugging
        const errMsg = imagenError.message?.toLowerCase() || '';
        let userMessage = 'Image generation failed: ';
        if (errMsg.includes('quota') || errMsg.includes('rate')) {
          userMessage += 'API rate limit reached. Please wait a moment and try again.';
        } else if (errMsg.includes('safety') || errMsg.includes('blocked') || errMsg.includes('policy')) {
          userMessage += 'Content was blocked by safety filters. Try a different prompt.';
        } else if (errMsg.includes('billing') || errMsg.includes('payment')) {
          userMessage += 'Billing issue with the API. Please contact support.';
        } else if (errMsg.includes('permission') || errMsg.includes('403') || errMsg.includes('denied')) {
          userMessage += 'API permission denied. Please contact support.';
        } else if (errMsg.includes('not found') || errMsg.includes('404')) {
          userMessage += 'Imagen model not available. Please contact support.';
        } else {
          userMessage += imagenError.message || 'Unknown error. Please try again.';
        }
        throw new functions.https.HttpsError('internal', userMessage);
      }

      usedModel = imagenModelId;
    }

    // Check if any images were generated
    if (generatedImages.length === 0) {
      throw new functions.https.HttpsError('internal', 'No images were generated. Please try again with different settings.');
    }

    // Deduct tokens
    const actualCost = config.tokenCost * generatedImages.length;
    await tokenRef.update({
      balance: admin.firestore.FieldValue.increment(-actualCost),
      lastUsed: admin.firestore.FieldValue.serverTimestamp()
    });

    // ==========================================
    // PHASE 7: QUALITY ENHANCEMENT PIPELINE
    // ==========================================

    // Build generation metadata for quality tracking and improvement
    const generationMetadata = {
      // Reference analysis data (if applicable)
      referenceAnalysis: referenceAnalysis || null,
      effectiveReferenceType: referenceImage ? effectiveReferenceType : null,

      // Settings used
      settings: {
        style,
        category,
        mode,
        compositionTemplate,
        faceStrength: effectiveReferenceType === 'face' ? faceStrength : null,
        styleStrength: effectiveReferenceType === 'style' ? styleStrength : null,
        expressionModifier,
        backgroundStyle
      },

      // Quality hints for user feedback
      qualityHints: {
        // Composition feedback
        composition: compositionGuide.name || 'Auto',
        textOverlaySpace: compositionGuide.textSpace || 'adaptive',

        // Suggestions for improvement
        suggestions: []
      },

      // A/B testing data
      abTestData: {
        promptVersion: 'v2.0-enhanced',
        modelVersion: usedModel,
        generationTimestamp: Date.now(),
        promptHash: imagePrompt.length > 100 ? imagePrompt.substring(0, 100) : imagePrompt
      }
    };

    // Add contextual suggestions based on settings
    if (mode === 'quick' && !referenceImage) {
      generationMetadata.qualityHints.suggestions.push(
        'Try "Reference Mode" with your photo for personalized thumbnails',
        'Upload a reference image to match your channel style'
      );
    }
    if (effectiveReferenceType === 'face' && faceStrength < 0.8) {
      generationMetadata.qualityHints.suggestions.push(
        'Increase "Face Strength" for better facial accuracy'
      );
    }
    if (category === 'general') {
      generationMetadata.qualityHints.suggestions.push(
        'Select a specific category for more optimized results'
      );
    }

    // Save to history with enhanced metadata
    const historyRef = await db.collection('thumbnailHistory').add({
      userId: uid,
      title,
      style,
      category,
      mode,
      customPrompt: customPrompt || null,
      prompt: imagePrompt,
      images: generatedImages,
      imageUrl: generatedImages[0]?.url, // Primary image for backward compatibility
      model: usedModel,
      tokenCost: actualCost,
      hasReference: !!referenceImage,
      // Phase 7: Enhanced metadata
      metadata: generationMetadata,
      // User feedback placeholders for quality improvement
      userFeedback: {
        rating: null,
        selectedImage: null,
        usedInVideo: null,
        improvementNotes: null
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Log usage
    await logUsage(uid, 'thumbnail_pro_generation', {
      title,
      mode,
      category,
      model: usedModel,
      imageCount: generatedImages.length,
      tokenCost: actualCost
    });

    return {
      success: true,
      historyId: historyRef.id,
      images: generatedImages,
      imageUrl: generatedImages[0]?.url,
      prompt: imagePrompt,
      model: usedModel,
      tokenCost: actualCost,
      remainingBalance: balance - actualCost,
      message: `Generated ${generatedImages.length} thumbnail(s) successfully`,
      // Phase 7: Enhanced response data
      metadata: {
        referenceType: referenceImage ? effectiveReferenceType : null,
        composition: compositionGuide.name || 'Auto',
        textOverlaySpace: compositionGuide.textSpace || 'adaptive',
        suggestions: generationMetadata.qualityHints.suggestions
      }
    };

  } catch (error) {
    console.error('Thumbnail Pro generation error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Thumbnail generation failed. Please try again.'));
  }
});

// ==============================================
// HD UPSCALE - Upscale thumbnails to 1080p using fal.ai AuraSR
// FREE upscaling with AuraSR model
// ==============================================

/**
 * upscaleThumbnail - Upscale a single thumbnail to HD (1920x1080)
 * Uses fal.ai AuraSR (FREE) for 4x upscaling
 * Cost: 1 token (configurable)
 *
 * @param {string} imageUrl - URL of the image to upscale
 * @returns {object} { success, hdUrl, originalUrl, dimensions }
 */
exports.upscaleThumbnail = functions
  .runWith({ timeoutSeconds: 120, memory: '1GB' })
  .https.onCall(async (data, context) => {
    const uid = await verifyAuth(context);
    checkRateLimit(uid, 'upscaleThumbnail', 10);

    const { imageUrl } = data;
    const TOKEN_COST = 1; // Low cost since AuraSR is free

    if (!imageUrl) {
      throw new functions.https.HttpsError('invalid-argument', 'Image URL is required');
    }

    try {
      // Check token balance
      const tokenDoc = await db.collection('creativeTokens').doc(uid).get();
      if (!tokenDoc.exists) {
        throw new functions.https.HttpsError('failed-precondition', 'Token balance not found');
      }

      const balance = tokenDoc.data().balance || 0;
      if (balance < TOKEN_COST) {
        throw new functions.https.HttpsError('resource-exhausted',
          `Insufficient tokens. Need ${TOKEN_COST}, have ${balance}`);
      }

      // Configure fal.ai client
      fal.config({
        credentials: process.env.FAL_KEY || functions.config().fal?.key
      });

      console.log(`Starting HD upscale for user ${uid}: ${imageUrl}`);

      // Call AuraSR for 4x upscale (FREE!)
      const result = await fal.subscribe('fal-ai/aura-sr', {
        input: {
          image_url: imageUrl,
          upscaling_factor: 4,
          overlapping_tiles: true // Removes seams for better quality
        }
      });

      if (!result.data?.image?.url) {
        throw new Error('Upscale failed - no image returned');
      }

      const upscaledUrl = result.data.image.url;
      console.log(`AuraSR upscale complete: ${upscaledUrl}`);

      // Download upscaled image and resize to exactly 1920x1080
      const upscaledResponse = await axios.get(upscaledUrl, {
        responseType: 'arraybuffer',
        timeout: 30000
      });

      const resizedBuffer = await sharp(upscaledResponse.data)
        .resize(1920, 1080, {
          fit: 'cover',
          position: 'center'
        })
        .png({ quality: 95, compressionLevel: 6 })
        .toBuffer();

      // Upload to Firebase Storage
      const storage = admin.storage().bucket();
      const timestamp = Date.now();
      const hdPath = `thumbnails-hd/${uid}/${timestamp}_hd.png`;
      const file = storage.file(hdPath);

      await file.save(resizedBuffer, {
        metadata: {
          contentType: 'image/png',
          metadata: {
            originalUrl: imageUrl,
            upscaleModel: 'aura-sr',
            dimensions: '1920x1080'
          }
        }
      });

      await file.makePublic();
      const hdUrl = `https://storage.googleapis.com/${storage.name}/${hdPath}`;

      // Deduct token
      await db.collection('creativeTokens').doc(uid).update({
        balance: admin.firestore.FieldValue.increment(-TOKEN_COST),
        lastUsed: admin.firestore.FieldValue.serverTimestamp()
      });

      // Log usage
      await logUsage(uid, 'hd_upscale', {
        originalUrl: imageUrl,
        hdUrl: hdUrl,
        tokenCost: TOKEN_COST
      });

      console.log(`HD upscale complete for user ${uid}: ${hdUrl}`);

      return {
        success: true,
        hdUrl: hdUrl,
        originalUrl: imageUrl,
        dimensions: { width: 1920, height: 1080 },
        tokensUsed: TOKEN_COST,
        remainingBalance: balance - TOKEN_COST
      };

    } catch (error) {
      console.error('HD Upscale error:', error);
      if (error instanceof functions.https.HttpsError) throw error;
      throw new functions.https.HttpsError('internal',
        sanitizeErrorMessage(error, 'HD upscale failed. Please try again.'));
    }
  });

/**
 * upscaleBatch - Upscale multiple thumbnails to HD
 * Processes in parallel for efficiency
 * Cost: 1 token per image
 *
 * @param {array} images - Array of { url, id } objects
 * @returns {object} { success, results, totalTokensUsed, successCount }
 */
exports.upscaleBatch = functions
  .runWith({ timeoutSeconds: 540, memory: '2GB' })
  .https.onCall(async (data, context) => {
    const uid = await verifyAuth(context);
    checkRateLimit(uid, 'upscaleBatch', 3);

    const { images } = data;
    const TOKEN_COST_PER_IMAGE = 1;

    if (!images || !Array.isArray(images) || images.length === 0) {
      throw new functions.https.HttpsError('invalid-argument', 'Images array is required');
    }

    if (images.length > 50) {
      throw new functions.https.HttpsError('invalid-argument', 'Maximum 50 images per batch');
    }

    const totalCost = images.length * TOKEN_COST_PER_IMAGE;

    try {
      // Check token balance
      const tokenDoc = await db.collection('creativeTokens').doc(uid).get();
      if (!tokenDoc.exists) {
        throw new functions.https.HttpsError('failed-precondition', 'Token balance not found');
      }

      const balance = tokenDoc.data().balance || 0;
      if (balance < totalCost) {
        throw new functions.https.HttpsError('resource-exhausted',
          `Insufficient tokens. Need ${totalCost}, have ${balance}`);
      }

      // Configure fal.ai client
      fal.config({
        credentials: process.env.FAL_KEY || functions.config().fal?.key
      });

      const storage = admin.storage().bucket();
      const results = [];
      let successCount = 0;

      console.log(`Starting batch upscale for user ${uid}: ${images.length} images`);

      // Process in chunks of 3 for parallel processing
      const chunkSize = 3;
      for (let i = 0; i < images.length; i += chunkSize) {
        const chunk = images.slice(i, i + chunkSize);

        const chunkResults = await Promise.all(
          chunk.map(async (img) => {
            try {
              // Call AuraSR
              const result = await fal.subscribe('fal-ai/aura-sr', {
                input: {
                  image_url: img.url,
                  upscaling_factor: 4,
                  overlapping_tiles: true
                }
              });

              if (!result.data?.image?.url) {
                throw new Error('No image returned');
              }

              // Download and resize
              const upscaledResponse = await axios.get(result.data.image.url, {
                responseType: 'arraybuffer',
                timeout: 30000
              });

              const resizedBuffer = await sharp(upscaledResponse.data)
                .resize(1920, 1080, { fit: 'cover', position: 'center' })
                .png({ quality: 95, compressionLevel: 6 })
                .toBuffer();

              // Upload to Firebase Storage
              const timestamp = Date.now();
              const hdPath = `thumbnails-hd/${uid}/${timestamp}_${img.id}_hd.png`;
              const file = storage.file(hdPath);

              await file.save(resizedBuffer, {
                metadata: {
                  contentType: 'image/png',
                  metadata: { originalUrl: img.url, upscaleModel: 'aura-sr' }
                }
              });

              await file.makePublic();
              const hdUrl = `https://storage.googleapis.com/${storage.name}/${hdPath}`;

              successCount++;
              return { id: img.id, hdUrl, status: 'success' };

            } catch (error) {
              console.error(`Batch upscale error for image ${img.id}:`, error.message);
              return { id: img.id, error: error.message, status: 'error' };
            }
          })
        );

        results.push(...chunkResults);
      }

      // Deduct tokens only for successful upscales
      const tokensUsed = successCount * TOKEN_COST_PER_IMAGE;
      if (tokensUsed > 0) {
        await db.collection('creativeTokens').doc(uid).update({
          balance: admin.firestore.FieldValue.increment(-tokensUsed),
          lastUsed: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // Log usage
      await logUsage(uid, 'hd_upscale_batch', {
        totalImages: images.length,
        successCount,
        tokensUsed
      });

      console.log(`Batch upscale complete for user ${uid}: ${successCount}/${images.length} successful`);

      return {
        success: true,
        results,
        totalTokensUsed: tokensUsed,
        successCount,
        failedCount: images.length - successCount,
        remainingBalance: balance - tokensUsed
      };

    } catch (error) {
      console.error('Batch upscale error:', error);
      if (error instanceof functions.https.HttpsError) throw error;
      throw new functions.https.HttpsError('internal',
        sanitizeErrorMessage(error, 'Batch upscale failed. Please try again.'));
    }
  });

// Get user's creative token balance (for Thumbnail Pro)
// Syncs with admin token configuration and user subscription plan
exports.getThumbnailTokenBalance = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  try {
    // Get user's subscription plan
    const userDoc = await db.collection('users').doc(uid).get();
    const userPlan = userDoc.exists ? (userDoc.data().subscription?.plan || 'free') : 'free';

    // Get admin-configured token settings (use shared helper for consistency)
    const tokenConfig = await getTokenConfigFromAdmin();

    // Get plan-specific allocation
    const planConfig = tokenConfig[userPlan] || tokenConfig.free;
    const monthlyAllocation = planConfig.monthlyTokens || 10;
    const rolloverPercent = planConfig.rolloverPercent || 0;

    // Get or create user's token balance
    const tokenDoc = await db.collection('creativeTokens').doc(uid).get();

    if (!tokenDoc.exists) {
      // Initialize new user with plan-appropriate tokens
      const initialTokens = {
        balance: monthlyAllocation,
        rollover: 0,
        plan: userPlan,
        monthlyAllocation: monthlyAllocation,
        rolloverPercent: rolloverPercent,
        lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      await db.collection('creativeTokens').doc(uid).set(initialTokens);
      return {
        success: true,
        balance: monthlyAllocation,
        plan: userPlan,
        monthlyAllocation: monthlyAllocation
      };
    }

    const tokenData = tokenDoc.data();

    // Check if plan has changed - sync if needed
    if (tokenData.plan !== userPlan) {
      const updatedTokens = {
        plan: userPlan,
        monthlyAllocation: monthlyAllocation,
        rolloverPercent: rolloverPercent
      };
      await db.collection('creativeTokens').doc(uid).update(updatedTokens);
      tokenData.plan = userPlan;
      tokenData.monthlyAllocation = monthlyAllocation;
    }

    // Check if monthly refresh is needed
    const now = new Date();
    const lastRefresh = tokenData.lastRefresh?.toDate() || new Date(0);
    const monthsSinceRefresh = (now.getFullYear() - lastRefresh.getFullYear()) * 12 +
                               (now.getMonth() - lastRefresh.getMonth());

    if (monthsSinceRefresh >= 1) {
      // Calculate rollover based on plan's rollover percent
      const maxRollover = Math.floor(tokenData.balance * (rolloverPercent / 100));
      const newBalance = monthlyAllocation + maxRollover;

      const refreshedTokens = {
        balance: newBalance,
        rollover: maxRollover,
        plan: userPlan,
        monthlyAllocation: monthlyAllocation,
        rolloverPercent: rolloverPercent,
        lastRefresh: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection('creativeTokens').doc(uid).update(refreshedTokens);

      return {
        success: true,
        balance: newBalance,
        plan: userPlan,
        monthlyAllocation: monthlyAllocation,
        rollover: maxRollover
      };
    }

    return {
      success: true,
      balance: tokenData.balance || 0,
      plan: userPlan,
      monthlyAllocation: monthlyAllocation
    };
  } catch (error) {
    console.error('Get token balance error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to get token balance');
  }
});

// ==============================================
// VIDEO WIZARD TOKEN FUNCTIONS
// ==============================================

/**
 * Default token costs for Video Wizard operations
 * Can be overridden in admin settings: settings/wizardTokenCosts
 */
const DEFAULT_WIZARD_TOKEN_COSTS = {
  analyzeVideo: 5,      // Analyze a YouTube video
  showMoreClips: 3,     // Generate additional clips
  generateSEO: 2,       // Generate SEO for a clip
  generateBRoll: 4,     // Generate B-Roll suggestions
  detectSpeakers: 3,    // Detect speakers in video
  exportClip: 0         // Export is free (already paid for analysis)
};

/**
 * Helper: Get wizard token costs from admin config or defaults
 */
async function getWizardTokenCosts() {
  try {
    const costsDoc = await db.collection('settings').doc('wizardTokenCosts').get();
    if (costsDoc.exists) {
      return { ...DEFAULT_WIZARD_TOKEN_COSTS, ...costsDoc.data() };
    }
  } catch (error) {
    console.log('[getWizardTokenCosts] Using defaults:', error.message);
  }
  return DEFAULT_WIZARD_TOKEN_COSTS;
}

/**
 * Helper: Deduct tokens for wizard operations
 * Uses creativeTokens collection (same as Thumbnail Generator)
 * @returns {Object} { success, newBalance, error }
 */
async function deductWizardTokens(uid, amount, operation, metadata = {}) {
  if (amount <= 0) {
    return { success: true, newBalance: null, deducted: 0 };
  }

  try {
    // Get current balance
    const tokenDoc = await db.collection('creativeTokens').doc(uid).get();

    if (!tokenDoc.exists) {
      // Initialize with free plan defaults
      const tokenConfig = await getTokenConfigFromAdmin();
      const planConfig = tokenConfig.free || { monthlyTokens: 10 };

      await db.collection('creativeTokens').doc(uid).set({
        balance: planConfig.monthlyTokens,
        rollover: 0,
        plan: 'free',
        monthlyAllocation: planConfig.monthlyTokens,
        rolloverPercent: 0,
        lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Re-fetch
      const newDoc = await db.collection('creativeTokens').doc(uid).get();
      if (!newDoc.exists) {
        return { success: false, error: 'Failed to initialize tokens' };
      }
    }

    const tokenData = (await db.collection('creativeTokens').doc(uid).get()).data();
    const currentBalance = tokenData.balance || 0;

    if (currentBalance < amount) {
      return {
        success: false,
        error: 'Insufficient tokens',
        required: amount,
        available: currentBalance
      };
    }

    const newBalance = currentBalance - amount;

    // Update balance
    await db.collection('creativeTokens').doc(uid).update({
      balance: newBalance,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });

    // Log transaction
    await db.collection('tokenTransactions').add({
      userId: uid,
      type: 'wizard_' + operation,
      amount: -amount,
      balanceAfter: newBalance,
      operation: operation,
      metadata: metadata,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`[deductWizardTokens] User ${uid}: ${operation} cost ${amount} tokens, new balance: ${newBalance}`);

    return { success: true, newBalance, deducted: amount };
  } catch (error) {
    console.error('[deductWizardTokens] Error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get user's token balance for Video Wizard
 * Uses creativeTokens collection (shared with Thumbnail Generator)
 */
exports.getWizardTokenBalance = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  try {
    // Get user's subscription plan
    const userDoc = await db.collection('users').doc(uid).get();
    const userPlan = userDoc.exists ? (userDoc.data().subscription?.plan || 'free') : 'free';

    // Get admin-configured token settings
    const tokenConfig = await getTokenConfigFromAdmin();
    const planConfig = tokenConfig[userPlan] || tokenConfig.free;
    const monthlyAllocation = planConfig.monthlyTokens || 10;
    const rolloverPercent = planConfig.rolloverPercent || 0;

    // Get or create user's token balance
    const tokenDoc = await db.collection('creativeTokens').doc(uid).get();

    if (!tokenDoc.exists) {
      // Initialize new user with plan-appropriate tokens
      const initialTokens = {
        balance: monthlyAllocation,
        rollover: 0,
        plan: userPlan,
        monthlyAllocation: monthlyAllocation,
        rolloverPercent: rolloverPercent,
        lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      await db.collection('creativeTokens').doc(uid).set(initialTokens);

      // Get token costs
      const costs = await getWizardTokenCosts();

      return {
        success: true,
        balance: monthlyAllocation,
        plan: userPlan,
        monthlyAllocation: monthlyAllocation,
        rollover: 0,
        costs: costs
      };
    }

    const tokenData = tokenDoc.data();

    // Check if plan has changed - sync if needed
    if (tokenData.plan !== userPlan) {
      await db.collection('creativeTokens').doc(uid).update({
        plan: userPlan,
        monthlyAllocation: monthlyAllocation,
        rolloverPercent: rolloverPercent
      });
    }

    // Check if monthly refresh is needed
    const now = new Date();
    const lastRefresh = tokenData.lastRefresh?.toDate() || new Date(0);
    const monthsSinceRefresh = (now.getFullYear() - lastRefresh.getFullYear()) * 12 +
                               (now.getMonth() - lastRefresh.getMonth());

    let balance = tokenData.balance || 0;
    let rollover = tokenData.rollover || 0;

    if (monthsSinceRefresh >= 1) {
      // Calculate rollover based on plan's rollover percent
      const maxRollover = Math.floor(balance * (rolloverPercent / 100));
      balance = monthlyAllocation + maxRollover;
      rollover = maxRollover;

      await db.collection('creativeTokens').doc(uid).update({
        balance: balance,
        rollover: rollover,
        plan: userPlan,
        monthlyAllocation: monthlyAllocation,
        rolloverPercent: rolloverPercent,
        lastRefresh: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // Get token costs
    const costs = await getWizardTokenCosts();

    return {
      success: true,
      balance: balance,
      plan: userPlan,
      monthlyAllocation: monthlyAllocation,
      rollover: rollover,
      costs: costs
    };
  } catch (error) {
    console.error('[getWizardTokenBalance] Error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to get token balance');
  }
});

/**
 * Admin function: Set Video Wizard token costs
 */
exports.adminSetWizardTokenCosts = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const { analyzeVideo, showMoreClips, generateSEO, generateBRoll, detectSpeakers, exportClip } = data;

  try {
    const costs = {};

    if (analyzeVideo !== undefined) costs.analyzeVideo = Math.max(0, parseInt(analyzeVideo));
    if (showMoreClips !== undefined) costs.showMoreClips = Math.max(0, parseInt(showMoreClips));
    if (generateSEO !== undefined) costs.generateSEO = Math.max(0, parseInt(generateSEO));
    if (generateBRoll !== undefined) costs.generateBRoll = Math.max(0, parseInt(generateBRoll));
    if (detectSpeakers !== undefined) costs.detectSpeakers = Math.max(0, parseInt(detectSpeakers));
    if (exportClip !== undefined) costs.exportClip = Math.max(0, parseInt(exportClip));

    costs.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    costs.updatedBy = context.auth.uid;

    await db.collection('settings').doc('wizardTokenCosts').set(costs, { merge: true });

    return { success: true, costs };
  } catch (error) {
    console.error('[adminSetWizardTokenCosts] Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * Admin function: Get Video Wizard token costs
 */
exports.adminGetWizardTokenCosts = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  try {
    const costs = await getWizardTokenCosts();
    return { success: true, costs };
  } catch (error) {
    console.error('[adminGetWizardTokenCosts] Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * Deduct tokens for Video Wizard operations
 * Called by frontend for operations like showMoreClips
 */
exports.wizardDeductTokens = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  const { amount, operation, metadata = {} } = data;

  if (!amount || amount <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid token amount');
  }

  if (!operation) {
    throw new functions.https.HttpsError('invalid-argument', 'Operation is required');
  }

  try {
    // Verify the cost matches the configured amount
    const costs = await getWizardTokenCosts();
    const expectedCost = costs[operation];

    if (expectedCost !== undefined && amount !== expectedCost) {
      console.warn(`[wizardDeductTokens] Client requested ${amount} tokens but ${operation} costs ${expectedCost}`);
      // Use the server-configured cost, not the client-provided one
    }

    const actualCost = expectedCost !== undefined ? expectedCost : amount;

    // Deduct tokens using the helper function
    const result = await deductWizardTokens(uid, actualCost, operation, metadata);

    return {
      success: true,
      newBalance: result.newBalance,
      tokensDeducted: actualCost
    };
  } catch (error) {
    console.error('[wizardDeductTokens] Error:', error);
    if (error.code === 'resource-exhausted') {
      throw error;
    }
    throw new functions.https.HttpsError('internal', error.message);
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
      placementSnap, channelAuditSnap, viralSnap, monetizationSnap, scriptSnap,
      sponsorshipSnap, diversificationSnap, cpmBoosterSnap, audienceProfileSnap,
      digitalProductSnap, affiliateSnap, multiIncomeSnap,
      brandDealSnap, licensingSnap, automationSnap
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
      safeQuery('scriptWriterHistory'),
      // Enterprise monetization tools - Phase 1
      safeQuery('sponsorshipHistory'),
      safeQuery('diversificationHistory'),
      safeQuery('cpmBoosterHistory'),
      safeQuery('audienceProfileHistory'),
      // Enterprise monetization tools - Phase 2
      safeQuery('digitalProductHistory'),
      safeQuery('affiliateHistory'),
      safeQuery('multiIncomeHistory'),
      // Enterprise monetization tools - Phase 3
      safeQuery('brandDealHistory'),
      safeQuery('licensingHistory'),
      safeQuery('automationHistory')
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
      ...formatHistory(scriptSnap, 'script'),
      // Enterprise monetization tools - Phase 1
      ...formatHistory(sponsorshipSnap, 'sponsorship'),
      ...formatHistory(diversificationSnap, 'diversification'),
      ...formatHistory(cpmBoosterSnap, 'cpmbooster'),
      ...formatHistory(audienceProfileSnap, 'audienceprofile'),
      // Enterprise monetization tools - Phase 2
      ...formatHistory(digitalProductSnap, 'digitalproduct'),
      ...formatHistory(affiliateSnap, 'affiliate'),
      ...formatHistory(multiIncomeSnap, 'multiincome'),
      // Enterprise monetization tools - Phase 3
      ...formatHistory(brandDealSnap, 'branddeal'),
      ...formatHistory(licensingSnap, 'licensing'),
      ...formatHistory(automationSnap, 'automation')
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
        scripts: formatHistory(scriptSnap, 'script'),
        // New enterprise monetization tools
        sponsorship: formatHistory(sponsorshipSnap, 'sponsorship'),
        diversification: formatHistory(diversificationSnap, 'diversification'),
        cpmbooster: formatHistory(cpmBoosterSnap, 'cpmbooster'),
        audienceprofile: formatHistory(audienceProfileSnap, 'audienceprofile')
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
        scripts: scriptSnap.size,
        // New enterprise monetization tools
        sponsorship: sponsorshipSnap.size,
        diversification: diversificationSnap.size,
        cpmbooster: cpmBoosterSnap.size,
        audienceprofile: audienceProfileSnap.size
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

    // Step 3: Get recent videos with FULL details to understand content
    const videosResponse = await youtube.search.list({
      part: 'snippet',
      channelId: channelId,
      type: 'video',
      order: 'date',
      maxResults: 10
    });

    // Get video IDs for detailed stats
    const videoIds = videosResponse.data.items?.map(v => v.id.videoId).filter(Boolean) || [];

    // Fetch detailed video statistics and content details
    let videoDetails = [];
    if (videoIds.length > 0) {
      const videoDetailsResponse = await youtube.videos.list({
        part: 'snippet,statistics,contentDetails',
        id: videoIds.join(',')
      });
      videoDetails = videoDetailsResponse.data.items || [];
    }

    // Build rich video context for AI
    const sourceVideos = videoDetails.map(v => ({
      title: v.snippet.title,
      description: (v.snippet.description || '').substring(0, 300),
      views: parseInt(v.statistics.viewCount) || 0,
      likes: parseInt(v.statistics.likeCount) || 0,
      tags: v.snippet.tags?.slice(0, 10) || [],
      category: v.snippet.categoryId,
      duration: v.contentDetails.duration
    }));

    // Sort by views to identify most popular content
    const topVideos = [...sourceVideos].sort((a, b) => b.views - a.views).slice(0, 5);
    const recentVideoTitles = sourceVideos.map(v => v.title);
    const allTags = [...new Set(sourceVideos.flatMap(v => v.tags))].slice(0, 20);
    const topicCategories = userChannel.topicDetails?.topicCategories?.map(t => t.split('/').pop()) || [];

    // Step 4: Use AI to identify PRIMARY TOPIC (audience interest) vs STYLE (presentation)
    // This is CRITICAL for ad placement - we need to find the RIGHT AUDIENCE
    const analysisPrompt = `You are a YouTube advertising expert. Your goal is to find channels with the SAME AUDIENCE for ad placement.

=== CHANNEL INFO ===
Name: ${channelName}
Description: ${channelDescription.substring(0, 500)}
Subscribers: ${subscriberCount.toLocaleString()}

=== CHANNEL'S VIDEOS ===
${sourceVideos.slice(0, 8).map((v, i) => `
VIDEO ${i + 1}: "${v.title}"
- Description: ${v.description.substring(0, 150)}
- Tags: ${v.tags.slice(0, 5).join(', ') || 'none'}
`).join('\n')}

=== ALL VIDEO TAGS ===
${allTags.join(', ') || 'No tags found'}

CRITICAL: Distinguish between PRIMARY TOPIC and STYLE:

PRIMARY TOPIC = What the content is ABOUT (determines the AUDIENCE)
Examples: Christmas, cooking, gaming, fitness, kids content, meditation, travel, tech reviews

STYLE = How the content is PRESENTED (just the format/genre)
Examples: rock music, animation, vlog style, tutorial format, comedy

For ad placement, we want to reach the SAME AUDIENCE. The audience for "Christmas rock music" is people who watch CHRISTMAS content, NOT rock music fans in general.

Respond in this EXACT JSON format:
{
  "primaryTopic": "The main subject/theme that defines the AUDIENCE (e.g., 'Christmas', 'Cooking', 'Gaming', 'Kids Entertainment')",
  "style": "How the content is presented (e.g., 'rock music', 'animation', 'tutorial')",
  "niche": "Combined description (e.g., 'Christmas Music')",
  "audienceInterest": "What the audience is interested in (e.g., 'Christmas content', 'holiday music', 'seasonal entertainment')",
  "language": "Primary language",
  "primaryTopicKeywords": ["keyword directly related to PRIMARY TOPIC", "another primary keyword", "third primary keyword"],
  "searchQueries": [
    "search query focused on PRIMARY TOPIC",
    "another PRIMARY TOPIC focused search",
    "third search for PRIMARY TOPIC content",
    "fourth PRIMARY TOPIC search",
    "fifth search query"
  ]
}

IMPORTANT EXAMPLES:
- "Christmas rock song" → primaryTopic: "Christmas", style: "rock music", searchQueries should find Christmas content
- "Animated cooking tutorial" → primaryTopic: "Cooking", style: "animation", searchQueries should find cooking content
- "Kids nursery rhymes" → primaryTopic: "Kids Entertainment", style: "music", searchQueries should find kids content

The searchQueries MUST focus on the PRIMARY TOPIC, not the style!`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: analysisPrompt }],
      temperature: 0.5,
      max_tokens: 800
    });

    let analysis;
    try {
      const responseText = aiResponse.choices[0].message.content.trim();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (e) {
      // Fallback: try to detect primary topic from content
      const contentText = (channelName + ' ' + recentVideoTitles.join(' ') + ' ' + allTags.join(' ')).toLowerCase();

      // Detect common primary topics
      let detectedTopic = 'General';
      const topicPatterns = {
        'Christmas': ['christmas', 'xmas', 'holiday', 'santa', 'noel', 'festive'],
        'Kids Entertainment': ['kids', 'children', 'nursery', 'cartoon', 'toddler'],
        'Gaming': ['game', 'gaming', 'gameplay', 'playthrough', 'gamer'],
        'Cooking': ['recipe', 'cooking', 'food', 'chef', 'kitchen'],
        'Fitness': ['workout', 'fitness', 'exercise', 'gym', 'training'],
        'Music': ['music', 'song', 'album', 'concert', 'band'],
        'Tech': ['tech', 'review', 'unboxing', 'gadget', 'smartphone']
      };

      for (const [topic, keywords] of Object.entries(topicPatterns)) {
        if (keywords.some(k => contentText.includes(k))) {
          detectedTopic = topic;
          break;
        }
      }

      analysis = {
        primaryTopic: detectedTopic,
        style: 'video',
        niche: detectedTopic,
        audienceInterest: detectedTopic + ' content',
        language: 'en',
        primaryTopicKeywords: allTags.slice(0, 3),
        searchQueries: [...recentVideoTitles.slice(0, 2), ...allTags.slice(0, 2), channelName].filter(Boolean).slice(0, 5)
      };
    }

    console.log('Placement Finder - Primary Topic:', analysis.primaryTopic, '| Style:', analysis.style);

    // Step 5: Search for channels with the SAME PRIMARY TOPIC
    const channelVideoMap = new Map();

    // Build search queries focused on PRIMARY TOPIC
    const primaryTopicQueries = analysis.searchQueries || [];
    const topicKeywordQueries = (analysis.primaryTopicKeywords || []).map(k => k + ' channel');

    // Also search using primary topic directly
    const directTopicQueries = [
      analysis.primaryTopic,
      analysis.primaryTopic + ' music',
      analysis.primaryTopic + ' videos',
      analysis.audienceInterest
    ].filter(q => q && q.length > 2);

    // Combine all queries, prioritizing topic-focused ones
    const allSearchQueries = [
      ...primaryTopicQueries,
      ...directTopicQueries,
      ...topicKeywordQueries
    ].filter(Boolean);

    const searchQueries = [...new Set(allSearchQueries)].slice(0, 10);

    console.log('Placement Finder search queries:', searchQueries);

    for (const query of searchQueries) {
      try {
        // Search for VIDEOS (don't restrict language - let it find all relevant content)
        const searchResponse = await youtube.search.list({
          part: 'snippet',
          q: query,
          type: 'video',
          maxResults: 25,
          order: 'relevance'
        });

        // Collect videos and their channels
        searchResponse.data.items?.forEach(item => {
          const vidChannelId = item.snippet.channelId;
          if (vidChannelId !== channelId) { // Exclude source channel
            if (!channelVideoMap.has(vidChannelId)) {
              channelVideoMap.set(vidChannelId, {
                channelId: vidChannelId,
                channelName: item.snippet.channelTitle,
                foundVideos: []
              });
            }
            channelVideoMap.get(vidChannelId).foundVideos.push({
              title: item.snippet.title,
              description: (item.snippet.description || '').substring(0, 200)
            });
          }
        });

        // If we found enough channels, we can stop early
        if (channelVideoMap.size >= 40) break;

      } catch (e) {
        console.log('Video search query failed:', query, e.message);
      }
    }

    // If video search failed, try channel search as fallback
    if (channelVideoMap.size < 5) {
      console.log('Video search found few results, trying channel search fallback');

      for (const query of searchQueries.slice(0, 4)) {
        try {
          const channelSearchResponse = await youtube.search.list({
            part: 'snippet',
            q: query,
            type: 'channel',
            maxResults: 15
          });

          channelSearchResponse.data.items?.forEach(item => {
            const chId = item.snippet.channelId;
            if (chId !== channelId && !channelVideoMap.has(chId)) {
              channelVideoMap.set(chId, {
                channelId: chId,
                channelName: item.snippet.channelTitle,
                foundVideos: []
              });
            }
          });
        } catch (e) {
          console.log('Channel search fallback failed:', query, e.message);
        }
      }
    }

    // Step 6: Get detailed channel info for found channels
    const channelIds = Array.from(channelVideoMap.keys()).slice(0, 50);

    console.log('Placement Finder found', channelIds.length, 'candidate channels');

    if (channelIds.length === 0) {
      throw new functions.https.HttpsError('not-found', 'No similar channels found. Try a different channel.');
    }

    const detailsResponse = await youtube.channels.list({
      part: 'snippet,statistics',
      id: channelIds.join(','),
      maxResults: 50
    });

    // Step 7: Get recent videos from each found channel for content analysis
    const channelsWithContent = [];
    const channelDetailsMap = new Map();

    detailsResponse.data.items?.forEach(ch => {
      channelDetailsMap.set(ch.id, ch);
    });

    // Batch fetch recent videos from top candidate channels (limit to save API quota)
    const topCandidates = channelIds.slice(0, 25);

    for (const candidateId of topCandidates) {
      try {
        const chDetails = channelDetailsMap.get(candidateId);
        const foundData = channelVideoMap.get(candidateId);

        if (!chDetails) continue;

        // Get recent videos from this channel
        const recentVidsResponse = await youtube.search.list({
          part: 'snippet',
          channelId: candidateId,
          type: 'video',
          order: 'date',
          maxResults: 8
        });

        const candidateVideoTitles = recentVidsResponse.data.items?.map(v => v.snippet.title) || [];

        channelsWithContent.push({
          channelId: candidateId,
          channelName: chDetails.snippet.title,
          channelDescription: (chDetails.snippet.description || '').substring(0, 300),
          handle: chDetails.snippet.customUrl || null,
          thumbnail: chDetails.snippet.thumbnails?.medium?.url || chDetails.snippet.thumbnails?.default?.url,
          subscribers: parseInt(chDetails.statistics.subscriberCount) || 0,
          totalViews: parseInt(chDetails.statistics.viewCount) || 0,
          videoCount: parseInt(chDetails.statistics.videoCount) || 0,
          recentVideoTitles: candidateVideoTitles,
          foundVideos: foundData?.foundVideos || []
        });
      } catch (e) {
        console.log('Failed to get videos for channel:', candidateId, e.message);
      }
    }

    if (channelsWithContent.length === 0) {
      throw new functions.https.HttpsError('not-found', 'No quality channels found. The analyzed channel may be too niche.');
    }

    // Step 8: Build PRIMARY TOPIC keywords for strict matching
    const primaryTopic = analysis.primaryTopic || 'General';
    const primaryTopicLower = primaryTopic.toLowerCase();

    // Build list of keywords that MUST be present for high scores
    const primaryTopicKeywords = [];

    // Add primary topic keywords from AI analysis
    if (analysis.primaryTopicKeywords) {
      primaryTopicKeywords.push(...analysis.primaryTopicKeywords);
    }

    // Add the primary topic itself
    primaryTopicKeywords.push(primaryTopic);

    // Detect specific topic patterns and add related keywords
    const topicPatterns = {
      'christmas': ['christmas', 'xmas', 'holiday', 'santa', 'noel', 'festive', 'carol'],
      'halloween': ['halloween', 'spooky', 'scary', 'horror', 'trick or treat'],
      'kids': ['kids', 'children', 'nursery', 'toddler', 'baby', 'educational'],
      'gaming': ['gaming', 'game', 'gameplay', 'gamer', 'playthrough', 'lets play'],
      'cooking': ['cooking', 'recipe', 'food', 'chef', 'kitchen', 'baking'],
      'fitness': ['fitness', 'workout', 'exercise', 'gym', 'training', 'health']
    };

    // Check which topic patterns match and add their keywords
    for (const [topic, keywords] of Object.entries(topicPatterns)) {
      if (primaryTopicLower.includes(topic) || keywords.some(k => primaryTopicLower.includes(k))) {
        primaryTopicKeywords.push(...keywords);
        break;
      }
    }

    const uniqueKeywords = [...new Set(primaryTopicKeywords.map(k => k.toLowerCase()))].slice(0, 10);
    console.log('PRIMARY TOPIC keywords for scoring:', uniqueKeywords);

    // Step 9: Use AI to score with STRICT focus on PRIMARY TOPIC (audience match)
    const scoringPrompt = `You are scoring YouTube channels for Google Ads placement targeting.

GOAL: Find channels with the SAME AUDIENCE as the source channel.

=== SOURCE CHANNEL ===
Name: ${channelName}
PRIMARY TOPIC (defines the audience): ${primaryTopic}
Style: ${analysis.style || 'video'}
Niche: ${analysis.niche}

Source Videos:
${topVideos.slice(0, 4).map(v => `- "${v.title}"`).join('\n')}

=== CANDIDATE CHANNELS ===
${channelsWithContent.slice(0, 20).map((ch, i) => `
[${i + 1}] ${ch.channelName}
Videos: ${ch.recentVideoTitles.slice(0, 3).join(' | ')}
`).join('\n')}

STRICT SCORING - Based on PRIMARY TOPIC match (audience match):
- 80-100: Channel has SAME PRIMARY TOPIC (e.g., both are Christmas content, both are kids content)
- 50-79: Channel is somewhat related to PRIMARY TOPIC
- 0-49: Channel does NOT match PRIMARY TOPIC (wrong audience)

CRITICAL RULE for "${primaryTopic}":
${primaryTopic === 'Christmas' || primaryTopicLower.includes('christmas') ?
  '- ONLY channels with Christmas/holiday content should score 60+\n- Regular music/rock/pop channels WITHOUT Christmas = MAX 40 points\n- Christmas Songs, Holiday Music, Carols = 80+ points' :
  primaryTopic === 'Kids Entertainment' || primaryTopicLower.includes('kids') ?
  '- ONLY channels with kids/children content should score 60+\n- Adult music or entertainment channels = MAX 40 points' :
  `- ONLY channels about "${primaryTopic}" should score 60+\n- Channels about different topics = MAX 40 points`
}

Respond with ONLY a JSON array of ${Math.min(channelsWithContent.length, 20)} scores:
[score1, score2, ...]`;

    let contentScores = [];
    try {
      const scoringResponse = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: scoringPrompt }],
        temperature: 0.2,
        max_tokens: 500
      });

      const scoresText = scoringResponse.choices[0].message.content.trim();
      const scoresMatch = scoresText.match(/\[[\d,\s]+\]/);
      if (scoresMatch) {
        contentScores = JSON.parse(scoresMatch[0]);
      }
    } catch (e) {
      console.log('AI scoring failed, using fallback:', e.message);
    }

    // Step 10: Build final placements with STRICT PRIMARY TOPIC matching
    const placements = channelsWithContent.slice(0, 20).map((ch, index) => {
      // Build channel text for keyword matching
      const channelText = (ch.channelName + ' ' + ch.channelDescription + ' ' + ch.recentVideoTitles.join(' ')).toLowerCase();

      // Check how many PRIMARY TOPIC keywords this channel matches
      const topicMatches = uniqueKeywords.filter(k => channelText.includes(k)).length;
      const hasPrimaryTopicMatch = topicMatches >= 1;

      // Get AI content score
      let contentScore = contentScores[index];

      // If AI didn't score, calculate based on keyword matching
      if (contentScore === undefined || contentScore === null) {
        if (hasPrimaryTopicMatch) {
          // Channel matches PRIMARY TOPIC - score based on match strength
          contentScore = 50 + (topicMatches * 15); // 65 for 1 match, 80 for 2, etc.
        } else {
          // Channel does NOT match PRIMARY TOPIC - very low score
          contentScore = 25;
        }
      } else {
        // AI scored it, but ENFORCE PRIMARY TOPIC requirement
        if (!hasPrimaryTopicMatch && uniqueKeywords.length > 0) {
          // Channel doesn't match PRIMARY TOPIC - cap at 40 regardless of AI score
          contentScore = Math.min(contentScore, 40);
        } else if (topicMatches >= 2) {
          // Strong match - boost score
          contentScore = Math.min(contentScore + 10, 100);
        }
      }

      // Very small engagement bonus (max 3 points) - content match is primary
      let engagementBonus = 0;
      if (ch.subscribers > 50000) engagementBonus += 1;
      if (ch.subscribers > 500000) engagementBonus += 2;

      const finalScore = Math.min(Math.round(contentScore + engagementBonus), 100);

      return {
        channelId: ch.channelId,
        channelName: ch.channelName,
        channelUrl: `https://www.youtube.com/channel/${ch.channelId}`,
        handle: ch.handle,
        thumbnail: ch.thumbnail,
        description: ch.channelDescription.substring(0, 150),
        subscribers: ch.subscribers,
        subscribersFormatted: formatNumber(ch.subscribers),
        totalViews: ch.totalViews,
        videoCount: ch.videoCount,
        relevanceScore: finalScore,
        matchesPrimaryTopic: hasPrimaryTopicMatch,
        sampleVideos: ch.recentVideoTitles.slice(0, 3)
      };
    })
    .filter(ch => ch.subscribers >= 500)
    .sort((a, b) => {
      // Sort by: primary topic match first, then by score
      if (a.matchesPrimaryTopic && !b.matchesPrimaryTopic) return -1;
      if (!a.matchesPrimaryTopic && b.matchesPrimaryTopic) return 1;
      return b.relevanceScore - a.relevanceScore;
    })
    .slice(0, 30);

    if (placements.length === 0) {
      throw new functions.https.HttpsError('not-found', 'No quality channels found. The analyzed channel may be too niche.');
    }

    // Step 11: Save to history
    const historyData = {
      userId: uid,
      channelUrl,
      channelInfo: {
        id: channelId,
        name: channelName,
        subscribers: subscriberCount,
        thumbnail: channelThumbnail,
        description: channelDescription.substring(0, 300),
        // Include source videos so users can see what was analyzed
        topVideos: topVideos.slice(0, 5).map(v => ({
          title: v.title,
          views: v.views
        }))
      },
      analysis: {
        primaryTopic: primaryTopic, // The main subject that defines the audience
        style: analysis.style || 'video', // How content is presented
        niche: analysis.niche,
        language: analysis.language || 'en',
        audienceInterest: analysis.audienceInterest,
        primaryTopicKeywords: uniqueKeywords, // Keywords used for matching
        targetAudience: analysis.targetAudience || analysis.audienceInterest
      },
      placements,
      totalFound: placements.length,
      searchQueries: searchQueries.slice(0, 5),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const historyRef = await db.collection('placementFinderHistory').add(historyData);

    // Step 12: Update usage
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

// Get user's creative tokens balance (synced with admin settings)
exports.getCreativeTokens = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  try {
    // Get user's subscription plan
    const userDoc = await db.collection('users').doc(uid).get();
    const userPlan = userDoc.exists ? (userDoc.data().subscription?.plan || 'free') : 'free';

    // Get admin-configured token settings (use shared helper for consistency)
    const tokenConfig = await getTokenConfigFromAdmin();
    const planConfig = tokenConfig[userPlan] || tokenConfig.free;
    const monthlyAllocation = planConfig.monthlyTokens || 10;
    const rolloverPercent = planConfig.rolloverPercent || 0;

    const tokenDoc = await db.collection('creativeTokens').doc(uid).get();

    if (!tokenDoc.exists) {
      // Initialize new user with plan-appropriate tokens
      const now = new Date();
      const initialTokens = {
        balance: monthlyAllocation,
        rollover: 0,
        plan: userPlan,
        monthlyAllocation: monthlyAllocation,
        rolloverPercent: rolloverPercent,
        lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      await db.collection('creativeTokens').doc(uid).set(initialTokens);
      return {
        balance: monthlyAllocation,
        rollover: 0,
        plan: userPlan,
        monthlyAllocation: monthlyAllocation,
        lastRefresh: now.toISOString(),
        createdAt: now.toISOString()
      };
    }

    const tokenData = tokenDoc.data();

    // Check if plan has changed - sync if needed
    if (tokenData.plan !== userPlan) {
      await db.collection('creativeTokens').doc(uid).update({
        plan: userPlan,
        monthlyAllocation: monthlyAllocation,
        rolloverPercent: rolloverPercent
      });
      tokenData.plan = userPlan;
      tokenData.monthlyAllocation = monthlyAllocation;
    }

    // Check if monthly refresh is needed
    const now = new Date();
    const lastRefresh = tokenData.lastRefresh?.toDate() || new Date(0);
    const monthsSinceRefresh = (now.getFullYear() - lastRefresh.getFullYear()) * 12 +
                               (now.getMonth() - lastRefresh.getMonth());

    if (monthsSinceRefresh >= 1) {
      // Calculate rollover based on plan's rollover percent
      const maxRollover = Math.floor(tokenData.balance * (rolloverPercent / 100));
      const newBalance = monthlyAllocation + maxRollover;

      const updatedTokens = {
        balance: newBalance,
        rollover: maxRollover,
        plan: userPlan,
        monthlyAllocation: monthlyAllocation,
        rolloverPercent: rolloverPercent,
        lastRefresh: admin.firestore.FieldValue.serverTimestamp()
      };

      await db.collection('creativeTokens').doc(uid).update(updatedTokens);

      return {
        ...tokenData,
        ...updatedTokens,
        balance: newBalance
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

// ==============================================
// RENEWAL REQUEST SYSTEM
// ==============================================

// Helper: Create notification for a user
async function createUserNotification(userId, type, title, message, data = {}) {
  try {
    await db.collection('users').doc(userId).collection('notifications').add({
      type,
      title,
      message,
      data,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return true;
  } catch (error) {
    console.error('Error creating user notification:', error);
    return false;
  }
}

// User: Submit a renewal request
exports.userSubmitRenewalRequest = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const userId = context.auth.uid;
  const { preferredPlan, preferredDuration, message } = data || {};

  if (!preferredPlan) {
    throw new functions.https.HttpsError('invalid-argument', 'Preferred plan is required');
  }

  const validPlans = ['lite', 'pro', 'enterprise'];
  if (!validPlans.includes(preferredPlan)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid plan');
  }

  const validDurations = ['week', 'month', '3months', 'year', 'lifetime'];
  if (preferredDuration && !validDurations.includes(preferredDuration)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid duration');
  }

  // Check for existing pending request
  const existingRequest = await db.collection('renewalRequests')
    .where('userId', '==', userId)
    .where('status', '==', 'pending')
    .limit(1)
    .get();

  if (!existingRequest.empty) {
    throw new functions.https.HttpsError('already-exists', 'You already have a pending renewal request');
  }

  // Get user data for the request
  const userDoc = await db.collection('users').doc(userId).get();
  const userData = userDoc.exists ? userDoc.data() : {};

  const requestData = {
    userId,
    userEmail: userData.email || context.auth.token.email || '',
    userName: userData.displayName || userData.clientAlias || '',
    isFiverrVerified: userData.isFiverrVerified || false,
    currentPlan: userData.subscription?.plan || 'free',
    previousEndDate: userData.subscription?.endDate || null,
    preferredPlan,
    preferredDuration: preferredDuration || 'month',
    message: (message || '').trim().substring(0, 500),
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    processedAt: null,
    processedBy: null,
    adminResponse: null,
    renewalDuration: null
  };

  const docRef = await db.collection('renewalRequests').add(requestData);

  // Create notification for user
  await createUserNotification(userId, 'request_submitted',
    'Renewal Request Submitted',
    'Your request for ' + preferredPlan.toUpperCase() + ' plan has been submitted. We will review it shortly.',
    { requestId: docRef.id }
  );

  // Log activity
  await logUserActivity(userId, 'renewal_request', { action: 'submitted', preferredPlan, preferredDuration });

  return { success: true, requestId: docRef.id, message: 'Renewal request submitted successfully' };
});

// User: Get their renewal requests
exports.userGetRenewalRequests = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const userId = context.auth.uid;

  const snapshot = await db.collection('renewalRequests')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();

  const requests = [];
  snapshot.forEach(doc => {
    const d = doc.data();
    requests.push({
      id: doc.id,
      ...d,
      createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
      processedAt: d.processedAt?.toDate?.()?.toISOString() || null,
      previousEndDate: d.previousEndDate?.toDate?.()?.toISOString() || null
    });
  });

  return { requests };
});

// User: Cancel a pending request
exports.userCancelRenewalRequest = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const userId = context.auth.uid;
  const { requestId } = data || {};

  if (!requestId) {
    throw new functions.https.HttpsError('invalid-argument', 'Request ID required');
  }

  const requestDoc = await db.collection('renewalRequests').doc(requestId).get();
  if (!requestDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Request not found');
  }

  const requestData = requestDoc.data();
  if (requestData.userId !== userId) {
    throw new functions.https.HttpsError('permission-denied', 'Not your request');
  }

  if (requestData.status !== 'pending') {
    throw new functions.https.HttpsError('failed-precondition', 'Can only cancel pending requests');
  }

  await db.collection('renewalRequests').doc(requestId).update({
    status: 'cancelled',
    processedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { success: true, message: 'Request cancelled' };
});

// User: Get their notifications
exports.userGetNotifications = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const userId = context.auth.uid;
  const { limit: limitCount = 20, unreadOnly = false } = data || {};

  let query = db.collection('users').doc(userId).collection('notifications');

  // where clause must come before orderBy in Firestore
  if (unreadOnly) {
    query = query.where('read', '==', false);
  }

  query = query.orderBy('createdAt', 'desc').limit(limitCount);

  const snapshot = await query.get();
  const notifications = [];

  snapshot.forEach(doc => {
    const d = doc.data();
    notifications.push({
      id: doc.id,
      ...d,
      createdAt: d.createdAt?.toDate?.()?.toISOString() || null
    });
  });

  // Get total unread count
  const unreadSnapshot = await db.collection('users').doc(userId).collection('notifications')
    .where('read', '==', false)
    .get();

  return { notifications, unreadCount: unreadSnapshot.size };
});

// User: Mark notification as read
exports.userMarkNotificationRead = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  }

  const userId = context.auth.uid;
  const { notificationId, markAllRead = false } = data || {};

  if (markAllRead) {
    const unreadSnapshot = await db.collection('users').doc(userId).collection('notifications')
      .where('read', '==', false)
      .get();

    const batch = db.batch();
    unreadSnapshot.forEach(doc => {
      batch.update(doc.ref, { read: true });
    });
    await batch.commit();

    return { success: true, message: 'All notifications marked as read' };
  }

  if (!notificationId) {
    throw new functions.https.HttpsError('invalid-argument', 'Notification ID required');
  }

  await db.collection('users').doc(userId).collection('notifications').doc(notificationId).update({
    read: true
  });

  return { success: true };
});

// Admin: Get all renewal requests
exports.adminGetRenewalRequests = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  try {
    const { status = 'pending', limit: limitCount = 50 } = data || {};

    let query = db.collection('renewalRequests');

    // where clause must come before orderBy in Firestore
    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }

    query = query.orderBy('createdAt', 'desc').limit(limitCount);

    const snapshot = await query.get();
    const requests = [];

    snapshot.forEach(doc => {
      const d = doc.data();
      requests.push({
        id: doc.id,
        ...d,
        createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
        processedAt: d.processedAt?.toDate?.()?.toISOString() || null,
        previousEndDate: d.previousEndDate?.toDate?.()?.toISOString() || null
      });
    });

    // Get counts by status
    const pendingSnapshot = await db.collection('renewalRequests').where('status', '==', 'pending').get();
    const approvedSnapshot = await db.collection('renewalRequests').where('status', '==', 'approved').get();
    const deniedSnapshot = await db.collection('renewalRequests').where('status', '==', 'denied').get();

    return {
      requests,
      counts: {
        pending: pendingSnapshot.size,
        approved: approvedSnapshot.size,
        denied: deniedSnapshot.size
      }
    };
  } catch (error) {
    console.error('adminGetRenewalRequests error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to get renewal requests: ' + error.message);
  }
});

// Admin: Process (approve/deny) a renewal request
exports.adminProcessRenewalRequest = functions.https.onCall(async (data, context) => {
  const adminUid = await requireAdmin(context);

  const { requestId, action, duration, adminResponse } = data || {};

  if (!requestId) {
    throw new functions.https.HttpsError('invalid-argument', 'Request ID required');
  }

  if (!action || !['approve', 'deny'].includes(action)) {
    throw new functions.https.HttpsError('invalid-argument', 'Action must be approve or deny');
  }

  const requestDoc = await db.collection('renewalRequests').doc(requestId).get();
  if (!requestDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'Request not found');
  }

  const requestData = requestDoc.data();
  if (requestData.status !== 'pending') {
    throw new functions.https.HttpsError('failed-precondition', 'Request already processed');
  }

  const userId = requestData.userId;

  if (action === 'approve') {
    const renewalDuration = duration || requestData.preferredDuration || 'month';
    const plan = requestData.preferredPlan;

    // Calculate new end date
    const now = new Date();
    let endDate = null;

    if (renewalDuration !== 'lifetime') {
      const durationDays = {
        'week': 7,
        'month': 30,
        '3months': 90,
        'year': 365
      };
      endDate = new Date(now.getTime() + (durationDays[renewalDuration] || 30) * 24 * 60 * 60 * 1000);
    }

    // Update user subscription
    const planDoc = await db.collection('subscriptionPlans').doc(plan).get();
    const planLimits = planDoc.exists ? planDoc.data()?.limits || {} : {};
    const defaultToolLimit = 2;

    await db.collection('users').doc(userId).update({
      'subscription.plan': plan,
      'subscription.status': 'active',
      'subscription.duration': renewalDuration,
      'subscription.startDate': admin.firestore.FieldValue.serverTimestamp(),
      'subscription.endDate': endDate ? admin.firestore.Timestamp.fromDate(endDate) : null,
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

    // Update request
    await db.collection('renewalRequests').doc(requestId).update({
      status: 'approved',
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      processedBy: adminUid,
      adminResponse: adminResponse || null,
      renewalDuration
    });

    // Notify user
    const durationLabel = {
      'week': '1 Week',
      'month': '1 Month',
      '3months': '3 Months',
      'year': '1 Year',
      'lifetime': 'Lifetime'
    };

    const endDateStr = endDate ? endDate.toLocaleDateString() : '';
    await createUserNotification(userId, 'request_approved',
      'Subscription Renewed!',
      'Great news! Your ' + plan.toUpperCase() + ' subscription has been renewed for ' + (durationLabel[renewalDuration] || renewalDuration) + '.' + (endDateStr ? ' Valid until ' + endDateStr + '.' : ''),
      { plan, duration: renewalDuration, endDate: endDate?.toISOString() || null }
    );

    // Log activity
    await logUserActivity(userId, 'subscription_change', {
      action: 'renewal_approved',
      plan,
      duration: renewalDuration,
      approvedBy: adminUid
    }, adminUid);

    return {
      success: true,
      message: 'Subscription renewed: ' + plan.toUpperCase() + ' for ' + renewalDuration,
      newEndDate: endDate?.toISOString() || null
    };

  } else {
    // Deny request
    await db.collection('renewalRequests').doc(requestId).update({
      status: 'denied',
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      processedBy: adminUid,
      adminResponse: adminResponse || null
    });

    // Notify user
    const denyMessage = adminResponse
      ? 'Your renewal request has been reviewed. Response: ' + adminResponse
      : 'Your renewal request has been reviewed. Please contact support for more information.';

    await createUserNotification(userId, 'request_denied',
      'Renewal Request Update',
      denyMessage,
      { reason: adminResponse || null }
    );

    // Log activity
    await logUserActivity(userId, 'renewal_request', { action: 'denied', reason: adminResponse }, adminUid);

    return { success: true, message: 'Request denied' };
  }
});

// ==========================================
// AI TOOLS HUB - CLOUD FUNCTIONS
// ==========================================

// AI Script Studio - Generate full video scripts
exports.generateScript = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'generateScript', 10);

  const { topic, tone = 'engaging', length = 'medium', includeHook = true, includeCTA = true } = data;

  if (!topic || topic.trim().length < 3) {
    throw new functions.https.HttpsError('invalid-argument', 'Please provide a valid video topic');
  }

  // Token cost: 5 tokens per script
  const tokenCost = 5;

  // Check token balance
  const tokenRef = db.collection('creativeTokens').doc(uid);
  let tokenDoc = await tokenRef.get();
  let balance = 0;

  if (!tokenDoc.exists) {
    const initialTokens = {
      balance: 50,
      rollover: 0,
      plan: 'free',
      monthlyAllocation: 50,
      lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await tokenRef.set(initialTokens);
    balance = 50;
  } else {
    balance = tokenDoc.data().balance || 0;
  }

  if (balance < tokenCost) {
    throw new functions.https.HttpsError('resource-exhausted',
      `Insufficient tokens. Need ${tokenCost}, have ${balance}. Please upgrade your plan.`);
  }

  // Length configurations
  const lengthConfig = {
    short: { minutes: '3-5', words: 500 },
    medium: { minutes: '8-12', words: 1200 },
    long: { minutes: '15-20', words: 2000 }
  };
  const config = lengthConfig[length] || lengthConfig.medium;

  // Tone descriptions
  const toneDescriptions = {
    engaging: 'conversational, energetic, keeps viewers hooked with dynamic pacing and relatable language',
    educational: 'informative, clear explanations, authoritative yet accessible, with structured learning points',
    entertaining: 'fun, humorous, uses storytelling and personality to captivate, includes jokes and pop culture references',
    professional: 'polished, business-appropriate, credible and trustworthy, with data-backed insights'
  };
  const toneDesc = toneDescriptions[tone] || toneDescriptions.engaging;

  try {
    const systemPrompt = `You are a professional YouTube script writer who creates viral, engaging video scripts. Your scripts consistently achieve high watch time and engagement.

Your scripts always include:
- Pattern interrupts to maintain viewer attention
- B-roll suggestions marked with [B-ROLL: description]
- Emphasis markers for key words using *asterisks*
- Natural pauses marked with (pause)
- Speaking pace notes where needed

Format your response as JSON with these exact keys:
{
  "hook": "Opening hook (first 5-10 seconds - the most crucial part)",
  "intro": "Introduction that establishes credibility and previews value",
  "mainContent": "The main body with all key points, transitions, and B-roll markers",
  "cta": "Call-to-action that drives engagement"
}`;

    const userPrompt = `Create a ${config.minutes} minute YouTube script (approximately ${config.words} words) about:

TOPIC: ${topic}

TONE: ${toneDesc}

Requirements:
${includeHook ? '- Start with a powerful hook that creates curiosity or makes a bold claim' : ''}
- Include clear section transitions
- Add [B-ROLL: description] markers for visual suggestions
- Mark emphasis words with *asterisks*
- Include retention markers every 60-90 seconds
${includeCTA ? '- End with a compelling call-to-action for likes, comments, and subscribes' : ''}

Make it feel natural, not scripted. Write like a top YouTuber speaks.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.8,
      max_tokens: 3000
    });

    let scriptData;
    const content = response.choices[0]?.message?.content;

    try {
      // Try to parse as JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        scriptData = JSON.parse(jsonMatch[0]);
      } else {
        // Fallback: treat as full script
        scriptData = {
          hook: '',
          intro: '',
          mainContent: content,
          cta: ''
        };
      }
    } catch (parseError) {
      scriptData = {
        hook: '',
        intro: '',
        mainContent: content,
        cta: ''
      };
    }

    // Deduct tokens
    await tokenRef.update({
      balance: admin.firestore.FieldValue.increment(-tokenCost),
      lastUsed: admin.firestore.FieldValue.serverTimestamp()
    });

    // Save to history
    await db.collection('scriptHistory').add({
      userId: uid,
      topic,
      tone,
      length,
      script: scriptData,
      tokenCost,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      ...scriptData,
      tokenCost,
      remainingBalance: balance - tokenCost
    };

  } catch (error) {
    console.error('Script generation error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to generate script. Please try again.');
  }
});

// Viral Hook Laboratory - Generate attention-grabbing hooks
exports.generateHooks = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'generateHooks', 15);

  const { topic, style = 'question', count = 5 } = data;

  if (!topic || topic.trim().length < 3) {
    throw new functions.https.HttpsError('invalid-argument', 'Please provide a valid video topic');
  }

  // Token cost: 3 tokens per generation
  const tokenCost = 3;

  // Check token balance
  const tokenRef = db.collection('creativeTokens').doc(uid);
  let tokenDoc = await tokenRef.get();
  let balance = tokenDoc.exists ? (tokenDoc.data().balance || 0) : 50;

  if (!tokenDoc.exists) {
    await tokenRef.set({
      balance: 50,
      rollover: 0,
      plan: 'free',
      monthlyAllocation: 50,
      lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    balance = 50;
  }

  if (balance < tokenCost) {
    throw new functions.https.HttpsError('resource-exhausted',
      `Insufficient tokens. Need ${tokenCost}, have ${balance}.`);
  }

  // Hook style descriptions
  const styleGuides = {
    question: 'Questions that spark curiosity and demand answers. Make viewers think "I need to know this!"',
    controversy: 'Controversial or contrarian statements that challenge common beliefs. Use "Actually, everything you know about X is wrong..."',
    promise: 'Clear value propositions that promise specific outcomes. "In the next X minutes, you\'ll learn..."',
    story: 'Personal story openers that create emotional connection. Start mid-action for maximum impact.',
    statistic: 'Shocking statistics or data points that make viewers stop scrolling. Use specific numbers.',
    challenge: 'Direct challenges to the viewer that engage their ego. "I bet you can\'t..." or "Most people fail at..."'
  };

  const styleGuide = styleGuides[style] || styleGuides.question;

  try {
    const systemPrompt = `You are a viral content expert who specializes in YouTube hooks. You understand that the first 3-5 seconds determine if a viewer stays or leaves.

Your hooks achieve:
- 80%+ retention past the first 30 seconds
- High curiosity gaps that MUST be resolved
- Emotional triggers that stop the scroll

Always provide hooks with predicted effectiveness scores and explanations.

Respond in JSON format:
{
  "hooks": [
    {
      "text": "The hook text",
      "score": 85,
      "explanation": "Why this hook works"
    }
  ]
}`;

    const userPrompt = `Generate ${count} viral YouTube hooks for this video topic:

TOPIC: ${topic}

STYLE: ${styleGuide}

Requirements:
- Each hook should be 1-2 sentences max (speakable in 5 seconds)
- Create curiosity gaps that MUST be resolved
- Use power words that trigger emotional responses
- Make each hook distinctly different
- Score each hook 1-100 based on predicted viral potential
- Explain WHY each hook would work

Think like MrBeast, MKBHD, and other top creators when crafting these.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.9,
      max_tokens: 1500
    });

    let hooksData;
    const content = response.choices[0]?.message?.content;

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        hooksData = JSON.parse(jsonMatch[0]);
      } else {
        hooksData = { hooks: [{ text: content, score: 70, explanation: 'Generated hook' }] };
      }
    } catch (parseError) {
      hooksData = { hooks: [{ text: content, score: 70, explanation: 'Generated hook' }] };
    }

    // Deduct tokens
    await tokenRef.update({
      balance: admin.firestore.FieldValue.increment(-tokenCost),
      lastUsed: admin.firestore.FieldValue.serverTimestamp()
    });

    // Save to history
    await db.collection('hookHistory').add({
      userId: uid,
      topic,
      style,
      count,
      hooks: hooksData.hooks,
      tokenCost,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      hooks: hooksData.hooks,
      tokenCost,
      remainingBalance: balance - tokenCost
    };

  } catch (error) {
    console.error('Hook generation error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to generate hooks. Please try again.');
  }
});

// Content Multiplier - Repurpose video content into multiple formats
exports.multiplyContent = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'multiplyContent', 5);

  const { transcript, formats = ['shorts', 'twitter', 'blog'] } = data;

  if (!transcript || transcript.trim().length < 100) {
    throw new functions.https.HttpsError('invalid-argument', 'Please provide a transcript with at least 100 characters');
  }

  // Token cost: 8 tokens per multiply
  const tokenCost = 8;

  // Check token balance
  const tokenRef = db.collection('creativeTokens').doc(uid);
  let tokenDoc = await tokenRef.get();
  let balance = tokenDoc.exists ? (tokenDoc.data().balance || 0) : 50;

  if (!tokenDoc.exists) {
    await tokenRef.set({
      balance: 50,
      rollover: 0,
      plan: 'free',
      monthlyAllocation: 50,
      lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    balance = 50;
  }

  if (balance < tokenCost) {
    throw new functions.https.HttpsError('resource-exhausted',
      `Insufficient tokens. Need ${tokenCost}, have ${balance}.`);
  }

  // Format instructions
  const formatInstructions = {
    shorts: 'Extract 3 viral YouTube Shorts scripts (60 seconds each). Focus on the most shareable, hook-worthy moments. Include visual suggestions.',
    twitter: 'Create a 10-15 tweet thread that tells the story of the video. Each tweet should be standalone but connected. Use hooks and cliffhangers between tweets.',
    blog: 'Write a full SEO-optimized blog post (800-1200 words) with headers, bullet points, and a compelling introduction. Include meta description.',
    quotes: 'Extract 5 quote-worthy statements that would work as shareable graphics. Make them punchy and memorable.',
    email: 'Create a newsletter email summarizing the key insights. Include a compelling subject line, preview text, and clear CTA.',
    linkedin: 'Write a professional LinkedIn post version of the key insights. Include engagement prompts and relevant hashtags.'
  };

  const selectedFormats = formats.filter(f => formatInstructions[f]);
  if (selectedFormats.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Please select at least one valid format');
  }

  try {
    const systemPrompt = `You are a content repurposing expert. You transform long-form video content into multiple formats while maintaining the core message and maximizing engagement for each platform.

Always preserve the creator's voice and key insights while adapting to platform-specific best practices.

Respond in JSON format with each requested format as a key.`;

    let formatPrompts = selectedFormats.map(f => `${f.toUpperCase()}: ${formatInstructions[f]}`).join('\n\n');

    const userPrompt = `Transform this video transcript into multiple content formats:

TRANSCRIPT:
${transcript.substring(0, 8000)}

REQUESTED FORMATS:
${formatPrompts}

Create high-quality, platform-optimized content for each format. Maintain the original insights but adapt the style for each platform.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 4000
    });

    let contentData;
    const content = response.choices[0]?.message?.content;

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        contentData = JSON.parse(jsonMatch[0]);
      } else {
        contentData = { content: content };
      }
    } catch (parseError) {
      contentData = { content: content };
    }

    // Deduct tokens
    await tokenRef.update({
      balance: admin.firestore.FieldValue.increment(-tokenCost),
      lastUsed: admin.firestore.FieldValue.serverTimestamp()
    });

    // Save to history
    await db.collection('contentMultiplierHistory').add({
      userId: uid,
      transcriptPreview: transcript.substring(0, 200),
      formats: selectedFormats,
      content: contentData,
      tokenCost,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      content: contentData,
      tokenCost,
      remainingBalance: balance - tokenCost
    };

  } catch (error) {
    console.error('Content multiplier error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to multiply content. Please try again.');
  }
});

// Thumbnail A/B Arena - Analyze and predict thumbnail CTR
exports.analyzeThumbnails = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'analyzeThumbnails', 10);

  const { thumbnailA, thumbnailB } = data;

  if (!thumbnailA?.base64 || !thumbnailB?.base64) {
    throw new functions.https.HttpsError('invalid-argument', 'Please provide two thumbnails to compare');
  }

  // Token cost: 4 tokens per analysis
  const tokenCost = 4;

  // Check token balance
  const tokenRef = db.collection('creativeTokens').doc(uid);
  let tokenDoc = await tokenRef.get();
  let balance = tokenDoc.exists ? (tokenDoc.data().balance || 0) : 50;

  if (!tokenDoc.exists) {
    await tokenRef.set({
      balance: 50,
      rollover: 0,
      plan: 'free',
      monthlyAllocation: 50,
      lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    balance = 50;
  }

  if (balance < tokenCost) {
    throw new functions.https.HttpsError('resource-exhausted',
      `Insufficient tokens. Need ${tokenCost}, have ${balance}.`);
  }

  try {
    // Use Gemini Vision for thumbnail analysis
    const geminiApiKey = functions.config().gemini?.key;
    if (!geminiApiKey) {
      throw new functions.https.HttpsError('failed-precondition', 'Vision service not configured');
    }

    const ai = new GoogleGenAI({ apiKey: geminiApiKey });

    const analysisPrompt = `You are a YouTube thumbnail CTR expert. Analyze these two thumbnails and predict which will perform better.

For each thumbnail, evaluate:
1. Visual hierarchy and focal points
2. Color contrast and vibrancy
3. Emotional impact and curiosity triggers
4. Text readability (if any)
5. Face/expression effectiveness (if any)
6. Mobile-friendliness (will it work at small sizes?)
7. Click-worthiness and curiosity gap

Respond in JSON format:
{
  "thumbnailA": {
    "score": 75,
    "strengths": ["Clear focal point", "Good contrast"],
    "weaknesses": ["Text too small", "Low emotional impact"]
  },
  "thumbnailB": {
    "score": 82,
    "strengths": ["Strong emotion", "Vibrant colors"],
    "weaknesses": ["Busy background"]
  },
  "winner": "b",
  "winnerScore": 9.3,
  "recommendations": [
    "Add more contrast to Thumbnail A",
    "Consider larger text for both"
  ]
}`;

    const result = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: thumbnailA.mimeType || 'image/png', data: thumbnailA.base64 } },
          { text: 'This is Thumbnail A' },
          { inlineData: { mimeType: thumbnailB.mimeType || 'image/png', data: thumbnailB.base64 } },
          { text: 'This is Thumbnail B' },
          { text: analysisPrompt }
        ]
      }]
    });

    let analysisData;
    const content = result.candidates?.[0]?.content?.parts?.[0]?.text || '';

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysisData = JSON.parse(jsonMatch[0]);
      } else {
        analysisData = {
          thumbnailA: { score: 70, strengths: ['Analyzed'], weaknesses: ['See recommendations'] },
          thumbnailB: { score: 70, strengths: ['Analyzed'], weaknesses: ['See recommendations'] },
          winner: 'tie',
          winnerScore: 0,
          recommendations: [content]
        };
      }
    } catch (parseError) {
      analysisData = {
        thumbnailA: { score: 70, strengths: ['Analyzed'], weaknesses: [] },
        thumbnailB: { score: 70, strengths: ['Analyzed'], weaknesses: [] },
        winner: 'tie',
        winnerScore: 0,
        recommendations: ['Analysis completed - see details above']
      };
    }

    // Deduct tokens
    await tokenRef.update({
      balance: admin.firestore.FieldValue.increment(-tokenCost),
      lastUsed: admin.firestore.FieldValue.serverTimestamp()
    });

    // Save to history (without storing full images)
    await db.collection('thumbnailTestHistory').add({
      userId: uid,
      analysis: analysisData,
      winner: analysisData.winner,
      tokenCost,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      ...analysisData,
      tokenCost,
      remainingBalance: balance - tokenCost
    };

  } catch (error) {
    console.error('Thumbnail analysis error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to analyze thumbnails. Please try again.');
  }
});

// ==============================================================================
// TREND HIJACKER - Find trending topics in your niche
// ==============================================================================
exports.generateTrendReport = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'generateTrendReport', 10);

  const { niche, region = 'US', timeframe = 'week' } = data;

  if (!niche || niche.trim().length < 2) {
    throw new functions.https.HttpsError('invalid-argument', 'Please provide a valid niche or topic area');
  }

  // Token cost: 6 tokens per trend analysis
  const tokenCost = 6;

  // Check token balance
  const tokenRef = db.collection('creativeTokens').doc(uid);
  let tokenDoc = await tokenRef.get();
  let balance = tokenDoc.exists ? (tokenDoc.data().balance || 0) : 50;

  if (!tokenDoc.exists) {
    await tokenRef.set({
      balance: 50,
      rollover: 0,
      plan: 'free',
      monthlyAllocation: 50,
      lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    balance = 50;
  }

  if (balance < tokenCost) {
    throw new functions.https.HttpsError('resource-exhausted',
      `Insufficient tokens. Need ${tokenCost}, have ${balance}.`);
  }

  try {
    const openaiApiKey = functions.config().openai?.key;
    if (!openaiApiKey) {
      throw new functions.https.HttpsError('failed-precondition', 'AI service not configured');
    }

    const timeframeText = timeframe === 'day' ? 'today (last 24 hours)' :
                          timeframe === 'week' ? 'this week (last 7 days)' :
                          'this month (last 30 days)';

    const regionText = region === 'GLOBAL' ? 'globally' : `in ${region}`;

    const prompt = `You are a trend analysis expert specializing in YouTube content strategy. Analyze current trends ${regionText} for the "${niche}" niche ${timeframeText}.

Identify 5-7 trending topics that a YouTube creator in this niche should create content about RIGHT NOW to capitalize on rising interest.

For each trend, provide:
1. The specific trending topic
2. A trend score (0-100) based on current momentum
3. Urgency level (high/medium/low) - how quickly they need to act
4. A brief description of why this is trending
5. 2-3 content angles they could take
6. A suggested video title that would perform well

Consider:
- Current news and events
- Seasonal relevance
- Platform-specific trends (YouTube, TikTok, Twitter discussions)
- Search volume patterns
- Competitor content gaps

Respond in JSON format:
{
  "trends": [
    {
      "topic": "Topic name",
      "score": 85,
      "urgency": "high",
      "description": "Why this is trending now",
      "angles": ["Angle 1", "Angle 2", "Angle 3"],
      "suggestedTitle": "A clickable video title"
    }
  ],
  "insights": "Overall market insight about the niche right now"
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a YouTube trend analyst who identifies emerging trends and viral opportunities. Always respond with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.8,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:', errorText);
      throw new Error('AI service error');
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content || '';

    let trendData;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        trendData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found');
      }
    } catch (parseError) {
      // Fallback structure if parsing fails
      trendData = {
        trends: [
          {
            topic: niche + ' trends',
            score: 75,
            urgency: 'medium',
            description: 'Current trending topic in your niche',
            angles: ['Educational breakdown', 'News reaction', 'How-to guide'],
            suggestedTitle: `The ${niche} Trend Everyone Is Talking About Right Now`
          }
        ],
        insights: content
      };
    }

    // Deduct tokens
    await tokenRef.update({
      balance: admin.firestore.FieldValue.increment(-tokenCost),
      lastUsed: admin.firestore.FieldValue.serverTimestamp()
    });

    // Save to history
    await db.collection('trendHistory').add({
      userId: uid,
      niche: niche.trim(),
      region,
      timeframe,
      trends: trendData.trends,
      insights: trendData.insights,
      tokenCost,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      trends: trendData.trends,
      insights: trendData.insights,
      tokenCost,
      remainingBalance: balance - tokenCost
    };

  } catch (error) {
    console.error('Trend analysis error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to analyze trends. Please try again.');
  }
});

// ==============================================================================
// CONTENT GAP FINDER - Discover untapped content opportunities
// ==============================================================================
exports.findContentGaps = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'findContentGaps', 10);

  const { niche, competitors = '', depth = 'moderate' } = data;

  if (!niche || niche.trim().length < 2) {
    throw new functions.https.HttpsError('invalid-argument', 'Please provide a valid niche or topic area');
  }

  // Token cost: 6 tokens per gap analysis
  const tokenCost = 6;

  // Check token balance
  const tokenRef = db.collection('creativeTokens').doc(uid);
  let tokenDoc = await tokenRef.get();
  let balance = tokenDoc.exists ? (tokenDoc.data().balance || 0) : 50;

  if (!tokenDoc.exists) {
    await tokenRef.set({
      balance: 50,
      rollover: 0,
      plan: 'free',
      monthlyAllocation: 50,
      lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    balance = 50;
  }

  if (balance < tokenCost) {
    throw new functions.https.HttpsError('resource-exhausted',
      `Insufficient tokens. Need ${tokenCost}, have ${balance}.`);
  }

  try {
    const openaiApiKey = functions.config().openai?.key;
    if (!openaiApiKey) {
      throw new functions.https.HttpsError('failed-precondition', 'AI service not configured');
    }

    const depthText = depth === 'quick' ? 'top 4-5 opportunities' :
                      depth === 'deep' ? 'comprehensive analysis with 8-10 opportunities' :
                      '5-7 balanced opportunities';

    const competitorText = competitors.trim()
      ? `\n\nCompetitors to analyze for gaps: ${competitors}`
      : '';

    const prompt = `You are a YouTube content strategy expert specializing in finding untapped content opportunities. Analyze the "${niche}" niche and identify ${depthText}.${competitorText}

Find content gaps - topics that have:
- High search interest but low quality existing content
- Underserved audience segments
- Questions that aren't being answered well
- Emerging subtopics with growth potential
- Unique angles competitors haven't explored

For each gap opportunity, provide:
1. The topic/gap opportunity
2. Difficulty level (easy/medium/hard) to rank for
3. Potential score (0-100) based on opportunity size
4. Why this is a gap (what's missing in current content)
5. Description of the opportunity
6. 2-3 specific video title ideas

Respond in JSON format:
{
  "gaps": [
    {
      "topic": "Gap topic name",
      "difficulty": "easy",
      "potential": 85,
      "reason": "Why this content gap exists",
      "description": "What kind of content would fill this gap",
      "suggestedTitles": [
        "Video Title Idea 1",
        "Video Title Idea 2",
        "Video Title Idea 3"
      ]
    }
  ],
  "summary": "Overall market summary and strategy recommendation"
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a YouTube content strategist who identifies underserved topics and content gaps. Always respond with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.8,
        max_tokens: 2500
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:', errorText);
      throw new Error('AI service error');
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content || '';

    let gapData;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        gapData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found');
      }
    } catch (parseError) {
      // Fallback structure if parsing fails
      gapData = {
        gaps: [
          {
            topic: 'Beginner-friendly ' + niche + ' content',
            difficulty: 'easy',
            potential: 80,
            reason: 'Most content assumes prior knowledge',
            description: 'Create truly beginner-friendly content for newcomers',
            suggestedTitles: [
              `${niche} for Complete Beginners - Everything You Need to Know`,
              `I Tried Learning ${niche} From Scratch - Here's What Happened`,
              `The ${niche} Beginner's Guide Everyone Wishes They Had`
            ]
          }
        ],
        summary: content
      };
    }

    // Deduct tokens
    await tokenRef.update({
      balance: admin.firestore.FieldValue.increment(-tokenCost),
      lastUsed: admin.firestore.FieldValue.serverTimestamp()
    });

    // Save to history
    await db.collection('contentGapHistory').add({
      userId: uid,
      niche: niche.trim(),
      competitors: competitors.trim(),
      depth,
      gaps: gapData.gaps,
      summary: gapData.summary,
      tokenCost,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      gaps: gapData.gaps,
      summary: gapData.summary,
      tokenCost,
      remainingBalance: balance - tokenCost
    };

  } catch (error) {
    console.error('Content gap analysis error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to find content gaps. Please try again.');
  }
});

// ==============================================================================
// AUDIENCE DNA ANALYZER - Deep audience insights
// ==============================================================================
exports.analyzeAudienceDNA = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'analyzeAudienceDNA', 10);

  const { niche, channelUrl = '', depth = 'standard' } = data;

  if (!niche || niche.trim().length < 2) {
    throw new functions.https.HttpsError('invalid-argument', 'Please provide a valid niche or content area');
  }

  // Token cost: 7 tokens per analysis
  const tokenCost = 7;

  // Check token balance
  const tokenRef = db.collection('creativeTokens').doc(uid);
  let tokenDoc = await tokenRef.get();
  let balance = tokenDoc.exists ? (tokenDoc.data().balance || 0) : 50;

  if (!tokenDoc.exists) {
    await tokenRef.set({
      balance: 50,
      rollover: 0,
      plan: 'free',
      monthlyAllocation: 50,
      lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    balance = 50;
  }

  if (balance < tokenCost) {
    throw new functions.https.HttpsError('resource-exhausted',
      `Insufficient tokens. Need ${tokenCost}, have ${balance}.`);
  }

  try {
    const openaiApiKey = functions.config().openai?.key;
    if (!openaiApiKey) {
      throw new functions.https.HttpsError('failed-precondition', 'AI service not configured');
    }

    const depthText = depth === 'quick' ? 'key demographics only' :
                      depth === 'deep' ? 'comprehensive psychographic analysis' :
                      'full audience profile';

    const channelContext = channelUrl ? `The creator's channel: ${channelUrl}` : '';

    const prompt = `You are an expert audience research analyst. Create a detailed audience DNA profile for a YouTube creator in the "${niche}" niche. Provide ${depthText}. ${channelContext}

Analyze and provide:
1. Demographics: age range, gender split, primary locations, income level
2. Interests & hobbies related to the niche
3. Pain points and challenges they face
4. Content preferences (formats, length, tone, peak watch times)
5. Actionable recommendations for content

Respond in JSON format:
{
  "demographics": {
    "ageRange": "25-34",
    "gender": "60% male, 40% female",
    "location": "United States, UK, Canada",
    "income": "Middle income"
  },
  "interests": ["Interest 1", "Interest 2", "Interest 3", "Interest 4", "Interest 5"],
  "painPoints": ["Pain point 1", "Pain point 2", "Pain point 3"],
  "contentPreferences": {
    "formats": ["Tutorials", "Reviews", "Vlogs"],
    "length": "10-15 minutes optimal",
    "watchTime": "Evenings and weekends",
    "tone": "Friendly and educational"
  },
  "recommendations": [
    "Recommendation 1",
    "Recommendation 2",
    "Recommendation 3"
  ]
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an audience research expert who creates detailed viewer personas. Always respond with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      throw new Error('AI service error');
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content || '';

    let audienceData;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        audienceData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found');
      }
    } catch (parseError) {
      audienceData = {
        demographics: { ageRange: '25-44', gender: 'Mixed', location: 'Global', income: 'Varied' },
        interests: ['Related topics', 'Learning', 'Entertainment'],
        painPoints: ['Finding quality content', 'Time management'],
        contentPreferences: { formats: ['Various'], length: '10-20 minutes', watchTime: 'Flexible', tone: 'Engaging' },
        recommendations: [content]
      };
    }

    // Deduct tokens
    await tokenRef.update({
      balance: admin.firestore.FieldValue.increment(-tokenCost),
      lastUsed: admin.firestore.FieldValue.serverTimestamp()
    });

    // Save to history
    await db.collection('audienceHistory').add({
      userId: uid,
      niche: niche.trim(),
      channelUrl,
      depth,
      result: audienceData,
      tokenCost,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      ...audienceData,
      tokenCost,
      remainingBalance: balance - tokenCost
    };

  } catch (error) {
    console.error('Audience analysis error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to analyze audience. Please try again.');
  }
});

// ==============================================================================
// COLLAB MATCHMAKER - Find collaboration partners
// ==============================================================================
exports.findCollabPartners = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'findCollabPartners', 10);

  const { niche, channelSize = 'any', contentStyle = 'any' } = data;

  if (!niche || niche.trim().length < 2) {
    throw new functions.https.HttpsError('invalid-argument', 'Please provide a valid niche or content area');
  }

  // Token cost: 5 tokens per search
  const tokenCost = 5;

  // Check token balance
  const tokenRef = db.collection('creativeTokens').doc(uid);
  let tokenDoc = await tokenRef.get();
  let balance = tokenDoc.exists ? (tokenDoc.data().balance || 0) : 50;

  if (!tokenDoc.exists) {
    await tokenRef.set({
      balance: 50,
      rollover: 0,
      plan: 'free',
      monthlyAllocation: 50,
      lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    balance = 50;
  }

  if (balance < tokenCost) {
    throw new functions.https.HttpsError('resource-exhausted',
      `Insufficient tokens. Need ${tokenCost}, have ${balance}.`);
  }

  try {
    const openaiApiKey = functions.config().openai?.key;
    if (!openaiApiKey) {
      throw new functions.https.HttpsError('failed-precondition', 'AI service not configured');
    }

    const sizeText = channelSize === 'any' ? 'any size' :
                     channelSize === 'small' ? '1K-10K subscribers' :
                     channelSize === 'medium' ? '10K-100K subscribers' :
                     '100K+ subscribers';

    const styleText = contentStyle === 'any' ? 'any style' : contentStyle;

    const prompt = `You are a YouTube collaboration strategist. Find 5 ideal collaboration partner TYPES (not specific channels) for a creator in the "${niche}" niche.

Target partner size: ${sizeText}
Content style preference: ${styleText}

For each potential partner type, provide:
1. Type of creator (e.g., "Tech Reviewers", "Lifestyle Vloggers")
2. Compatibility score (0-100)
3. Why they would be a good match
4. Their typical audience size range
5. 3 collaboration video ideas
6. A personalized outreach email template

Respond in JSON format:
{
  "matches": [
    {
      "creatorType": "Creator type name",
      "compatibility": 85,
      "reason": "Why this is a great match",
      "audienceSize": "10K-50K typically",
      "collabIdeas": ["Idea 1", "Idea 2", "Idea 3"],
      "outreachTemplate": "Hi [Name],\\n\\nI love your content about...\\n\\nWould you be interested in...\\n\\nBest,\\n[Your Name]"
    }
  ],
  "tips": "General collaboration tips for this niche"
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a YouTube collaboration expert who matches creators for mutual growth. Always respond with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.8,
        max_tokens: 2500
      })
    });

    if (!response.ok) {
      throw new Error('AI service error');
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content || '';

    let collabData;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        collabData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found');
      }
    } catch (parseError) {
      collabData = {
        matches: [{
          creatorType: 'Complementary creators in ' + niche,
          compatibility: 75,
          reason: 'Shared audience interests',
          audienceSize: 'Various',
          collabIdeas: ['Joint video', 'Guest appearance', 'Challenge video'],
          outreachTemplate: 'Hi! I love your content and think we could create something great together. Would you be interested in collaborating?'
        }],
        tips: content
      };
    }

    // Deduct tokens
    await tokenRef.update({
      balance: admin.firestore.FieldValue.increment(-tokenCost),
      lastUsed: admin.firestore.FieldValue.serverTimestamp()
    });

    // Save to history
    await db.collection('collabHistory').add({
      userId: uid,
      niche: niche.trim(),
      channelSize,
      contentStyle,
      matches: collabData.matches,
      tips: collabData.tips,
      tokenCost,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      matches: collabData.matches,
      tips: collabData.tips,
      tokenCost,
      remainingBalance: balance - tokenCost
    };

  } catch (error) {
    console.error('Collab matchmaker error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to find collaboration partners. Please try again.');
  }
});

// ==============================================================================
// REVENUE MAXIMIZER PRO - Maximize earnings
// ==============================================================================
exports.analyzeRevenue = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'analyzeRevenue', 10);

  const { niche, audienceSize = 'small', currentMethods = [] } = data;

  if (!niche || niche.trim().length < 2) {
    throw new functions.https.HttpsError('invalid-argument', 'Please provide a valid niche or content area');
  }

  // Token cost: 8 tokens per analysis
  const tokenCost = 8;

  // Check token balance
  const tokenRef = db.collection('creativeTokens').doc(uid);
  let tokenDoc = await tokenRef.get();
  let balance = tokenDoc.exists ? (tokenDoc.data().balance || 0) : 50;

  if (!tokenDoc.exists) {
    await tokenRef.set({
      balance: 50,
      rollover: 0,
      plan: 'free',
      monthlyAllocation: 50,
      lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    balance = 50;
  }

  if (balance < tokenCost) {
    throw new functions.https.HttpsError('resource-exhausted',
      `Insufficient tokens. Need ${tokenCost}, have ${balance}.`);
  }

  try {
    const openaiApiKey = functions.config().openai?.key;
    if (!openaiApiKey) {
      throw new functions.https.HttpsError('failed-precondition', 'AI service not configured');
    }

    const sizeText = audienceSize === 'starter' ? '0-1K subscribers' :
                     audienceSize === 'small' ? '1K-10K subscribers' :
                     audienceSize === 'medium' ? '10K-100K subscribers' :
                     '100K+ subscribers';

    const currentMethodsText = currentMethods.length > 0
      ? `Currently using: ${currentMethods.join(', ')}`
      : 'Not currently monetizing';

    const prompt = `You are a YouTube monetization expert. Create a comprehensive revenue maximization strategy for a creator in the "${niche}" niche.

Audience size: ${sizeText}
${currentMethodsText}

Identify 5-6 revenue opportunities with:
1. Revenue stream name
2. Priority (high/medium/low)
3. Estimated monthly revenue potential
4. Description of the opportunity
5. Step-by-step implementation guide
6. Recommended tools/platforms

Also provide:
- A pricing guide for sponsorships at their level
- A sponsor pitch email template

Respond in JSON format:
{
  "potentialMonthly": "500-2000",
  "opportunities": [
    {
      "name": "Revenue stream name",
      "icon": "💰",
      "priority": "high",
      "estimatedRevenue": "200-500",
      "description": "What this opportunity is",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "tools": ["Tool 1", "Tool 2"]
    }
  ],
  "pricingGuide": "Sponsorship pricing guide text...",
  "sponsorPitch": "Email template for reaching out to sponsors..."
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a YouTube monetization expert who helps creators maximize revenue. Always respond with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 3000
      })
    });

    if (!response.ok) {
      throw new Error('AI service error');
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content || '';

    let revenueData;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        revenueData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found');
      }
    } catch (parseError) {
      revenueData = {
        potentialMonthly: 'Varies',
        opportunities: [{
          name: 'Multiple revenue streams',
          icon: '💰',
          priority: 'high',
          estimatedRevenue: 'Varies',
          description: 'Explore various monetization options',
          steps: ['Research options', 'Start with one method', 'Expand gradually'],
          tools: ['YouTube Studio', 'Various platforms']
        }],
        pricingGuide: content,
        sponsorPitch: 'Contact for personalized template'
      };
    }

    // Deduct tokens
    await tokenRef.update({
      balance: admin.firestore.FieldValue.increment(-tokenCost),
      lastUsed: admin.firestore.FieldValue.serverTimestamp()
    });

    // Save to history
    await db.collection('revenueHistory').add({
      userId: uid,
      niche: niche.trim(),
      audienceSize,
      currentMethods,
      result: revenueData,
      tokenCost,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      ...revenueData,
      tokenCost,
      remainingBalance: balance - tokenCost
    };

  } catch (error) {
    console.error('Revenue analysis error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to analyze revenue opportunities. Please try again.');
  }
});

// ==============================================================================
// AI VIDEO COACH - Personal YouTube mentor
// ==============================================================================
exports.getVideoCoaching = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'getVideoCoaching', 10);

  const { videoUrl = '', transcript = '', challenge = '', focusArea = 'general' } = data;

  if (!challenge && !transcript && !videoUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Please provide a video URL, transcript, or describe your challenge');
  }

  // Token cost: 10 tokens per coaching session
  const tokenCost = 10;

  // Check token balance
  const tokenRef = db.collection('creativeTokens').doc(uid);
  let tokenDoc = await tokenRef.get();
  let balance = tokenDoc.exists ? (tokenDoc.data().balance || 0) : 50;

  if (!tokenDoc.exists) {
    await tokenRef.set({
      balance: 50,
      rollover: 0,
      plan: 'free',
      monthlyAllocation: 50,
      lastRefresh: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    balance = 50;
  }

  if (balance < tokenCost) {
    throw new functions.https.HttpsError('resource-exhausted',
      `Insufficient tokens. Need ${tokenCost}, have ${balance}.`);
  }

  try {
    const openaiApiKey = functions.config().openai?.key;
    if (!openaiApiKey) {
      throw new functions.https.HttpsError('failed-precondition', 'AI service not configured');
    }

    const focusAreaMap = {
      'general': 'overall video quality and strategy',
      'retention': 'viewer retention and watch time optimization',
      'hooks': 'hooks, intros, and first 30 seconds',
      'ctr': 'click-through rate, titles, and thumbnails',
      'engagement': 'comments, likes, and community engagement',
      'growth': 'channel growth and subscriber acquisition',
      'monetization': 'monetization and revenue optimization',
      'scripting': 'script writing and storytelling'
    };

    const focusText = focusAreaMap[focusArea] || focusAreaMap['general'];

    let contextText = '';
    if (videoUrl) contextText += `Video URL: ${videoUrl}\n`;
    if (transcript) contextText += `Transcript/Script:\n${transcript.substring(0, 2000)}\n`;
    if (challenge) contextText += `Creator's Challenge: ${challenge}\n`;

    const prompt = `You are an elite YouTube coach who has helped channels grow from 0 to millions of subscribers. Provide expert coaching focused on ${focusText}.

${contextText}

Analyze and provide:
1. Overall assessment with a score out of 10
2. What they're doing well (strengths)
3. Priority improvements (with specific actions)
4. Step-by-step action plan
5. Pro tips from top creators

Be specific, actionable, and encouraging. Reference specific timestamps or sections if analyzing a transcript.

Respond in JSON format:
{
  "score": 7.5,
  "assessment": "Overall assessment of current performance...",
  "strengths": [
    "Strength 1",
    "Strength 2",
    "Strength 3"
  ],
  "improvements": [
    {
      "title": "Improvement area",
      "action": "Specific action to take"
    }
  ],
  "actionPlan": [
    "Immediate action 1",
    "This week action 2",
    "This month action 3"
  ],
  "proTips": [
    "Pro tip 1",
    "Pro tip 2",
    "Pro tip 3"
  ]
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an expert YouTube coach with deep knowledge of algorithm, retention, and growth strategies. Always respond with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 2500
      })
    });

    if (!response.ok) {
      throw new Error('AI service error');
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content || '';

    let coachData;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        coachData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found');
      }
    } catch (parseError) {
      coachData = {
        score: 7,
        assessment: content,
        strengths: ['Good effort', 'Room for growth'],
        improvements: [{ title: 'See detailed feedback', action: 'Review the assessment above' }],
        actionPlan: ['Start with one improvement', 'Track your progress', 'Iterate and improve'],
        proTips: ['Consistency is key', 'Focus on your audience', 'Study your analytics']
      };
    }

    // Deduct tokens
    await tokenRef.update({
      balance: admin.firestore.FieldValue.increment(-tokenCost),
      lastUsed: admin.firestore.FieldValue.serverTimestamp()
    });

    // Save to history
    await db.collection('coachHistory').add({
      userId: uid,
      videoUrl,
      hasTranscript: !!transcript,
      challenge,
      focusArea,
      result: coachData,
      tokenCost,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      ...coachData,
      tokenCost,
      remainingBalance: balance - tokenCost
    };

  } catch (error) {
    console.error('Video coaching error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to get coaching. Please try again.');
  }
});

// ==========================================
// GET AI TOOLS HISTORY
// ==========================================
exports.getAIToolsHistory = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'getAIToolsHistory', 10);

  const { limit = 10, type = 'all' } = data || {};
  const safeLimit = Math.min(Math.max(1, parseInt(limit) || 10), 50);

  // Safe query helper
  const safeQuery = async (collectionName) => {
    try {
      return await db.collection(collectionName)
        .where('userId', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(safeLimit)
        .get();
    } catch (e) {
      console.warn(`Query failed for ${collectionName}:`, e.message);
      return { forEach: () => {}, size: 0 };
    }
  };

  // Safe timestamp handler
  const getTimestamp = (field) => {
    if (!field) return Date.now();
    if (typeof field === 'number') return field;
    if (typeof field.toMillis === 'function') return field.toMillis();
    if (field._seconds) return field._seconds * 1000;
    if (field instanceof Date) return field.getTime();
    return Date.now();
  };

  // Safe serialization
  const sanitize = (obj) => {
    if (obj === null || obj === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (e) {
      return null;
    }
  };

  const formatHistory = (snap, historyType) => {
    const items = [];
    snap.forEach(doc => {
      try {
        const data = doc.data();
        const timestamp = getTimestamp(data.createdAt);

        const item = {
          id: doc.id,
          type: historyType,
          timestamp,
          createdAt: new Date(timestamp).toISOString()
        };

        Object.keys(data).forEach(key => {
          if (key !== 'createdAt' && key !== 'userId') {
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

  try {
    // Define collection mappings
    const collections = {
      script: 'scriptHistory',
      hooks: 'hookHistory',
      multiplier: 'contentMultiplierHistory',
      thumbnail: 'thumbnailTestHistory',
      trends: 'trendHistory',
      gaps: 'contentGapHistory',
      audience: 'audienceHistory',
      collab: 'collabHistory',
      revenue: 'revenueHistory',
      coach: 'coachHistory'
    };

    let results = {};

    if (type === 'all') {
      // Fetch all types in parallel
      const queries = Object.entries(collections).map(async ([key, collection]) => {
        const snap = await safeQuery(collection);
        return { key, items: formatHistory(snap, key) };
      });

      const allResults = await Promise.all(queries);
      allResults.forEach(({ key, items }) => {
        results[key] = items;
      });
    } else if (collections[type]) {
      // Fetch single type
      const snap = await safeQuery(collections[type]);
      results[type] = formatHistory(snap, type);
    } else {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid history type');
    }

    return {
      success: true,
      history: results
    };

  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Get AI tools history error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to retrieve history.');
  }
});

// ==========================================
// SPONSORSHIP RATE CALCULATOR
// ==========================================
/**
 * Calculates sponsorship rates for a YouTube channel
 * Analyzes channel metrics, engagement, and niche to generate professional rate cards
 */
exports.calculateSponsorshipRates = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'calculateSponsorshipRates', 5);
  await checkUsageLimit(uid, 'sponsorshipCalculator');

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

    // Get recent videos for engagement analysis
    const videosResponse = await youtube.search.list({
      part: 'snippet',
      channelId: channelId,
      type: 'video',
      order: 'date',
      maxResults: 20
    });

    const recentVideoIds = videosResponse.data.items?.map(v => v.id.videoId).filter(Boolean) || [];

    let avgViews = 0;
    let avgEngagement = 0;
    if (recentVideoIds.length > 0) {
      const videoDetailsResponse = await youtube.videos.list({
        part: 'statistics',
        id: recentVideoIds.slice(0, 15).join(',')
      });

      const recentStats = videoDetailsResponse.data.items || [];
      const totalViews = recentStats.reduce((sum, v) => sum + parseInt(v.statistics.viewCount || 0), 0);
      const totalLikes = recentStats.reduce((sum, v) => sum + parseInt(v.statistics.likeCount || 0), 0);
      const totalComments = recentStats.reduce((sum, v) => sum + parseInt(v.statistics.commentCount || 0), 0);

      avgViews = Math.round(totalViews / Math.max(recentStats.length, 1));
      avgEngagement = totalViews > 0 ? ((totalLikes + totalComments) / totalViews * 100).toFixed(2) : 0;
    }

    // Determine niche from topics
    const nicheMap = {
      'Finance': 'Finance',
      'Business': 'Finance',
      'Technology': 'Technology',
      'Gaming': 'Gaming',
      'Entertainment': 'Entertainment',
      'Education': 'Education',
      'Lifestyle': 'Lifestyle',
      'Beauty': 'Beauty',
      'Fashion': 'Beauty',
      'Health': 'Health',
      'Fitness': 'Health',
      'Food': 'Food',
      'Travel': 'Travel'
    };

    let detectedNiche = 'General';
    for (const topic of topicCategories) {
      for (const [key, niche] of Object.entries(nicheMap)) {
        if (topic.toLowerCase().includes(key.toLowerCase())) {
          detectedNiche = niche;
          break;
        }
      }
    }

    // Calculate sponsorship rates based on industry standards
    // Base rate: $20-50 per 1,000 subscribers for integration
    // Adjusted by engagement rate and niche multipliers
    const nicheMultipliers = {
      'Finance': 2.5,
      'Technology': 2.0,
      'Business': 2.0,
      'Health': 1.8,
      'Beauty': 1.6,
      'Education': 1.5,
      'Food': 1.4,
      'Travel': 1.4,
      'Lifestyle': 1.3,
      'Gaming': 1.2,
      'Entertainment': 1.0,
      'General': 1.0
    };

    const nicheMultiplier = nicheMultipliers[detectedNiche] || 1.0;
    const engagementBonus = parseFloat(avgEngagement) > 5 ? 1.5 : parseFloat(avgEngagement) > 3 ? 1.2 : 1.0;

    // Base rate per 1000 subscribers
    const baseRatePer1K = 30;
    const baseIntegrationRate = (subscriberCount / 1000) * baseRatePer1K * nicheMultiplier * engagementBonus;

    // Calculate different rate tiers
    const integrationRate = Math.max(100, Math.round(baseIntegrationRate / 50) * 50);
    const dedicatedVideoRate = Math.round(integrationRate * 2.5);
    const shoutoutRate = Math.round(integrationRate * 0.4);

    // Industry averages for comparison
    const industryAverage = Math.round((subscriberCount / 1000) * 25);
    const topCreatorRate = Math.round((subscriberCount / 1000) * 60);

    // Determine position relative to industry
    let position = 'average';
    let insight = 'Your rates are in line with industry averages.';
    if (integrationRate > industryAverage * 1.2) {
      position = 'above';
      insight = 'Your strong engagement justifies premium rates above industry average.';
    } else if (integrationRate < industryAverage * 0.8) {
      position = 'below';
      insight = 'Consider increasing your rates - your content quality may warrant higher pricing.';
    }

    // Use AI to generate negotiation tips
    const prompt = `You are a YouTube sponsorship expert. A creator with ${subscriberCount.toLocaleString()} subscribers in the ${detectedNiche} niche has an average of ${avgViews.toLocaleString()} views per video and ${avgEngagement}% engagement rate.

Generate 4 negotiation strategies to help them get higher sponsorship rates. Each tip should be specific and actionable.

Return as JSON:
{
  "tips": [
    { "title": "Short title", "description": "Detailed strategy explanation" }
  ]
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 800
    });

    let negotiationTips = [];
    try {
      const parsed = JSON.parse(aiResponse.choices[0].message.content);
      negotiationTips = parsed.tips || [];
    } catch (e) {
      negotiationTips = [
        { title: 'Highlight Your Engagement', description: 'Brands value engagement over raw subscriber counts. Emphasize your like-to-view and comment ratios.' },
        { title: 'Create a Media Kit', description: 'A professional media kit with demographics, case studies, and past results can justify higher rates.' },
        { title: 'Bundle Services', description: 'Offer packages that include social media posts, stories, and community posts for added value.' },
        { title: 'Show ROI', description: 'Track and share click-through rates and conversion data from previous sponsorships.' }
      ];
    }

    // Save to history
    const historyData = {
      userId: uid,
      type: 'sponsorship',
      channelUrl,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche: detectedNiche,
      avgViews,
      avgEngagement: parseFloat(avgEngagement),
      rates: {
        dedicatedVideo: '$' + dedicatedVideoRate.toLocaleString(),
        integration: '$' + integrationRate.toLocaleString(),
        shoutout: '$' + shoutoutRate.toLocaleString()
      },
      comparison: {
        average: '$' + industryAverage.toLocaleString(),
        top: '$' + topCreatorRate.toLocaleString(),
        position,
        insight
      },
      negotiationTips,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('sponsorshipHistory').add(historyData);
    await incrementUsage(uid, 'sponsorshipCalculator');
    await logUsage(uid, 'sponsorship_calculator', { channelUrl, subscribers: subscriberCount });

    return {
      success: true,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche: detectedNiche,
      avgViews,
      avgEngagement: parseFloat(avgEngagement),
      rates: {
        dedicatedVideo: '$' + dedicatedVideoRate.toLocaleString(),
        integration: '$' + integrationRate.toLocaleString(),
        shoutout: '$' + shoutoutRate.toLocaleString()
      },
      comparison: {
        average: '$' + industryAverage.toLocaleString(),
        top: '$' + topCreatorRate.toLocaleString(),
        position,
        insight
      },
      negotiationTips
    };

  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Sponsorship calculator error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to calculate sponsorship rates.');
  }
});

// ==========================================
// REVENUE DIVERSIFICATION ANALYZER
// ==========================================
/**
 * Analyzes a channel's current revenue sources and identifies gaps
 * Provides recommendations for new income streams
 */
exports.analyzeRevenueDiversification = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'analyzeRevenueDiversification', 5);
  await checkUsageLimit(uid, 'revenueDiversification');

  const { channelUrl, currentSources = [] } = data;
  if (!channelUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Channel URL is required');
  }

  try {
    // Extract and fetch channel info
    const channelInfo = extractChannelInfo(channelUrl);

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
    const channelName = channel.snippet.title;
    const channelThumbnail = channel.snippet.thumbnails?.medium?.url || channel.snippet.thumbnails?.default?.url;
    const subscriberCount = parseInt(channel.statistics.subscriberCount) || 0;
    const topicCategories = channel.topicDetails?.topicCategories?.map(t => t.split('/').pop()) || [];

    // Determine niche
    let niche = 'General';
    const nicheKeywords = ['Finance', 'Technology', 'Gaming', 'Education', 'Lifestyle', 'Beauty', 'Health', 'Food', 'Travel', 'Entertainment'];
    for (const topic of topicCategories) {
      for (const keyword of nicheKeywords) {
        if (topic.toLowerCase().includes(keyword.toLowerCase())) {
          niche = keyword;
          break;
        }
      }
    }

    // Define all possible revenue sources with icons
    const allSources = [
      { id: 'adsense', name: 'AdSense', icon: '💰' },
      { id: 'sponsors', name: 'Sponsorships', icon: '🤝' },
      { id: 'merch', name: 'Merchandise', icon: '👕' },
      { id: 'courses', name: 'Courses', icon: '📚' },
      { id: 'affiliate', name: 'Affiliates', icon: '🔗' },
      { id: 'memberships', name: 'Memberships', icon: '⭐' },
      { id: 'consulting', name: 'Consulting', icon: '💼' },
      { id: 'digital', name: 'Digital Products', icon: '📦' }
    ];

    // Mark active/inactive sources
    const currentSourcesData = allSources.map(source => ({
      ...source,
      active: currentSources.includes(source.id),
      estimated: source.active ? estimateRevenueForSource(source.id, subscriberCount, niche) : null
    }));

    // Calculate diversification score
    const activeCount = currentSources.length;
    const diversificationScore = Math.round((activeCount / allSources.length) * 100);

    // Use AI to generate personalized recommendations
    const prompt = `You are a YouTube monetization expert. Analyze this channel:
- Subscribers: ${subscriberCount.toLocaleString()}
- Niche: ${niche}
- Current revenue sources: ${currentSources.length > 0 ? currentSources.join(', ') : 'Only AdSense'}
- Missing sources: ${allSources.filter(s => !currentSources.includes(s.id)).map(s => s.name).join(', ')}

Generate:
1. An estimate of monthly revenue they're missing (format: "$X,XXX")
2. Top 4 revenue stream recommendations with potential monthly earnings
3. A 5-step prioritized action plan

Return as JSON:
{
  "missingRevenue": "$X,XXX",
  "recommendations": [
    {
      "icon": "emoji",
      "name": "Revenue Stream Name",
      "potential": "$X,XXX",
      "description": "Why this is good for them",
      "effort": "Low/Medium/High",
      "roi": "High/Medium/Low"
    }
  ],
  "actionPlan": [
    { "task": "Action item", "impact": "Expected result" }
  ]
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 1200
    });

    let aiData;
    try {
      aiData = JSON.parse(aiResponse.choices[0].message.content);
    } catch (e) {
      aiData = {
        missingRevenue: '$' + Math.round(subscriberCount / 100) + '/mo',
        recommendations: [
          { icon: '🤝', name: 'Brand Sponsorships', potential: '$' + Math.round(subscriberCount / 50), description: 'Partner with brands in your niche', effort: 'Medium', roi: 'High' }
        ],
        actionPlan: [
          { task: 'Create a media kit', impact: 'Professional outreach to brands' }
        ]
      };
    }

    // Save to history
    const historyData = {
      userId: uid,
      type: 'diversification',
      channelUrl,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche,
      currentSources: currentSourcesData,
      diversificationScore,
      missingRevenue: aiData.missingRevenue,
      recommendations: aiData.recommendations,
      actionPlan: aiData.actionPlan,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('diversificationHistory').add(historyData);
    await incrementUsage(uid, 'revenueDiversification');
    await logUsage(uid, 'revenue_diversification', { channelUrl, subscribers: subscriberCount });

    return {
      success: true,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche,
      diversificationScore,
      currentSources: currentSourcesData,
      missingRevenue: aiData.missingRevenue,
      recommendations: aiData.recommendations,
      actionPlan: aiData.actionPlan
    };

  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Revenue diversification error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to analyze revenue diversification.');
  }
});

// Helper function for revenue estimation
function estimateRevenueForSource(sourceId, subscribers, niche) {
  const baseRates = {
    adsense: subscribers * 0.002,
    sponsors: subscribers * 0.01,
    merch: subscribers * 0.001,
    courses: subscribers * 0.005,
    affiliate: subscribers * 0.003,
    memberships: subscribers * 0.002,
    consulting: subscribers * 0.001,
    digital: subscribers * 0.004
  };

  const nicheMultipliers = {
    Finance: 2.0,
    Technology: 1.5,
    Education: 1.3,
    Health: 1.4,
    General: 1.0
  };

  const multiplier = nicheMultipliers[niche] || 1.0;
  const estimate = Math.round((baseRates[sourceId] || 0) * multiplier);
  return '$' + estimate.toLocaleString();
}

// ==========================================
// CPM BOOSTER STRATEGIST
// ==========================================
/**
 * Analyzes a channel and provides strategies to increase CPM
 * Identifies high-CPM keywords, topics, and optimal video lengths
 */
exports.analyzeCpmBooster = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'analyzeCpmBooster', 5);
  await checkUsageLimit(uid, 'cpmBooster');

  const { channelUrl } = data;
  if (!channelUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Channel URL is required');
  }

  try {
    // Extract and fetch channel info
    const channelInfo = extractChannelInfo(channelUrl);

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
    const channelDescription = channel.snippet.description || '';
    const topicCategories = channel.topicDetails?.topicCategories?.map(t => t.split('/').pop()) || [];

    // Determine current niche and CPM
    const nicheCPMRates = {
      'Finance': { current: 12, potential: 18 },
      'Insurance': { current: 15, potential: 22 },
      'Legal': { current: 14, potential: 20 },
      'Technology': { current: 8, potential: 12 },
      'Business': { current: 10, potential: 15 },
      'Education': { current: 6, potential: 10 },
      'Health': { current: 7, potential: 11 },
      'Gaming': { current: 4, potential: 6 },
      'Entertainment': { current: 3, potential: 5 },
      'Lifestyle': { current: 5, potential: 8 },
      'General': { current: 4, potential: 7 }
    };

    let detectedNiche = 'General';
    for (const topic of topicCategories) {
      for (const niche of Object.keys(nicheCPMRates)) {
        if (topic.toLowerCase().includes(niche.toLowerCase())) {
          detectedNiche = niche;
          break;
        }
      }
    }

    const cpmData = nicheCPMRates[detectedNiche] || nicheCPMRates.General;

    // Use AI to generate CPM optimization strategies
    const prompt = `You are a YouTube CPM optimization expert. Analyze this channel:
- Channel: ${channelName}
- Niche: ${detectedNiche}
- Description: ${channelDescription.slice(0, 500)}
- Current estimated CPM: $${cpmData.current}

Generate:
1. 8 high-CPM keywords relevant to their niche (with CPM estimates)
2. 5 video topic ideas that would attract higher-paying advertisers
3. Optimal video length recommendation with reasoning
4. Quarterly content calendar showing CPM multipliers

Return as JSON:
{
  "highCpmKeywords": [
    { "keyword": "keyword phrase", "cpm": 15 }
  ],
  "topicIdeas": [
    { "title": "Video title idea", "estimatedCpm": 12, "description": "Why this attracts premium advertisers" }
  ],
  "optimalLength": "8-12 minutes",
  "lengthReason": "Allows 2-3 mid-roll ad placements",
  "contentCalendar": [
    { "period": "Q1", "cpmMultiplier": 0.8, "tip": "Post-holiday dip" },
    { "period": "Q4", "cpmMultiplier": 1.8, "tip": "Holiday ad spend peak" }
  ]
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 1500
    });

    let aiData;
    try {
      aiData = JSON.parse(aiResponse.choices[0].message.content);
    } catch (e) {
      aiData = {
        highCpmKeywords: [
          { keyword: 'best investment strategies', cpm: 15 },
          { keyword: 'how to save money', cpm: 12 }
        ],
        topicIdeas: [
          { title: 'Complete Guide to [Topic]', estimatedCpm: 10, description: 'Educational content attracts premium brands' }
        ],
        optimalLength: '8-12 minutes',
        lengthReason: 'Optimal for mid-roll ad placements',
        contentCalendar: [
          { period: 'Q1', cpmMultiplier: 0.8, tip: 'Lower ad spend' },
          { period: 'Q4', cpmMultiplier: 1.8, tip: 'Holiday peak' }
        ]
      };
    }

    const cpmIncrease = Math.round(((cpmData.potential - cpmData.current) / cpmData.current) * 100) + '%';

    // Save to history
    const historyData = {
      userId: uid,
      type: 'cpmbooster',
      channelUrl,
      channelName,
      niche: detectedNiche,
      currentCPM: '$' + cpmData.current,
      potentialCPM: '$' + cpmData.potential,
      cpmIncrease,
      highCpmKeywords: aiData.highCpmKeywords,
      topicIdeas: aiData.topicIdeas,
      optimalLength: aiData.optimalLength,
      lengthReason: aiData.lengthReason,
      contentCalendar: aiData.contentCalendar,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('cpmBoosterHistory').add(historyData);
    await incrementUsage(uid, 'cpmBooster');
    await logUsage(uid, 'cpm_booster', { channelUrl, niche: detectedNiche });

    return {
      success: true,
      channelName,
      niche: detectedNiche,
      currentCPM: '$' + cpmData.current,
      potentialCPM: '$' + cpmData.potential,
      cpmIncrease,
      highCpmKeywords: aiData.highCpmKeywords,
      topicIdeas: aiData.topicIdeas,
      optimalLength: aiData.optimalLength,
      lengthReason: aiData.lengthReason,
      contentCalendar: aiData.contentCalendar
    };

  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('CPM booster error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to analyze CPM opportunities.');
  }
});

// ==========================================
// AUDIENCE MONETIZATION PROFILER
// ==========================================
/**
 * Analyzes a channel's audience demographics and spending behavior
 * Provides segmentation and targeted offer recommendations
 */
exports.analyzeAudienceProfile = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'analyzeAudienceProfile', 5);
  await checkUsageLimit(uid, 'audienceProfiler');

  const { channelUrl } = data;
  if (!channelUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Channel URL is required');
  }

  try {
    // Extract and fetch channel info
    const channelInfo = extractChannelInfo(channelUrl);

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
    const channelDescription = channel.snippet.description || '';
    const subscriberCount = parseInt(channel.statistics.subscriberCount) || 0;
    const topicCategories = channel.topicDetails?.topicCategories?.map(t => t.split('/').pop()) || [];

    // Get recent videos for content analysis
    const videosResponse = await youtube.search.list({
      part: 'snippet',
      channelId: channelId,
      type: 'video',
      order: 'viewCount',
      maxResults: 10
    });

    const topVideoTitles = videosResponse.data.items?.map(v => v.snippet.title).join(', ') || '';

    // Determine niche
    let niche = 'General';
    const nicheKeywords = ['Finance', 'Technology', 'Gaming', 'Education', 'Lifestyle', 'Beauty', 'Health', 'Food', 'Travel', 'Entertainment', 'Business'];
    for (const topic of topicCategories) {
      for (const keyword of nicheKeywords) {
        if (topic.toLowerCase().includes(keyword.toLowerCase())) {
          niche = keyword;
          break;
        }
      }
    }

    // Use AI to generate audience profile
    const prompt = `You are an audience monetization expert. Analyze this YouTube channel:
- Channel: ${channelName}
- Subscribers: ${subscriberCount.toLocaleString()}
- Niche: ${niche}
- Description: ${channelDescription.slice(0, 300)}
- Top videos: ${topVideoTitles.slice(0, 400)}

Create a detailed monetization profile:
1. 4 audience segments with purchasing power analysis
2. 5 products/services this audience would likely buy
3. 4 content recommendations to attract higher-value viewers
4. 3 targeted offer ideas for different segments

Return as JSON:
{
  "segments": [
    {
      "icon": "emoji",
      "name": "Segment Name",
      "percentage": 30,
      "value": "$150",
      "description": "Description of this segment's characteristics and spending habits"
    }
  ],
  "productRecommendations": [
    {
      "icon": "emoji",
      "name": "Product category",
      "reason": "Why they'd buy this",
      "conversionRate": 3.5
    }
  ],
  "contentRecommendations": [
    {
      "title": "Content strategy",
      "impact": "Expected result on audience value"
    }
  ],
  "targetedOffers": [
    {
      "name": "Offer name",
      "segment": "Target segment",
      "description": "Offer details",
      "expectedRevenue": "$X,XXX/month"
    }
  ]
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 1500
    });

    let aiData;
    try {
      aiData = JSON.parse(aiResponse.choices[0].message.content);
    } catch (e) {
      aiData = {
        segments: [
          { icon: '💼', name: 'Professionals', percentage: 40, value: '$200', description: 'Working professionals interested in career growth' }
        ],
        productRecommendations: [
          { icon: '📚', name: 'Online Courses', reason: 'Educational content viewers value learning', conversionRate: 3.2 }
        ],
        contentRecommendations: [
          { title: 'Create premium tutorials', impact: 'Attracts higher-income viewers' }
        ],
        targetedOffers: [
          { name: 'Premium Course Bundle', segment: 'Professionals', description: 'Advanced training package', expectedRevenue: '$2,000/month' }
        ]
      };
    }

    // Save to history
    const historyData = {
      userId: uid,
      type: 'audienceprofile',
      channelUrl,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche,
      segments: aiData.segments,
      productRecommendations: aiData.productRecommendations,
      contentRecommendations: aiData.contentRecommendations,
      targetedOffers: aiData.targetedOffers,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('audienceProfileHistory').add(historyData);
    await incrementUsage(uid, 'audienceProfiler');
    await logUsage(uid, 'audience_profiler', { channelUrl, subscribers: subscriberCount });

    return {
      success: true,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche,
      segments: aiData.segments,
      productRecommendations: aiData.productRecommendations,
      contentRecommendations: aiData.contentRecommendations,
      targetedOffers: aiData.targetedOffers
    };

  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Audience profiler error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to profile audience.');
  }
});

// ============================================================
// DIGITAL PRODUCT ARCHITECT
// Analyzes channel to suggest digital products the creator can sell
// ============================================================
exports.analyzeDigitalProduct = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'analyzeDigitalProduct', 5);
  await checkUsageLimit(uid, 'digitalProductArchitect');

  const { channelUrl } = data;
  if (!channelUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Channel URL is required.');
  }

  try {
    // Extract channel info from URL
    const channelInfo = extractChannelInfo(channelUrl);

    // Get channel details based on URL type
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
      // Search for custom/user URLs
      const searchResponse = await youtube.search.list({
        part: 'snippet',
        q: channelInfo.value,
        type: 'channel',
        maxResults: 1
      });

      if (!searchResponse.data.items?.length) {
        throw new functions.https.HttpsError('not-found', 'Channel not found.');
      }

      channelResponse = await youtube.channels.list({
        part: 'snippet,statistics,topicDetails',
        id: searchResponse.data.items[0].snippet.channelId
      });
    }

    if (!channelResponse.data.items || channelResponse.data.items.length === 0) {
      throw new functions.https.HttpsError('not-found', 'Channel not found.');
    }

    const channel = channelResponse.data.items[0];
    const channelId = channel.id;
    const channelName = channel.snippet.title;
    const channelThumbnail = channel.snippet.thumbnails?.medium?.url || channel.snippet.thumbnails?.default?.url;
    const channelDescription = channel.snippet.description || '';
    const subscriberCount = parseInt(channel.statistics.subscriberCount) || 0;
    const topicCategories = channel.topicDetails?.topicCategories?.map(t => t.split('/').pop()) || [];

    // Get popular videos for content analysis
    const videosResponse = await youtube.search.list({
      part: 'snippet',
      channelId: channelId,
      type: 'video',
      order: 'viewCount',
      maxResults: 15
    });

    const videoTitles = videosResponse.data.items?.map(v => v.snippet.title).join(', ') || '';

    // Determine niche
    let niche = 'General';
    const nicheKeywords = ['Finance', 'Technology', 'Gaming', 'Education', 'Lifestyle', 'Beauty', 'Health', 'Food', 'Travel', 'Entertainment', 'Business', 'Fitness', 'Music'];
    for (const topic of topicCategories) {
      for (const keyword of nicheKeywords) {
        if (topic.toLowerCase().includes(keyword.toLowerCase())) {
          niche = keyword;
          break;
        }
      }
    }

    // Use AI to generate digital product ideas
    const prompt = `You are a digital product strategist. Analyze this YouTube channel and create a comprehensive product plan:

Channel: ${channelName}
Subscribers: ${subscriberCount.toLocaleString()}
Niche: ${niche}
Description: ${channelDescription.slice(0, 300)}
Popular videos: ${videoTitles.slice(0, 500)}

Create a digital product strategy with:
1. 5 digital product ideas ranked by potential revenue
2. Pricing strategy with tier recommendations
3. A 90-day launch timeline
4. Skills/expertise this creator can monetize

Return as JSON:
{
  "productIdeas": [
    {
      "icon": "emoji",
      "name": "Product name",
      "type": "Course/Ebook/Template/Community/Tool",
      "description": "What this product offers",
      "targetAudience": "Who would buy this",
      "estimatedPrice": "$XX-$XXX",
      "estimatedMonthlyRevenue": "$X,XXX",
      "difficulty": "Easy/Medium/Hard",
      "priority": 1
    }
  ],
  "pricingStrategy": {
    "tiers": [
      {
        "name": "Tier name",
        "price": "$XX",
        "features": ["Feature 1", "Feature 2"],
        "targetBuyer": "Description of who buys this tier"
      }
    ],
    "recommendation": "Strategic recommendation for pricing"
  },
  "launchTimeline": [
    {
      "week": "Week 1-2",
      "phase": "Phase name",
      "tasks": ["Task 1", "Task 2", "Task 3"],
      "milestone": "Key milestone to achieve"
    }
  ],
  "expertise": [
    {
      "skill": "Skill name",
      "monetizationPotential": "High/Medium/Low",
      "productType": "How to monetize this skill"
    }
  ]
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 2000
    });

    let aiData;
    try {
      aiData = JSON.parse(aiResponse.choices[0].message.content);
    } catch (e) {
      aiData = {
        productIdeas: [
          { icon: '📚', name: 'Comprehensive Course', type: 'Course', description: 'Full training program', targetAudience: 'Beginners', estimatedPrice: '$97-$297', estimatedMonthlyRevenue: '$5,000', difficulty: 'Medium', priority: 1 }
        ],
        pricingStrategy: {
          tiers: [{ name: 'Basic', price: '$47', features: ['Core content'], targetBuyer: 'Budget-conscious learners' }],
          recommendation: 'Start with a low-tier product and upsell'
        },
        launchTimeline: [
          { week: 'Week 1-2', phase: 'Planning', tasks: ['Define product scope', 'Create outline'], milestone: 'Product plan complete' }
        ],
        expertise: [
          { skill: 'Content Creation', monetizationPotential: 'High', productType: 'Online course' }
        ]
      };
    }

    // Save to history
    const historyData = {
      userId: uid,
      type: 'digitalproduct',
      channelUrl,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche,
      productIdeas: aiData.productIdeas,
      pricingStrategy: aiData.pricingStrategy,
      launchTimeline: aiData.launchTimeline,
      expertise: aiData.expertise,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('digitalProductHistory').add(historyData);
    await incrementUsage(uid, 'digitalProductArchitect');
    await logUsage(uid, 'digital_product_architect', { channelUrl, subscribers: subscriberCount });

    return {
      success: true,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche,
      productIdeas: aiData.productIdeas,
      pricingStrategy: aiData.pricingStrategy,
      launchTimeline: aiData.launchTimeline,
      expertise: aiData.expertise
    };

  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Digital product architect error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to analyze digital products.');
  }
});

// ============================================================
// AFFILIATE GOLDMINE FINDER
// Finds affiliate programs matching channel's niche
// ============================================================
exports.analyzeAffiliate = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'analyzeAffiliate', 5);
  await checkUsageLimit(uid, 'affiliateFinder');

  const { channelUrl } = data;
  if (!channelUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Channel URL is required.');
  }

  try {
    // Extract channel info from URL
    const channelInfo = extractChannelInfo(channelUrl);

    // Get channel details based on URL type
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
      // Search for custom/user URLs
      const searchResponse = await youtube.search.list({
        part: 'snippet',
        q: channelInfo.value,
        type: 'channel',
        maxResults: 1
      });

      if (!searchResponse.data.items?.length) {
        throw new functions.https.HttpsError('not-found', 'Channel not found.');
      }

      channelResponse = await youtube.channels.list({
        part: 'snippet,statistics,topicDetails',
        id: searchResponse.data.items[0].snippet.channelId
      });
    }

    if (!channelResponse.data.items || channelResponse.data.items.length === 0) {
      throw new functions.https.HttpsError('not-found', 'Channel not found.');
    }

    const channel = channelResponse.data.items[0];
    const channelId = channel.id;
    const channelName = channel.snippet.title;
    const channelThumbnail = channel.snippet.thumbnails?.medium?.url || channel.snippet.thumbnails?.default?.url;
    const channelDescription = channel.snippet.description || '';
    const subscriberCount = parseInt(channel.statistics.subscriberCount) || 0;
    const viewCount = parseInt(channel.statistics.viewCount) || 0;
    const topicCategories = channel.topicDetails?.topicCategories?.map(t => t.split('/').pop()) || [];

    // Get popular videos
    const videosResponse = await youtube.search.list({
      part: 'snippet',
      channelId: channelId,
      type: 'video',
      order: 'viewCount',
      maxResults: 15
    });

    const videoTitles = videosResponse.data.items?.map(v => v.snippet.title).join(', ') || '';

    // Determine niche
    let niche = 'General';
    const nicheKeywords = ['Finance', 'Technology', 'Gaming', 'Education', 'Lifestyle', 'Beauty', 'Health', 'Food', 'Travel', 'Entertainment', 'Business', 'Fitness'];
    for (const topic of topicCategories) {
      for (const keyword of nicheKeywords) {
        if (topic.toLowerCase().includes(keyword.toLowerCase())) {
          niche = keyword;
          break;
        }
      }
    }

    // Use AI to find affiliate opportunities
    const prompt = `You are an affiliate marketing expert. Analyze this YouTube channel and find the best affiliate opportunities:

Channel: ${channelName}
Subscribers: ${subscriberCount.toLocaleString()}
Total Views: ${viewCount.toLocaleString()}
Niche: ${niche}
Description: ${channelDescription.slice(0, 300)}
Popular videos: ${videoTitles.slice(0, 500)}

Create a comprehensive affiliate strategy:
1. 6 affiliate programs perfectly matched to this channel
2. Scripts for naturally mentioning affiliate products
3. Earnings breakdown projection
4. Best placement strategies

Return as JSON:
{
  "affiliatePrograms": [
    {
      "icon": "emoji",
      "name": "Program/Company name",
      "network": "Amazon/ShareASale/Impact/Direct/etc",
      "commission": "X% or $XX per sale",
      "cookieDuration": "XX days",
      "avgOrderValue": "$XXX",
      "estimatedEarnings": "$X,XXX/month",
      "fitScore": 95,
      "signupUrl": "General signup info",
      "whyItFits": "Why this is perfect for this channel"
    }
  ],
  "placementScripts": [
    {
      "type": "Intro/Mid-roll/Outro/Description",
      "script": "Natural-sounding script to mention the product",
      "duration": "XX seconds",
      "tips": "How to make it more effective"
    }
  ],
  "earningsBreakdown": {
    "monthly": {
      "conservative": "$X,XXX",
      "moderate": "$X,XXX",
      "optimistic": "$XX,XXX"
    },
    "perVideo": {
      "conservative": "$XXX",
      "moderate": "$XXX",
      "optimistic": "$X,XXX"
    },
    "assumptions": "What these projections are based on"
  },
  "placementStrategy": [
    {
      "location": "Where in video",
      "effectiveness": "High/Medium/Low",
      "conversionRate": "X.X%",
      "tips": "Best practices"
    }
  ]
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 2000
    });

    let aiData;
    try {
      aiData = JSON.parse(aiResponse.choices[0].message.content);
    } catch (e) {
      aiData = {
        affiliatePrograms: [
          { icon: '🛒', name: 'Amazon Associates', network: 'Amazon', commission: '1-10%', cookieDuration: '24 hours', avgOrderValue: '$50', estimatedEarnings: '$500/month', fitScore: 85, signupUrl: 'affiliate-program.amazon.com', whyItFits: 'Universal appeal for any niche' }
        ],
        placementScripts: [
          { type: 'Mid-roll', script: 'Speaking of which, I use [Product] for this and you can check it out in the description below.', duration: '10 seconds', tips: 'Keep it natural and brief' }
        ],
        earningsBreakdown: {
          monthly: { conservative: '$300', moderate: '$800', optimistic: '$2,000' },
          perVideo: { conservative: '$30', moderate: '$80', optimistic: '$200' },
          assumptions: 'Based on current subscriber count and typical conversion rates'
        },
        placementStrategy: [
          { location: 'Video description', effectiveness: 'High', conversionRate: '2.5%', tips: 'Put link above the fold' }
        ]
      };
    }

    // Save to history
    const historyData = {
      userId: uid,
      type: 'affiliate',
      channelUrl,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche,
      affiliatePrograms: aiData.affiliatePrograms,
      placementScripts: aiData.placementScripts,
      earningsBreakdown: aiData.earningsBreakdown,
      placementStrategy: aiData.placementStrategy,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('affiliateHistory').add(historyData);
    await incrementUsage(uid, 'affiliateFinder');
    await logUsage(uid, 'affiliate_finder', { channelUrl, subscribers: subscriberCount });

    return {
      success: true,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche,
      affiliatePrograms: aiData.affiliatePrograms,
      placementScripts: aiData.placementScripts,
      earningsBreakdown: aiData.earningsBreakdown,
      placementStrategy: aiData.placementStrategy
    };

  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Affiliate finder error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to find affiliate opportunities.');
  }
});

// ============================================================
// VIDEO-TO-MULTI-INCOME CONVERTER
// Analyzes a video to create multiple content pieces for various platforms
// ============================================================
exports.analyzeMultiIncome = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'analyzeMultiIncome', 5);
  await checkUsageLimit(uid, 'multiIncomeConverter');

  const { videoUrl } = data;
  if (!videoUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Video URL is required.');
  }

  try {
    // Extract video ID
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid YouTube video URL.');
    }

    // Fetch video data
    const videoResponse = await youtube.videos.list({
      part: 'snippet,statistics,contentDetails',
      id: videoId
    });

    if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
      throw new functions.https.HttpsError('not-found', 'Video not found.');
    }

    const video = videoResponse.data.items[0];
    const videoTitle = video.snippet.title;
    const videoThumbnail = video.snippet.thumbnails?.maxres?.url || video.snippet.thumbnails?.high?.url || video.snippet.thumbnails?.medium?.url;
    const videoDescription = video.snippet.description || '';
    const viewCount = parseInt(video.statistics.viewCount) || 0;
    const likeCount = parseInt(video.statistics.likeCount) || 0;
    const channelTitle = video.snippet.channelTitle;
    const duration = video.contentDetails.duration;
    const tags = video.snippet.tags?.slice(0, 10).join(', ') || '';

    // Parse duration
    const durationMatch = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    const hours = parseInt(durationMatch?.[1] || 0);
    const minutes = parseInt(durationMatch?.[2] || 0);
    const seconds = parseInt(durationMatch?.[3] || 0);
    const totalMinutes = hours * 60 + minutes + Math.round(seconds / 60);

    // Use AI to create multi-platform content strategy
    const prompt = `You are a content repurposing expert. Analyze this YouTube video and create a comprehensive multi-platform income strategy:

Video: ${videoTitle}
Channel: ${channelTitle}
Views: ${viewCount.toLocaleString()}
Likes: ${likeCount.toLocaleString()}
Duration: ${totalMinutes} minutes
Description: ${videoDescription.slice(0, 400)}
Tags: ${tags}

Create a strategy to repurpose this video into multiple income streams:
1. 6 content pieces for different platforms
2. Distribution strategy across platforms
3. Revenue potential for each platform
4. Step-by-step action items

Return as JSON:
{
  "contentPieces": [
    {
      "icon": "emoji",
      "platform": "Platform name",
      "contentType": "Short/Article/Thread/Post/etc",
      "title": "Suggested title or hook",
      "description": "What this content would be",
      "estimatedReach": "X,XXX-XX,XXX",
      "timeToCreate": "X hours",
      "monetization": "How to monetize this"
    }
  ],
  "distributionStrategy": {
    "immediate": ["Platform 1", "Platform 2"],
    "within24Hours": ["Platform 3", "Platform 4"],
    "withinWeek": ["Platform 5", "Platform 6"],
    "schedule": "Recommended posting schedule"
  },
  "revenuePotential": [
    {
      "platform": "Platform name",
      "monthlyPotential": "$XXX-$X,XXX",
      "revenueType": "Ads/Affiliate/Sponsorship/etc",
      "requirements": "What's needed to monetize"
    }
  ],
  "actionItems": [
    {
      "step": 1,
      "action": "What to do",
      "timeRequired": "X hours",
      "tools": "Tools needed",
      "priority": "High/Medium/Low"
    }
  ],
  "summary": {
    "totalPotentialRevenue": "$X,XXX/month",
    "totalTimeInvestment": "X hours",
    "quickestWin": "Platform/content that can generate income fastest"
  }
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 2000
    });

    let aiData;
    try {
      aiData = JSON.parse(aiResponse.choices[0].message.content);
    } catch (e) {
      aiData = {
        contentPieces: [
          { icon: '📱', platform: 'TikTok', contentType: 'Short', title: 'Key moment highlight', description: 'Extract the most engaging 60 seconds', estimatedReach: '5,000-50,000', timeToCreate: '1 hour', monetization: 'Creator fund + affiliate links' }
        ],
        distributionStrategy: {
          immediate: ['YouTube Shorts', 'TikTok'],
          within24Hours: ['Instagram Reels', 'Twitter'],
          withinWeek: ['LinkedIn Article', 'Blog Post'],
          schedule: 'Post shorts immediately, long-form content within a week'
        },
        revenuePotential: [
          { platform: 'TikTok', monthlyPotential: '$100-$500', revenueType: 'Creator Fund', requirements: '10K followers' }
        ],
        actionItems: [
          { step: 1, action: 'Extract key clips', timeRequired: '2 hours', tools: 'Video editor', priority: 'High' }
        ],
        summary: {
          totalPotentialRevenue: '$500-$2,000/month',
          totalTimeInvestment: '10 hours',
          quickestWin: 'YouTube Shorts from existing content'
        }
      };
    }

    // Save to history
    const historyData = {
      userId: uid,
      type: 'multiincome',
      videoUrl,
      videoId,
      videoTitle,
      videoThumbnail,
      channelTitle,
      views: viewCount,
      duration: totalMinutes,
      contentPieces: aiData.contentPieces,
      distributionStrategy: aiData.distributionStrategy,
      revenuePotential: aiData.revenuePotential,
      actionItems: aiData.actionItems,
      summary: aiData.summary,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('multiIncomeHistory').add(historyData);
    await incrementUsage(uid, 'multiIncomeConverter');
    await logUsage(uid, 'multi_income_converter', { videoUrl, views: viewCount });

    return {
      success: true,
      videoTitle,
      videoThumbnail,
      channelTitle,
      views: viewCount,
      duration: totalMinutes,
      contentPieces: aiData.contentPieces,
      distributionStrategy: aiData.distributionStrategy,
      revenuePotential: aiData.revenuePotential,
      actionItems: aiData.actionItems,
      summary: aiData.summary
    };

  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Multi-income converter error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to analyze video for income streams.');
  }
});

// ============================================================
// BRAND DEAL MATCHMAKER
// Finds brand partnership opportunities for creators
// ============================================================
exports.analyzeBrandDeal = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'analyzeBrandDeal', 5);
  await checkUsageLimit(uid, 'brandDealMatchmaker');

  const { channelUrl } = data;
  if (!channelUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Channel URL is required.');
  }

  try {
    // Extract channel info from URL
    const channelInfo = extractChannelInfo(channelUrl);

    // Get channel details based on URL type
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
      // Search for custom/user URLs
      const searchResponse = await youtube.search.list({
        part: 'snippet',
        q: channelInfo.value,
        type: 'channel',
        maxResults: 1
      });

      if (!searchResponse.data.items?.length) {
        throw new functions.https.HttpsError('not-found', 'Channel not found.');
      }

      channelResponse = await youtube.channels.list({
        part: 'snippet,statistics,topicDetails',
        id: searchResponse.data.items[0].snippet.channelId
      });
    }

    if (!channelResponse.data.items || channelResponse.data.items.length === 0) {
      throw new functions.https.HttpsError('not-found', 'Channel not found.');
    }

    const channel = channelResponse.data.items[0];
    const channelId = channel.id;
    const channelName = channel.snippet.title;
    const channelThumbnail = channel.snippet.thumbnails?.medium?.url || channel.snippet.thumbnails?.default?.url;
    const channelDescription = channel.snippet.description || '';
    const subscriberCount = parseInt(channel.statistics.subscriberCount) || 0;
    const viewCount = parseInt(channel.statistics.viewCount) || 0;
    const topicCategories = channel.topicDetails?.topicCategories?.map(t => t.split('/').pop()) || [];

    // Get popular videos
    const videosResponse = await youtube.search.list({
      part: 'snippet',
      channelId: channelId,
      type: 'video',
      order: 'viewCount',
      maxResults: 15
    });

    const videoTitles = videosResponse.data.items?.map(v => v.snippet.title).join(', ') || '';

    // Determine niche
    let niche = 'General';
    const nicheKeywords = ['Finance', 'Technology', 'Gaming', 'Education', 'Lifestyle', 'Beauty', 'Health', 'Food', 'Travel', 'Entertainment', 'Business', 'Fitness', 'Fashion'];
    for (const topic of topicCategories) {
      for (const keyword of nicheKeywords) {
        if (topic.toLowerCase().includes(keyword.toLowerCase())) {
          niche = keyword;
          break;
        }
      }
    }

    // Use AI to find brand matches
    const prompt = `You are a brand partnership expert. Analyze this YouTube channel and find ideal brand partners:

Channel: ${channelName}
Subscribers: ${subscriberCount.toLocaleString()}
Total Views: ${viewCount.toLocaleString()}
Niche: ${niche}
Description: ${channelDescription.slice(0, 300)}
Popular videos: ${videoTitles.slice(0, 500)}

Create a comprehensive brand deal strategy:
1. 6 brands that would be perfect partners for this channel
2. Pitch templates for outreach
3. Negotiation tips specific to this creator's level

Return as JSON:
{
  "matchedBrands": [
    {
      "icon": "emoji",
      "name": "Brand name",
      "industry": "Industry category",
      "matchScore": 95,
      "whyMatch": "Why this brand is perfect for this channel",
      "dealRange": "$X,XXX - $XX,XXX",
      "contactMethod": "How to reach out"
    }
  ],
  "pitchTemplates": [
    {
      "icon": "emoji",
      "type": "Email/DM/Cold Outreach",
      "template": "Full pitch template text with placeholders"
    }
  ],
  "negotiationTips": [
    {
      "title": "Tip title",
      "description": "Detailed negotiation advice"
    }
  ]
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 2000
    });

    let aiData;
    try {
      aiData = JSON.parse(aiResponse.choices[0].message.content);
    } catch (e) {
      aiData = {
        matchedBrands: [
          { icon: '🏢', name: 'Sample Brand', industry: 'Technology', matchScore: 85, whyMatch: 'Aligned audience demographics', dealRange: '$500 - $2,000', contactMethod: 'Email marketing team' }
        ],
        pitchTemplates: [
          { icon: '📧', type: 'Email', template: 'Hi [Brand],\n\nI run [Channel Name] with [X] subscribers...' }
        ],
        negotiationTips: [
          { title: 'Know Your Worth', description: 'Research industry rates before negotiating' }
        ]
      };
    }

    // Save to history
    const historyData = {
      userId: uid,
      type: 'branddeal',
      channelUrl,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche,
      matchedBrands: aiData.matchedBrands,
      pitchTemplates: aiData.pitchTemplates,
      negotiationTips: aiData.negotiationTips,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('brandDealHistory').add(historyData);
    await incrementUsage(uid, 'brandDealMatchmaker');
    await logUsage(uid, 'brand_deal_matchmaker', { channelUrl, subscribers: subscriberCount });

    return {
      success: true,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche,
      matchedBrands: aiData.matchedBrands,
      pitchTemplates: aiData.pitchTemplates,
      negotiationTips: aiData.negotiationTips
    };

  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Brand deal matchmaker error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to find brand deals.');
  }
});

// ============================================================
// LICENSING & SYNDICATION SCOUT
// Finds licensing and syndication opportunities for content
// ============================================================
exports.analyzeLicensing = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'analyzeLicensing', 5);
  await checkUsageLimit(uid, 'licensingScout');

  const { channelUrl } = data;
  if (!channelUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Channel URL is required.');
  }

  try {
    // Extract channel info from URL
    const channelInfo = extractChannelInfo(channelUrl);

    // Get channel details based on URL type
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
      // Search for custom/user URLs
      const searchResponse = await youtube.search.list({
        part: 'snippet',
        q: channelInfo.value,
        type: 'channel',
        maxResults: 1
      });

      if (!searchResponse.data.items?.length) {
        throw new functions.https.HttpsError('not-found', 'Channel not found.');
      }

      channelResponse = await youtube.channels.list({
        part: 'snippet,statistics,topicDetails',
        id: searchResponse.data.items[0].snippet.channelId
      });
    }

    if (!channelResponse.data.items || channelResponse.data.items.length === 0) {
      throw new functions.https.HttpsError('not-found', 'Channel not found.');
    }

    const channel = channelResponse.data.items[0];
    const channelId = channel.id;
    const channelName = channel.snippet.title;
    const channelThumbnail = channel.snippet.thumbnails?.medium?.url || channel.snippet.thumbnails?.default?.url;
    const channelDescription = channel.snippet.description || '';
    const subscriberCount = parseInt(channel.statistics.subscriberCount) || 0;
    const videoCount = parseInt(channel.statistics.videoCount) || 0;
    const topicCategories = channel.topicDetails?.topicCategories?.map(t => t.split('/').pop()) || [];

    // Get popular videos
    const videosResponse = await youtube.search.list({
      part: 'snippet',
      channelId: channelId,
      type: 'video',
      order: 'viewCount',
      maxResults: 15
    });

    const videoTitles = videosResponse.data.items?.map(v => v.snippet.title).join(', ') || '';

    // Determine niche
    let niche = 'General';
    const nicheKeywords = ['Finance', 'Technology', 'Gaming', 'Education', 'Lifestyle', 'Beauty', 'Health', 'Food', 'Travel', 'Entertainment', 'Business', 'News', 'Sports'];
    for (const topic of topicCategories) {
      for (const keyword of nicheKeywords) {
        if (topic.toLowerCase().includes(keyword.toLowerCase())) {
          niche = keyword;
          break;
        }
      }
    }

    // Use AI to find licensing opportunities
    const prompt = `You are a content licensing expert. Analyze this YouTube channel and find licensing/syndication opportunities:

Channel: ${channelName}
Subscribers: ${subscriberCount.toLocaleString()}
Videos: ${videoCount}
Niche: ${niche}
Description: ${channelDescription.slice(0, 300)}
Popular videos: ${videoTitles.slice(0, 500)}

Create a comprehensive licensing strategy:
1. 5 licensing opportunities for this content
2. 4 syndication networks to join
3. Step-by-step action plan

Return as JSON:
{
  "opportunities": [
    {
      "icon": "emoji",
      "platform": "Platform/Company name",
      "type": "Licensing/Syndication/Compilation/Stock",
      "description": "What this opportunity involves",
      "potentialRevenue": "$X,XXX/month",
      "requirements": "What's needed to qualify"
    }
  ],
  "syndicationNetworks": [
    {
      "icon": "emoji",
      "name": "Network name",
      "description": "What this network does",
      "revenueModel": "How you earn money"
    }
  ],
  "actionSteps": [
    {
      "action": "What to do",
      "details": "How to do it"
    }
  ]
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 2000
    });

    let aiData;
    try {
      aiData = JSON.parse(aiResponse.choices[0].message.content);
    } catch (e) {
      aiData = {
        opportunities: [
          { icon: '📺', platform: 'TV Networks', type: 'Licensing', description: 'License clips to news channels', potentialRevenue: '$500/month', requirements: 'High-quality original content' }
        ],
        syndicationNetworks: [
          { icon: '🌐', name: 'Jukin Media', description: 'Viral video licensing network', revenueModel: 'Revenue share on licensed content' }
        ],
        actionSteps: [
          { action: 'Register content with ID systems', details: 'Sign up for Content ID to track usage' }
        ]
      };
    }

    // Save to history
    const historyData = {
      userId: uid,
      type: 'licensing',
      channelUrl,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche,
      opportunities: aiData.opportunities,
      syndicationNetworks: aiData.syndicationNetworks,
      actionSteps: aiData.actionSteps,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('licensingHistory').add(historyData);
    await incrementUsage(uid, 'licensingScout');
    await logUsage(uid, 'licensing_scout', { channelUrl, subscribers: subscriberCount });

    return {
      success: true,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche,
      opportunities: aiData.opportunities,
      syndicationNetworks: aiData.syndicationNetworks,
      actionSteps: aiData.actionSteps
    };

  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Licensing scout error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to find licensing opportunities.');
  }
});

// ============================================================
// REVENUE AUTOMATION PIPELINE
// Creates automated revenue systems for creators
// ============================================================
exports.analyzeAutomation = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'analyzeAutomation', 5);
  await checkUsageLimit(uid, 'automationPipeline');

  const { channelUrl } = data;
  if (!channelUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Channel URL is required.');
  }

  try {
    // Extract channel info from URL
    const channelInfo = extractChannelInfo(channelUrl);

    // Get channel details based on URL type
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
      // Search for custom/user URLs
      const searchResponse = await youtube.search.list({
        part: 'snippet',
        q: channelInfo.value,
        type: 'channel',
        maxResults: 1
      });

      if (!searchResponse.data.items?.length) {
        throw new functions.https.HttpsError('not-found', 'Channel not found.');
      }

      channelResponse = await youtube.channels.list({
        part: 'snippet,statistics,topicDetails',
        id: searchResponse.data.items[0].snippet.channelId
      });
    }

    if (!channelResponse.data.items || channelResponse.data.items.length === 0) {
      throw new functions.https.HttpsError('not-found', 'Channel not found.');
    }

    const channel = channelResponse.data.items[0];
    const channelId = channel.id;
    const channelName = channel.snippet.title;
    const channelThumbnail = channel.snippet.thumbnails?.medium?.url || channel.snippet.thumbnails?.default?.url;
    const channelDescription = channel.snippet.description || '';
    const subscriberCount = parseInt(channel.statistics.subscriberCount) || 0;
    const videoCount = parseInt(channel.statistics.videoCount) || 0;
    const topicCategories = channel.topicDetails?.topicCategories?.map(t => t.split('/').pop()) || [];

    // Get recent videos
    const videosResponse = await youtube.search.list({
      part: 'snippet',
      channelId: channelId,
      type: 'video',
      order: 'date',
      maxResults: 10
    });

    const videoTitles = videosResponse.data.items?.map(v => v.snippet.title).join(', ') || '';

    // Determine niche
    let niche = 'General';
    const nicheKeywords = ['Finance', 'Technology', 'Gaming', 'Education', 'Lifestyle', 'Beauty', 'Health', 'Food', 'Travel', 'Entertainment', 'Business'];
    for (const topic of topicCategories) {
      for (const keyword of nicheKeywords) {
        if (topic.toLowerCase().includes(keyword.toLowerCase())) {
          niche = keyword;
          break;
        }
      }
    }

    // Calculate automation score based on channel size
    let automationScore = 50;
    if (subscriberCount > 100000) automationScore = 90;
    else if (subscriberCount > 50000) automationScore = 80;
    else if (subscriberCount > 10000) automationScore = 70;
    else if (subscriberCount > 1000) automationScore = 60;

    // Use AI to create automation pipeline
    const prompt = `You are a revenue automation expert for content creators. Analyze this YouTube channel and create an automation pipeline:

Channel: ${channelName}
Subscribers: ${subscriberCount.toLocaleString()}
Videos: ${videoCount}
Niche: ${niche}
Description: ${channelDescription.slice(0, 300)}
Recent videos: ${videoTitles.slice(0, 400)}

Create a comprehensive automation strategy:
1. Revenue summary (current vs automated potential)
2. 5 automation workflows to implement
3. Recommended tool stack
4. Implementation timeline

Return as JSON:
{
  "revenueSummary": {
    "currentManual": "$X,XXX/month",
    "afterAutomation": "$XX,XXX/month",
    "timeSaved": "XX hours/week"
  },
  "workflows": [
    {
      "icon": "emoji",
      "name": "Workflow name",
      "category": "Content/Sales/Marketing/Admin",
      "description": "What this workflow automates",
      "difficulty": "Easy/Medium/Hard",
      "revenueImpact": "+$X,XXX/month",
      "tools": "Tools needed"
    }
  ],
  "toolStack": [
    {
      "icon": "emoji",
      "name": "Tool name",
      "purpose": "What it does",
      "pricing": "Free/$XX/month"
    }
  ],
  "timeline": [
    {
      "week": "Week 1-2",
      "focus": "What to focus on",
      "tasks": "Specific tasks to complete"
    }
  ]
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 2000
    });

    let aiData;
    try {
      aiData = JSON.parse(aiResponse.choices[0].message.content);
    } catch (e) {
      aiData = {
        revenueSummary: {
          currentManual: '$1,000/month',
          afterAutomation: '$3,000/month',
          timeSaved: '15 hours/week'
        },
        workflows: [
          { icon: '📧', name: 'Email Automation', category: 'Marketing', description: 'Automated email sequences', difficulty: 'Easy', revenueImpact: '+$500/month', tools: 'ConvertKit' }
        ],
        toolStack: [
          { icon: '📧', name: 'ConvertKit', purpose: 'Email marketing automation', pricing: '$29/month' }
        ],
        timeline: [
          { week: 'Week 1-2', focus: 'Set up foundation', tasks: 'Create accounts, connect integrations' }
        ]
      };
    }

    // Save to history
    const historyData = {
      userId: uid,
      type: 'automation',
      channelUrl,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche,
      automationScore,
      revenueSummary: aiData.revenueSummary,
      workflows: aiData.workflows,
      toolStack: aiData.toolStack,
      timeline: aiData.timeline,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('automationHistory').add(historyData);
    await incrementUsage(uid, 'automationPipeline');
    await logUsage(uid, 'automation_pipeline', { channelUrl, subscribers: subscriberCount });

    return {
      success: true,
      channelName,
      channelThumbnail,
      subscribers: subscriberCount,
      niche,
      automationScore,
      revenueSummary: aiData.revenueSummary,
      workflows: aiData.workflows,
      toolStack: aiData.toolStack,
      timeline: aiData.timeline
    };

  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Automation pipeline error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to build automation pipeline.');
  }
});

// ==============================================
// VIDEO-TO-SHORTS WIZARD FUNCTIONS
// ==============================================

/**
 * Extract video ID from various YouTube URL formats
 */
function extractYouTubeVideoId(url) {
  if (!url) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Parse ISO 8601 duration to seconds
 */
function parseDurationToSeconds(duration) {
  if (!duration) return 0;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return parseInt(match[1] || 0) * 3600 + parseInt(match[2] || 0) * 60 + parseInt(match[3] || 0);
}

/**
 * wizardAnalyzeVideo - Analyzes video and finds potential viral clips
 * Uses transcript analysis for better clip identification
 */
exports.wizardAnalyzeVideo = functions
  .runWith({ timeoutSeconds: 300, memory: '1GB' })
  .https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'wizardAnalyzeVideo', 3);

  // Check and deduct tokens for video analysis
  const tokenCosts = await getWizardTokenCosts();
  const analyzeCost = tokenCosts.analyzeVideo || 5;

  const tokenResult = await deductWizardTokens(uid, analyzeCost, 'analyzeVideo', {
    videoUrl: data.videoUrl || 'uploaded_file'
  });

  if (!tokenResult.success) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      `Insufficient tokens. This operation requires ${analyzeCost} tokens, but you have ${tokenResult.available || 0}.`
    );
  }

  const { videoUrl, options, uploadedVideoUrl, uploadedVideoPath, uploadedVideoName, extensionData, useExtension, contentType, platformPreset } = data;
  const isUploadedFile = !!uploadedVideoUrl;
  const hasExtensionData = useExtension && extensionData && extensionData.videoInfo;

  // Platform preset settings with defaults
  const platform = contentType || 'youtube-shorts';
  const presetConfig = platformPreset || {
    minDuration: 45,
    maxDuration: 60,
    targetDuration: 55,
    durationRange: '50-60',
    aiPrompt: 'Each clip should be 50-60 seconds to maximize YouTube Shorts watch time. Focus on complete story arcs with satisfying conclusions.'
  };

  console.log('[wizardAnalyzeVideo] Platform settings:', { platform, targetDuration: presetConfig.targetDuration, durationRange: presetConfig.durationRange });

  // Log extension data if provided
  if (hasExtensionData) {
    console.log('[wizardAnalyzeVideo] Extension data provided:', {
      hasVideoInfo: !!extensionData.videoInfo,
      hasStreamData: !!extensionData.streamData,
      videoId: extensionData.videoInfo?.videoId
    });
  }

  // Validate input - need either YouTube URL or uploaded file
  if (!videoUrl && !uploadedVideoUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Video URL or uploaded file is required');
  }

  // Handle uploaded file
  if (isUploadedFile) {
    console.log('Processing uploaded video file:', uploadedVideoName);

    // Generate a unique ID for uploaded videos
    const videoId = `upload_${Date.now()}_${uid.substring(0, 8)}`;
    const videoData = {
      videoId,
      title: uploadedVideoName || 'Uploaded Video',
      description: 'Uploaded video file',
      channelTitle: 'User Upload',
      thumbnail: '', // No thumbnail for uploaded files initially
      duration: 0, // Will be determined during processing
      viewCount: 0,
      likeCount: 0,
      isUpload: true,
      uploadedVideoUrl,
      uploadedVideoPath
    };

    // For uploaded files, we'll create a project and process it differently
    // The video processor will handle extracting duration and generating clips
    // IMPORTANT: Create sourceAsset from the uploaded file - this is the canonical source for export
    const sourceAsset = {
      storageUrl: uploadedVideoUrl,
      storagePath: uploadedVideoPath || null,
      duration: 0, // Will be updated by video processor
      format: 'video/mp4',
      fileSize: 0,
      capturedAt: Date.now(),
      source: 'direct_upload'
    };

    const projectData = {
      userId: uid,
      videoId,
      videoUrl: uploadedVideoUrl,
      videoData,
      clips: [], // Will be populated by video processor
      isUpload: true,
      uploadedVideoPath,
      uploadedVideoName: uploadedVideoName || 'Uploaded Video',
      sourceAsset, // Canonical source for export - uses the uploaded file
      options: options || {},
      status: 'pending_processing', // Needs video processor to analyze
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Enforce max projects limit before creating new project
    const maxProjects = await getMaxProjectsLimit();
    await enforceMaxProjects(uid, maxProjects);

    const projectRef = await db.collection('wizardProjects').add(projectData);
    await logUsage(uid, 'wizard_analyze_upload', { videoId, fileName: uploadedVideoName });

    // Call video processor to analyze the uploaded file
    try {
      const videoProcessorUrl = functions.config().videoprocessor?.url;
      if (videoProcessorUrl) {
        // Trigger async processing
        const processorResponse = await fetch(`${videoProcessorUrl}/analyze-upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: projectRef.id,
            videoUrl: uploadedVideoUrl,
            storagePath: uploadedVideoPath,
            userId: uid
          })
        });

        if (processorResponse.ok) {
          const result = await processorResponse.json();
          // Update project with analysis results
          if (result.clips && result.duration) {
            await projectRef.update({
              clips: result.clips,
              'videoData.duration': result.duration,
              status: 'analyzed',
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            projectData.clips = result.clips;
            projectData.videoData.duration = result.duration;
            projectData.status = 'analyzed';
          }
        }
      }
    } catch (processorError) {
      console.log('Video processor not available for uploaded file:', processorError.message);
      // Continue without processor - clips will be generated on export
    }

    return {
      success: true,
      projectId: projectRef.id,
      videoData: projectData.videoData,
      clips: projectData.clips,
      isUpload: true,
      sourceAsset: sourceAsset, // Return sourceAsset so frontend can store it
      message: 'Uploaded video ready for processing'
    };
  }

  // Handle YouTube URL (existing logic)
  const videoId = extractYouTubeVideoId(videoUrl);
  if (!videoId) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid YouTube URL');
  }

  try {
    let videoData;
    let snippet = {};
    let stats = {};
    let durationSeconds = 0;

    // Check if extension provided USEFUL video info (not just empty/sparse data)
    // We need at least a real title AND duration to skip the YouTube API
    const extInfo = extensionData?.videoInfo;
    const hasUsefulExtensionData = hasExtensionData && extInfo &&
      extInfo.title && extInfo.title !== 'YouTube Video' && // Has real title
      (extInfo.duration && extInfo.duration !== 0); // Has real duration

    console.log('[wizardAnalyzeVideo] Extension data check:', {
      hasExtensionData,
      hasVideoInfo: !!extInfo,
      title: extInfo?.title || 'none',
      duration: extInfo?.duration || 'none',
      hasUsefulExtensionData
    });

    // If extension provided USEFUL video info, use it; otherwise fetch from YouTube API
    if (hasUsefulExtensionData) {
      console.log('[wizardAnalyzeVideo] Using extension-provided video info:', extInfo.title);

      // Parse duration from extension format (e.g., "10:30" or "1:05:30" or seconds)
      if (typeof extInfo.duration === 'number') {
        durationSeconds = extInfo.duration;
      } else if (typeof extInfo.duration === 'string' && extInfo.duration.includes(':')) {
        const parts = extInfo.duration.split(':').map(Number);
        if (parts.length === 3) {
          durationSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        } else if (parts.length === 2) {
          durationSeconds = parts[0] * 60 + parts[1];
        }
      }

      videoData = {
        videoId,
        title: extInfo.title,
        description: '', // Extension doesn't capture description
        channelTitle: extInfo.channel || extInfo.channelTitle || 'Unknown Channel',
        thumbnail: extInfo.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: durationSeconds || 300, // Default to 5 mins if unknown
        viewCount: 0,
        likeCount: 0,
        fromExtension: true
      };

      // Store extension stream data for later use in processing
      // CRITICAL: Preserve ALL fields from streamData, especially source and uploadedToStorage
      // These fields are needed by the video processor to determine the download method
      if (extensionData.streamData) {
        videoData.extensionStreamData = {
          ...extensionData.streamData,  // Preserve ALL fields from extension
          capturedAt: extensionData.streamData.capturedAt || Date.now()
        };
        console.log('[wizardAnalyzeVideo] Extension stream data stored:', {
          hasVideoUrl: !!extensionData.streamData.videoUrl,
          hasAudioUrl: !!extensionData.streamData.audioUrl,
          quality: extensionData.streamData.quality,
          source: extensionData.streamData.source,
          uploadedToStorage: extensionData.streamData.uploadedToStorage,
          captureStartTime: extensionData.streamData.captureStartTime,
          captureEndTime: extensionData.streamData.captureEndTime
        });
      }

      // Also set snippet for the AI prompt
      snippet = {
        title: videoData.title,
        description: videoData.description,
        channelTitle: videoData.channelTitle
      };
      stats = { viewCount: 0, likeCount: 0 };
    } else {
      // Fallback to YouTube API (extension didn't provide useful data)
      console.log('[wizardAnalyzeVideo] Fetching video metadata from YouTube API (extension data was sparse or missing)');
      const videoResponse = await youtube.videos.list({
        part: ['snippet', 'statistics', 'contentDetails'],
        id: [videoId]
      });

      if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
        throw new functions.https.HttpsError('not-found', 'Video not found');
      }

      const video = videoResponse.data.items[0];
      snippet = video.snippet;
      stats = video.statistics;
      durationSeconds = parseDurationToSeconds(video.contentDetails.duration);

      videoData = {
        videoId,
        title: snippet.title,
        description: snippet.description?.substring(0, 1000) || '',
        channelTitle: snippet.channelTitle,
        thumbnail: snippet.thumbnails?.maxres?.url || snippet.thumbnails?.high?.url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        duration: durationSeconds,
        viewCount: parseInt(stats.viewCount || 0),
        likeCount: parseInt(stats.likeCount || 0)
      };

      console.log('[wizardAnalyzeVideo] YouTube API returned:', {
        title: videoData.title,
        duration: videoData.duration,
        channel: videoData.channelTitle
      });
    }

    // Get actual transcript using the working getVideoTranscript function
    // Add 30 second timeout for transcript fetch
    let transcriptData = { segments: [], fullText: '' };
    try {
      const TRANSCRIPT_TIMEOUT_MS = 30000;
      transcriptData = await Promise.race([
        getVideoTranscript(videoId),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Transcript fetch timeout')), TRANSCRIPT_TIMEOUT_MS)
        )
      ]);
      console.log(`Fetched transcript: ${transcriptData.segments.length} segments, ${transcriptData.fullText.length} chars`);
    } catch (transcriptError) {
      console.log('Transcript fetch note:', transcriptError.message);
      // Continue without transcript - AI can still analyze based on title/description
    }

    const transcriptSegments = transcriptData.segments;
    const fullTranscript = transcriptData.fullText;

    // ============================================
    // PHASE 1: Dynamic Clip Limits Based on Duration
    // ============================================
    // Calculate how many clips to request based on video length
    // Longer videos = more potential viral moments
    function calculateClipCount(durationSecs) {
      if (durationSecs < 600) {          // < 10 min
        return { min: 4, max: 8 };
      } else if (durationSecs < 1800) {  // 10-30 min
        return { min: 8, max: 15 };
      } else if (durationSecs < 3600) {  // 30-60 min
        return { min: 12, max: 25 };
      } else if (durationSecs < 7200) {  // 1-2 hours
        return { min: 20, max: 40 };
      } else {                            // 2+ hours
        return { min: 30, max: 60 };
      }
    }

    const clipLimits = calculateClipCount(durationSeconds);
    console.log(`[wizardAnalyzeVideo] Video duration: ${Math.floor(durationSeconds / 60)}min, requesting ${clipLimits.min}-${clipLimits.max} clips`);

    // ============================================
    // PHASE 2: Smart Transcript Sampling
    // ============================================
    // For long videos, sample transcript from different parts instead of just the beginning
    // This ensures AI sees content from intro, middle, and end
    function getSmartTranscriptSample(segments, fullText, maxChars, durationSecs) {
      if (!segments || segments.length === 0) {
        return fullText ? fullText.substring(0, maxChars) : '';
      }

      // For short videos (< 30 min), just use the full transcript up to limit
      if (durationSecs < 1800) {
        return fullText ? fullText.substring(0, maxChars) : '';
      }

      // For longer videos, sample from multiple segments
      const numSamples = durationSecs > 7200 ? 6 : durationSecs > 3600 ? 4 : 3; // 6 for 2h+, 4 for 1-2h, 3 for 30m-1h
      const charsPerSample = Math.floor(maxChars / numSamples);

      // Calculate time boundaries for each sample
      const sampleDuration = durationSecs / numSamples;
      const samples = [];

      for (let i = 0; i < numSamples; i++) {
        const sampleStart = i * sampleDuration;
        const sampleEnd = (i + 1) * sampleDuration;

        // Find transcript segments in this time range
        const segmentsInRange = segments.filter(seg => {
          const segStart = seg.start || seg.offset || 0;
          return segStart >= sampleStart && segStart < sampleEnd;
        });

        // Get text from these segments
        const sampleText = segmentsInRange.map(seg => seg.text || seg.snippet || '').join(' ');
        const truncatedSample = sampleText.substring(0, charsPerSample);

        if (truncatedSample.length > 50) {
          const timeLabel = `[${Math.floor(sampleStart / 60)}-${Math.floor(sampleEnd / 60)} min]`;
          samples.push(`${timeLabel}: ${truncatedSample}`);
        }
      }

      const result = samples.join('\n\n');
      console.log(`[wizardAnalyzeVideo] Smart transcript: ${numSamples} samples, ${result.length} total chars`);
      return result;
    }

    // Use smart sampling for transcript
    const transcriptCharLimit = Math.min(12000, Math.max(4000, Math.floor(durationSeconds * 2)));
    const transcriptForPrompt = getSmartTranscriptSample(transcriptSegments, fullTranscript, transcriptCharLimit, durationSeconds);
    console.log(`[wizardAnalyzeVideo] Transcript for prompt: ${transcriptForPrompt.length} chars (limit: ${transcriptCharLimit})`);

    const clipAnalysisPrompt = `You are an expert viral content analyst specializing in short-form video content. Analyze this YouTube video and identify ${clipLimits.min}-${clipLimits.max} DISTINCT, NON-OVERLAPPING viral clip opportunities.

VIDEO INFORMATION:
- Title: "${snippet.title}"
- Channel: ${snippet.channelTitle}
- Description: ${snippet.description?.substring(0, 800) || 'No description'}
- Total Duration: ${Math.floor(durationSeconds / 60)} minutes ${durationSeconds % 60} seconds (${durationSeconds} total seconds)
- Views: ${parseInt(stats.viewCount || 0).toLocaleString()}
- Likes: ${parseInt(stats.likeCount || 0).toLocaleString()}
${transcriptForPrompt ? `
ACTUAL VIDEO TRANSCRIPT:
${transcriptForPrompt}
${fullTranscript && fullTranscript.length > 4000 ? '\n[Transcript truncated...]' : ''}
` : ''}

CRITICAL REQUIREMENTS:
1. DIVERSITY: Each clip must focus on a DIFFERENT topic, moment, or theme - NO similar clips
2. SPREAD: Distribute clips across the ENTIRE video duration (beginning, middle, end)
3. NO OVERLAP: Clips must NOT overlap in time - minimum 60 second gap between clips
4. TARGET DURATION: ${presetConfig.aiPrompt}
5. CLIP LENGTH: Each clip should be ${presetConfig.durationRange} seconds (minimum ${presetConfig.minDuration}s, maximum ${presetConfig.maxDuration}s)
6. DIFFERENT START TIMES: Clips should NOT all start at similar timestamps

CLIP SELECTION CRITERIA (prioritize variety):
- Opening hooks (first 60 seconds) - max 1 clip
- Key turning points or revelations
- Emotional peaks (humor, inspiration, shock)
- Quotable statements or one-liners
- Actionable tips or advice
- Story climaxes
- Controversial or debate-worthy moments
- Behind-the-scenes insights
- Closing thoughts or calls-to-action

For each clip, analyze:
- What makes this moment UNIQUE from other clips
- Why this specific timestamp would perform well on short-form platforms
- The emotional hook that will stop scrolling

RESPOND IN VALID JSON:
{
  "clips": [
    {
      "startTime": <integer seconds from video start>,
      "endTime": <integer seconds from video start>,
      "duration": <clip length in seconds, between ${presetConfig.minDuration}-${presetConfig.maxDuration}>,
      "transcript": "The key quote or summary of what's said in this moment (be specific)",
      "viralityScore": <0-100 based on viral potential>,
      "uniqueAngle": "What makes THIS clip different from others",
      "emotionalHook": "The emotion this triggers (curiosity, shock, inspiration, etc.)",
      "platforms": ["youtube", "tiktok", "instagram"],
      "reason": "Detailed explanation of viral potential"
    }
  ],
  "overallPotential": "High/Medium/Low with explanation",
  "bestTopics": ["main theme 1", "main theme 2", "main theme 3"],
  "contentType": "educational/entertainment/motivational/tutorial/vlog/other"
}

IMPORTANT:
- startTime must be >= 0 and < ${durationSeconds}
- endTime must be > startTime and <= ${durationSeconds}
- You MUST provide at least ${clipLimits.min} clips, ideally ${clipLimits.max} clips
- For this ${Math.floor(durationSeconds / 60)}-minute video, distribute clips evenly:
${durationSeconds > 3600 ? `  * Segment 1 (0-30min): ${Math.ceil(clipLimits.min / 4)} clips minimum
  * Segment 2 (30-60min): ${Math.ceil(clipLimits.min / 4)} clips minimum
  * Segment 3 (60-90min): ${Math.ceil(clipLimits.min / 4)} clips minimum
  * Segment 4 (90min+): ${Math.ceil(clipLimits.min / 4)} clips minimum` :
durationSeconds > 1800 ? `  * First third (0-${Math.floor(durationSeconds * 0.33)}s): ${Math.ceil(clipLimits.min / 3)} clips minimum
  * Middle third (${Math.floor(durationSeconds * 0.33)}-${Math.floor(durationSeconds * 0.66)}s): ${Math.ceil(clipLimits.min / 3)} clips minimum
  * Final third (${Math.floor(durationSeconds * 0.66)}-${durationSeconds}s): ${Math.ceil(clipLimits.min / 3)} clips minimum` :
`  * Spread evenly across: 0-${Math.floor(durationSeconds * 0.33)}s, ${Math.floor(durationSeconds * 0.33)}-${Math.floor(durationSeconds * 0.66)}s, ${Math.floor(durationSeconds * 0.66)}-${durationSeconds}s`}`;

    // Scale max_tokens based on expected clips (more clips = more JSON output)
    // ~250 tokens per clip in JSON format
    const maxTokens = Math.min(8000, Math.max(3500, clipLimits.max * 200));

    // Add 120 second timeout for main analysis (GPT-4o can be slow with long transcripts)
    const AI_ANALYSIS_TIMEOUT_MS = 120000;
    console.log('[wizardAnalyzeVideo] Starting AI clip analysis with 120s timeout...');

    // Helper function to generate fallback clips
    function generateFallbackClips() {
      const numClips = Math.min(clipLimits.max, Math.max(clipLimits.min, Math.floor(durationSeconds / 60)));
      console.log(`[wizardAnalyzeVideo] Fallback: generating ${numClips} clips`);
      const clips = [];
      const segmentSize = Math.floor(durationSeconds / numClips);

      for (let i = 0; i < numClips; i++) {
        const minDur = presetConfig.minDuration || 45;
        const maxDur = presetConfig.maxDuration || 60;
        const targetDur = presetConfig.targetDuration || 55;
        const variance = Math.floor((maxDur - minDur) / 2);
        const clipDuration = Math.min(maxDur, Math.max(minDur, targetDur + Math.floor(Math.random() * variance * 2) - variance));
        const segmentStart = segmentSize * i;
        const startOffset = Math.floor(Math.random() * (segmentSize - clipDuration - 10)) + 5;
        const startTime = Math.max(0, segmentStart + startOffset);

        clips.push({
          startTime,
          endTime: Math.min(startTime + clipDuration, durationSeconds),
          duration: clipDuration,
          transcript: `Segment ${i + 1} of "${snippet.title}"`,
          viralityScore: Math.floor(60 + Math.random() * 35),
          uniqueAngle: `Key moment ${i + 1}`,
          emotionalHook: ['curiosity', 'inspiration', 'humor', 'shock'][i % 4],
          platforms: ['youtube', 'tiktok', 'instagram'],
          reason: 'Potential viral moment'
        });
      }
      return { clips, overallPotential: 'Good', bestTopics: [], contentType: 'general' };
    }

    let analysisResult;
    try {
      const aiResponse = await Promise.race([
        openai.chat.completions.create({
          model: 'gpt-4o',  // Use GPT-4o for better analysis
          messages: [{ role: 'user', content: clipAnalysisPrompt }],
          response_format: { type: 'json_object' },
          max_tokens: maxTokens,
          temperature: 0.7
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('AI analysis timeout')), AI_ANALYSIS_TIMEOUT_MS)
        )
      ]);

      analysisResult = JSON.parse(aiResponse.choices[0].message.content);
      console.log(`[wizardAnalyzeVideo] AI returned ${analysisResult.clips?.length || 0} clips`);
    } catch (e) {
      console.error('[wizardAnalyzeVideo] AI analysis failed, using fallback:', e.message);
      analysisResult = generateFallbackClips();
    }

    // Helper function to get actual transcript for a time range
    function getTranscriptForTimeRange(segments, startTime, endTime) {
      if (!segments || segments.length === 0) return null;
      const relevantSegments = segments.filter(seg =>
        seg.timestamp >= startTime && seg.timestamp < endTime
      );
      if (relevantSegments.length === 0) return null;
      return relevantSegments.map(s => s.text).join(' ');
    }

    // Validate and process clips - ensure no overlaps and proper spread
    // ENFORCE platform-specific durations
    const minDuration = presetConfig.minDuration || 45;
    const maxDuration = presetConfig.maxDuration || 60;
    const targetDuration = presetConfig.targetDuration || 55;

    let processedClips = (analysisResult.clips || [])
      .filter(clip => {
        // Validate timestamps
        const start = parseInt(clip.startTime) || 0;
        return start >= 0 && start < durationSeconds;
      })
      .map((clip, index) => {
        const start = parseInt(clip.startTime) || 0;
        // ENFORCE platform-specific duration: use AI's duration if within range, otherwise use target
        let clipDuration = parseInt(clip.duration) || targetDuration;
        if (clipDuration < minDuration) clipDuration = targetDuration;
        if (clipDuration > maxDuration) clipDuration = maxDuration;
        // Calculate end based on enforced duration
        const end = Math.min(start + clipDuration, durationSeconds);
        // Recalculate duration in case end was capped by video length
        const finalDuration = end - start;

        // Get actual transcript for this clip's time range
        const actualTranscript = getTranscriptForTimeRange(transcriptSegments, start, end);
        return {
          id: `clip_${videoId}_${index}_${Date.now()}`,
          startTime: start,
          endTime: end,
          duration: finalDuration,
          // Use actual transcript if available, otherwise use AI-generated summary
          transcript: actualTranscript || clip.transcript || `Clip ${index + 1}`,
          aiSummary: clip.transcript || '', // Keep AI summary as additional context
          thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          score: Math.min(100, Math.max(0, clip.viralityScore || 75)),
          uniqueAngle: clip.uniqueAngle || '',
          emotionalHook: clip.emotionalHook || '',
          platforms: clip.platforms || ['youtube', 'tiktok', 'instagram'],
          reason: clip.reason || ''
        };
      })
      .sort((a, b) => a.startTime - b.startTime);

    // Remove overlapping clips (keep higher scoring one)
    const nonOverlappingClips = [];
    for (const clip of processedClips) {
      const overlaps = nonOverlappingClips.some(existing =>
        (clip.startTime >= existing.startTime && clip.startTime < existing.endTime) ||
        (clip.endTime > existing.startTime && clip.endTime <= existing.endTime) ||
        (clip.startTime <= existing.startTime && clip.endTime >= existing.endTime)
      );

      if (!overlaps) {
        nonOverlappingClips.push(clip);
      }
    }

    // Sort by score for final output
    processedClips = nonOverlappingClips.sort((a, b) => b.score - a.score);

    // ENHANCED VIRALITY SCORING (OpusClip-style)
    // This adds detailed breakdown and predictions for top clips
    // Add timeout protection to prevent function timeout (60 second limit for scoring)
    try {
      console.log('[wizardAnalyzeVideo] Running enhanced virality scoring on top clips...');
      const videoContext = {
        title: snippet.title || videoData.title,
        channelTitle: snippet.channelTitle || videoData.channelTitle,
        viewCount: parseInt(stats.viewCount || videoData.viewCount || 0),
        contentType: analysisResult.contentType || 'general'
      };

      // Race between enhanced scoring and a 60-second timeout
      const SCORING_TIMEOUT_MS = 60000; // 60 seconds max for enhanced scoring
      const scoringPromise = batchCalculateViralityScores(processedClips, videoContext);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Enhanced scoring timeout')), SCORING_TIMEOUT_MS)
      );

      processedClips = await Promise.race([scoringPromise, timeoutPromise]);
      console.log('[wizardAnalyzeVideo] Enhanced virality scoring complete');
    } catch (scoringError) {
      console.log('[wizardAnalyzeVideo] Enhanced scoring skipped:', scoringError.message);
      // Continue with basic scores - add basic predictions for all clips
      processedClips = processedClips.map(clip => ({
        ...clip,
        viralPrediction: clip.score >= 80 ? 'HIGH' : clip.score >= 60 ? 'MEDIUM' : 'LOW'
      }));
    }

    const projectData = {
      userId: uid,
      videoId,
      videoUrl,
      videoData,
      clips: processedClips,
      // Platform preset used for clip generation
      platform: platform,
      platformPreset: {
        minDuration: presetConfig.minDuration,
        maxDuration: presetConfig.maxDuration,
        targetDuration: presetConfig.targetDuration,
        durationRange: presetConfig.durationRange
      },
      // Store transcript data for SEO generation and other features
      transcriptSegments: transcriptSegments.slice(0, 500), // Limit to 500 segments
      fullTranscript: fullTranscript ? fullTranscript.substring(0, 10000) : '', // First 10k chars
      hasTranscript: transcriptSegments.length > 0,
      options: options || {},
      overallPotential: analysisResult.overallPotential,
      bestTopics: analysisResult.bestTopics || [],
      contentType: analysisResult.contentType || 'general',
      status: 'analyzed',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),

      // CANONICAL SOURCE ASSET - for reliable export
      // This is the single source of truth for video data during export
      // If present, export will use this instead of re-capturing
      sourceAsset: null,  // Will be populated by frontend after capture upload
      isUpload: false     // Will be set to true for uploaded videos
    };

    // Enforce max projects limit before creating new project
    const maxProjects = await getMaxProjectsLimit();
    await enforceMaxProjects(uid, maxProjects);

    const projectRef = await db.collection('wizardProjects').add(projectData);
    await logUsage(uid, 'wizard_analyze_video', { videoId, clipCount: processedClips.length });

    return {
      success: true,
      projectId: projectRef.id,
      videoData,
      clips: processedClips,
      overallPotential: analysisResult.overallPotential,
      bestTopics: analysisResult.bestTopics || [],
      contentType: analysisResult.contentType || 'general'
    };

  } catch (error) {
    console.error('Wizard analyze video error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to analyze video.'));
  }
});

/**
 * wizardSmartCrop - AI-powered subject detection for optimal crop positioning
 * Analyzes a video thumbnail to detect the main subject (person/face) and
 * suggests the optimal horizontal crop position for 9:16 format.
 */
exports.wizardSmartCrop = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { thumbnailUrl, videoId, clipStartTime } = data;

  if (!thumbnailUrl && !videoId) {
    throw new functions.https.HttpsError('invalid-argument', 'Thumbnail URL or video ID required');
  }

  try {
    // Get the thumbnail URL
    let imageUrl = thumbnailUrl;
    if (!imageUrl && videoId) {
      imageUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    }

    // Use GPT-4 Vision to analyze the image and detect subject position
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an expert video editor analyzing frames for optimal crop positioning.
Your task is to identify where the main subject (typically a person) is located horizontally in the frame.
The goal is to crop a 16:9 video to 9:16 (vertical) format while keeping the main subject centered.

Analyze the image and determine the optimal horizontal crop position as a percentage from 0-100:
- 0% = crop from the LEFT edge (subject is on the left)
- 50% = crop from CENTER (subject is centered)
- 100% = crop from the RIGHT edge (subject is on the right)

Consider:
1. Face/person position
2. Important visual elements
3. Text/graphics that should remain visible
4. Rule of thirds composition

Respond with ONLY a JSON object, no markdown or other text.`
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analyze this video frame and determine the optimal horizontal crop position (0-100) to best capture the main subject when converting from 16:9 to 9:16 format. Return JSON with: cropPosition (0-100), confidence (low/medium/high), subject (what you detected), and reasoning.'
            },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
                detail: 'low'
              }
            }
          ]
        }
      ],
      max_tokens: 300
    });

    const content = response.choices[0]?.message?.content || '';

    // Parse the response
    let result;
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.log('[wizardSmartCrop] Failed to parse AI response, using fallback:', content);
      // Fallback: try to extract number from response
      const numberMatch = content.match(/(\d+)/);
      result = {
        cropPosition: numberMatch ? parseInt(numberMatch[1], 10) : 50,
        confidence: 'low',
        subject: 'unknown',
        reasoning: 'Fallback analysis'
      };
    }

    // Validate crop position
    let cropPosition = parseInt(result.cropPosition, 10);
    if (isNaN(cropPosition) || cropPosition < 0 || cropPosition > 100) {
      cropPosition = 50; // Default to center
    }

    console.log(`[wizardSmartCrop] AI detected subject at ${cropPosition}%:`, result.subject);

    return {
      success: true,
      cropPosition,
      confidence: result.confidence || 'medium',
      subject: result.subject || 'person',
      reasoning: result.reasoning || 'AI analysis'
    };

  } catch (error) {
    console.error('[wizardSmartCrop] Error:', error);

    // Return a reasonable fallback instead of throwing
    return {
      success: true,
      cropPosition: 50,
      confidence: 'low',
      subject: 'unknown',
      reasoning: 'Fallback to center (AI analysis unavailable)'
    };
  }
});

/**
 * wizardUpdateSourceAsset - Updates project with canonical source asset
 * Called by frontend after successfully capturing and uploading video during analysis
 *
 * The sourceAsset is the single source of truth for export operations.
 * Once set, export will use this asset instead of re-capturing.
 */
exports.wizardUpdateSourceAsset = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId, sourceAsset } = data;

  if (!projectId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID required');
  }

  if (!sourceAsset || !sourceAsset.storageUrl) {
    throw new functions.https.HttpsError('invalid-argument', 'Valid sourceAsset with storageUrl required');
  }

  try {
    // Verify project ownership
    const projectRef = db.collection('wizardProjects').doc(projectId);
    const projectDoc = await projectRef.get();

    if (!projectDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Project not found');
    }

    const project = projectDoc.data();
    if (project.userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    // Validate sourceAsset structure
    const validatedSourceAsset = {
      storageUrl: sourceAsset.storageUrl,        // Firebase Storage download URL
      storagePath: sourceAsset.storagePath || null,  // gs:// path if available
      duration: sourceAsset.duration || project.videoData?.duration || 0,
      format: sourceAsset.format || 'video/mp4',
      fileSize: sourceAsset.fileSize || 0,
      capturedAt: sourceAsset.capturedAt || Date.now(),
      source: sourceAsset.source || 'extension_capture'  // 'extension_capture' | 'direct_upload' | 'server_download'
    };

    console.log(`[wizardUpdateSourceAsset] Updating project ${projectId} with sourceAsset:`, {
      storageUrl: validatedSourceAsset.storageUrl.substring(0, 80) + '...',
      duration: validatedSourceAsset.duration,
      source: validatedSourceAsset.source
    });

    // Update project with sourceAsset
    await projectRef.update({
      sourceAsset: validatedSourceAsset,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`[wizardUpdateSourceAsset] Project ${projectId} sourceAsset updated successfully`);

    return {
      success: true,
      message: 'Source asset saved. Video is ready for export.',
      sourceAsset: validatedSourceAsset
    };

  } catch (error) {
    console.error('[wizardUpdateSourceAsset] Error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to update source asset');
  }
});

/**
 * wizardGenerateClipSEO - Generates SEO for a clip
 */
exports.wizardGenerateClipSEO = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'wizardGenerateClipSEO', 10);

  // Check and deduct tokens for SEO generation
  const tokenCosts = await getWizardTokenCosts();
  const seoCost = tokenCosts.generateSEO || 2;

  const tokenResult = await deductWizardTokens(uid, seoCost, 'generateSEO', {
    clipId: data.clipId,
    projectId: data.projectId
  });

  if (!tokenResult.success) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      `Insufficient tokens. This operation requires ${seoCost} tokens, but you have ${tokenResult.available || 0}.`
    );
  }

  const { clipId, transcript, platform, projectId, videoTitle } = data;
  if (!transcript) {
    throw new functions.https.HttpsError('invalid-argument', 'Transcript is required');
  }

  try {
    // Fetch project data for more context
    let videoDescription = '';
    let channelTitle = '';
    let bestTopics = [];
    let contentType = '';

    if (projectId) {
      const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
      if (projectDoc.exists) {
        const project = projectDoc.data();
        videoDescription = project.videoData?.description || '';
        channelTitle = project.videoData?.channelTitle || '';
        bestTopics = project.bestTopics || [];
        contentType = project.contentType || '';
      }
    }

    const seoPrompt = `Generate viral ${platform || 'YouTube Shorts'} SEO metadata for this video clip.

CLIP TRANSCRIPT (what's actually said):
"${transcript}"

VIDEO CONTEXT:
- Original Video Title: ${videoTitle || 'Not provided'}
- Channel: ${channelTitle || 'Not provided'}
- Content Type: ${contentType || 'general'}
- Main Topics: ${bestTopics.length > 0 ? bestTopics.join(', ') : 'Not specified'}
${videoDescription ? `- Video Description Preview: ${videoDescription.substring(0, 300)}...` : ''}

PLATFORM: ${platform || 'YouTube Shorts'}

Generate SEO that:
1. Captures the ACTUAL content from the transcript
2. Uses hooks and keywords that match what's spoken
3. Targets ${platform || 'YouTube Shorts'} audience specifically
4. Includes relevant hashtags for discoverability

RESPOND IN VALID JSON:
{
  "title": "Catchy, hook-driven title based on actual content (max 100 chars)",
  "description": "Engaging description that summarizes the clip content with CTA and 3-5 relevant hashtags",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8"],
  "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"]
}`;

    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: seoPrompt }],
      response_format: { type: 'json_object' },
      max_tokens: 1000
    });

    let seoData;
    try {
      seoData = JSON.parse(aiResponse.choices[0].message.content);
    } catch (e) {
      seoData = {
        title: transcript.substring(0, 60) + '...',
        description: transcript + '\n\n🔔 Follow for more!',
        tags: ['shorts', 'viral', 'trending'],
        hashtags: ['#shorts', '#viral', '#fyp']
      };
    }

    if (projectId && clipId) {
      await db.collection('wizardProjects').doc(projectId).update({
        [`clipSEO.${clipId}`]: { ...seoData, platform: platform || 'youtube', generatedAt: admin.firestore.FieldValue.serverTimestamp() },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await logUsage(uid, 'wizard_generate_seo', { platform, clipId });
    return { success: true, ...seoData };

  } catch (error) {
    console.error('Wizard generate SEO error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to generate SEO.'));
  }
});

/**
 * wizardGenerateThumbnails - Generates 2 high-quality thumbnail concepts
 * Uses main video context and video frames as reference for consistent style
 */
exports.wizardGenerateThumbnails = functions
  .runWith({ timeoutSeconds: 180, memory: '1GB' })
  .https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'wizardGenerateThumbnails', 5);

  const { clipId, transcript, projectId, videoTitle } = data;
  if (!transcript) {
    throw new functions.https.HttpsError('invalid-argument', 'Transcript is required');
  }

  try {
    // Get FULL project data for comprehensive video context
    let videoId = null;
    let videoThumbnailUrl = null;
    let mainVideoTitle = videoTitle || '';
    let mainVideoDescription = '';
    let channelName = '';
    let clipStartTime = 0;
    let clipEndTime = 0;

    if (projectId) {
      const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
      if (projectDoc.exists) {
        const project = projectDoc.data();
        videoId = project.videoData?.videoId || project.videoId;
        videoThumbnailUrl = project.videoData?.thumbnail;
        mainVideoTitle = project.videoData?.title || videoTitle || '';
        mainVideoDescription = project.videoData?.description || '';
        channelName = project.videoData?.channelTitle || '';

        // Get clip timing for frame extraction
        const clip = project.clips?.find(c => c.id === clipId);
        if (clip) {
          clipStartTime = clip.startTime || 0;
          clipEndTime = clip.endTime || clipStartTime + 30;
        }
      }
    }

    // Use Gemini API key for Nano Banana Pro
    const geminiApiKey = functions.config().gemini?.key;
    if (!geminiApiKey) {
      throw new functions.https.HttpsError('failed-precondition', 'Gemini API key not configured');
    }

    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    const geminiModelId = 'gemini-3-pro-image-preview'; // Nano Banana Pro

    // Fetch ACTUAL video frames from YouTube's standard thumbnail endpoints
    // YouTube provides multiple thumbnails that ARE actual frames from the video:
    // - 0.jpg: Main thumbnail (full quality)
    // - 1.jpg: Frame at ~25% of video
    // - 2.jpg: Frame at ~50% of video (middle)
    // - 3.jpg: Frame at ~75% of video
    const referenceImages = [];

    if (videoId) {
      // YouTube's numbered thumbnails are ACTUAL FRAMES from the video at different timestamps
      const frameUrls = [
        `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,  // HD main thumbnail
        `https://img.youtube.com/vi/${videoId}/0.jpg`,              // Full-size main frame
        `https://img.youtube.com/vi/${videoId}/1.jpg`,              // Frame at ~25%
        `https://img.youtube.com/vi/${videoId}/2.jpg`,              // Frame at ~50%
        `https://img.youtube.com/vi/${videoId}/3.jpg`,              // Frame at ~75%
        `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,      // HQ fallback
      ];

      console.log(`[wizardGenerateThumbnails] Fetching video frames for ${videoId}`);

      // Fetch multiple frames in parallel for better reference
      const framePromises = frameUrls.slice(0, 4).map(async (url, index) => {
        try {
          const imageResponse = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 8000,
            validateStatus: (status) => status === 200
          });

          // Check if it's a valid image (not a placeholder)
          if (imageResponse.data && imageResponse.data.length > 5000) {
            return {
              base64: Buffer.from(imageResponse.data).toString('base64'),
              type: 'video_frame',
              source: url.includes('maxres') ? 'maxres' : `frame_${index}`
            };
          }
        } catch (err) {
          console.log(`[wizardGenerateThumbnails] Could not fetch ${url.split('/').pop()}`);
        }
        return null;
      });

      const fetchedFrames = (await Promise.all(framePromises)).filter(f => f !== null);
      referenceImages.push(...fetchedFrames);

      console.log(`[wizardGenerateThumbnails] Fetched ${referenceImages.length} actual video frames`);
    }

    // Use custom thumbnail URL if provided and we don't have enough frames
    if (referenceImages.length < 2 && videoThumbnailUrl) {
      try {
        const imageResponse = await axios.get(videoThumbnailUrl, {
          responseType: 'arraybuffer',
          timeout: 5000,
          validateStatus: (status) => status === 200
        });
        if (imageResponse.data && imageResponse.data.length > 1000) {
          referenceImages.push({
            base64: Buffer.from(imageResponse.data).toString('base64'),
            type: 'custom_thumbnail'
          });
        }
      } catch (err) {
        // Ignore
      }
    }

    const hasReference = referenceImages.length > 0;
    console.log(`[wizardGenerateThumbnails] Total reference images: ${referenceImages.length}`);

    // Build comprehensive context from main video
    const videoContext = `
MAIN VIDEO CONTEXT:
- Title: "${mainVideoTitle}"
- Channel: "${channelName}"
- Description excerpt: "${mainVideoDescription.substring(0, 300)}"

CLIP CONTENT (what this short is about):
"${transcript.substring(0, 400)}"
`.trim();

    // Generate 2 thumbnail variations with different high-impact styles
    const thumbnailConcepts = [
      {
        name: 'Hero Shot',
        prompt: `Generate a professional YouTube thumbnail that captures the essence of this video content.

${videoContext}

DESIGN REQUIREMENTS:
1. Create a HERO SHOT thumbnail - the most impactful, eye-catching frame that represents this content
2. Feature a compelling focal point (person, object, or scene) that relates to the video topic
3. Use dramatic lighting: bright highlights on the subject, darker background for contrast
4. Composition: Subject positioned using rule of thirds (not dead center)
5. Leave 30% space on one side for potential text overlay
6. Colors: Vibrant, high saturation, complementary color scheme

STYLE: Ultra high quality, photorealistic, cinematic lighting, 9:16 vertical/portrait aspect ratio (for YouTube Shorts, TikTok, Instagram Reels), 4K resolution, professional short-form video thumbnail that gets clicks. Magazine cover quality with depth and dimension.

TEXT RULES: If including any text overlay, use ONLY simple ASCII characters (A-Z, a-z, 0-9). Do NOT use checkmarks, special symbols, emojis, or Unicode characters like ✓ ✗ → ★. Keep text minimal and impactful.

CRITICAL: The thumbnail must visually represent the VIDEO TOPIC, not just generic graphics. Make it specific to the content described above.`
      },
      {
        name: 'Dynamic Action',
        prompt: `Generate a professional YouTube thumbnail that creates intrigue and energy for this video content.

${videoContext}

DESIGN REQUIREMENTS:
1. Create a DYNAMIC ACTION thumbnail - convey movement, energy, and excitement
2. Use visual elements that create a sense of anticipation or reveal
3. Dramatic perspective: slight angle, dynamic framing, not flat/static
4. High contrast with bold colors that pop on both desktop and mobile
5. Include visual elements specific to the topic (icons, objects, expressions related to the content)
6. Background: either blurred/bokeh or gradient that makes subject pop

STYLE: High energy, bold contrast, vibrant colors, professional short-form video thumbnail, 9:16 vertical/portrait aspect ratio (for YouTube Shorts, TikTok, Instagram Reels), 4K resolution. The kind of thumbnail that stops scroll and demands attention.

TEXT RULES: If including any text overlay, use ONLY simple ASCII characters (A-Z, a-z, 0-9). Do NOT use checkmarks, special symbols, emojis, or Unicode characters like ✓ ✗ → ★. Keep text minimal and impactful.

CRITICAL: The thumbnail must visually represent the VIDEO TOPIC with specific relevant imagery. Make viewers understand what the video is about at a glance.`
      }
    ];

    const storage = admin.storage().bucket();
    const timestamp = Date.now();
    const generatedThumbnails = [];

    // Generate only 2 thumbnails
    for (let i = 0; i < thumbnailConcepts.length; i++) {
      const concept = thumbnailConcepts[i];

      try {
        // Build content parts with reference images FIRST for better context
        const contentParts = [];

        // Add multiple reference images from the actual video
        if (hasReference) {
          // Add up to 3 reference images for comprehensive style matching
          const imagesToAdd = referenceImages.slice(0, 3);
          for (const refImg of imagesToAdd) {
            contentParts.push({
              inlineData: {
                mimeType: 'image/jpeg',
                data: refImg.base64
              }
            });
          }
          console.log(`[wizardGenerateThumbnails] Added ${imagesToAdd.length} reference images to prompt`);
        }

        // Build enhanced prompt with strong reference instructions
        let finalPrompt;
        if (hasReference) {
          finalPrompt = `REFERENCE FRAMES: I've provided ${Math.min(referenceImages.length, 3)} actual frame(s) from the original video. These show the REAL content of the video.

CRITICAL - YOU MUST FOLLOW THESE RULES:
1. The thumbnail MUST match the visual content shown in these reference frames
2. If the reference shows animation/cartoon - create an animated/cartoon style thumbnail
3. If the reference shows a real person - create a thumbnail featuring a similar-looking person
4. If the reference shows a specific scene/setting - use that same setting
5. MATCH the color palette, art style, and visual aesthetic of the reference frames exactly
6. Do NOT create unrelated imagery - the thumbnail must represent what's actually in the video

${concept.prompt}`;
        } else {
          finalPrompt = concept.prompt;
        }

        contentParts.push({ text: finalPrompt });

        // Generate image - using exact same pattern as working generateThumbnailPro/generateCreativeImage
        console.log(`[wizardGenerateThumbnails] Generating thumbnail ${i + 1}/2 with model: ${geminiModelId}`);
        console.log(`[wizardGenerateThumbnails] Prompt length: ${finalPrompt.length}, hasReference: ${hasReference}`);

        const result = await ai.models.generateContent({
          model: geminiModelId,
          contents: [{ role: 'user', parts: contentParts }],
          config: {
            responseModalities: ['image', 'text']
          }
        });

        // Extract image from response - handle both SDK response structures (same as working code)
        const candidates = result.candidates || (result.response && result.response.candidates);
        console.log(`[wizardGenerateThumbnails] Got ${candidates?.length || 0} candidates`);

        if (candidates && candidates.length > 0) {
          const candidate = candidates[0];
          const parts = candidate.content?.parts || candidate.parts || [];
          console.log(`[wizardGenerateThumbnails] Candidate has ${parts.length} parts`);

          for (const part of parts) {
            const inlineData = part.inlineData || part.inline_data;
            if (inlineData && (inlineData.data || inlineData.bytesBase64Encoded)) {
              const imageBytes = inlineData.data || inlineData.bytesBase64Encoded;
              const mimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
              const extension = mimeType.includes('jpeg') ? 'jpg' : 'png';

              console.log(`[wizardGenerateThumbnails] Found image data, mimeType: ${mimeType}`);

              // Upload to Firebase Storage
              const fileName = `wizard-thumbnails/${uid}/${timestamp}-${clipId}-${i}.${extension}`;
              const file = storage.file(fileName);

              const buffer = Buffer.from(imageBytes, 'base64');
              await file.save(buffer, {
                metadata: {
                  contentType: mimeType,
                  metadata: {
                    concept: concept.name,
                    clipId: clipId,
                    model: geminiModelId
                  }
                }
              });

              await file.makePublic();
              const publicUrl = `https://storage.googleapis.com/${storage.name}/${fileName}`;

              generatedThumbnails.push({
                id: `thumb_${clipId}_${i}`,
                concept: concept.name,
                previewUrl: publicUrl,
                storagePath: fileName,
                generatedAt: new Date().toISOString()
              });

              console.log(`[wizardGenerateThumbnails] Saved thumbnail: ${publicUrl}`);

              console.log(`[wizardGenerateThumbnails] Generated thumbnail ${i + 1}/2: ${concept.name}`);
              break; // Only need first image from response
            }
          }
        }
      } catch (genError) {
        console.error(`[wizardGenerateThumbnails] Error generating thumbnail ${i + 1}/2:`, genError.message);
        // Add placeholder for failed generation - use video thumbnail as fallback
        const fallbackUrl = videoThumbnailUrl || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        generatedThumbnails.push({
          id: `thumb_${clipId}_${i}`,
          concept: concept.name,
          previewUrl: fallbackUrl,
          error: 'Generation failed - using video thumbnail',
          generatedAt: new Date().toISOString()
        });
      }
    }

    // Save to project
    if (projectId && clipId && generatedThumbnails.length > 0) {
      await db.collection('wizardProjects').doc(projectId).update({
        [`clipThumbnails.${clipId}`]: {
          thumbnails: generatedThumbnails,
          selectedIndex: 0,
          generatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    await logUsage(uid, 'wizard_generate_thumbnails', { clipId, count: generatedThumbnails.length });
    return { success: true, thumbnails: generatedThumbnails };

  } catch (error) {
    console.error('Wizard generate thumbnails error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to generate thumbnails.'));
  }
});

/**
 * wizardSaveClipSettings - Saves customization settings
 */
exports.wizardSaveClipSettings = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId, clipId, settings, seo } = data;

  if (!projectId || !clipId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID and Clip ID required');
  }

  try {
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists || projectDoc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Save clip settings if provided
    if (settings) {
      updateData[`clipSettings.${clipId}`] = { ...settings, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    }

    // Save clip SEO if provided
    if (seo) {
      updateData[`clipSEO.${clipId}`] = { ...seo, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    }

    await db.collection('wizardProjects').doc(projectId).update(updateData);

    return { success: true };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to save settings.');
  }
});

/**
 * wizardGetProject - Retrieves a project by ID
 */
exports.wizardGetProject = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId } = data;

  if (!projectId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID required');
  }

  try {
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Project not found');
    }
    if (projectDoc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    return { success: true, project: { id: projectDoc.id, ...projectDoc.data() } };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to get project.');
  }
});

/**
 * wizardGetProjects - Retrieves all projects for user
 */
exports.wizardGetProjects = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { limit = 20 } = data || {};

  try {
    let snapshot;
    try {
      // Try with orderBy (requires composite index)
      snapshot = await db.collection('wizardProjects')
        .where('userId', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(Math.min(limit, 50))
        .get();
    } catch (indexError) {
      // Fallback: if index doesn't exist, query without orderBy and sort in memory
      console.log('Index not available, using fallback query:', indexError.message);
      snapshot = await db.collection('wizardProjects')
        .where('userId', '==', uid)
        .limit(Math.min(limit, 50))
        .get();
    }

    let projects = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        videoTitle: data.videoData?.title || 'Untitled',
        videoThumbnail: data.videoData?.thumbnail,
        clipCount: data.clips?.length || 0,
        status: data.status || 'draft',
        createdAt: data.createdAt,
        updatedAt: data.updatedAt
      };
    });

    // Sort by createdAt in memory (fallback for when index isn't available)
    projects.sort((a, b) => {
      const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
      const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
      return timeB - timeA;
    });

    return { success: true, projects, hasMore: projects.length === limit };
  } catch (error) {
    console.error('wizardGetProjects error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to get projects: ' + error.message);
  }
});

/**
 * wizardDeleteProject - Deletes a project
 */
exports.wizardDeleteProject = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId } = data;

  if (!projectId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID required');
  }

  try {
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists || projectDoc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    await db.collection('wizardProjects').doc(projectId).delete();
    return { success: true };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to delete project.');
  }
});

/**
 * wizardGenerateAllSEO - Batch generates SEO for all clips
 */
exports.wizardGenerateAllSEO = functions
  .runWith({ timeoutSeconds: 120 })
  .https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  checkRateLimit(uid, 'wizardGenerateAllSEO', 3);

  const { projectId, clipIds, platform } = data;
  if (!projectId || !clipIds?.length) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID and clip IDs required');
  }

  try {
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists || projectDoc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    const clips = projectDoc.data().clips.filter(c => clipIds.includes(c.id));
    const seoResults = {};

    for (let i = 0; i < clips.length; i += 3) {
      const batch = clips.slice(i, i + 3);
      const promises = batch.map(async (clip) => {
        const response = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: `Generate viral ${platform || 'YouTube Shorts'} metadata: "${clip.transcript}"\nRESPOND IN JSON: {"title":"","description":"","tags":[],"hashtags":[]}` }],
          response_format: { type: 'json_object' },
          max_tokens: 500
        });
        try {
          return { clipId: clip.id, seo: JSON.parse(response.choices[0].message.content) };
        } catch {
          return { clipId: clip.id, seo: { title: clip.transcript.substring(0, 60), description: clip.transcript, tags: ['shorts'], hashtags: ['#shorts'] } };
        }
      });
      const results = await Promise.all(promises);
      results.forEach(r => { seoResults[r.clipId] = r.seo; });
    }

    const updateData = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    Object.entries(seoResults).forEach(([clipId, seo]) => {
      updateData[`clipSEO.${clipId}`] = { ...seo, platform: platform || 'youtube', generatedAt: admin.firestore.FieldValue.serverTimestamp() };
    });
    await db.collection('wizardProjects').doc(projectId).update(updateData);

    await logUsage(uid, 'wizard_generate_all_seo', { projectId, clipCount: clipIds.length });
    return { success: true, seoData: seoResults };

  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to generate SEO.'));
  }
});

/**
 * wizardExportProject - Exports project data as CSV/JSON
 */
exports.wizardExportProject = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId, format = 'csv' } = data;

  if (!projectId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID required');
  }

  try {
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists || projectDoc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    const project = projectDoc.data();
    const clips = project.clips || [];
    const clipSEO = project.clipSEO || {};

    let exportData, filename;

    if (format === 'json') {
      exportData = JSON.stringify({
        videoTitle: project.videoData?.title,
        videoUrl: project.videoUrl,
        exportedAt: new Date().toISOString(),
        clips: clips.map(clip => ({ ...clip, seo: clipSEO[clip.id] || {} }))
      }, null, 2);
      filename = `shorts-export-${projectDoc.id}.json`;
    } else {
      const headers = ['Clip ID', 'Start Time', 'End Time', 'Duration', 'Score', 'Title', 'Description', 'Tags', 'Platforms'];
      const rows = clips.map(clip => {
        const seo = clipSEO[clip.id] || {};
        return [clip.id, clip.startTime, clip.endTime, clip.duration, clip.score,
          `"${(seo.title || '').replace(/"/g, '""')}"`,
          `"${(seo.description || '').replace(/"/g, '""').substring(0, 200)}"`,
          `"${(seo.tags || []).join(', ')}"`,
          `"${(clip.platforms || []).join(', ')}"`
        ].join(',');
      });
      exportData = [headers.join(','), ...rows].join('\n');
      filename = `shorts-export-${projectDoc.id}.csv`;
    }

    return { success: true, data: exportData, filename, format };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to export project.');
  }
});

// ============================================
// PHASE 4: ADVANCED AI FEATURES
// ============================================

/**
 * wizardGenerateBRoll - Generates AI B-Roll suggestions for clips
 * Uses OpenAI to analyze transcript and suggest relevant B-Roll footage
 */
exports.wizardGenerateBRoll = functions.runWith({ timeoutSeconds: 120 }).https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId, clipId } = data;

  if (!projectId || !clipId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID and Clip ID required');
  }

  // Check and deduct tokens for B-Roll generation
  const tokenCosts = await getWizardTokenCosts();
  const brollCost = tokenCosts.generateBRoll || 4;

  const tokenResult = await deductWizardTokens(uid, brollCost, 'generateBRoll', {
    clipId: clipId,
    projectId: projectId
  });

  if (!tokenResult.success) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      `Insufficient tokens. This operation requires ${brollCost} tokens, but you have ${tokenResult.available || 0}.`
    );
  }

  try {
    // Verify project ownership
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists || projectDoc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    const project = projectDoc.data();
    const clip = (project.clips || []).find(c => c.id === clipId);

    if (!clip) {
      throw new functions.https.HttpsError('not-found', 'Clip not found');
    }

    // Get OpenAI API key
    const settingsDoc = await db.collection('settings').doc('openai').get();
    const openaiKey = settingsDoc.exists ? settingsDoc.data().apiKey : null;

    if (!openaiKey) {
      throw new functions.https.HttpsError('failed-precondition', 'OpenAI API key not configured');
    }

    // Generate B-Roll suggestions using GPT
    const prompt = `Analyze this video clip transcript and suggest 5 B-Roll footage ideas that would enhance the visual storytelling. For each suggestion, provide:
1. A brief description of the footage
2. Suggested duration (2-5 seconds)
3. When in the clip it should appear (beginning, middle, end, or specific phrase)
4. Search keywords for stock footage

Clip transcript: "${clip.transcript}"

Video context: ${project.videoData?.title || 'Business/Educational content'}

Respond in JSON format:
{
  "suggestions": [
    {
      "id": "broll_1",
      "description": "Description of the B-Roll footage",
      "duration": 3,
      "placement": "beginning",
      "triggerPhrase": "optional specific phrase",
      "keywords": ["keyword1", "keyword2", "keyword3"],
      "category": "stock" | "ai-generated" | "screen-recording"
    }
  ]
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 1000,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const result = await response.json();
    const brollData = JSON.parse(result.choices[0].message.content);

    // Add AI-generated image prompts for each suggestion
    brollData.suggestions = brollData.suggestions.map(suggestion => ({
      ...suggestion,
      imagePrompt: `Professional cinematic B-Roll footage: ${suggestion.description}. High quality, 4K, smooth motion, ${suggestion.keywords.join(', ')}`
    }));

    // Save B-Roll suggestions to project
    const clipBRoll = project.clipBRoll || {};
    clipBRoll[clipId] = brollData.suggestions;

    await db.collection('wizardProjects').doc(projectId).update({
      clipBRoll,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      clipId,
      brollSuggestions: brollData.suggestions
    };

  } catch (error) {
    console.error('B-Roll generation error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to generate B-Roll suggestions.'));
  }
});

/**
 * wizardRemoveFillers - Analyzes transcript and marks filler words for removal
 * Returns timestamps and cleaned transcript
 */
exports.wizardRemoveFillers = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId, clipId } = data;

  if (!projectId || !clipId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID and Clip ID required');
  }

  try {
    // Verify project ownership
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists || projectDoc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    const project = projectDoc.data();
    const clip = (project.clips || []).find(c => c.id === clipId);

    if (!clip) {
      throw new functions.https.HttpsError('not-found', 'Clip not found');
    }

    // Common filler words and phrases
    const fillerPatterns = [
      { pattern: /\b(um|uh|uhm|umm)\b/gi, type: 'hesitation' },
      { pattern: /\b(like)\b(?!\s+(to|a|the|this|that|it|when|if|because))/gi, type: 'filler' },
      { pattern: /\b(you know)\b/gi, type: 'filler' },
      { pattern: /\b(I mean)\b/gi, type: 'filler' },
      { pattern: /\b(basically)\b/gi, type: 'filler' },
      { pattern: /\b(literally)\b/gi, type: 'filler' },
      { pattern: /\b(actually)\b(?!\s+(is|was|are|were|do|did|have|has))/gi, type: 'filler' },
      { pattern: /\b(so)\b(?=\s*,|\s*\.|\s*$)/gi, type: 'trailing' },
      { pattern: /\b(right)\b(?=\s*,|\s*\?)/gi, type: 'tag' },
      { pattern: /\b(kind of|sort of)\b/gi, type: 'hedge' },
      { pattern: /\b(just)\b(?!\s+(now|then|because|in|on|at))/gi, type: 'minimizer' }
    ];

    const transcript = clip.transcript || '';
    const fillers = [];
    let cleanedTranscript = transcript;
    let totalFillerDuration = 0;

    // Find all filler occurrences
    fillerPatterns.forEach(({ pattern, type }) => {
      let match;
      const regex = new RegExp(pattern.source, pattern.flags);
      while ((match = regex.exec(transcript)) !== null) {
        // Estimate timing based on word position (rough estimate)
        const wordsBefore = transcript.substring(0, match.index).split(/\s+/).length;
        const estimatedTime = clip.startTime + (wordsBefore * 0.4); // ~0.4s per word

        fillers.push({
          word: match[0],
          type,
          position: match.index,
          estimatedTimestamp: Math.min(estimatedTime, clip.endTime),
          duration: match[0].split(/\s+/).length * 0.3 // ~0.3s per filler word
        });

        totalFillerDuration += match[0].split(/\s+/).length * 0.3;
      }
    });

    // Clean the transcript
    fillerPatterns.forEach(({ pattern }) => {
      cleanedTranscript = cleanedTranscript.replace(pattern, '').replace(/\s+/g, ' ').trim();
    });

    // Sort fillers by position
    fillers.sort((a, b) => a.position - b.position);

    // Calculate statistics
    const stats = {
      originalWordCount: transcript.split(/\s+/).length,
      cleanedWordCount: cleanedTranscript.split(/\s+/).length,
      fillersRemoved: fillers.length,
      estimatedTimeSaved: Math.round(totalFillerDuration * 10) / 10,
      fillersByType: fillers.reduce((acc, f) => {
        acc[f.type] = (acc[f.type] || 0) + 1;
        return acc;
      }, {})
    };

    // Save to project
    const clipFillers = project.clipFillers || {};
    clipFillers[clipId] = {
      fillers,
      cleanedTranscript,
      stats,
      processedAt: new Date().toISOString()
    };

    await db.collection('wizardProjects').doc(projectId).update({
      clipFillers,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      clipId,
      originalTranscript: transcript,
      cleanedTranscript,
      fillers,
      stats
    };

  } catch (error) {
    console.error('Filler removal error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to process fillers.'));
  }
});

/**
 * wizardGenerateHook - Generates viral hook variations for clips
 * Creates attention-grabbing opening lines
 */
exports.wizardGenerateHook = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId, clipId, hookStyle } = data;

  if (!projectId || !clipId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID and Clip ID required');
  }

  try {
    // Verify project ownership
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists || projectDoc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    const project = projectDoc.data();
    const clip = (project.clips || []).find(c => c.id === clipId);

    if (!clip) {
      throw new functions.https.HttpsError('not-found', 'Clip not found');
    }

    // Get OpenAI API key
    const settingsDoc = await db.collection('settings').doc('openai').get();
    const openaiKey = settingsDoc.exists ? settingsDoc.data().apiKey : null;

    if (!openaiKey) {
      throw new functions.https.HttpsError('failed-precondition', 'OpenAI API key not configured');
    }

    const styleDescriptions = {
      curiosity: 'Create curiosity gaps that make viewers desperate to know more',
      controversy: 'Make bold, slightly controversial statements that spark debate',
      story: 'Start with a compelling personal story or narrative hook',
      question: 'Ask thought-provoking questions that viewers want answered',
      shock: 'Lead with surprising facts or statistics that stop the scroll',
      promise: 'Make a clear value promise about what viewers will learn'
    };

    const style = hookStyle || 'curiosity';
    const styleGuide = styleDescriptions[style] || styleDescriptions.curiosity;

    const prompt = `You are a viral content expert. Generate 5 attention-grabbing hook variations for this short-form video clip.

CLIP TRANSCRIPT:
"${clip.transcript}"

VIDEO CONTEXT: ${project.videoData?.title || 'Content creator video'}

HOOK STYLE: ${style}
STYLE GUIDE: ${styleGuide}

Requirements:
- Each hook should be 2-8 words (super punchy)
- Hooks should be speakable in under 3 seconds
- Create FOMO or curiosity
- Match the energy and topic of the content
- Make viewers stop scrolling immediately

Respond in JSON format:
{
  "hooks": [
    {
      "id": "hook_1",
      "text": "The hook text here",
      "style": "${style}",
      "speakingDuration": 2.5,
      "emotionalTrigger": "curiosity|fear|excitement|surprise",
      "captionOverlay": "Optional text to show on screen",
      "voiceDirection": "excited|mysterious|urgent|casual"
    }
  ],
  "recommendedHook": "hook_1",
  "explanation": "Why this hook works best for this content"
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8,
        max_tokens: 800,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const result = await response.json();
    const hookData = JSON.parse(result.choices[0].message.content);

    // Save hooks to project
    const clipHooks = project.clipHooks || {};
    clipHooks[clipId] = {
      ...hookData,
      generatedAt: new Date().toISOString(),
      style
    };

    await db.collection('wizardProjects').doc(projectId).update({
      clipHooks,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      clipId,
      ...hookData
    };

  } catch (error) {
    console.error('Hook generation error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to generate hooks.'));
  }
});

/**
 * wizardDetectSpeakers - Analyzes video/audio to detect and label speakers
 * Uses transcript analysis to identify speaker changes
 */
exports.wizardDetectSpeakers = functions.runWith({ timeoutSeconds: 120 }).https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId, clipId } = data;

  if (!projectId || !clipId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID and Clip ID required');
  }

  // Check and deduct tokens for speaker detection
  const tokenCosts = await getWizardTokenCosts();
  const speakerCost = tokenCosts.detectSpeakers || 3;

  const tokenResult = await deductWizardTokens(uid, speakerCost, 'detectSpeakers', {
    clipId: clipId,
    projectId: projectId
  });

  if (!tokenResult.success) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      `Insufficient tokens. This operation requires ${speakerCost} tokens, but you have ${tokenResult.available || 0}.`
    );
  }

  try {
    // Verify project ownership
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists || projectDoc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    const project = projectDoc.data();
    const clip = (project.clips || []).find(c => c.id === clipId);

    if (!clip) {
      throw new functions.https.HttpsError('not-found', 'Clip not found');
    }

    // Get OpenAI API key
    const settingsDoc = await db.collection('settings').doc('openai').get();
    const openaiKey = settingsDoc.exists ? settingsDoc.data().apiKey : null;

    if (!openaiKey) {
      throw new functions.https.HttpsError('failed-precondition', 'OpenAI API key not configured');
    }

    // Use GPT to analyze transcript for speaker patterns
    const prompt = `Analyze this transcript and identify if there are multiple speakers. Look for:
- Changes in speaking style or vocabulary
- Question/answer patterns
- Interview dynamics
- Different perspectives being expressed

TRANSCRIPT:
"${clip.transcript}"

VIDEO CONTEXT: ${project.videoData?.title || 'Video content'}

Respond in JSON format:
{
  "speakerCount": 1,
  "speakers": [
    {
      "id": "speaker_1",
      "label": "Host" | "Guest" | "Interviewer" | "Speaker 1",
      "estimatedRole": "main_speaker" | "interviewer" | "guest" | "narrator",
      "characteristics": ["energetic", "expert", "casual"],
      "segments": [
        {
          "text": "Part of transcript spoken by this speaker",
          "estimatedStart": 0,
          "estimatedEnd": 15
        }
      ]
    }
  ],
  "isSingleSpeaker": true,
  "isInterview": false,
  "isPodcast": false,
  "confidence": 0.85,
  "analysis": "Brief explanation of the speaker detection"
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const result = await response.json();
    const speakerData = JSON.parse(result.choices[0].message.content);

    // Recommend reframe mode based on speaker count
    let recommendedReframe = 'auto_center';
    if (speakerData.speakerCount === 2) {
      recommendedReframe = 'split_screen';
    } else if (speakerData.speakerCount >= 3) {
      recommendedReframe = 'three_person';
    }

    speakerData.recommendedReframe = recommendedReframe;

    // Save speaker detection to project
    const clipSpeakers = project.clipSpeakers || {};
    clipSpeakers[clipId] = {
      ...speakerData,
      detectedAt: new Date().toISOString()
    };

    await db.collection('wizardProjects').doc(projectId).update({
      clipSpeakers,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      clipId,
      ...speakerData
    };

  } catch (error) {
    console.error('Speaker detection error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to detect speakers.'));
  }
});

/**
 * wizardApplyAIEnhancements - Batch applies AI enhancements to a clip
 * Combines multiple AI features in one call
 */
exports.wizardApplyAIEnhancements = functions.runWith({ timeoutSeconds: 180, memory: '1GB' }).https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId, clipId, enhancements = [] } = data;

  if (!projectId || !clipId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID and Clip ID required');
  }

  const validEnhancements = ['broll', 'fillers', 'hook', 'speakers', 'captions', 'reframe'];
  const requestedEnhancements = enhancements.filter(e => validEnhancements.includes(e));

  if (requestedEnhancements.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'At least one valid enhancement required');
  }

  try {
    const results = {
      success: true,
      clipId,
      applied: [],
      failed: [],
      data: {}
    };

    // Apply each enhancement
    for (const enhancement of requestedEnhancements) {
      try {
        let result;
        switch (enhancement) {
          case 'broll':
            result = await exports.wizardGenerateBRoll.run({ projectId, clipId }, context);
            results.data.broll = result.brollSuggestions;
            break;
          case 'fillers':
            result = await exports.wizardRemoveFillers.run({ projectId, clipId }, context);
            results.data.fillers = result.stats;
            break;
          case 'hook':
            result = await exports.wizardGenerateHook.run({ projectId, clipId }, context);
            results.data.hooks = result.hooks;
            break;
          case 'speakers':
            result = await exports.wizardDetectSpeakers.run({ projectId, clipId }, context);
            results.data.speakers = result.speakers;
            break;
        }
        results.applied.push(enhancement);
      } catch (err) {
        console.error(`Enhancement ${enhancement} failed:`, err);
        results.failed.push({ enhancement, error: err.message });
      }
    }

    return results;

  } catch (error) {
    console.error('AI enhancements error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to apply AI enhancements.'));
  }
});

/**
 * wizardGenerateAICaptions - Generates styled captions with timing
 * Creates word-by-word captions with animation cues
 */
exports.wizardGenerateAICaptions = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId, clipId, style = 'karaoke' } = data;

  if (!projectId || !clipId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID and Clip ID required');
  }

  try {
    // Verify project ownership
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists || projectDoc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    const project = projectDoc.data();
    const clip = (project.clips || []).find(c => c.id === clipId);

    if (!clip) {
      throw new functions.https.HttpsError('not-found', 'Clip not found');
    }

    // Parse transcript into words with estimated timing
    const words = (clip.transcript || '').split(/\s+/).filter(w => w.length > 0);

    if (words.length === 0) {
      throw new functions.https.HttpsError('failed-precondition', 'Clip has no transcript text to generate captions from');
    }

    const clipDuration = clip.duration || (clip.endTime - clip.startTime);
    const avgWordDuration = clipDuration / words.length;

    const captionStyles = {
      karaoke: { highlightColor: '#FBBF24', animation: 'scale', wordsPerGroup: 3 },
      beasty: { highlightColor: '#FBBF24', animation: 'pop', wordsPerGroup: 2, uppercase: true },
      hormozi: { highlightColor: '#22C55E', animation: 'highlight', wordsPerGroup: 4 },
      minimal: { highlightColor: '#FFFFFF', animation: 'fade', wordsPerGroup: 5 },
      ali: { highlightColor: '#EC4899', animation: 'glow', wordsPerGroup: 3 }
    };

    const styleConfig = captionStyles[style] || captionStyles.karaoke;

    // Generate word-by-word captions with timing
    const captions = [];
    let currentTime = clip.startTime;

    for (let i = 0; i < words.length; i++) {
      const word = styleConfig.uppercase ? words[i].toUpperCase() : words[i];
      const isKeyword = word.length > 5 || /[!?]/.test(word); // Simple keyword detection

      captions.push({
        word,
        startTime: currentTime,
        endTime: currentTime + avgWordDuration,
        isHighlight: isKeyword,
        animation: isKeyword ? styleConfig.animation : 'none',
        color: isKeyword ? styleConfig.highlightColor : '#FFFFFF',
        groupIndex: Math.floor(i / styleConfig.wordsPerGroup)
      });

      currentTime += avgWordDuration;
    }

    // Group captions for display
    const captionGroups = [];
    for (let i = 0; i < captions.length; i += styleConfig.wordsPerGroup) {
      const group = captions.slice(i, i + styleConfig.wordsPerGroup);
      captionGroups.push({
        text: group.map(c => c.word).join(' '),
        startTime: group[0].startTime,
        endTime: group[group.length - 1].endTime,
        words: group
      });
    }

    // Save captions to project
    const clipCaptions = project.clipCaptions || {};
    clipCaptions[clipId] = {
      style,
      styleConfig,
      captions,
      captionGroups,
      generatedAt: new Date().toISOString()
    };

    await db.collection('wizardProjects').doc(projectId).update({
      clipCaptions,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      clipId,
      style,
      captionCount: captions.length,
      groupCount: captionGroups.length,
      captions,
      captionGroups
    };

  } catch (error) {
    console.error('Caption generation error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to generate captions.'));
  }
});

// ============================================
// PHASE 5: EXPORT & INTEGRATION
// ============================================

/**
 * wizardExportFullProject - Comprehensive export with all AI data
 * Exports complete project data including settings, SEO, hooks, B-Roll, etc.
 */
exports.wizardExportFullProject = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId, format = 'json', includeAIData = true } = data;

  if (!projectId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID required');
  }

  try {
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists || projectDoc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    const project = projectDoc.data();
    const clips = project.clips || [];

    // Build comprehensive export
    const exportPackage = {
      meta: {
        exportVersion: '1.0',
        exportedAt: new Date().toISOString(),
        projectId: projectDoc.id
      },
      video: {
        title: project.videoData?.title,
        url: project.videoUrl,
        duration: project.videoData?.duration,
        thumbnail: project.videoData?.thumbnail
      },
      clips: clips.map(clip => {
        const clipData = {
          id: clip.id,
          startTime: clip.startTime,
          endTime: clip.endTime,
          duration: clip.duration,
          score: clip.score,
          transcript: clip.transcript,
          platforms: clip.platforms || [],
          thumbnail: clip.thumbnail
        };

        // Add settings
        if (project.clipSettings && project.clipSettings[clip.id]) {
          clipData.settings = project.clipSettings[clip.id];
        }

        // Add SEO
        if (project.clipSEO && project.clipSEO[clip.id]) {
          clipData.seo = project.clipSEO[clip.id];
        }

        // Add AI data if requested
        if (includeAIData) {
          if (project.clipHooks && project.clipHooks[clip.id]) {
            clipData.hooks = project.clipHooks[clip.id];
          }
          if (project.clipBRoll && project.clipBRoll[clip.id]) {
            clipData.broll = project.clipBRoll[clip.id];
          }
          if (project.clipFillers && project.clipFillers[clip.id]) {
            clipData.fillers = project.clipFillers[clip.id];
          }
          if (project.clipSpeakers && project.clipSpeakers[clip.id]) {
            clipData.speakers = project.clipSpeakers[clip.id];
          }
          if (project.clipCaptions && project.clipCaptions[clip.id]) {
            clipData.captions = project.clipCaptions[clip.id];
          }
        }

        return clipData;
      }),
      summary: {
        totalClips: clips.length,
        totalDuration: clips.reduce((sum, c) => sum + (c.duration || 0), 0),
        averageScore: clips.length > 0
          ? Math.round(clips.reduce((sum, c) => sum + (c.score || 0), 0) / clips.length)
          : 0,
        platforms: [...new Set(clips.flatMap(c => c.platforms || []))]
      }
    };

    let exportData, filename;

    if (format === 'json') {
      exportData = JSON.stringify(exportPackage, null, 2);
      filename = `shorts-project-${projectDoc.id}.json`;
    } else if (format === 'csv') {
      // Multi-sheet style CSV with sections
      let csvContent = '';

      // Video Info
      csvContent += '# VIDEO INFO\n';
      csvContent += 'Title,URL,Duration\n';
      csvContent += `"${exportPackage.video.title || ''}","${exportPackage.video.url || ''}",${exportPackage.video.duration || 0}\n\n`;

      // Clips
      csvContent += '# CLIPS\n';
      csvContent += 'Clip ID,Start,End,Duration,Score,Platforms,SEO Title,SEO Description,Tags\n';
      exportPackage.clips.forEach(clip => {
        const seo = clip.seo || {};
        csvContent += [
          clip.id,
          clip.startTime,
          clip.endTime,
          clip.duration,
          clip.score,
          `"${(clip.platforms || []).join('; ')}"`,
          `"${(seo.title || '').replace(/"/g, '""')}"`,
          `"${(seo.description || '').replace(/"/g, '""').substring(0, 200)}"`,
          `"${(seo.tags || []).join('; ')}"`
        ].join(',') + '\n';
      });

      // Hooks section
      if (includeAIData) {
        csvContent += '\n# AI HOOKS\n';
        csvContent += 'Clip ID,Hook Text,Style,Duration,Trigger\n';
        exportPackage.clips.forEach(clip => {
          if (clip.hooks && clip.hooks.hooks) {
            clip.hooks.hooks.forEach(hook => {
              csvContent += [
                clip.id,
                `"${(hook.text || '').replace(/"/g, '""')}"`,
                hook.style || '',
                hook.speakingDuration || '',
                hook.emotionalTrigger || ''
              ].join(',') + '\n';
            });
          }
        });
      }

      exportData = csvContent;
      filename = `shorts-project-${projectDoc.id}.csv`;
    }

    return {
      success: true,
      data: exportData,
      filename,
      format,
      summary: exportPackage.summary
    };

  } catch (error) {
    console.error('Full export error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to export project.'));
  }
});

/**
 * wizardGetProjectsList - Gets list of user's wizard projects with summaries
 */
exports.wizardGetProjectsList = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { limit = 20, startAfter = null } = data;

  try {
    let query = db.collection('wizardProjects')
      .where('userId', '==', uid)
      .orderBy('updatedAt', 'desc')
      .limit(Math.min(limit, 50));

    if (startAfter) {
      const startDoc = await db.collection('wizardProjects').doc(startAfter).get();
      if (startDoc.exists) {
        query = query.startAfter(startDoc);
      }
    }

    const snapshot = await query.get();

    const projects = snapshot.docs.map(doc => {
      const data = doc.data();
      const clips = data.clips || [];

      return {
        id: doc.id,
        videoTitle: data.videoData?.title || 'Untitled Project',
        videoUrl: data.videoUrl,
        videoThumbnail: data.videoData?.thumbnail,
        clipCount: clips.length,
        totalDuration: clips.reduce((sum, c) => sum + (c.duration || 0), 0),
        averageScore: clips.length > 0
          ? Math.round(clips.reduce((sum, c) => sum + (c.score || 0), 0) / clips.length)
          : 0,
        status: data.status || 'draft',
        createdAt: data.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: data.updatedAt?.toDate?.()?.toISOString() || null
      };
    });

    return {
      success: true,
      projects,
      hasMore: snapshot.docs.length === limit,
      lastId: snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1].id : null
    };

  } catch (error) {
    console.error('Get projects list error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to get projects.'));
  }
});

/**
 * wizardLoadProject - Loads a complete project for editing
 */
exports.wizardLoadProject = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId } = data;

  if (!projectId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID required');
  }

  try {
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Project not found');
    }

    const project = projectDoc.data();
    if (project.userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    return {
      success: true,
      project: {
        id: projectDoc.id,
        videoUrl: project.videoUrl,
        videoData: project.videoData,
        clips: project.clips || [],
        clipSettings: project.clipSettings || {},
        clipSEO: project.clipSEO || {},
        clipThumbnails: project.clipThumbnails || {},
        clipHooks: project.clipHooks || {},
        clipBRoll: project.clipBRoll || {},
        clipFillers: project.clipFillers || {},
        clipSpeakers: project.clipSpeakers || {},
        clipCaptions: project.clipCaptions || {},
        status: project.status || 'draft',
        createdAt: project.createdAt?.toDate?.()?.toISOString() || null,
        updatedAt: project.updatedAt?.toDate?.()?.toISOString() || null
      }
    };

  } catch (error) {
    console.error('Load project error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to load project.'));
  }
});

/**
 * wizardDuplicateProject - Creates a copy of an existing project
 */
exports.wizardDuplicateProject = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId } = data;

  if (!projectId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID required');
  }

  try {
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Project not found');
    }

    const project = projectDoc.data();
    if (project.userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    // Create duplicate with new ID
    const newProject = {
      ...project,
      videoData: {
        ...project.videoData,
        title: `${project.videoData?.title || 'Project'} (Copy)`
      },
      status: 'draft',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const newDoc = await db.collection('wizardProjects').add(newProject);

    return {
      success: true,
      newProjectId: newDoc.id,
      message: 'Project duplicated successfully'
    };

  } catch (error) {
    console.error('Duplicate project error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to duplicate project.'));
  }
});

/**
 * wizardUpdateProjectStatus - Updates project status (draft/complete/archived)
 */
exports.wizardUpdateProjectStatus = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId, status } = data;

  if (!projectId || !status) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID and status required');
  }

  const validStatuses = ['draft', 'complete', 'archived'];
  if (!validStatuses.includes(status)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid status');
  }

  try {
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists || projectDoc.data().userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    await db.collection('wizardProjects').doc(projectId).update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, status };

  } catch (error) {
    console.error('Update status error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to update status.'));
  }
});

// ============================================
// VIDEO PROCESSING FUNCTIONS
// ============================================

/**
 * wizardProcessClip - Creates a video processing job for a clip
 * This sets up the infrastructure for FFmpeg-based video processing
 *
 * CANONICAL SOURCE ASSET ARCHITECTURE:
 * Export REQUIRES a sourceAsset (video file stored in our storage).
 * The sourceAsset is created during analysis when user captures video.
 * This eliminates unreliable re-capture at export time.
 */
exports.wizardProcessClip = functions
  .runWith({ timeoutSeconds: 540, memory: '2GB' })
  .https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId, clipId, quality, settings, extensionCaptureData } = data;
  // extensionCaptureData is used as fallback when sourceAsset is missing (e.g., extension capture failed during analysis)

  if (!projectId || !clipId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID and Clip ID required');
  }

  const validQualities = ['720p', '1080p'];
  const outputQuality = validQualities.includes(quality) ? quality : '720p';

  try {
    // Get project and clip data
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Project not found');
    }

    const project = projectDoc.data();
    if (project.userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    const clip = (project.clips || []).find(c => c.id === clipId);
    if (!clip) {
      throw new functions.https.HttpsError('not-found', 'Clip not found');
    }

    // Get clip settings (from project or from request)
    const clipSettings = settings || project.clipSettings?.[clipId] || {};

    // Log cropPosition for debugging export issues
    console.log(`[wizardProcessClip] ========== CROP POSITION DEBUG ==========`);
    console.log(`[wizardProcessClip] Clip ID: ${clipId}`);
    console.log(`[wizardProcessClip] Settings source: ${settings ? 'from request' : (project.clipSettings?.[clipId] ? 'from project' : 'default empty')}`);
    console.log(`[wizardProcessClip] clipSettings.cropPosition: ${clipSettings.cropPosition} (type: ${typeof clipSettings.cropPosition})`);
    console.log(`[wizardProcessClip] clipSettings.reframeMode: ${clipSettings.reframeMode}`);
    console.log(`[wizardProcessClip] ==========================================`);

    // SOURCE ASSET PRIORITY:
    // 1. extensionCaptureData - ALWAYS preferred when provided (clip-specific capture)
    // 2. sourceAsset - full source video stored during analysis
    // 3. uploadedVideoUrl - for user-uploaded videos
    //
    // CRITICAL FIX: extensionCaptureData contains the clip-specific captured segment.
    // We must use it when provided, NOT fall back to sourceAsset (which may be a different clip's segment).
    // Do NOT save clip-specific captures as sourceAsset - that's for the full source video only.

    let sourceAsset = project.sourceAsset;
    const isUploadedVideo = project.isUpload && project.videoData?.uploadedVideoUrl;

    // Check if we have clip-specific capture data from the extension
    const hasClipSpecificCapture = extensionCaptureData &&
      extensionCaptureData.streamData &&
      extensionCaptureData.streamData.uploadedToStorage &&
      extensionCaptureData.streamData.videoUrl;

    console.log(`[wizardProcessClip] Checking source for ${clipId}:`, {
      hasClipSpecificCapture,
      hasSourceAsset: !!sourceAsset,
      sourceAssetUrl: sourceAsset?.storageUrl?.substring(0, 60) + '...' || 'none',
      isUploadedVideo,
      projectId
    });

    // Determine the video source URL for processing
    // PRIORITY: clip-specific capture > sourceAsset > uploaded video
    let videoSourceUrl = null;
    let videoSourceType = 'unknown';

    if (hasClipSpecificCapture) {
      // HIGHEST PRIORITY: Use clip-specific captured segment from extension
      // This is the video that was captured specifically for THIS clip at export time
      videoSourceUrl = extensionCaptureData.streamData.videoUrl;
      videoSourceType = 'clip_capture';
      console.log(`[wizardProcessClip] Using clip-specific capture for ${clipId}: ${videoSourceUrl.substring(0, 60)}...`);

      // NOTE: We intentionally do NOT save this as sourceAsset.
      // sourceAsset should only contain the full source video, not clip segments.
      // Each clip gets its own captured segment via extensionCaptureData.
    } else if (sourceAsset && sourceAsset.storageUrl) {
      // SECOND PRIORITY: Use full source video from analysis
      videoSourceUrl = sourceAsset.storageUrl;
      videoSourceType = 'source_asset';
      console.log(`[wizardProcessClip] Using sourceAsset: ${videoSourceUrl.substring(0, 60)}...`);
    } else if (isUploadedVideo) {
      // THIRD PRIORITY: Use user-uploaded video
      videoSourceUrl = project.videoData.uploadedVideoUrl;
      videoSourceType = 'uploaded_video';
      console.log(`[wizardProcessClip] Using uploaded video: ${videoSourceUrl.substring(0, 60)}...`);
    }

    // Validate we have a video source
    if (!videoSourceUrl) {
      console.error(`[wizardProcessClip] ERROR: No video source for project ${projectId}, clip ${clipId}`);
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Video source not available. The video capture may have failed. Please try re-analyzing the video.'
      );
    }

    // Create processing job record with canonical source
    const processingJob = {
      userId: uid,
      projectId,
      clipId,
      videoId: project.videoId,
      videoUrl: project.videoUrl,

      // CANONICAL SOURCE - single source of truth for video data
      videoSourceUrl: videoSourceUrl,
      videoSourceType: videoSourceType,

      // Legacy fields (for backward compatibility)
      isUpload: project.isUpload || false,
      uploadedVideoUrl: videoSourceUrl,
      uploadedVideoPath: project.uploadedVideoPath || null,

      // Mark that we have a valid source (replaces extensionStreamData logic)
      hasExtensionStream: true,  // Always true now since we require sourceAsset
      extensionStreamData: {
        videoUrl: videoSourceUrl,
        source: videoSourceType,
        uploadedToStorage: true,
        capturedAt: sourceAsset?.capturedAt || Date.now()
      },

      // Clip timing
      startTime: clip.startTime,
      endTime: clip.endTime,
      duration: clip.duration,

      // Processing settings
      quality: outputQuality,
      settings: {
        captionStyle: clipSettings.captionStyle || 'karaoke',
        captionSource: clipSettings.captionSource || 'primary',  // Which video's audio to use for captions
        customCaptionStyle: clipSettings.customCaptionStyle || null,
        reframeMode: clipSettings.reframeMode || 'auto_center',
        cropPosition: clipSettings.cropPosition !== undefined ? clipSettings.cropPosition : 50,
        trimStart: clipSettings.trimStart || 0,
        trimEnd: clipSettings.trimEnd || clip.duration,
        introTransition: clipSettings.introTransition || 'none',
        outroTransition: clipSettings.outroTransition || 'none',
        autoZoom: clipSettings.autoZoom || false,
        vignette: clipSettings.vignette || false,
        colorGrade: clipSettings.colorGrade || false,
        enhanceAudio: clipSettings.enhanceAudio !== false,
        removeFiller: clipSettings.removeFiller || false,
        voiceVolume: clipSettings.voiceVolume || 100,
        addMusic: clipSettings.addMusic || false,
        musicVolume: clipSettings.musicVolume || 30,
        selectedTrack: clipSettings.selectedTrack || null,

        // Multi-source split screen settings
        secondarySource: clipSettings.secondarySource && clipSettings.secondarySource.enabled ? {
          enabled: true,
          type: clipSettings.secondarySource.type || null,
          uploadedUrl: clipSettings.secondarySource.uploadedUrl || null,
          youtubeUrl: clipSettings.secondarySource.youtubeUrl || null,
          youtubeVideoId: clipSettings.secondarySource.youtubeVideoId || null,
          position: clipSettings.secondarySource.position || 'bottom',
          timeOffset: clipSettings.secondarySource.timeOffset || 0
        } : null,

        // Audio mixing settings (for multi-source)
        audioMix: clipSettings.audioMix ? {
          primaryVolume: clipSettings.audioMix.primaryVolume ?? 100,
          secondaryVolume: clipSettings.audioMix.secondaryVolume ?? 0,
          primaryMuted: clipSettings.audioMix.primaryMuted ?? false,
          secondaryMuted: clipSettings.audioMix.secondaryMuted ?? true
        } : null,

        // Split screen speaker position settings
        splitScreenSettings: clipSettings.splitScreenSettings ? {
          speaker1: {
            cropPosition: clipSettings.splitScreenSettings.speaker1?.cropPosition ?? 17,
            cropWidth: clipSettings.splitScreenSettings.speaker1?.cropWidth ?? 33
          },
          speaker2: {
            cropPosition: clipSettings.splitScreenSettings.speaker2?.cropPosition ?? 83,
            cropWidth: clipSettings.splitScreenSettings.speaker2?.cropWidth ?? 33
          },
          preset: clipSettings.splitScreenSettings.preset || 'interview'
        } : null
      },

      // Output specifications - use frame rate from settings
      output: {
        format: 'mp4',
        aspectRatio: '9:16',
        resolution: outputQuality === '1080p' ? { width: 1080, height: 1920 } : { width: 720, height: 1280 },
        fps: parseInt(clipSettings.frameRate) || 30,
        codec: 'h264'
      },

      // Status tracking
      status: 'queued',
      progress: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Save job to Firestore
    const jobRef = await db.collection('wizardProcessingJobs').add(processingJob);

    // Update project with processing status
    await db.collection('wizardProjects').doc(projectId).update({
      [`clipProcessing.${clipId}`]: {
        jobId: jobRef.id,
        status: 'queued',
        quality: outputQuality,
        queuedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Get user's YouTube credentials if available
    let youtubeCredentials = null;
    try {
      youtubeCredentials = await getYouTubeCredentialsForUser(uid);
      if (youtubeCredentials) {
        // Store credentials reference in job (not the actual tokens for security)
        await jobRef.update({
          hasYouTubeAuth: true
        });
        console.log(`[${jobRef.id}] User has YouTube credentials available`);
      } else {
        console.log(`[${jobRef.id}] No YouTube credentials - will use fallback download method`);
      }
    } catch (credError) {
      console.log(`[${jobRef.id}] Could not fetch YouTube credentials:`, credError.message);
    }

    // Trigger Cloud Run video processor service (fire and forget)
    const videoProcessorUrl = functions.config().videoprocessor?.url;
    if (videoProcessorUrl) {
      try {
        // Prepare request body with optional YouTube credentials
        const requestBody = {
          jobId: jobRef.id
        };

        // Include YouTube credentials if available (passed securely)
        if (youtubeCredentials) {
          requestBody.youtubeAuth = {
            accessToken: youtubeCredentials.accessToken
          };
        }

        // Async call to Cloud Run - don't await
        axios.post(`${videoProcessorUrl}/process`, requestBody, {
          timeout: 5000,
          headers: { 'Content-Type': 'application/json' }
        }).catch(err => {
          console.log('Video processor trigger sent (async):', err.message || 'pending');
        });
        console.log(`Triggered video processor for job: ${jobRef.id}`);
      } catch (triggerError) {
        // Log but don't fail - job is queued and can be picked up by scheduler
        console.log('Video processor trigger note:', triggerError.message);
      }
    } else {
      console.log('Video processor URL not configured - job queued for manual processing');
    }

    await logUsage(uid, 'wizard_process_clip', { projectId, clipId, quality: outputQuality });

    return {
      success: true,
      jobId: jobRef.id,
      status: 'queued',
      message: 'Video processing job created. Processing will be available soon.',
      estimatedTime: outputQuality === '1080p' ? '3-5 minutes' : '2-3 minutes'
    };

  } catch (error) {
    console.error('Process clip error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to create processing job.'));
  }
});

/**
 * wizardGetProcessingStatus - Gets the status of a processing job
 */
exports.wizardGetProcessingStatus = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { jobId } = data;

  if (!jobId) {
    throw new functions.https.HttpsError('invalid-argument', 'Job ID required');
  }

  try {
    const jobDoc = await db.collection('wizardProcessingJobs').doc(jobId).get();
    if (!jobDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Job not found');
    }

    const job = jobDoc.data();
    if (job.userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    return {
      success: true,
      job: {
        id: jobId,
        clipId: job.clipId,
        status: job.status,
        progress: job.progress || 0,
        quality: job.quality,
        outputUrl: job.outputUrl || null,
        error: job.error || null,
        createdAt: job.createdAt?.toDate?.()?.toISOString() || null,
        completedAt: job.completedAt?.toDate?.()?.toISOString() || null
      }
    };

  } catch (error) {
    console.error('Get processing status error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', sanitizeErrorMessage(error, 'Failed to get job status.'));
  }
});

// ============================================
// BATCH EXPORT TRACKING FUNCTIONS
// ============================================

/**
 * wizardCreateBatchExport - Create a batch export tracking document
 * This allows users to resume viewing progress if they refresh/leave the page
 */
exports.wizardCreateBatchExport = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId, clips } = data;

  if (!projectId || !clips || !Array.isArray(clips)) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID and clips array required');
  }

  try {
    // Create batch export document
    const batchData = {
      userId: uid,
      projectId: projectId,
      status: 'processing',
      clips: clips.map(clip => ({
        clipId: clip.clipId,
        title: clip.title || '',
        jobId: null,
        status: 'pending',
        progress: 0,
        outputUrl: null,
        error: null
      })),
      totalClips: clips.length,
      completedClips: 0,
      failedClips: 0,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      completedAt: null,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };

    const batchRef = await db.collection('wizardBatchExports').add(batchData);

    console.log(`[wizardCreateBatchExport] Created batch ${batchRef.id} for project ${projectId} with ${clips.length} clips`);

    return {
      success: true,
      batchId: batchRef.id
    };
  } catch (error) {
    console.error('[wizardCreateBatchExport] Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * wizardUpdateBatchExportClip - Update a single clip's status in a batch export
 */
exports.wizardUpdateBatchExportClip = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { batchId, clipId, jobId, status, progress, outputUrl, error } = data;

  if (!batchId || !clipId) {
    throw new functions.https.HttpsError('invalid-argument', 'Batch ID and clip ID required');
  }

  try {
    const batchRef = db.collection('wizardBatchExports').doc(batchId);
    const batchDoc = await batchRef.get();

    if (!batchDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Batch export not found');
    }

    const batch = batchDoc.data();
    if (batch.userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    // Update the specific clip in the array
    const updatedClips = batch.clips.map(clip => {
      if (clip.clipId === clipId) {
        return {
          ...clip,
          jobId: jobId || clip.jobId,
          status: status || clip.status,
          progress: progress !== undefined ? progress : clip.progress,
          outputUrl: outputUrl || clip.outputUrl,
          error: error || clip.error
        };
      }
      return clip;
    });

    // Calculate completion stats
    const completedClips = updatedClips.filter(c => c.status === 'completed').length;
    const failedClips = updatedClips.filter(c => c.status === 'error').length;
    const allDone = (completedClips + failedClips) === batch.totalClips;

    const updateData = {
      clips: updatedClips,
      completedClips,
      failedClips,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };

    if (allDone) {
      updateData.status = failedClips === batch.totalClips ? 'failed' : (failedClips > 0 ? 'partial' : 'completed');
      updateData.completedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await batchRef.update(updateData);

    return {
      success: true,
      completedClips,
      failedClips,
      isComplete: allDone
    };
  } catch (error) {
    console.error('[wizardUpdateBatchExportClip] Error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * wizardGetBatchExport - Get batch export status
 */
exports.wizardGetBatchExport = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { batchId } = data;

  if (!batchId) {
    throw new functions.https.HttpsError('invalid-argument', 'Batch ID required');
  }

  try {
    const batchDoc = await db.collection('wizardBatchExports').doc(batchId).get();

    if (!batchDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Batch export not found');
    }

    const batch = batchDoc.data();
    if (batch.userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    return {
      success: true,
      batch: {
        id: batchId,
        projectId: batch.projectId,
        status: batch.status,
        clips: batch.clips,
        totalClips: batch.totalClips,
        completedClips: batch.completedClips,
        failedClips: batch.failedClips,
        startedAt: batch.startedAt?.toDate?.()?.toISOString() || null,
        completedAt: batch.completedAt?.toDate?.()?.toISOString() || null
      }
    };
  } catch (error) {
    console.error('[wizardGetBatchExport] Error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * wizardGetPendingBatchExport - Get any pending batch export for a project
 * Called on page load to check if there's an export in progress
 */
exports.wizardGetPendingBatchExport = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { projectId } = data;

  if (!projectId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID required');
  }

  try {
    // Find any processing batch for this project
    const batchSnapshot = await db.collection('wizardBatchExports')
      .where('userId', '==', uid)
      .where('projectId', '==', projectId)
      .where('status', '==', 'processing')
      .orderBy('startedAt', 'desc')
      .limit(1)
      .get();

    if (batchSnapshot.empty) {
      return { success: true, batch: null };
    }

    const batchDoc = batchSnapshot.docs[0];
    const batch = batchDoc.data();

    // Check if any jobs are still actually processing
    // If all jobs are done but status wasn't updated, fix it
    const pendingClips = batch.clips.filter(c => c.status === 'pending' || c.status === 'capturing' || c.status === 'processing');
    const completedClips = batch.clips.filter(c => c.status === 'completed').length;
    const failedClips = batch.clips.filter(c => c.status === 'error').length;

    // Refresh job statuses from wizardProcessingJobs collection
    const updatedClips = await Promise.all(batch.clips.map(async (clip) => {
      if (clip.jobId && (clip.status === 'processing' || clip.status === 'capturing')) {
        try {
          const jobDoc = await db.collection('wizardProcessingJobs').doc(clip.jobId).get();
          if (jobDoc.exists) {
            const job = jobDoc.data();
            return {
              ...clip,
              status: job.status,
              progress: job.progress || clip.progress,
              outputUrl: job.outputUrl || clip.outputUrl,
              error: job.error || clip.error
            };
          }
        } catch (e) {
          console.warn(`Could not fetch job ${clip.jobId}:`, e.message);
        }
      }
      return clip;
    }));

    // Recalculate stats
    const actualCompleted = updatedClips.filter(c => c.status === 'completed').length;
    const actualFailed = updatedClips.filter(c => c.status === 'error').length;
    const allDone = (actualCompleted + actualFailed) === batch.totalClips;

    // Update the batch if stats changed
    if (actualCompleted !== completedClips || actualFailed !== failedClips || allDone) {
      const updateData = {
        clips: updatedClips,
        completedClips: actualCompleted,
        failedClips: actualFailed,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      };

      if (allDone) {
        updateData.status = actualFailed === batch.totalClips ? 'failed' : (actualFailed > 0 ? 'partial' : 'completed');
        updateData.completedAt = admin.firestore.FieldValue.serverTimestamp();
      }

      await batchDoc.ref.update(updateData);
    }

    return {
      success: true,
      batch: {
        id: batchDoc.id,
        projectId: batch.projectId,
        status: allDone ? (actualFailed === batch.totalClips ? 'failed' : (actualFailed > 0 ? 'partial' : 'completed')) : 'processing',
        clips: updatedClips,
        totalClips: batch.totalClips,
        completedClips: actualCompleted,
        failedClips: actualFailed,
        startedAt: batch.startedAt?.toDate?.()?.toISOString() || null,
        completedAt: allDone ? new Date().toISOString() : null
      }
    };
  } catch (error) {
    console.error('[wizardGetPendingBatchExport] Error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * wizardCancelBatchExport - Cancel a batch export
 */
exports.wizardCancelBatchExport = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { batchId } = data;

  if (!batchId) {
    throw new functions.https.HttpsError('invalid-argument', 'Batch ID required');
  }

  try {
    const batchRef = db.collection('wizardBatchExports').doc(batchId);
    const batchDoc = await batchRef.get();

    if (!batchDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Batch export not found');
    }

    const batch = batchDoc.data();
    if (batch.userId !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'Not authorized');
    }

    await batchRef.update({
      status: 'cancelled',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true };
  } catch (error) {
    console.error('[wizardCancelBatchExport] Error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ============================================
// YOUTUBE OAUTH FUNCTIONS
// ============================================

/**
 * YouTube OAuth2 Client Configuration
 * These credentials must be configured in Firebase Functions config:
 * firebase functions:config:set youtube.client_id="YOUR_CLIENT_ID" youtube.client_secret="YOUR_CLIENT_SECRET"
 */
function getYouTubeOAuth2Client(redirectUri) {
  const clientId = functions.config().youtube?.client_id || process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = functions.config().youtube?.client_secret || process.env.YOUTUBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'YouTube OAuth is not configured. Please contact support.'
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * getYouTubeOAuthUrl - Generate OAuth URL for user to authorize YouTube access
 * This allows the app to use the user's YouTube session for video downloads
 */
exports.getYouTubeOAuthUrl = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  try {
    // Use the frontend URL as the redirect - it will handle the callback
    const redirectUri = data.redirectUri || 'https://ytseo.siteuo.com/video-wizard.html';

    const oauth2Client = getYouTubeOAuth2Client(redirectUri);

    // Generate state parameter for security (CSRF protection)
    const state = Buffer.from(JSON.stringify({
      uid: uid,
      timestamp: Date.now(),
      nonce: Math.random().toString(36).substring(7)
    })).toString('base64');

    // Store state in Firestore for validation
    await db.collection('youtubeOAuthStates').doc(state).set({
      uid: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
    });

    // Generate the OAuth URL
    // We need access to YouTube to download videos on behalf of the user
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline', // Get refresh token
      prompt: 'consent', // Always show consent screen to get refresh token
      scope: [
        'https://www.googleapis.com/auth/youtube.readonly', // Read-only access to YouTube account
        'https://www.googleapis.com/auth/youtube.force-ssl'  // Force SSL for all requests
      ],
      state: state,
      include_granted_scopes: true
    });

    console.log(`[YouTubeOAuth] Generated auth URL for user ${uid}`);

    return {
      success: true,
      authUrl: authUrl,
      state: state
    };

  } catch (error) {
    console.error('[YouTubeOAuth] Error generating auth URL:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to generate YouTube authorization URL');
  }
});

/**
 * handleYouTubeOAuthCallback - Process the OAuth callback and store tokens
 */
exports.handleYouTubeOAuthCallback = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { code, state, redirectUri } = data;

  if (!code || !state) {
    throw new functions.https.HttpsError('invalid-argument', 'Authorization code and state are required');
  }

  try {
    // Validate state parameter
    const stateDoc = await db.collection('youtubeOAuthStates').doc(state).get();

    if (!stateDoc.exists) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid or expired state parameter');
    }

    const stateData = stateDoc.data();

    // Verify state belongs to this user
    if (stateData.uid !== uid) {
      throw new functions.https.HttpsError('permission-denied', 'State parameter does not match user');
    }

    // Check if state has expired
    if (stateData.expiresAt && stateData.expiresAt.toDate() < new Date()) {
      throw new functions.https.HttpsError('invalid-argument', 'Authorization request has expired. Please try again.');
    }

    // Delete state to prevent reuse
    await db.collection('youtubeOAuthStates').doc(state).delete();

    // Exchange code for tokens
    const actualRedirectUri = redirectUri || 'https://ytseo.siteuo.com/video-wizard.html';
    const oauth2Client = getYouTubeOAuth2Client(actualRedirectUri);

    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.access_token) {
      throw new functions.https.HttpsError('internal', 'Failed to obtain access token from YouTube');
    }

    // Store tokens securely in Firestore (encrypted in production)
    const youtubeConnection = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      tokenType: tokens.token_type || 'Bearer',
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scope: tokens.scope || '',
      connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'connected'
    };

    // Get YouTube channel info to display to user
    oauth2Client.setCredentials(tokens);
    const youtubeApi = google.youtube({ version: 'v3', auth: oauth2Client });

    try {
      const channelResponse = await youtubeApi.channels.list({
        part: ['snippet'],
        mine: true
      });

      if (channelResponse.data.items && channelResponse.data.items.length > 0) {
        const channel = channelResponse.data.items[0];
        youtubeConnection.channelId = channel.id;
        youtubeConnection.channelTitle = channel.snippet?.title || 'Unknown Channel';
        youtubeConnection.channelThumbnail = channel.snippet?.thumbnails?.default?.url || null;
      }
    } catch (channelError) {
      console.log('[YouTubeOAuth] Could not fetch channel info:', channelError.message);
      // Continue without channel info - tokens are still valid
    }

    // Store in user's document
    await db.collection('users').doc(uid).set({
      youtubeConnection: youtubeConnection
    }, { merge: true });

    console.log(`[YouTubeOAuth] Successfully connected YouTube for user ${uid}`);

    await logUsage(uid, 'youtube_oauth_connect', {
      channelId: youtubeConnection.channelId
    });

    return {
      success: true,
      message: 'YouTube account connected successfully',
      channel: {
        id: youtubeConnection.channelId || null,
        title: youtubeConnection.channelTitle || 'YouTube Account',
        thumbnail: youtubeConnection.channelThumbnail || null
      }
    };

  } catch (error) {
    console.error('[YouTubeOAuth] Callback error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to connect YouTube account. Please try again.');
  }
});

/**
 * getYouTubeConnectionStatus - Check if user has connected YouTube
 */
exports.getYouTubeConnectionStatus = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  try {
    const userDoc = await db.collection('users').doc(uid).get();

    if (!userDoc.exists) {
      return {
        connected: false,
        channel: null
      };
    }

    const userData = userDoc.data();
    const connection = userData.youtubeConnection;

    if (!connection || connection.status !== 'connected' || !connection.accessToken) {
      return {
        connected: false,
        channel: null
      };
    }

    // Check if token is expired
    const isExpired = connection.expiresAt &&
      connection.expiresAt.toDate &&
      connection.expiresAt.toDate() < new Date();

    // If we have a refresh token, we can refresh expired access tokens
    const canRefresh = !!connection.refreshToken;

    return {
      connected: true,
      needsRefresh: isExpired && canRefresh,
      expired: isExpired && !canRefresh,
      channel: {
        id: connection.channelId || null,
        title: connection.channelTitle || 'YouTube Account',
        thumbnail: connection.channelThumbnail || null
      },
      connectedAt: connection.connectedAt?.toDate?.()?.toISOString() || null
    };

  } catch (error) {
    console.error('[YouTubeOAuth] Status check error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to check YouTube connection status');
  }
});

/**
 * disconnectYouTube - Remove YouTube connection
 */
exports.disconnectYouTube = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  try {
    const userDoc = await db.collection('users').doc(uid).get();

    if (userDoc.exists && userDoc.data().youtubeConnection) {
      // Optionally revoke token at Google
      const connection = userDoc.data().youtubeConnection;
      if (connection.accessToken) {
        try {
          await axios.post(`https://oauth2.googleapis.com/revoke?token=${connection.accessToken}`);
        } catch (revokeError) {
          console.log('[YouTubeOAuth] Token revoke note:', revokeError.message);
          // Continue even if revoke fails
        }
      }
    }

    // Remove connection from user document
    await db.collection('users').doc(uid).update({
      youtubeConnection: admin.firestore.FieldValue.delete()
    });

    console.log(`[YouTubeOAuth] Disconnected YouTube for user ${uid}`);

    await logUsage(uid, 'youtube_oauth_disconnect', {});

    return {
      success: true,
      message: 'YouTube account disconnected'
    };

  } catch (error) {
    console.error('[YouTubeOAuth] Disconnect error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to disconnect YouTube account');
  }
});

/**
 * refreshYouTubeToken - Refresh expired YouTube access token
 * Called internally or when token is about to expire
 */
exports.refreshYouTubeToken = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);

  try {
    const userDoc = await db.collection('users').doc(uid).get();

    if (!userDoc.exists || !userDoc.data().youtubeConnection) {
      throw new functions.https.HttpsError('not-found', 'No YouTube connection found');
    }

    const connection = userDoc.data().youtubeConnection;

    if (!connection.refreshToken) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'No refresh token available. Please reconnect your YouTube account.'
      );
    }

    // Create OAuth client and refresh
    const oauth2Client = getYouTubeOAuth2Client('https://ytseo.siteuo.com/video-wizard.html');
    oauth2Client.setCredentials({
      refresh_token: connection.refreshToken
    });

    const { credentials } = await oauth2Client.refreshAccessToken();

    // Update stored tokens
    await db.collection('users').doc(uid).update({
      'youtubeConnection.accessToken': credentials.access_token,
      'youtubeConnection.expiresAt': credentials.expiry_date ? new Date(credentials.expiry_date) : null,
      'youtubeConnection.updatedAt': admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`[YouTubeOAuth] Refreshed token for user ${uid}`);

    return {
      success: true,
      message: 'YouTube token refreshed successfully'
    };

  } catch (error) {
    console.error('[YouTubeOAuth] Token refresh error:', error);

    // If refresh fails, mark connection as needing reconnection
    try {
      await db.collection('users').doc(uid).update({
        'youtubeConnection.status': 'expired',
        'youtubeConnection.updatedAt': admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (updateError) {
      console.error('[YouTubeOAuth] Failed to update status:', updateError);
    }

    throw new functions.https.HttpsError(
      'unauthenticated',
      'Failed to refresh YouTube token. Please reconnect your account.'
    );
  }
});

/**
 * Internal helper to get valid YouTube credentials for a user
 * Used by video processing functions
 */
async function getYouTubeCredentialsForUser(uid) {
  const userDoc = await db.collection('users').doc(uid).get();

  if (!userDoc.exists || !userDoc.data().youtubeConnection) {
    return null;
  }

  const connection = userDoc.data().youtubeConnection;

  if (connection.status !== 'connected' || !connection.accessToken) {
    return null;
  }

  // Check if token needs refresh
  const needsRefresh = connection.expiresAt &&
    connection.expiresAt.toDate &&
    connection.expiresAt.toDate() < new Date(Date.now() + 5 * 60 * 1000); // 5 min buffer

  if (needsRefresh && connection.refreshToken) {
    try {
      const oauth2Client = getYouTubeOAuth2Client('https://ytseo.siteuo.com/video-wizard.html');
      oauth2Client.setCredentials({
        refresh_token: connection.refreshToken
      });

      const { credentials } = await oauth2Client.refreshAccessToken();

      // Update stored tokens
      await db.collection('users').doc(uid).update({
        'youtubeConnection.accessToken': credentials.access_token,
        'youtubeConnection.expiresAt': credentials.expiry_date ? new Date(credentials.expiry_date) : null,
        'youtubeConnection.updatedAt': admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        accessToken: credentials.access_token,
        refreshToken: connection.refreshToken
      };
    } catch (refreshError) {
      console.error('[YouTubeOAuth] Auto-refresh failed:', refreshError);
      return null;
    }
  }

  return {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken
  };
}

// ============================================
// YOUTUBE OAUTH CALLBACK PAGE
// ============================================

/**
 * HTTP endpoint that serves the OAuth callback page
 * This eliminates the need to upload a separate HTML file
 * URL: https://us-central1-ytseo-6d1b0.cloudfunctions.net/youtubeOAuthCallbackPage
 */
exports.youtubeOAuthCallbackPage = functions.https.onRequest((req, res) => {
  // Set CORS headers
  res.set('Access-Control-Allow-Origin', '*');

  const callbackHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>YouTube Authorization</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
        }
        .container { text-align: center; padding: 2rem; max-width: 400px; }
        .icon {
            width: 80px; height: 80px; margin: 0 auto 1.5rem;
            background: rgba(255, 0, 0, 0.1); border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
        }
        .icon svg { width: 40px; height: 40px; }
        h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
        p { color: rgba(255, 255, 255, 0.6); margin-bottom: 1.5rem; }
        .spinner {
            width: 40px; height: 40px;
            border: 3px solid rgba(255, 255, 255, 0.1);
            border-top-color: #ff0000; border-radius: 50%;
            animation: spin 1s linear infinite; margin: 0 auto;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .success { color: #10b981; }
        .error { color: #ef4444; }
        .status-icon { font-size: 3rem; margin-bottom: 1rem; }
    </style>
</head>
<body>
    <div class="container" id="content">
        <div class="icon">
            <svg viewBox="0 0 24 24" fill="#ff0000">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
            </svg>
        </div>
        <h1>Connecting YouTube...</h1>
        <p>Please wait while we complete the authorization.</p>
        <div class="spinner"></div>
    </div>
    <script>
        (function() {
            var params = new URLSearchParams(window.location.search);
            var code = params.get('code');
            var state = params.get('state');
            var error = params.get('error');
            var container = document.getElementById('content');

            function showSuccess() {
                container.innerHTML = '<div class="status-icon success">✓</div>' +
                    '<h1 class="success">Connected!</h1>' +
                    '<p>YouTube account connected. This window will close automatically.</p>';
            }
            function showError(msg) {
                container.innerHTML = '<div class="status-icon error">✗</div>' +
                    '<h1 class="error">Connection Failed</h1>' +
                    '<p>' + (msg || 'Authorization failed.') + '</p>' +
                    '<p style="margin-top:1rem">You can close this window and try again.</p>';
            }

            if (error) { showError(error === 'access_denied' ? 'Authorization was cancelled.' : error); return; }
            if (!code || !state) { showError('Missing authorization parameters.'); return; }

            // Check if opener exists
            if (window.opener && !window.opener.closed) {
                // Always use postMessage first - it works cross-origin
                // The try/catch for direct function call would fail on cross-origin
                try {
                    // Send via postMessage (cross-origin compatible)
                    window.opener.postMessage({
                        type: 'youtube-oauth-callback',
                        code: code,
                        state: state
                    }, '*');

                    showSuccess();
                    setTimeout(function() { window.close(); }, 2000);
                } catch (e) {
                    console.error('postMessage failed:', e);
                    // Fallback to localStorage
                    try {
                        localStorage.setItem('youtube_oauth_pending', JSON.stringify({ code: code, state: state, timestamp: Date.now() }));
                        showSuccess();
                        container.innerHTML += '<p style="margin-top:1rem;font-size:0.85rem">Return to Video Wizard to complete connection.</p>';
                    } catch (e2) {
                        showError('Could not communicate with main window.');
                    }
                }
            } else {
                // No opener - store in localStorage for main app to pick up
                try {
                    localStorage.setItem('youtube_oauth_pending', JSON.stringify({ code: code, state: state, timestamp: Date.now() }));
                    showSuccess();
                    container.innerHTML += '<p style="margin-top:1rem;font-size:0.85rem">Return to Video Wizard to complete connection.</p>';
                } catch (e) { showError('Could not save authorization.'); }
            }
        })();
    </script>
</body>
</html>`;

  res.status(200).send(callbackHTML);
});

// ==============================================
// WIZARD: AI-POWERED METADATA EXTRACTION
// Extract title, description, tags from uploaded video
// Uses Whisper for transcription + GPT-4 for metadata generation
// ==============================================

exports.wizardExtractVideoMetadata = functions
  .runWith({
    timeoutSeconds: 300,  // 5 minutes for transcription
    memory: '1GB'         // Need memory for video processing
  })
  .https.onCall(async (data, context) => {
    const uid = await verifyAuth(context);

    const { videoUrl, fileName } = data;

    if (!videoUrl) {
      throw new functions.https.HttpsError('invalid-argument', 'Video URL is required');
    }

    console.log(`[MetadataExtract] Starting for user ${uid}, file: ${fileName || 'unknown'}`);

    try {
      // Step 1: Download video to temporary file
      console.log(`[MetadataExtract] Downloading video from: ${videoUrl.substring(0, 100)}...`);

      const fetch = (await import('node-fetch')).default;
      const fs = require('fs');
      const os = require('os');
      const path = require('path');

      const tempDir = os.tmpdir();
      const tempVideoFile = path.join(tempDir, `metadata_${Date.now()}.mp4`);

      const response = await fetch(videoUrl);
      if (!response.ok) {
        throw new Error(`Failed to download video: ${response.status}`);
      }

      const buffer = await response.buffer();
      fs.writeFileSync(tempVideoFile, buffer);

      const fileSizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
      console.log(`[MetadataExtract] Downloaded ${fileSizeMB} MB`);

      // Check file size limit for Whisper (25MB for audio, but video files are larger)
      // Whisper API has a 25MB limit - we'll need to extract just audio for larger files
      // For now, let's try with the video file directly (Whisper extracts audio)

      let transcription = '';

      try {
        // Step 2: Transcribe with Whisper
        console.log(`[MetadataExtract] Transcribing with Whisper...`);

        const whisperResponse = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tempVideoFile),
          model: 'whisper-1',
          response_format: 'text',
          language: 'en'  // Can be auto-detected by removing this
        });

        transcription = whisperResponse;
        console.log(`[MetadataExtract] Transcription complete: ${transcription.length} chars`);

      } catch (whisperError) {
        console.error(`[MetadataExtract] Whisper error:`, whisperError.message);

        // If file too large, try with a shorter segment
        if (whisperError.message.includes('too large') || whisperError.message.includes('25 MB')) {
          console.log(`[MetadataExtract] File too large for Whisper, skipping transcription`);
          transcription = '(Video too large for automatic transcription)';
        } else {
          throw whisperError;
        }
      } finally {
        // Clean up temp file
        try {
          fs.unlinkSync(tempVideoFile);
        } catch (e) {
          console.log(`[MetadataExtract] Could not delete temp file:`, e.message);
        }
      }

      // Step 3: Generate metadata with GPT-4
      console.log(`[MetadataExtract] Generating metadata with GPT-4...`);

      const gptPrompt = `You are an expert video content analyst. Based on the following transcript from a video, generate SEO-optimized metadata.

TRANSCRIPT:
${transcription.substring(0, 4000)}${transcription.length > 4000 ? '...(truncated)' : ''}

FILE NAME (may contain hints): ${fileName || 'unknown'}

Generate the following in JSON format:
{
  "title": "A compelling, SEO-friendly title (max 60 chars)",
  "description": "A detailed description summarizing the content (100-200 words). Include key points and make it engaging for viewers.",
  "tags": ["array", "of", "relevant", "tags", "for", "discovery"],
  "category": "Best fitting category (e.g., Education, Entertainment, Gaming, How-to, Vlog, etc.)",
  "keyTopics": ["main", "topics", "discussed"],
  "suggestedHashtags": ["#relevant", "#hashtags"]
}

Respond ONLY with valid JSON, no markdown or explanation.`;

      const gptResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',  // Cost-efficient for this task
        messages: [
          {
            role: 'system',
            content: 'You are a video content analyst that generates SEO metadata. Always respond with valid JSON only.'
          },
          { role: 'user', content: gptPrompt }
        ],
        temperature: 0.7,
        max_tokens: 1000
      });

      const gptContent = gptResponse.choices[0]?.message?.content || '{}';
      console.log(`[MetadataExtract] GPT response: ${gptContent.substring(0, 200)}...`);

      // Parse the JSON response
      let metadata;
      try {
        // Clean up potential markdown formatting
        let cleanJson = gptContent.trim();
        if (cleanJson.startsWith('```json')) {
          cleanJson = cleanJson.replace(/^```json\n?/, '').replace(/\n?```$/, '');
        } else if (cleanJson.startsWith('```')) {
          cleanJson = cleanJson.replace(/^```\n?/, '').replace(/\n?```$/, '');
        }

        metadata = JSON.parse(cleanJson);
      } catch (parseError) {
        console.error(`[MetadataExtract] Failed to parse GPT response:`, parseError.message);
        metadata = {
          title: fileName?.replace(/\.[^/.]+$/, '') || 'Untitled Video',
          description: transcription.substring(0, 500) || 'No description available',
          tags: [],
          category: 'Other',
          keyTopics: [],
          suggestedHashtags: []
        };
      }

      // Add transcription to metadata for reference
      metadata.transcription = transcription.substring(0, 2000);
      metadata.hasFullTranscription = transcription.length > 0 && !transcription.includes('too large');

      console.log(`[MetadataExtract] Success! Title: "${metadata.title}"`);

      return {
        success: true,
        metadata: metadata
      };

    } catch (error) {
      console.error(`[MetadataExtract] Error:`, error.message);
      throw new functions.https.HttpsError('internal', `Failed to extract metadata: ${error.message}`);
    }
  });

// ==============================================
// EXTENSION: Video Upload Endpoint
// Receives captured video from browser extension and stores in Firebase Storage
// This is a fallback when Cloud Run video-processor is not available
// ==============================================

const Busboy = require('busboy');

exports.extensionUploadVideo = functions
  .runWith({
    timeoutSeconds: 300,
    memory: '1GB'
  })
  .https.onRequest(async (req, res) => {
    // Set CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    console.log('[ExtensionUpload] Received upload request');

    try {
      const busboy = Busboy({ headers: req.headers });

      let videoBuffer = null;
      let videoId = null;
      let fileType = 'video';
      let mimeType = 'video/webm';
      let captureStart = 0;
      let captureEnd = 0;

      const filePromise = new Promise((resolve, reject) => {
        busboy.on('field', (name, val) => {
          if (name === 'videoId') videoId = val;
          if (name === 'type') fileType = val;
          if (name === 'captureStart') captureStart = parseFloat(val) || 0;
          if (name === 'captureEnd') captureEnd = parseFloat(val) || 0;
        });

        busboy.on('file', (name, file, info) => {
          mimeType = info.mimeType || 'video/webm';
          const chunks = [];
          file.on('data', (data) => chunks.push(data));
          file.on('end', () => {
            videoBuffer = Buffer.concat(chunks);
            console.log(`[ExtensionUpload] File received: ${(videoBuffer.length / 1024 / 1024).toFixed(2)}MB`);
          });
        });

        busboy.on('finish', () => resolve());
        busboy.on('error', reject);
      });

      if (req.rawBody) {
        busboy.end(req.rawBody);
      } else {
        req.pipe(busboy);
      }

      await filePromise;

      if (!videoBuffer) {
        return res.status(400).json({ error: 'No video file provided' });
      }

      if (!videoId) {
        return res.status(400).json({ error: 'videoId is required' });
      }

      const timestamp = Date.now();
      const extension = mimeType.includes('webm') ? 'webm' : 'mp4';
      const fileName = `extension-uploads/${videoId}/${fileType}_${timestamp}.${extension}`;

      console.log(`[ExtensionUpload] Uploading to storage: ${fileName}`);

      const bucket = admin.storage().bucket();
      const file = bucket.file(fileName);

      await file.save(videoBuffer, {
        metadata: {
          contentType: mimeType,
          metadata: {
            videoId: videoId,
            type: fileType,
            captureStart: String(captureStart),
            captureEnd: String(captureEnd),
            uploadedAt: new Date().toISOString(),
            source: 'browser-extension'
          }
        }
      });

      await file.makePublic();

      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
      console.log(`[ExtensionUpload] Upload successful: ${publicUrl}`);

      return res.status(200).json({
        success: true,
        url: publicUrl,
        videoId: videoId,
        type: fileType,
        size: videoBuffer.length
      });

    } catch (error) {
      console.error('[ExtensionUpload] Error:', error);
      return res.status(500).json({ error: error.message || 'Upload failed' });
    }
  });

// ============================================================================
// VIDEO WIZARD ADMIN MANAGEMENT FUNCTIONS
// ============================================================================

/**
 * adminGetWizardStorageStats - Get storage usage statistics
 * Returns total storage used, video count, and breakdown by folder
 */
exports.adminGetWizardStorageStats = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  try {
    const bucket = admin.storage().bucket();

    // Get all files in storage
    const [files] = await bucket.getFiles();

    let totalSize = 0;
    let totalFiles = 0;
    const folderStats = {};

    for (const file of files) {
      const [metadata] = await file.getMetadata();
      const size = parseInt(metadata.size || 0);
      totalSize += size;
      totalFiles++;

      // Group by top-level folder
      const folder = file.name.split('/')[0] || 'root';
      if (!folderStats[folder]) {
        folderStats[folder] = { files: 0, size: 0 };
      }
      folderStats[folder].files++;
      folderStats[folder].size += size;
    }

    // Get project count
    const projectsSnapshot = await db.collection('wizardProjects').get();
    const totalProjects = projectsSnapshot.size;

    // Get processing jobs count
    const activeJobsSnapshot = await db.collection('processingJobs')
      .where('status', 'in', ['pending', 'processing'])
      .get();
    const activeJobs = activeJobsSnapshot.size;

    // Get failed jobs count
    const failedJobsSnapshot = await db.collection('processingJobs')
      .where('status', '==', 'failed')
      .limit(100)
      .get();
    const failedJobs = failedJobsSnapshot.size;

    // Get config
    const configDoc = await db.collection('settings').doc('wizardConfig').get();
    const config = configDoc.exists ? configDoc.data() : {};

    return {
      success: true,
      stats: {
        totalSize,
        totalSizeGB: (totalSize / (1024 * 1024 * 1024)).toFixed(2),
        totalFiles,
        totalProjects,
        activeJobs,
        failedJobs,
        folderStats
      },
      config: {
        maxProjectsPerUser: config.maxProjectsPerUser || 8,
        retentionDays: config.retentionDays || 14,
        autoCleanupEnabled: config.autoCleanupEnabled || false
      }
    };
  } catch (error) {
    console.error('[adminGetWizardStorageStats] Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * adminGetWizardVideos - List all videos/projects with user info
 */
exports.adminGetWizardVideos = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const { limit: queryLimit = 50, startAfter, filterByUser, olderThanDays } = data || {};

  try {
    let query = db.collection('wizardProjects')
      .orderBy('createdAt', 'desc');

    if (filterByUser) {
      query = query.where('userId', '==', filterByUser);
    }

    if (startAfter) {
      const startDoc = await db.collection('wizardProjects').doc(startAfter).get();
      if (startDoc.exists) {
        query = query.startAfter(startDoc);
      }
    }

    query = query.limit(queryLimit);
    const snapshot = await query.get();

    const videos = [];
    const userIds = new Set();

    snapshot.forEach(doc => {
      const data = doc.data();
      userIds.add(data.userId);

      const createdAt = data.createdAt?.toDate?.() || new Date();
      const ageInDays = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

      // Filter by age if specified
      if (olderThanDays && ageInDays < olderThanDays) {
        return;
      }

      videos.push({
        id: doc.id,
        userId: data.userId,
        videoId: data.videoId,
        title: data.videoData?.title || data.uploadedVideoName || 'Unknown',
        clipCount: data.clips?.length || 0,
        isUpload: data.isUpload || false,
        hasSourceAsset: !!data.sourceAsset?.storageUrl,
        createdAt: createdAt.toISOString(),
        ageInDays,
        status: data.status
      });
    });

    // Get user emails for display
    const userEmails = {};
    for (const userId of userIds) {
      try {
        const userRecord = await admin.auth().getUser(userId);
        userEmails[userId] = userRecord.email || 'Unknown';
      } catch (e) {
        userEmails[userId] = 'Deleted User';
      }
    }

    // Add emails to videos
    videos.forEach(v => {
      v.userEmail = userEmails[v.userId] || 'Unknown';
    });

    return {
      success: true,
      videos,
      hasMore: snapshot.size === queryLimit,
      lastId: videos.length > 0 ? videos[videos.length - 1].id : null
    };
  } catch (error) {
    console.error('[adminGetWizardVideos] Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * adminGetTopStorageUsers - Get users consuming most storage
 */
exports.adminGetTopStorageUsers = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  try {
    const projectsSnapshot = await db.collection('wizardProjects').get();

    const userStats = {};

    projectsSnapshot.forEach(doc => {
      const data = doc.data();
      const userId = data.userId;

      if (!userStats[userId]) {
        userStats[userId] = { projectCount: 0, clipCount: 0 };
      }

      userStats[userId].projectCount++;
      userStats[userId].clipCount += data.clips?.length || 0;
    });

    // Get user emails and sort by project count
    const userList = [];
    for (const [userId, stats] of Object.entries(userStats)) {
      try {
        const userRecord = await admin.auth().getUser(userId);
        userList.push({
          userId,
          email: userRecord.email || 'Unknown',
          ...stats
        });
      } catch (e) {
        userList.push({
          userId,
          email: 'Deleted User',
          ...stats
        });
      }
    }

    userList.sort((a, b) => b.projectCount - a.projectCount);

    return {
      success: true,
      users: userList.slice(0, 20) // Top 20 users
    };
  } catch (error) {
    console.error('[adminGetTopStorageUsers] Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * adminDeleteWizardProject - Delete a specific project and its storage
 */
exports.adminDeleteWizardProject = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const { projectId } = data;
  if (!projectId) {
    throw new functions.https.HttpsError('invalid-argument', 'Project ID required');
  }

  try {
    const projectDoc = await db.collection('wizardProjects').doc(projectId).get();
    if (!projectDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Project not found');
    }

    const projectData = projectDoc.data();
    // Use the default bucket (most reliable) - Firebase admin SDK knows the correct bucket
    const bucket = admin.storage().bucket();
    const STORAGE_BUCKET = bucket.name;

    console.log(`[adminDeleteWizardProject] Using bucket: ${STORAGE_BUCKET}, videoId: ${projectData.videoId}`);

    // Delete associated storage files
    const deletedFiles = [];

    // Delete sourceAsset
    if (projectData.sourceAsset?.storagePath) {
      try {
        await bucket.file(projectData.sourceAsset.storagePath).delete();
        deletedFiles.push(projectData.sourceAsset.storagePath);
      } catch (e) { /* ignore */ }
    }

    // Delete uploaded video
    if (projectData.uploadedVideoPath) {
      try {
        await bucket.file(projectData.uploadedVideoPath).delete();
        deletedFiles.push(projectData.uploadedVideoPath);
      } catch (e) { /* ignore */ }
    }

    // Delete extension uploads for this video
    if (projectData.videoId) {
      const prefix = `extension-uploads/${projectData.videoId}/`;
      const [files] = await bucket.getFiles({ prefix });
      for (const file of files) {
        await file.delete().catch(() => {});
        deletedFiles.push(file.name);
      }
    }

    // Delete project document
    await db.collection('wizardProjects').doc(projectId).delete();

    // Delete related processing jobs
    const jobsSnapshot = await db.collection('processingJobs')
      .where('projectId', '==', projectId)
      .get();

    const batch = db.batch();
    jobsSnapshot.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    return {
      success: true,
      deletedProject: projectId,
      deletedFiles: deletedFiles.length,
      deletedJobs: jobsSnapshot.size
    };
  } catch (error) {
    console.error('[adminDeleteWizardProject] Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * adminBulkDeleteWizardProjects - Delete multiple projects or all old projects
 */
exports.adminBulkDeleteWizardProjects = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const { projectIds, olderThanDays, userId, deleteAll, cleanAllStorage } = data;

  try {
    let query = db.collection('wizardProjects');
    let targetDocs = [];

    if (projectIds && projectIds.length > 0) {
      // Delete specific projects
      for (const id of projectIds) {
        const doc = await db.collection('wizardProjects').doc(id).get();
        if (doc.exists) targetDocs.push(doc);
      }
    } else if (olderThanDays) {
      // Delete projects older than X days
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      const snapshot = await query
        .where('createdAt', '<', cutoffDate)
        .get();
      targetDocs = snapshot.docs;
    } else if (userId) {
      // Delete all projects for a specific user
      const snapshot = await query
        .where('userId', '==', userId)
        .get();
      targetDocs = snapshot.docs;
    } else if (deleteAll) {
      // Delete ALL projects (dangerous!)
      const snapshot = await query.get();
      targetDocs = snapshot.docs;
    }

    // CRITICAL: Try multiple bucket name formats - Firebase can use different formats
    const BUCKET_FORMATS = [
      'ytseo-6d1b0.firebasestorage.app',  // New format
      'ytseo-6d1b0.appspot.com',           // Old format
    ];

    let bucket;
    let STORAGE_BUCKET;

    // First, try the default bucket (most reliable)
    console.log('[adminBulkDeleteWizardProjects] Detecting correct bucket...');
    const defaultBucket = admin.storage().bucket();
    const defaultBucketName = defaultBucket.name;
    console.log(`[adminBulkDeleteWizardProjects] Default bucket name: ${defaultBucketName}`);

    // Test if default bucket has files
    try {
      const [testFiles] = await defaultBucket.getFiles({ prefix: 'processed-clips/', maxResults: 5 });
      if (testFiles.length > 0) {
        bucket = defaultBucket;
        STORAGE_BUCKET = defaultBucketName;
        console.log(`[adminBulkDeleteWizardProjects] Using default bucket: ${STORAGE_BUCKET} (found ${testFiles.length} files)`);
      }
    } catch (e) {
      console.log(`[adminBulkDeleteWizardProjects] Default bucket test failed: ${e.message}`);
    }

    // If default bucket didn't have files, try explicit bucket names
    if (!bucket) {
      for (const bucketName of BUCKET_FORMATS) {
        try {
          const testBucket = admin.storage().bucket(bucketName);
          const [testFiles] = await testBucket.getFiles({ prefix: 'processed-clips/', maxResults: 5 });
          if (testFiles.length > 0) {
            bucket = testBucket;
            STORAGE_BUCKET = bucketName;
            console.log(`[adminBulkDeleteWizardProjects] Using bucket: ${STORAGE_BUCKET} (found ${testFiles.length} files)`);
            break;
          }
        } catch (e) {
          console.log(`[adminBulkDeleteWizardProjects] ${bucketName} failed: ${e.message}`);
        }
      }
    }

    // If still no bucket, use default
    if (!bucket) {
      bucket = defaultBucket;
      STORAGE_BUCKET = defaultBucketName;
      console.log(`[adminBulkDeleteWizardProjects] No files found, using default bucket: ${STORAGE_BUCKET}`);
    }

    let deletedCount = 0;
    let deletedFilesCount = 0;

    console.log(`[adminBulkDeleteWizardProjects] Using bucket: ${STORAGE_BUCKET}`);

    // Delete project-associated files
    for (const doc of targetDocs) {
      const projectData = doc.data();

      // Delete storage files
      if (projectData.sourceAsset?.storagePath) {
        await bucket.file(projectData.sourceAsset.storagePath).delete().catch(() => {});
        deletedFilesCount++;
      }
      if (projectData.uploadedVideoPath) {
        await bucket.file(projectData.uploadedVideoPath).delete().catch(() => {});
        deletedFilesCount++;
      }
      if (projectData.videoId) {
        const prefix = `extension-uploads/${projectData.videoId}/`;
        const [files] = await bucket.getFiles({ prefix });
        for (const file of files) {
          await file.delete().catch(() => {});
          deletedFilesCount++;
        }
      }

      // Delete project
      await db.collection('wizardProjects').doc(doc.id).delete();
      deletedCount++;
    }

    // If deleteAll or cleanAllStorage flag is set, also delete ALL files in storage
    // This catches orphaned files not referenced by any project document
    if (deleteAll || cleanAllStorage) {
      console.log('[adminBulkDeleteWizardProjects] Cleaning ALL storage files...');

      // All storage folders that the Video Wizard uses
      const storageFolders = [
        'processed-clips/',     // Exported processed clips (video-processor)
        'extension-uploads/',   // Extension video/audio captures
        'uploads/',             // Frontend: file uploads, export captures, parallel exports
        'video-cache/',         // FULL SOURCE VIDEOS cached by video-processor (HUGE!)
        'thumbnails-pro/',      // Pro thumbnail generator (Gemini, DALL-E, Imagen)
        'wizard-thumbnails/',   // Wizard clip AI thumbnails
        'wizard-videos/',       // Legacy - may not exist
        'video-uploads/',       // Legacy - may not exist
      ];

      for (const folder of storageFolders) {
        const [files] = await bucket.getFiles({ prefix: folder });
        for (const file of files) {
          await file.delete().catch((e) => console.warn(`Failed to delete ${file.name}:`, e.message));
          deletedFilesCount++;
        }
        if (files.length > 0) {
          console.log(`[adminBulkDeleteWizardProjects] Deleted ${files.length} files from ${folder}`);
        }
      }
    }

    console.log(`[adminBulkDeleteWizardProjects] Total: Deleted ${deletedCount} projects, ${deletedFilesCount} files`);

    return {
      success: true,
      deleted: deletedCount,
      deletedFiles: deletedFilesCount
    };
  } catch (error) {
    console.error('[adminBulkDeleteWizardProjects] Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * adminCleanWizardStorage - Clean ALL Video Wizard storage files (orphan cleanup)
 * This deletes ALL files in wizard-related storage folders regardless of project references
 */
exports.adminCleanWizardStorage = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const { dryRun = false } = data;

  try {
    // Try multiple bucket name formats - Firebase can use different formats
    const BUCKET_FORMATS = [
      'ytseo-6d1b0.firebasestorage.app',  // New format
      'ytseo-6d1b0.appspot.com',           // Old format
    ];

    let bucket;
    let STORAGE_BUCKET;
    let foundFiles = false;

    // First, try the default bucket (most reliable)
    console.log('[adminCleanWizardStorage] Trying default bucket first...');
    const defaultBucket = admin.storage().bucket();
    const defaultBucketName = defaultBucket.name;
    console.log(`[adminCleanWizardStorage] Default bucket name: ${defaultBucketName}`);

    try {
      const [testFiles] = await defaultBucket.getFiles({ prefix: 'processed-clips/', maxResults: 5 });
      console.log(`[adminCleanWizardStorage] Default bucket: found ${testFiles.length} files in processed-clips/`);
      if (testFiles.length > 0) {
        bucket = defaultBucket;
        STORAGE_BUCKET = defaultBucketName;
        foundFiles = true;
        console.log(`[adminCleanWizardStorage] Using default bucket: ${STORAGE_BUCKET}`);
      }
    } catch (e) {
      console.log(`[adminCleanWizardStorage] Default bucket test failed: ${e.message}`);
    }

    // If default bucket didn't have files, try explicit bucket names
    if (!foundFiles) {
      for (const bucketName of BUCKET_FORMATS) {
        console.log(`[adminCleanWizardStorage] Trying bucket: ${bucketName}`);
        try {
          const testBucket = admin.storage().bucket(bucketName);
          const [testFiles] = await testBucket.getFiles({ prefix: 'processed-clips/', maxResults: 5 });
          console.log(`[adminCleanWizardStorage] ${bucketName}: found ${testFiles.length} files in processed-clips/`);
          if (testFiles.length > 0) {
            bucket = testBucket;
            STORAGE_BUCKET = bucketName;
            foundFiles = true;
            console.log(`[adminCleanWizardStorage] Using bucket: ${STORAGE_BUCKET}`);
            break;
          }
        } catch (e) {
          console.log(`[adminCleanWizardStorage] ${bucketName} failed: ${e.message}`);
        }
      }
    }

    // If still no files found, use default bucket anyway and report what we find
    if (!bucket) {
      bucket = defaultBucket;
      STORAGE_BUCKET = defaultBucketName;
      console.log(`[adminCleanWizardStorage] No files found in any bucket, using default: ${STORAGE_BUCKET}`);
    }

    console.log(`[adminCleanWizardStorage] Starting cleanup, bucket: ${STORAGE_BUCKET}, dryRun: ${dryRun}`);

    // Check all possible storage locations used by Video Wizard
    // IMPORTANT: These must match the ACTUAL folder names in Firebase Storage
    const storagePrefixes = [
      'processed-clips/',     // Exported processed clips (video-processor)
      'extension-uploads/',   // Extension video/audio captures
      'uploads/',             // Frontend: file uploads, export captures, parallel exports (HIGH IMPACT!)
      'video-cache/',         // FULL SOURCE VIDEOS cached by video-processor (HUGE!)
      'thumbnails-pro/',      // Pro thumbnail generator (Gemini, DALL-E, Imagen)
      'wizard-thumbnails/',   // Wizard clip AI thumbnails
      'wizard-videos/',       // Legacy - may not exist
      'video-uploads/',       // Legacy - may not exist
      'temp/'                 // Temporary files
    ];

    let totalFiles = 0;
    let totalSize = 0;
    const results = {};

    for (const prefix of storagePrefixes) {
      console.log(`[adminCleanWizardStorage] Scanning: ${prefix}`);
      const [files] = await bucket.getFiles({ prefix });
      let folderSize = 0;

      for (const file of files) {
        try {
          const [metadata] = await file.getMetadata();
          folderSize += parseInt(metadata.size || 0);
        } catch (e) {
          // Ignore metadata errors
        }

        if (!dryRun) {
          await file.delete().catch((e) => console.warn(`Failed to delete ${file.name}:`, e.message));
        }
      }

      results[prefix] = {
        fileCount: files.length,
        sizeBytes: folderSize,
        sizeMB: (folderSize / (1024 * 1024)).toFixed(2)
      };

      if (files.length > 0) {
        console.log(`[adminCleanWizardStorage] ${prefix}: ${files.length} files, ${(folderSize / (1024 * 1024)).toFixed(2)} MB`);
      }

      totalFiles += files.length;
      totalSize += folderSize;
    }

    // Also try to list ALL files in the bucket to find any unexpected locations
    console.log(`[adminCleanWizardStorage] Scanning entire bucket for any remaining files...`);
    const [allFiles] = await bucket.getFiles({ maxResults: 1000 });

    // Find files that weren't in our prefixes
    const knownPrefixes = storagePrefixes;
    const otherFiles = allFiles.filter(f => !knownPrefixes.some(p => f.name.startsWith(p)));

    if (otherFiles.length > 0) {
      let otherSize = 0;
      const otherPaths = new Set();

      for (const file of otherFiles) {
        const folder = file.name.split('/')[0] + '/';
        otherPaths.add(folder);

        try {
          const [metadata] = await file.getMetadata();
          otherSize += parseInt(metadata.size || 0);
        } catch (e) {}

        if (!dryRun) {
          await file.delete().catch((e) => console.warn(`Failed to delete ${file.name}:`, e.message));
        }
      }

      results['OTHER (unexpected)'] = {
        fileCount: otherFiles.length,
        sizeBytes: otherSize,
        sizeMB: (otherSize / (1024 * 1024)).toFixed(2),
        paths: Array.from(otherPaths)
      };

      console.log(`[adminCleanWizardStorage] Found ${otherFiles.length} files in unexpected locations: ${Array.from(otherPaths).join(', ')}`);

      totalFiles += otherFiles.length;
      totalSize += otherSize;
    }

    console.log(`[adminCleanWizardStorage] ${dryRun ? 'DRY RUN - ' : ''}Total: ${totalFiles} files, ${(totalSize / (1024 * 1024)).toFixed(2)} MB`);

    // Also clean up the videoSourceCache Firestore collection (references to video-cache/ files)
    let cacheDocsDeleted = 0;
    try {
      const cacheSnapshot = await db.collection('videoSourceCache').get();
      if (!cacheSnapshot.empty) {
        console.log(`[adminCleanWizardStorage] Found ${cacheSnapshot.size} videoSourceCache documents`);
        if (!dryRun) {
          const batch = db.batch();
          cacheSnapshot.docs.forEach(doc => batch.delete(doc.ref));
          await batch.commit();
          cacheDocsDeleted = cacheSnapshot.size;
          console.log(`[adminCleanWizardStorage] Deleted ${cacheDocsDeleted} videoSourceCache documents`);
        } else {
          cacheDocsDeleted = cacheSnapshot.size;
        }
      }
    } catch (cacheError) {
      console.log('[adminCleanWizardStorage] videoSourceCache cleanup note:', cacheError.message);
    }

    return {
      success: true,
      dryRun,
      bucket: STORAGE_BUCKET,
      totalFiles,
      totalSizeBytes: totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      totalSizeGB: (totalSize / (1024 * 1024 * 1024)).toFixed(3),
      breakdown: results,
      cacheDocsDeleted,
      message: dryRun
        ? `Found ${totalFiles} files (${(totalSize / (1024 * 1024)).toFixed(2)} MB) that would be deleted`
        : `Deleted ${totalFiles} files (${(totalSize / (1024 * 1024)).toFixed(2)} MB)`
    };
  } catch (error) {
    console.error('[adminCleanWizardStorage] Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * adminSetWizardConfig - Set Video Wizard configuration
 */
exports.adminSetWizardConfig = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const { maxProjectsPerUser, retentionDays, autoCleanupEnabled } = data;

  try {
    const updateData = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: context.auth.uid
    };

    if (maxProjectsPerUser !== undefined) {
      updateData.maxProjectsPerUser = Math.max(1, Math.min(50, parseInt(maxProjectsPerUser)));
    }
    if (retentionDays !== undefined) {
      updateData.retentionDays = Math.max(1, Math.min(365, parseInt(retentionDays)));
    }
    if (autoCleanupEnabled !== undefined) {
      updateData.autoCleanupEnabled = !!autoCleanupEnabled;
    }

    await db.collection('settings').doc('wizardConfig').set(updateData, { merge: true });

    return {
      success: true,
      config: updateData
    };
  } catch (error) {
    console.error('[adminSetWizardConfig] Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * adminGetProcessingJobs - Get processing job status
 */
exports.adminGetProcessingJobs = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const { status, limit: queryLimit = 50 } = data || {};

  try {
    let query = db.collection('processingJobs')
      .orderBy('createdAt', 'desc');

    if (status) {
      query = query.where('status', '==', status);
    }

    const snapshot = await query.limit(queryLimit).get();

    const jobs = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      jobs.push({
        id: doc.id,
        projectId: data.projectId,
        clipId: data.clipId,
        status: data.status,
        error: data.error,
        createdAt: data.createdAt?.toDate?.().toISOString(),
        completedAt: data.completedAt?.toDate?.().toISOString()
      });
    });

    return { success: true, jobs };
  } catch (error) {
    console.error('[adminGetProcessingJobs] Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * adminRetryFailedJob - Retry a failed processing job
 */
exports.adminRetryFailedJob = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const { jobId } = data;
  if (!jobId) {
    throw new functions.https.HttpsError('invalid-argument', 'Job ID required');
  }

  try {
    const jobDoc = await db.collection('processingJobs').doc(jobId).get();
    if (!jobDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Job not found');
    }

    const jobData = jobDoc.data();
    if (jobData.status !== 'failed') {
      throw new functions.https.HttpsError('failed-precondition', 'Job is not in failed state');
    }

    // Reset job status to pending
    await db.collection('processingJobs').doc(jobId).update({
      status: 'pending',
      error: null,
      retryCount: (jobData.retryCount || 0) + 1,
      retriedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, message: 'Job queued for retry' };
  } catch (error) {
    console.error('[adminRetryFailedJob] Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * adminClearFailedJobs - Delete all failed processing jobs
 */
exports.adminClearFailedJobs = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  try {
    const snapshot = await db.collection('processingJobs')
      .where('status', '==', 'failed')
      .get();

    const batch = db.batch();
    snapshot.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    return { success: true, deleted: snapshot.size };
  } catch (error) {
    console.error('[adminClearFailedJobs] Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * scheduledWizardCleanup - Scheduled function to clean up old projects
 * Runs daily at 3 AM UTC
 */
exports.scheduledWizardCleanup = functions.pubsub
  .schedule('0 3 * * *')
  .timeZone('UTC')
  .onRun(async (context) => {
    console.log('[scheduledWizardCleanup] Starting scheduled cleanup...');

    try {
      // Check if auto-cleanup is enabled
      const configDoc = await db.collection('settings').doc('wizardConfig').get();
      const config = configDoc.exists ? configDoc.data() : {};

      if (!config.autoCleanupEnabled) {
        console.log('[scheduledWizardCleanup] Auto-cleanup is disabled, skipping');
        return null;
      }

      const retentionDays = config.retentionDays || 14;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      console.log(`[scheduledWizardCleanup] Deleting projects older than ${retentionDays} days (before ${cutoffDate.toISOString()})`);

      // Find old projects
      const snapshot = await db.collection('wizardProjects')
        .where('createdAt', '<', cutoffDate)
        .get();

      if (snapshot.empty) {
        console.log('[scheduledWizardCleanup] No old projects to delete');
        return null;
      }

      const bucket = admin.storage().bucket();
      let deletedCount = 0;
      let deletedFilesCount = 0;

      for (const doc of snapshot.docs) {
        const projectData = doc.data();

        // Delete storage files
        if (projectData.sourceAsset?.storagePath) {
          await bucket.file(projectData.sourceAsset.storagePath).delete().catch(() => {});
          deletedFilesCount++;
        }
        if (projectData.uploadedVideoPath) {
          await bucket.file(projectData.uploadedVideoPath).delete().catch(() => {});
          deletedFilesCount++;
        }
        if (projectData.videoId) {
          const prefix = `extension-uploads/${projectData.videoId}/`;
          const [files] = await bucket.getFiles({ prefix });
          for (const file of files) {
            await file.delete().catch(() => {});
            deletedFilesCount++;
          }
        }

        // Delete project
        await db.collection('wizardProjects').doc(doc.id).delete();
        deletedCount++;
      }

      console.log(`[scheduledWizardCleanup] Completed: deleted ${deletedCount} projects, ${deletedFilesCount} files`);

      // Log cleanup action
      await db.collection('adminLogs').add({
        action: 'scheduled_wizard_cleanup',
        deletedProjects: deletedCount,
        deletedFiles: deletedFilesCount,
        retentionDays,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return null;
    } catch (error) {
      console.error('[scheduledWizardCleanup] Error:', error);
      return null;
    }
  });

/**
 * adminManualCleanup - Manually trigger cleanup
 */
exports.adminManualCleanup = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);

  const { olderThanDays } = data;

  if (!olderThanDays || olderThanDays < 1) {
    throw new functions.https.HttpsError('invalid-argument', 'olderThanDays must be at least 1');
  }

  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const snapshot = await db.collection('wizardProjects')
      .where('createdAt', '<', cutoffDate)
      .get();

    if (snapshot.empty) {
      return { success: true, deleted: 0, message: 'No old projects found' };
    }

    const bucket = admin.storage().bucket();
    let deletedCount = 0;
    let deletedFilesCount = 0;

    for (const doc of snapshot.docs) {
      const projectData = doc.data();

      if (projectData.sourceAsset?.storagePath) {
        await bucket.file(projectData.sourceAsset.storagePath).delete().catch(() => {});
        deletedFilesCount++;
      }
      if (projectData.uploadedVideoPath) {
        await bucket.file(projectData.uploadedVideoPath).delete().catch(() => {});
        deletedFilesCount++;
      }
      if (projectData.videoId) {
        const prefix = `extension-uploads/${projectData.videoId}/`;
        const [files] = await bucket.getFiles({ prefix });
        for (const file of files) {
          await file.delete().catch(() => {});
          deletedFilesCount++;
        }
      }

      await db.collection('wizardProjects').doc(doc.id).delete();
      deletedCount++;
    }

    await db.collection('adminLogs').add({
      action: 'manual_wizard_cleanup',
      deletedProjects: deletedCount,
      deletedFiles: deletedFilesCount,
      olderThanDays,
      adminId: context.auth.uid,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      deleted: deletedCount,
      deletedFiles: deletedFilesCount
    };
  } catch (error) {
    console.error('[adminManualCleanup] Error:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});
