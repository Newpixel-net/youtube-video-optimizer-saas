/**
 * Test Script for YouTube Ads Tool Functions
 * Run this after deploying to verify everything works
 * 
 * Usage: node test-deployment.js
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin with your project
// You'll need to download service account key from Firebase Console
const serviceAccount = require('./serviceAccountKey.json'); // You'll need to download this

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const functions = admin.functions();

// Test video URL (Rick Astley - Never Gonna Give You Up)
const TEST_VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

async function testAnalyzeVideo() {
  console.log('\n🧪 Testing analyzeVideo function...');
  console.log('Video URL:', TEST_VIDEO_URL);
  
  try {
    const analyzeVideo = functions.httpsCallable('analyzeVideo');
    const result = await analyzeVideo({ videoUrl: TEST_VIDEO_URL });
    
    console.log('✅ SUCCESS!');
    console.log('\nVideo Data:');
    console.log('- Title:', result.data.videoData.title);
    console.log('- Channel:', result.data.videoData.channelName);
    console.log('- Views:', result.data.videoData.views.toLocaleString());
    console.log('- Likes:', result.data.videoData.likes.toLocaleString());
    
    console.log('\nKeywords Generated:');
    console.log('- Primary:', result.data.keywords.primary.length);
    console.log('- Long-tail:', result.data.keywords.longTail.length);
    console.log('- Negative:', result.data.keywords.negative.length);
    console.log('- Estimated CPV: $' + result.data.keywords.cpvEstimate);
    
    console.log('\nSample Primary Keywords:');
    result.data.keywords.primary.slice(0, 5).forEach((kw, i) => {
      console.log(`  ${i + 1}. ${kw}`);
    });
    
    return result.data;
    
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    throw error;
  }
}

async function testGenerateComments(videoData, transcript) {
  console.log('\n🧪 Testing generateComments function...');
  
  try {
    const generateComments = functions.httpsCallable('generateComments');
    const result = await generateComments({
      videoData,
      transcript,
      longCount: 5,  // Test with smaller numbers
      shortCount: 3
    });
    
    console.log('✅ SUCCESS!');
    console.log('\nComments Generated:');
    console.log('- Long comments:', result.data.comments.long.length);
    console.log('- Short comments:', result.data.comments.short.length);
    
    console.log('\nSample Long Comment:');
    console.log('"' + result.data.comments.long[0] + '"');
    console.log(`(${result.data.comments.long[0].split(' ').length} words)`);
    
    console.log('\nSample Short Comment:');
    console.log('"' + result.data.comments.short[0] + '"');
    console.log(`(${result.data.comments.short[0].split(' ').length} words)`);
    
    return result.data;
    
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    throw error;
  }
}

async function testOptimizeCampaign(videoData, keywords) {
  console.log('\n🧪 Testing optimizeCampaign function...');
  
  try {
    const optimizeCampaign = functions.httpsCallable('optimizeCampaign');
    const result = await optimizeCampaign({
      videoData,
      keywords,
      budget: 100,
      targetCPV: 0.05
    });
    
    console.log('✅ SUCCESS!');
    console.log('\nCampaign Strategy:');
    console.log('- Bid Strategy:', result.data.strategy.bidStrategy.type);
    console.log('- Initial Bid: $' + result.data.strategy.bidStrategy.initialBid);
    console.log('- Primary Geo:', result.data.strategy.geoTargeting.primary.join(', '));
    console.log('- Audience Segments:', result.data.strategy.audienceSegments.length);
    console.log('- Budget Allocation:');
    console.log('  - Primary Keywords:', result.data.strategy.budgetAllocation.primaryKeywords + '%');
    console.log('  - Long-tail:', result.data.strategy.budgetAllocation.longTailKeywords + '%');
    console.log('  - Testing:', result.data.strategy.budgetAllocation.testing + '%');
    
    return result.data;
    
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    throw error;
  }
}

async function testSaveAnalysis(videoData, keywords, comments) {
  console.log('\n🧪 Testing saveAnalysis function...');
  
  try {
    const saveAnalysis = functions.httpsCallable('saveAnalysis');
    const result = await saveAnalysis({
      videoData,
      keywords,
      comments,
      userNotes: 'Test analysis from deployment verification',
      tags: ['test', 'deployment', 'verification']
    });
    
    console.log('✅ SUCCESS!');
    console.log('- Analysis ID:', result.data.analysisId);
    console.log('- Message:', result.data.message);
    
    return result.data.analysisId;
    
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    throw error;
  }
}

async function testSearchHistory() {
  console.log('\n🧪 Testing searchHistory function...');
  
  try {
    const searchHistory = functions.httpsCallable('searchHistory');
    const result = await searchHistory({
      query: 'test',
      limit: 10
    });
    
    console.log('✅ SUCCESS!');
    console.log('- Results found:', result.data.count);
    
    if (result.data.results.length > 0) {
      console.log('\nMost Recent Analysis:');
      const latest = result.data.results[0];
      console.log('- Title:', latest.videoData.title);
      console.log('- Channel:', latest.videoData.channelName);
      console.log('- Analyzed:', new Date(latest.createdAt).toLocaleString());
    }
    
    return result.data;
    
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    throw error;
  }
}

async function testDeleteAnalysis(analysisId) {
  console.log('\n🧪 Testing deleteAnalysis function...');
  
  try {
    const deleteAnalysis = functions.httpsCallable('deleteAnalysis');
    const result = await deleteAnalysis({ analysisId });
    
    console.log('✅ SUCCESS!');
    console.log('- Message:', result.data.message);
    
    return result.data;
    
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    throw error;
  }
}

async function runAllTests() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('   YOUTUBE ADS TOOL - FUNCTION DEPLOYMENT TEST');
  console.log('═══════════════════════════════════════════════════════');
  
  try {
    // Test 1: Analyze Video
    const analysisData = await testAnalyzeVideo();
    
    // Test 2: Generate Comments
    const commentsData = await testGenerateComments(
      analysisData.videoData,
      analysisData.transcript
    );
    
    // Test 3: Campaign Optimizer
    await testOptimizeCampaign(
      analysisData.videoData,
      analysisData.keywords
    );
    
    // Test 4: Save Analysis
    const analysisId = await testSaveAnalysis(
      analysisData.videoData,
      analysisData.keywords,
      commentsData.comments
    );
    
    // Test 5: Search History
    await testSearchHistory();
    
    // Test 6: Delete Analysis (cleanup)
    await testDeleteAnalysis(analysisId);
    
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('   ✅ ALL TESTS PASSED!');
    console.log('═══════════════════════════════════════════════════════');
    console.log('\nYour Firebase Functions are working perfectly! 🎉');
    console.log('Next step: Build the frontend widget.\n');
    
  } catch (error) {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('   ❌ TESTS FAILED');
    console.log('═══════════════════════════════════════════════════════');
    console.error('\nError:', error.message);
    console.log('\nPlease check:');
    console.log('1. Firebase functions are deployed');
    console.log('2. API keys are configured correctly');
    console.log('3. Firebase project is initialized');
    console.log('4. Service account key is in the correct location\n');
    process.exit(1);
  }
}

// Run tests
runAllTests();
