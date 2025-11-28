# Quick Reference - Essential Commands

## 🚀 Deployment Commands

```bash
# Install dependencies
cd youtube-ads-tool/functions && npm install && cd ..

# Set API keys
firebase functions:config:set openai.key="YOUR_KEY"
firebase functions:config:set youtube.key="YOUR_KEY"

# Deploy everything
firebase deploy --only functions,firestore

# Deploy only functions
firebase deploy --only functions

# Deploy specific function
firebase deploy --only functions:analyzeVideo
```

## 🧪 Testing & Monitoring

```bash
# View real-time logs
firebase functions:log

# View specific function logs
firebase functions:log --only analyzeVideo

# List all deployed functions
firebase functions:list

# Test deployment
node test-deployment.js
```

## ⚙️ Configuration

```bash
# View current config
firebase functions:config:get

# Update API key
firebase functions:config:set openai.key="NEW_KEY"

# Remove config
firebase functions:config:unset openai

# Download config for local testing
firebase functions:config:get > .runtimeconfig.json
```

## 🔍 Debugging

```bash
# Open Firebase Console
firebase open

# Run local emulator
cd functions && npm run serve

# Check Firebase project
firebase use
```

## 📦 Maintenance

```bash
# Update dependencies
cd functions
npm update
cd ..

# Reinstall clean
cd functions
rm -rf node_modules package-lock.json
npm install
cd ..

# Check for outdated packages
cd functions && npm outdated
```

## 🌐 URLs

After deployment, your functions will be at:
```
https://us-central1-YOUR_PROJECT.cloudfunctions.net/analyzeVideo
https://us-central1-YOUR_PROJECT.cloudfunctions.net/generateComments
https://us-central1-YOUR_PROJECT.cloudfunctions.net/optimizeCampaign
https://us-central1-YOUR_PROJECT.cloudfunctions.net/analyzeCompetitors
https://us-central1-YOUR_PROJECT.cloudfunctions.net/searchHistory
https://us-central1-YOUR_PROJECT.cloudfunctions.net/saveAnalysis
https://us-central1-YOUR_PROJECT.cloudfunctions.net/deleteAnalysis
```

## 🔐 Security

```bash
# Deploy updated Firestore rules
firebase deploy --only firestore:rules

# Deploy updated indexes
firebase deploy --only firestore:indexes
```

## 📊 Costs & Quotas

**Check Firebase usage:**
https://console.firebase.google.com/project/YOUR_PROJECT/usage

**Check OpenAI usage:**
https://platform.openai.com/usage

**Check YouTube quota:**
https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas

## ⚠️ Emergency Commands

```bash
# Delete all functions (careful!)
firebase functions:delete analyzeVideo
firebase functions:delete generateComments
# ... etc

# Rollback to previous deployment
firebase deploy --only functions --force

# Clear functions config
firebase functions:config:unset openai
firebase functions:config:unset youtube
```

## 💡 Pro Tips

```bash
# Tail logs in real-time
firebase functions:log --only analyzeVideo

# Deploy with specific region
firebase deploy --only functions --region us-central1

# Set memory limit (default 256MB)
# Edit functions/index.js and add:
# exports.analyzeVideo = functions
#   .runWith({ memory: '512MB' })
#   .https.onCall(...)
```

---

**Keep this handy during deployment!** 📌
