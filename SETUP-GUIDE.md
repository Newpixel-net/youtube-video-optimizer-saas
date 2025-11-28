# Firebase Functions - Step-by-Step Setup Guide

Follow these steps carefully to deploy the backend for your YouTube Ads Tool.

---

## 📋 Prerequisites Checklist

Before you begin, make sure you have:

- [ ] Node.js 18+ installed (`node --version` to check)
- [ ] Firebase CLI installed (`firebase --version` to check)
- [ ] Your Firebase project created (you already have this ✅)
- [ ] OpenAI API account with credits
- [ ] Google Cloud account with YouTube Data API enabled

---

## 🔧 Step 1: Install Firebase CLI (if not installed)

```bash
npm install -g firebase-tools
```

Verify installation:
```bash
firebase --version
```

---

## 🔑 Step 2: Login to Firebase

```bash
firebase login
```

This will open your browser for authentication.

---

## 📂 Step 3: Navigate to Project Directory

```bash
cd /path/to/youtube-ads-tool
```

---

## 🎯 Step 4: Initialize Firebase Project

If you haven't initialized Firebase in this directory:

```bash
firebase init
```

Select:
- ✅ Functions: Configure a Cloud Functions directory
- ✅ Firestore: Deploy rules and create indexes

Choose:
- Use an existing project → Select your Firebase project
- Language: JavaScript
- ESLint: No (or Yes if you prefer)
- Install dependencies now: Yes

---

## 🔐 Step 5: Get Your API Keys

### OpenAI API Key

1. Go to https://platform.openai.com/api-keys
2. Sign in or create an account
3. Click "Create new secret key"
4. Copy the key (starts with `sk-...`)
5. **Save it securely** - you'll need it in Step 7

### YouTube Data API Key

1. Go to https://console.cloud.google.com/apis/credentials
2. Select your project (or create one)
3. Click "+ CREATE CREDENTIALS" → "API Key"
4. Copy the API key
5. Click "Edit API key" (optional but recommended)
   - Under "API restrictions" → "Restrict key"
   - Select "YouTube Data API v3"
   - Save

6. Enable YouTube Data API v3:
   - Go to https://console.cloud.google.com/apis/library
   - Search for "YouTube Data API v3"
   - Click "Enable"

---

## 📦 Step 6: Install Dependencies

```bash
cd functions
npm install
cd ..
```

This installs all required packages:
- firebase-admin
- firebase-functions
- openai
- googleapis
- axios

---

## ⚙️ Step 7: Configure API Keys

### Set OpenAI API Key

```bash
firebase functions:config:set openai.key="sk-your-actual-key-here"
```

Replace `sk-your-actual-key-here` with your real OpenAI key.

### Set YouTube API Key

```bash
firebase functions:config:set youtube.key="your-actual-youtube-key-here"
```

Replace `your-actual-youtube-key-here` with your real YouTube API key.

### Verify Configuration

```bash
firebase functions:config:get
```

You should see:
```json
{
  "openai": {
    "key": "sk-..."
  },
  "youtube": {
    "key": "AIza..."
  }
}
```

---

## 🚀 Step 8: Deploy Firestore Rules

```bash
firebase deploy --only firestore:rules
```

Expected output:
```
✔  firestore: rules file firestore.rules compiled successfully
✔  firestore: released rules firestore.rules
```

---

## 📊 Step 9: Deploy Firestore Indexes

```bash
firebase deploy --only firestore:indexes
```

Expected output:
```
✔  firestore: deployed indexes in firestore.indexes.json successfully
```

---

## 🎯 Step 10: Deploy Cloud Functions

This is the main deployment step:

```bash
firebase deploy --only functions
```

This will:
- Upload your code to Firebase
- Create 7 cloud functions
- Configure them with your API keys
- Make them accessible via HTTPS

**Expected output:**
```
✔  functions[analyzeVideo(us-central1)] Successful create operation.
✔  functions[generateComments(us-central1)] Successful create operation.
✔  functions[optimizeCampaign(us-central1)] Successful create operation.
✔  functions[analyzeCompetitors(us-central1)] Successful create operation.
✔  functions[searchHistory(us-central1)] Successful create operation.
✔  functions[saveAnalysis(us-central1)] Successful create operation.
✔  functions[deleteAnalysis(us-central1)] Successful create operation.

✔  Deploy complete!
```

**This process takes 2-5 minutes.** ☕

---

## ✅ Step 11: Verify Deployment

### Option 1: View in Firebase Console

```bash
firebase open functions
```

Or visit: https://console.firebase.google.com/project/YOUR_PROJECT/functions

You should see 7 functions listed.

### Option 2: Check Function URLs

```bash
firebase functions:list
```

You'll see URLs like:
```
analyzeVideo(us-central1): https://us-central1-your-project.cloudfunctions.net/analyzeVideo
```

---

## 🧪 Step 12: Test Your Functions (Optional)

### Quick Test via Firebase Console

1. Go to Firebase Console → Functions
2. Click on `analyzeVideo`
3. Go to "Logs" tab
4. You can trigger it manually

### Automated Test (Recommended)

First, download your service account key:
1. Go to Firebase Console → Project Settings → Service Accounts
2. Click "Generate New Private Key"
3. Save as `serviceAccountKey.json` in project root

Then run:
```bash
node test-deployment.js
```

This will test all 7 functions with a real YouTube video.

---

## 📊 Step 13: Monitor Functions

View real-time logs:
```bash
firebase functions:log
```

View specific function:
```bash
firebase functions:log --only analyzeVideo
```

---

## 🎉 Success! What's Next?

Your backend is now live and ready! ✅

**Your Functions:**
1. ✅ analyzeVideo - Extracts video data & generates keywords
2. ✅ generateComments - Creates human-quality comments
3. ✅ optimizeCampaign - Campaign strategy recommendations
4. ✅ analyzeCompetitors - Gap analysis
5. ✅ searchHistory - Search past analyses
6. ✅ saveAnalysis - Save to database
7. ✅ deleteAnalysis - Remove analyses

**Next Steps:**
1. Build the frontend widget (Custom Code Widget for Siteuo.com)
2. Connect widget to these Firebase Functions
3. Test end-to-end workflow
4. Deploy to your website

---

## 🆘 Troubleshooting

### "Command not found: firebase"
Install Firebase CLI:
```bash
npm install -g firebase-tools
```

### "No project active"
Initialize project:
```bash
firebase use --add
```
Select your project from the list.

### "Failed to configure environment"
Make sure API keys are valid:
```bash
firebase functions:config:get
```

### "YouTube quota exceeded"
YouTube API has daily limits (10,000 units/day free). Wait 24 hours or upgrade quota.

### "OpenAI API error"
Check your OpenAI account:
- Has available credits
- API key is correct
- No rate limits hit

### "Functions not deploying"
Check Node version:
```bash
node --version
```
Should be 18 or higher.

---

## 💡 Tips

1. **Keep API keys secret** - Never commit them to git
2. **Monitor usage** - Check Firebase Console for costs
3. **Set up billing alerts** - Avoid unexpected charges
4. **Use Firestore indexes** - Already configured for optimal queries
5. **Test locally first** - Use Firebase emulator for development

---

## 📞 Need Help?

Check logs for errors:
```bash
firebase functions:log
```

View function status:
```bash
firebase functions:list
```

Open Firebase Console:
```bash
firebase console
```

---

**Ready to build the frontend? Let me know!** 🚀
