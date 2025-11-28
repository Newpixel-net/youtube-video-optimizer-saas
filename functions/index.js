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
  const admin = await isAdmin(uid);
  if (!admin) {
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
  
  const usage = user.usage[toolType];
  const now = admin.firestore.Timestamp.now();
  
  if (usage.cooldownUntil && usage.cooldownUntil.toMillis() > now.toMillis()) {
    const remainingSeconds = Math.ceil((usage.cooldownUntil.toMillis() - now.toMillis()) / 1000);
    const remainingHours = Math.ceil(remainingSeconds / 3600);
    throw new functions.https.HttpsError(
      'resource-exhausted',
      `Cooldown active. Try again in ${remainingHours} hour(s).`,
      { remainingSeconds, remainingHours, cooldownUntil: usage.cooldownUntil.toMillis() }
    );
  }
  
  const lastReset = usage.lastResetAt.toDate();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  if (lastReset < today) {
    await db.collection('users').doc(uid).update({
      [`usage.${toolType}.usedToday`]: 0,
      [`usage.${toolType}.lastResetAt`]: admin.firestore.FieldValue.serverTimestamp(),
      [`usage.${toolType}.cooldownUntil`]: null
    });
    usage.usedToday = 0;
    usage.cooldownUntil = null;
  }
  
  if (usage.usedToday >= usage.limit) {
    const planDoc = await db.collection('subscriptionPlans').doc(user.subscription.plan).get();
    const cooldownHours = planDoc.data().limits[toolType].cooldownHours;
    
    if (cooldownHours > 0) {
      const cooldownUntil = new Date(now.toMillis() + (cooldownHours * 60 * 60 * 1000));
      await db.collection('users').doc(uid).update({
        [`usage.${toolType}.cooldownUntil`]: admin.firestore.Timestamp.fromDate(cooldownUntil)
      });
      throw new functions.https.HttpsError(
        'resource-exhausted',
        `Daily limit reached (${usage.limit}). Try again in ${cooldownHours} hour(s).`,
        { limit: usage.limit, cooldownHours, cooldownUntil: cooldownUntil.getTime() }
      );
    }
    throw new functions.https.HttpsError(
      'resource-exhausted',
      `Daily limit reached (${usage.limit}). Resets tomorrow.`,
      { limit: usage.limit }
    );
  }
  
  return { allowed: true, remaining: usage.limit - usage.usedToday - 1 };
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
    const snippet = video.snippet;
    const statistics = video.statistics;

    return {
      videoId,
      title: snippet.title || 'Untitled',
      description: snippet.description || '',
      channelName: snippet.channelTitle,
      channelId: snippet.channelId,
      publishedAt: snippet.publishedAt,
      thumbnail: snippet.thumbnails.high?.url || snippet.thumbnails.default?.url,
      tags: snippet.tags || [],
      categoryId: snippet.categoryId,
      views: parseInt(statistics.viewCount) || 0,
      likes: parseInt(statistics.likeCount) || 0,
      comments: parseInt(statistics.commentCount) || 0,
      duration: video.contentDetails.duration,
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
    
    const [titles, description, tags] = await Promise.all([
      generateTitlesInternal(metadata, transcript),
      generateDescriptionInternal(metadata, transcript),
      generateTagsInternal(metadata, transcript)
    ]);
    
    const processingTime = Math.round((Date.now() - startTime) / 1000);
    
    // Calculate simple SEO score
    const seoScore = Math.min(100, Math.round(
      (titles.length * 5) + 
      (description.length > 200 ? 20 : 10) + 
      (tags.length * 2) +
      (metadata.viewCount > 10000 ? 20 : 10)
    ));
    
    const seoRecommendations = [];
    if (titles.length < 5) seoRecommendations.push('Consider adding more title variations');
    if (description.length < 200) seoRecommendations.push('Description could be more detailed');
    if (tags.length < 15) seoRecommendations.push('Add more relevant tags for better discoverability');
    
    const seoAnalysis = {
      score: seoScore,
      recommendations: seoRecommendations
    };
    
    // Save to optimizations collection (for history)
    const optimizationRef = await db.collection('optimizations').add({
      userId: uid,
      videoUrl,
      videoInfo: {
        title: metadata.title,
        channelTitle: metadata.channelTitle,
        viewCount: metadata.viewCount,
        duration: metadata.duration,
        thumbnail: metadata.thumbnail
      },
      titles,
      description,
      tags,
      seoAnalysis,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    await incrementUsage(uid, 'warpOptimizer');
    await logUsage(uid, 'warp_optimizer_used', { videoId, processingTime });
    
    return {
      success: true,
      optimizationId: optimizationRef.id,
      videoInfo: {
        title: metadata.title,
        channelTitle: metadata.channelTitle,
        viewCount: metadata.viewCount,
        duration: metadata.duration,
        thumbnail: metadata.thumbnail
      },
      titles,
      description,
      tags,
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
  return { success: true, profile: user };
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
  await requireAdmin(context);
  const { limit = 50, offset = 0, plan = null } = data;
  
  let query = db.collection('users').orderBy('createdAt', 'desc').limit(limit).offset(offset);
  if (plan) query = query.where('subscription.plan', '==', plan);
  
  const snapshot = await query.get();
  const users = [];
  snapshot.forEach(doc => {
    const userData = doc.data();
    users.push({
      id: doc.id,
      ...userData,
      createdAt: userData.createdAt?.toDate().toISOString(),
      lastLoginAt: userData.lastLoginAt?.toDate().toISOString()
    });
  });
  
  return { success: true, users, count: users.length };
});

exports.adminUpdateUserPlan = functions.https.onCall(async (data, context) => {
  await requireAdmin(context);
  const { userId, newPlan } = data;
  
  const planDoc = await db.collection('subscriptionPlans').doc(newPlan).get();
  if (!planDoc.exists) throw new functions.https.HttpsError('invalid-argument', 'Invalid plan');
  
  const planLimits = planDoc.data().limits;
  await db.collection('users').doc(userId).update({
    'subscription.plan': newPlan,
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
  
  await logUsage(userId, 'plan_changed_by_admin', { newPlan, changedBy: context.auth.uid });
  return { success: true };
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

  try {
    // Query optimizations collection for this user
    // Ordered by createdAt descending (newest first)
    // Limited to last 50 items
    const snapshot = await db.collection('optimizations')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const history = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      history.push({
        id: doc.id,
        videoUrl: data.videoUrl,
        videoInfo: data.videoInfo || null,
        titles: data.titles || [],
        description: data.description || '',
        tags: data.tags || [],
        seoAnalysis: data.seoAnalysis || null,
        timestamp: data.createdAt ? data.createdAt.toMillis() : Date.now(),
        createdAt: data.createdAt
      });
    });

    return {
      success: true,
      history: history
    };

  } catch (error) {
    console.error('Error fetching optimization history:', error);
    throw new functions.https.HttpsError(
      'internal',
      'Failed to fetch optimization history',
      error.message
    );
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
