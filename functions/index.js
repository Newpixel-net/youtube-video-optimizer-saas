/**
 * YouTube Tools - Complete SaaS Backend
 * 20+ Cloud Functions with Authentication, Usage Limits, and Admin Panel
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const { google } = require('googleapis');
const axios = require('axios');

admin.initializeApp();
const db = admin.firestore();

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
    throw new functions.https.HttpsError('not-found', 'User not found');
  }
  return userDoc.data();
}

async function checkUsageLimit(uid, toolType) {
  const userDoc = await db.collection('users').doc(uid).get();
  const user = userDoc.data();
  if (!user) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }

  const usage = user.usage?.[toolType];
  if (!usage) {
    throw new functions.https.HttpsError('not-found', 'Usage data not found for tool: ' + toolType);
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
        titleGenerator: {
          usedToday: 0,
          limit: planLimits.titleGenerator.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        descriptionGenerator: {
          usedToday: 0,
          limit: planLimits.descriptionGenerator.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        tagGenerator: {
          usedToday: 0,
          limit: planLimits.tagGenerator.dailyLimit,
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

async function generateTitlesInternal(metadata, transcript) {
  const transcriptText = transcript.fullText || '';
  const titlePrompt = `Generate 3 viral YouTube titles for this video.

Video: ${metadata.title}
Description: ${metadata.description?.substring(0, 500) || ''}
Transcript: ${transcriptText.substring(0, 2000)}

DETECT VIDEO TYPE (music, tutorial, review, gaming, vlog, etc.) and add appropriate suffixes.

Create 3 titles (60-70 chars each):
1. CLICKBAIT: Curiosity-driven
2. SEO-OPTIMIZED: Keyword-rich
3. QUESTION FORMAT: Addresses pain point

Return ONLY valid JSON:
{
  "clickbait": "title",
  "seo": "title",
  "question": "title",
  "detectedType": "type"
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Create viral YouTube titles. Return only valid JSON.' },
      { role: 'user', content: titlePrompt }
    ],
    temperature: 0.8,
    max_tokens: 400
  });
  
  try {
    const responseText = completion.choices[0].message.content.trim();
    const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleanJson);
  } catch (error) {
    return { 
      clickbait: metadata.title, 
      seo: metadata.title, 
      question: metadata.title,
      detectedType: 'general'
    };
  }
}

async function generateDescriptionInternal(metadata, transcript) {
  const transcriptText = transcript.fullText || '';
  const durationSeconds = parseDuration(metadata.duration);
  
  const descriptionPrompt = `Create YouTube description for this video.

Video: ${metadata.title}
Duration: ${formatTimestamp(durationSeconds)}
Transcript: ${transcriptText.substring(0, 3000)}

Include:
1. Hook (2-3 sentences)
2. Key points (3-5 bullets with emojis)
3. Timestamps (every 2-3 min)
4. Resources/Links
5. Call-to-action
6. 3-5 hashtags`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Create engaging YouTube descriptions.' },
      { role: 'user', content: descriptionPrompt }
    ],
    temperature: 0.7,
    max_tokens: 1000
  });
  
  return completion.choices[0].message.content.trim();
}

async function generateTagsInternal(metadata, transcript) {
  const transcriptText = transcript.fullText || '';
  
  const tagsPrompt = `Generate YouTube tags for this video.

Video: ${metadata.title}
Transcript: ${transcriptText.substring(0, 2000)}

Create 30-50 tags in categories:
1. Primary (5-8)
2. Secondary (8-12)
3. Long-tail (10-15)
4. Trending (5-10)

Return ONLY valid JSON:
{
  "primary": ["tag1"],
  "secondary": ["tag2"],
  "longTail": ["phrase"],
  "trending": ["trend"]
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'Generate YouTube tags. Return only valid JSON.' },
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
    throw new functions.https.HttpsError('internal', error.message);
  }
});

exports.generateTitles = functions.https.onCall(async (data, context) => {
  try {
    const uid = await verifyAuth(context);
    const usageCheck = await checkUsageLimit(uid, 'titleGenerator');
    const { videoUrl } = data;
    if (!videoUrl) throw new functions.https.HttpsError('invalid-argument', 'Video URL required');
    
    const videoId = extractVideoId(videoUrl);
    const metadata = await getVideoMetadata(videoId);
    const transcript = await getVideoTranscript(videoId);
    const titles = await generateTitlesInternal(metadata, transcript);
    
    await incrementUsage(uid, 'titleGenerator');
    await logUsage(uid, 'title_generator_used', { videoId });
    
    return { success: true, videoData: metadata, titles, usageRemaining: usageCheck.remaining };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', error.message);
  }
});

exports.generateDescription = functions.https.onCall(async (data, context) => {
  try {
    const uid = await verifyAuth(context);
    const usageCheck = await checkUsageLimit(uid, 'descriptionGenerator');
    const { videoUrl } = data;
    if (!videoUrl) throw new functions.https.HttpsError('invalid-argument', 'Video URL required');
    
    const videoId = extractVideoId(videoUrl);
    const metadata = await getVideoMetadata(videoId);
    const transcript = await getVideoTranscript(videoId);
    const description = await generateDescriptionInternal(metadata, transcript);
    
    await incrementUsage(uid, 'descriptionGenerator');
    await logUsage(uid, 'description_generator_used', { videoId });
    
    return { success: true, videoData: metadata, description, usageRemaining: usageCheck.remaining };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', error.message);
  }
});

exports.generateTags = functions.https.onCall(async (data, context) => {
  try {
    const uid = await verifyAuth(context);
    const usageCheck = await checkUsageLimit(uid, 'tagGenerator');
    const { videoUrl } = data;
    if (!videoUrl) throw new functions.https.HttpsError('invalid-argument', 'Video URL required');
    
    const videoId = extractVideoId(videoUrl);
    const metadata = await getVideoMetadata(videoId);
    const transcript = await getVideoTranscript(videoId);
    const tags = await generateTagsInternal(metadata, transcript);
    
    await incrementUsage(uid, 'tagGenerator');
    await logUsage(uid, 'tag_generator_used', { videoId });
    
    return { success: true, videoData: metadata, tags, usageRemaining: usageCheck.remaining };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ==============================================
// USER DASHBOARD
// ==============================================

exports.getUserProfile = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const user = await getUser(uid);

  // Get quota settings for reset time info
  let resetTimeMinutes = 1440; // Default 24 hours
  try {
    const settingsDoc = await db.collection('settings').doc('quotaSettings').get();
    if (settingsDoc.exists && settingsDoc.data().resetTimeMinutes) {
      resetTimeMinutes = settingsDoc.data().resetTimeMinutes;
    }
  } catch (e) {
    console.log('Using default reset time');
  }

  // Calculate reset timestamps for each tool
  const now = Date.now();
  const resetIntervalMs = resetTimeMinutes * 60 * 1000;
  const quotaInfo = {};

  const tools = ['warpOptimizer', 'titleGenerator', 'descriptionGenerator', 'tagGenerator'];
  tools.forEach(tool => {
    const usage = user.usage?.[tool];
    if (usage) {
      const lastResetMs = usage.lastResetAt?.toMillis?.() || now;
      const nextResetMs = lastResetMs + resetIntervalMs;
      const bonusUses = user.bonusUses?.[tool] || 0;
      const totalLimit = (usage.limit || 0) + bonusUses;

      quotaInfo[tool] = {
        used: usage.usedToday || 0,
        limit: usage.limit || 0,
        bonusUses: bonusUses,
        totalLimit: totalLimit,
        remaining: Math.max(0, totalLimit - (usage.usedToday || 0)),
        lastResetMs: lastResetMs,
        nextResetMs: nextResetMs,
        remainingMs: Math.max(0, nextResetMs - now)
      };
    }
  });

  return {
    success: true,
    profile: user,
    quotaInfo: quotaInfo,
    resetTimeMinutes: resetTimeMinutes
  };
});

exports.getHistory = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  const { limit = 20, offset = 0 } = data;
  
  const snapshot = await db.collection('optimizations')
    .where('userId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .offset(offset)
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
        isAdmin: userData.isAdmin || false,
        createdAt: userData.createdAt?.toDate?.()?.toISOString() || null,
        lastLoginAt: userData.lastLoginAt?.toDate?.()?.toISOString() || null
      });
    });

    return { success: true, users, count: users.length };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to fetch users: ' + error.message);
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
      'usage.titleGenerator.limit': planLimits.titleGenerator.dailyLimit,
      'usage.titleGenerator.usedToday': 0,
      'usage.descriptionGenerator.limit': planLimits.descriptionGenerator.dailyLimit,
      'usage.descriptionGenerator.usedToday': 0,
      'usage.tagGenerator.limit': planLimits.tagGenerator.dailyLimit,
      'usage.tagGenerator.usedToday': 0
    });

    await logUsage(userId, 'plan_changed_by_admin', { plan: targetPlan, changedBy: context.auth.uid });
    return { success: true, message: 'User plan updated to ' + targetPlan };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to update user plan: ' + error.message);
  }
});

exports.adminSetCustomLimits = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const { userId, tool, limit, cooldownHours } = data;

  await db.collection('users').doc(userId).update({
    [`usage.${tool}.limit`]: limit,
    [`customLimits.${tool}`]: { limit, cooldownHours }
  });

  return { success: true };
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
    throw new functions.https.HttpsError('internal', 'Failed to get quota settings: ' + error.message);
  }
});

exports.adminSetQuotaSettings = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const { resetTimeMinutes } = data || {};

    if (!resetTimeMinutes || resetTimeMinutes < 1) {
      throw new functions.https.HttpsError('invalid-argument', 'Reset time must be at least 1 minute');
    }

    await db.collection('settings').doc('quotaSettings').set({
      resetTimeMinutes: parseInt(resetTimeMinutes),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: context.auth.uid
    }, { merge: true });

    return {
      success: true,
      message: `Quota reset time set to ${resetTimeMinutes} minutes`
    };
  } catch (error) {
    console.error('adminSetQuotaSettings error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Failed to update quota settings: ' + error.message);
  }
});

exports.adminGrantBonusUses = functions.https.onCall(async (data, context) => {
  try {
    await requireAdmin(context);

    const { userId, tool, bonusAmount } = data || {};

    if (!userId) throw new functions.https.HttpsError('invalid-argument', 'User ID required');
    if (!tool) throw new functions.https.HttpsError('invalid-argument', 'Tool name required');
    if (!bonusAmount || bonusAmount < 1) throw new functions.https.HttpsError('invalid-argument', 'Bonus amount must be at least 1');

    const validTools = ['warpOptimizer', 'titleGenerator', 'descriptionGenerator', 'tagGenerator'];
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
    throw new functions.https.HttpsError('internal', 'Failed to grant bonus uses: ' + error.message);
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
          titleGenerator: { dailyLimit: 3, cooldownHours: 0 },
          descriptionGenerator: { dailyLimit: 3, cooldownHours: 0 },
          tagGenerator: { dailyLimit: 3, cooldownHours: 0 }
        }
      },
      lite: {
        name: 'Lite',
        price: 9.99,
        limits: {
          warpOptimizer: { dailyLimit: 5, cooldownHours: 0 },
          titleGenerator: { dailyLimit: 5, cooldownHours: 0 },
          descriptionGenerator: { dailyLimit: 5, cooldownHours: 0 },
          tagGenerator: { dailyLimit: 5, cooldownHours: 0 }
        }
      },
      pro: {
        name: 'Pro',
        price: 19.99,
        limits: {
          warpOptimizer: { dailyLimit: 10, cooldownHours: 0 },
          titleGenerator: { dailyLimit: 10, cooldownHours: 0 },
          descriptionGenerator: { dailyLimit: 10, cooldownHours: 0 },
          tagGenerator: { dailyLimit: 10, cooldownHours: 0 }
        }
      },
      enterprise: {
        name: 'Enterprise',
        price: 49.99,
        limits: {
          warpOptimizer: { dailyLimit: 50, cooldownHours: 0 },
          titleGenerator: { dailyLimit: 50, cooldownHours: 0 },
          descriptionGenerator: { dailyLimit: 50, cooldownHours: 0 },
          tagGenerator: { dailyLimit: 50, cooldownHours: 0 }
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
    throw new functions.https.HttpsError('internal', 'Failed to initialize plans: ' + error.message);
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
// ADS TOOL (LEGACY - NO AUTH)
// ==============================================

exports.analyzeVideo = functions.https.onCall(async (data, context) => {
  try {
    const { videoUrl } = data;
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
    
    return {
      success: true,
      videoData: metadata,
      analysis: completion.choices[0].message.content,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

exports.generateComments = functions.https.onCall(async (data, context) => {
  try {
    const { videoUrl, count = 50 } = data;
    const videoId = extractVideoId(videoUrl);
    const metadata = await getVideoMetadata(videoId);
    const transcript = await getVideoTranscript(videoId);
    
    const commentsPrompt = `Generate ${count} YouTube comments.

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
    
    return {
      success: true,
      comments,
      videoData: metadata,
      count: comments.length,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

exports.optimizeCampaign = functions.https.onCall(async (data, context) => {
  try {
    const { videoUrl, budget, targetAudience } = data;
    const videoId = extractVideoId(videoUrl);
    const metadata = await getVideoMetadata(videoId);
    
    const campaignPrompt = `Create campaign strategy.
Video: ${metadata.title}
Budget: $${budget}
Target: ${targetAudience}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Create YouTube ad campaign strategies.' },
        { role: 'user', content: campaignPrompt }
      ],
      temperature: 0.7,
      max_tokens: 2000
    });
    
    return {
      success: true,
      strategy: completion.choices[0].message.content,
      videoData: metadata,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

exports.saveAnalysis = functions.https.onCall(async (data, context) => {
  const { videoUrl, analysis, comments } = data;
  const docRef = await db.collection('analyses').add({
    videoUrl,
    analysis,
    comments: comments || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { success: true, id: docRef.id };
});

exports.analyzeCompetitors = functions.https.onCall(async (data, context) => {
  try {
    const { channelName } = data;
    const searchResponse = await youtube.search.list({
      part: ['snippet'],
      q: channelName,
      type: ['channel'],
      maxResults: 1
    });
    
    if (!searchResponse.data.items || searchResponse.data.items.length === 0) {
      throw new Error('Channel not found');
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
    
    return { success: true, channelId, videos, count: videos.length };
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

exports.searchHistory = functions.https.onCall(async (data, context) => {
  const { limit = 10 } = data;
  const snapshot = await db.collection('analyses')
    .orderBy('createdAt', 'desc')
    .limit(limit)
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
  const { id } = data;
  await db.collection('analyses').doc(id).delete();
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
// SETUP ADMIN USER (One-time setup)
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

    // Make user an admin
    await db.collection('adminUsers')
      .doc(userId)
      .set({
        uid: userId,
        email: userEmail,
        isAdmin: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: 'self-setup'
      });

    // Also update user profile
    await db.collection('users')
      .doc(userId)
      .update({
        isAdmin: true
      });

    return {
      success: true,
      message: 'You are now an admin!',
      email: userEmail,
      userId: userId
    };

  } catch (error) {
    console.error('Error setting up admin:', error);
    throw new functions.https.HttpsError(
      'internal',
      'Failed to set up admin access',
      error.message
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
        titleGenerator: { dailyLimit: 10 },
        descriptionGenerator: { dailyLimit: 10 },
        tagGenerator: { dailyLimit: 10 }
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
          titleGenerator: {
            usedToday: 0,
            usedTotal: 0,
            limit: planLimits.titleGenerator.dailyLimit,
            lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
            cooldownUntil: null
          },
          descriptionGenerator: {
            usedToday: 0,
            usedTotal: 0,
            limit: planLimits.descriptionGenerator.dailyLimit,
            lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
            cooldownUntil: null
          },
          tagGenerator: {
            usedToday: 0,
            usedTotal: 0,
            limit: planLimits.tagGenerator.dailyLimit,
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
        titleGenerator: { dailyLimit: 10 },
        descriptionGenerator: { dailyLimit: 10 },
        tagGenerator: { dailyLimit: 10 }
      };

      updates.usage = {
        warpOptimizer: {
          usedToday: 0,
          usedTotal: 0,
          limit: planLimits.warpOptimizer.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        titleGenerator: {
          usedToday: 0,
          usedTotal: 0,
          limit: planLimits.titleGenerator.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        descriptionGenerator: {
          usedToday: 0,
          usedTotal: 0,
          limit: planLimits.descriptionGenerator.dailyLimit,
          lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
          cooldownUntil: null
        },
        tagGenerator: {
          usedToday: 0,
          usedTotal: 0,
          limit: planLimits.tagGenerator.dailyLimit,
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
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ==============================================
// NEW FEATURE: COMPETITOR ANALYSIS
// ==============================================

exports.analyzeCompetitor = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  await checkUsageLimit(uid, 'warpOptimizer');

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

    await incrementUsage(uid, 'warpOptimizer');
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
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ==============================================
// NEW FEATURE: TREND PREDICTOR
// ==============================================

exports.predictTrends = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  await checkUsageLimit(uid, 'warpOptimizer');

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

    await incrementUsage(uid, 'warpOptimizer');
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
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ==============================================
// NEW FEATURE: AI THUMBNAIL GENERATOR (RunPod)
// ==============================================

exports.generateThumbnail = functions.https.onCall(async (data, context) => {
  const uid = await verifyAuth(context);
  await checkUsageLimit(uid, 'warpOptimizer');

  const { title, style = 'youtube_thumbnail', customPrompt } = data;
  if (!title) {
    throw new functions.https.HttpsError('invalid-argument', 'Video title is required');
  }

  const runpodKey = functions.config().runpod?.key;
  if (!runpodKey) {
    throw new functions.https.HttpsError('failed-precondition', 'RunPod API key not configured');
  }

  try {
    // Generate optimized prompt for thumbnail
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

    const imagePrompt = promptGeneratorResponse.choices[0].message.content.trim();
    const negativePrompt = "blurry, low quality, ugly, distorted, watermark, nsfw, text overlay";
    const seed = Math.floor(Math.random() * 999999999999);

    // Generate a signed URL for Firebase Storage upload
    const bucket = admin.storage().bucket();
    const fileName = `thumbnails/${uid}/${Date.now()}_${seed}.png`;
    const file = bucket.file(fileName);

    // Generate signed URL for uploading (PUT with octet-stream)
    const [uploadUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 30 * 60 * 1000, // 30 minutes
      contentType: 'application/octet-stream',
    });

    // Call RunPod API - HiDream text-to-image
    const runpodEndpoint = 'https://api.runpod.ai/v2/rgq0go2nkcfx4h/run';

    // Send all required parameters including image_upload_url
    const runpodResponse = await axios.post(runpodEndpoint, {
      input: {
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
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${runpodKey}`
      },
      timeout: 30000
    });

    const jobId = runpodResponse.data.id;
    const status = runpodResponse.data.status;

    // Generate public URL for the uploaded image
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

    await incrementUsage(uid, 'warpOptimizer');
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
    throw new functions.https.HttpsError('internal', error.message);
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
    throw new functions.https.HttpsError('internal', error.message);
  }
});
