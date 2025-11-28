# YouTube Ads Intelligence Tool - Firebase Functions

## 📋 Overview

This is the backend for your YouTube Ads Intelligence Tool. It provides 7 cloud functions that handle:

1. **analyzeVideo** - Extract video metadata, transcript, and generate low CPV keywords
2. **generateComments** - Create human-quality comments based on video content
3. **optimizeCampaign** - Generate campaign strategy and budget recommendations
4. **analyzeCompetitors** - Perform competitive gap analysis
5. **searchHistory** - Search past analyses with filters
6. **saveAnalysis** - Save analysis to Firestore
7. **deleteAnalysis** - Remove analysis from database

---

## 🚀 Setup Instructions

### Step 1: Prerequisites

Make sure you have:
- Node.js 18+ installed
- Firebase CLI installed: `npm install -g firebase-tools`
- A Firebase project created (you already have this ✅)
- OpenAI API key
- YouTube Data API key

### Step 2: Get API Keys

#### OpenAI API Key:
1. Go to https://platform.openai.com/api-keys
2. Click "Create new secret key"
3. Copy the key (starts with `sk-...`)
4. Save it securely

#### YouTube Data API Key:
1. Go to https://console.cloud.google.com/apis/credentials
2. Click "Create Credentials" → "API Key"
3. Enable "YouTube Data API v3" in the API Library
4. Copy the API key
5. (Optional) Restrict the key to YouTube Data API v3 only

### Step 3: Firebase Project Setup

```bash
# Login to Firebase
firebase login

# Navigate to the project directory
cd youtube-ads-tool

# Initialize Firebase (if not already done)
firebase init

# Select:
# - Functions (use JavaScript)
# - Firestore
# - Use existing project → Select your project
```

### Step 4: Install Dependencies

```bash
cd functions
npm install
```

### Step 5: Configure Environment Variables

Set your API keys using Firebase CLI:

```bash
# Set OpenAI API Key
firebase functions:config:set openai.key="sk-your-actual-openai-key"

# Set YouTube API Key
firebase functions:config:set youtube.key="your-actual-youtube-key"

# Verify configuration
firebase functions:config:get
```

**For local development**, create a `.env` file:

```bash
cp .env.example .env
# Then edit .env and add your actual API keys
```

### Step 6: Deploy Functions

```bash
# Deploy all functions
firebase deploy --only functions

# Or deploy specific function
firebase deploy --only functions:analyzeVideo
```

**Expected output:**
```
✔ functions[us-central1-analyzeVideo] Successful deploy
✔ functions[us-central1-generateComments] Successful deploy
✔ functions[us-central1-optimizeCampaign] Successful deploy
✔ functions[us-central1-analyzeCompetitors] Successful deploy
✔ functions[us-central1-searchHistory] Successful deploy
✔ functions[us-central1-saveAnalysis] Successful deploy
✔ functions[us-central1-deleteAnalysis] Successful deploy
```

### Step 7: Deploy Firestore Rules

```bash
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

---

## 🧪 Testing Functions

### Test with Firebase Emulator (Local)

```bash
cd functions
npm run serve
```

This starts the Functions emulator at `http://localhost:5001`

### Test Individual Functions

Create a test file `functions/test.js`:

```javascript
// Test script - run with: node test.js
const admin = require('firebase-admin');
const functions = require('firebase-functions-test')();

// Initialize
const myFunctions = require('./index');

async function testAnalyzeVideo() {
  const wrapped = functions.wrap(myFunctions.analyzeVideo);
  
  const data = {
    videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' // Rick Astley test
  };
  
  try {
    const result = await wrapped(data);
    console.log('✅ analyzeVideo SUCCESS:', result);
  } catch (error) {
    console.error('❌ analyzeVideo ERROR:', error);
  }
}

testAnalyzeVideo();
```

---

## 📊 Function Details

### 1. analyzeVideo

**Input:**
```javascript
{
  videoUrl: "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

**Output:**
```javascript
{
  success: true,
  videoData: {
    videoId: "...",
    title: "...",
    description: "...",
    channelName: "...",
    thumbnail: "...",
    views: 123456,
    likes: 5000,
    ...
  },
  keywords: {
    primary: ["keyword1", "keyword2", ...],
    longTail: ["phrase1", "phrase2", ...],
    negative: ["exclude1", "exclude2", ...],
    cpvEstimate: 0.05,
    notes: "Strategy notes"
  },
  transcript: "Partial transcript...",
  analyzedAt: "2024-01-15T10:30:00Z"
}
```

### 2. generateComments

**Input:**
```javascript
{
  videoData: { ... }, // From analyzeVideo
  transcript: "Full transcript",
  longCount: 10,      // Number of 32-45 word comments
  shortCount: 5       // Number of 5-10 word comments
}
```

**Output:**
```javascript
{
  success: true,
  comments: {
    long: ["comment 1", "comment 2", ...],
    short: ["comment 1", "comment 2", ...]
  },
  generatedAt: "2024-01-15T10:31:00Z"
}
```

### 3. optimizeCampaign

**Input:**
```javascript
{
  videoData: { ... },
  keywords: { ... },
  budget: 100,        // USD
  targetCPV: 0.05     // Target cost per view
}
```

**Output:**
```javascript
{
  success: true,
  strategy: {
    bidStrategy: { ... },
    geoTargeting: { ... },
    audienceSegments: [...],
    budgetAllocation: { ... },
    scheduling: { ... },
    optimizationTips: [...]
  }
}
```

### 4. analyzeCompetitors

**Input:**
```javascript
{
  competitorUrls: [
    "https://youtube.com/watch?v=...",
    "https://youtube.com/watch?v=..."
  ],
  yourKeywords: ["keyword1", "keyword2", ...]
}
```

**Output:**
```javascript
{
  success: true,
  analysis: {
    gapKeywords: [...],
    opportunityKeywords: [...],
    differentiationStrategy: { ... },
    competitiveInsights: [...]
  }
}
```

### 5. searchHistory

**Input:**
```javascript
{
  query: "search term",           // Optional
  channelFilter: "Channel Name",  // Optional
  dateFrom: "2024-01-01",        // Optional
  dateTo: "2024-12-31",          // Optional
  limit: 20
}
```

### 6. saveAnalysis

**Input:**
```javascript
{
  videoData: { ... },
  keywords: { ... },
  comments: { ... },
  strategy: { ... },    // Optional
  userNotes: "...",    // Optional
  tags: ["tag1", "tag2"]
}
```

### 7. deleteAnalysis

**Input:**
```javascript
{
  analysisId: "firestore-doc-id"
}
```

---

## 🔐 Security Notes

1. **API Keys are secure**: They're stored in Firebase environment config, never exposed to frontend
2. **Firestore Rules**: Currently open for development - add authentication before production
3. **Rate Limiting**: Consider adding rate limits in production
4. **CORS**: Functions automatically handle CORS for Firebase domains

---

## 📝 Firestore Data Structure

```
/analyses/{analysisId}
  - videoData: object
  - keywords: object
  - comments: object
  - strategy: object
  - userNotes: string
  - tags: array
  - createdAt: timestamp
  - updatedAt: timestamp
```

---

## 🐛 Troubleshooting

### Error: "Function not found"
- Make sure functions are deployed: `firebase deploy --only functions`
- Check Firebase console: https://console.firebase.google.com

### Error: "OpenAI API key not configured"
- Verify config: `firebase functions:config:get`
- Set key: `firebase functions:config:set openai.key="YOUR_KEY"`

### Error: "YouTube quota exceeded"
- YouTube API has daily quota limits
- Check quota: https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas

### Error: "Transcript not available"
- Not all videos have transcripts/captions
- Function will return "Transcript not available" but continue processing

---

## 📈 Monitoring

View function logs:
```bash
# Real-time logs
firebase functions:log

# Filter by function
firebase functions:log --only analyzeVideo
```

View in Firebase Console:
https://console.firebase.google.com/project/YOUR_PROJECT/functions

---

## 💰 Cost Estimates

**Firebase Functions:**
- First 2 million invocations/month: FREE
- After: $0.40 per million invocations

**OpenAI API (GPT-4):**
- Input: ~$0.03 per 1K tokens
- Output: ~$0.06 per 1K tokens
- Estimated cost per video analysis: $0.10-0.30

**YouTube Data API:**
- Free up to 10,000 quota units/day
- Each video fetch: ~5 units
- ~2,000 videos/day free

---

## 🔄 Updates & Maintenance

To update functions:
```bash
# Make changes to index.js
# Then redeploy
firebase deploy --only functions
```

To view deployed functions:
```bash
firebase functions:list
```

---

## ✅ Next Steps

1. ✅ Deploy functions to Firebase
2. ✅ Test with a sample YouTube URL
3. 🔲 Build frontend widget
4. 🔲 Integrate with Siteuo.com
5. 🔲 Add authentication (if needed)

---

## 📞 Support

If you encounter issues:
1. Check Firebase console logs
2. Verify API keys are set correctly
3. Ensure YouTube API is enabled in Google Cloud Console
4. Check OpenAI account has available credits

**Ready to test?** Let's run a test deployment next! 🚀
