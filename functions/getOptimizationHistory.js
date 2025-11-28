const functions = require('firebase-functions');
const admin = require('firebase-admin');

/**
 * Get Optimization History
 * Returns list of past optimizations for the authenticated user
 * 
 * Request: {} (empty - uses auth context)
 * Response: {
 *   success: true,
 *   history: [
 *     {
 *       id: string,
 *       videoUrl: string,
 *       videoInfo: {...},
 *       titles: [...],
 *       description: string,
 *       tags: [...],
 *       seoAnalysis: {...},
 *       timestamp: number,
 *       createdAt: Timestamp
 *     },
 *     ...
 *   ]
 * }
 */
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
    const snapshot = await admin.firestore()
      .collection('optimizations')
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
