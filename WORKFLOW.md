# YouTube Video Optimizer SaaS - Workflow Guide

## Publishing Method
This system is published through a **website builder** using a **custom code widget**.
The frontend is a single HTML file (`frontend/dual-auth-widget.html`) that contains all HTML, CSS, and JavaScript.

---

## Firebase Deployment Commands

### Deploy All Functions
```bash
cd /home/user/youtube-video-optimizer-saas
firebase deploy --only functions
```

### Deploy Specific Function
```bash
firebase deploy --only functions:functionName
```

### Deploy Firestore Rules
```bash
firebase deploy --only firestore:rules
```

### Deploy Firestore Indexes
```bash
firebase deploy --only firestore:indexes
```

### Deploy Everything
```bash
firebase deploy
```

### View Function Logs
```bash
firebase functions:log
firebase functions:log --only functionName
```

### Emulator for Local Testing
```bash
firebase emulators:start
```

---

## Branch Files Updated Tracker

**IMPORTANT**: After working on a feature branch, list all modified files here so you know which files to download when updating the main branch.

### Current Branch: `claude/fix-recurring-issue-01Mc4jyJeGSeB1N8Gqk1qhVH`

**Files Modified:**
- `frontend/dual-auth-widget.html` - Added Placement Finder history support in frontend
- `WORKFLOW.md` - Created this workflow documentation

---

## Project File Structure

| File Path | Purpose |
|-----------|---------|
| `frontend/dual-auth-widget.html` | Main frontend - single page app with all UI |
| `functions/index.js` | All Firebase Cloud Functions (backend) |
| `firestore.rules` | Firestore security rules |
| `firestore.indexes.json` | Firestore composite indexes |
| `firebase.json` | Firebase project configuration |

---

## Previous Workflows & Features Implemented

### Placement Finder Feature (Latest)
- Added channel analysis using YouTube API
- AI-powered niche detection and keyword generation
- Finds similar YouTube channels for Google Ads placements
- Backend saves to `placementFinderHistory` collection
- Frontend displays placement results with export functionality

### History 500 Error Fix
- Fixed timestamp serialization in `getAllHistory` function
- Added safe timestamp conversion helper `getTs()` function
- Applied fix across all history collections

### AI Thumbnails Feature
- Integration with RunPod Flux image generation
- Multiple style presets (YouTube thumbnail, professional, etc.)
- Firebase Storage for generated images

### Trend Predictor Feature
- YouTube trending analysis by niche and country
- AI predictions with growth rates
- Top performers tracking

### Competitor Analysis Feature
- Video URL analysis
- AI-powered SWOT analysis
- Better titles/tags suggestions

### Warp Optimizer (Core Feature)
- SEO optimization for YouTube videos
- Title, description, and tag generation
- Score-based analysis

---

## Quota System

- Users get daily usage limits per tool
- Limits reset based on `resetTimeMinutes` setting
- Bonus uses can be added by admins
- Free tier: 2 uses per tool per day

---

## Firestore Collections

| Collection | Purpose |
|------------|---------|
| `users` | User profiles and usage data |
| `optimizations` | Warp Optimizer history |
| `competitorHistory` | Competitor Analysis history |
| `trendHistory` | Trend Predictor history |
| `thumbnailHistory` | AI Thumbnails history |
| `placementFinderHistory` | Placement Finder history |

---

## Common Issues & Solutions

### "Cannot read property of undefined" errors
- Usually means data is missing in Firestore
- Check if the document exists before accessing properties

### Quota not resetting
- Check `lastResetAt` timestamp in user document
- Verify `resetTimeMinutes` setting

### Function timeout
- Increase timeout in function config
- Optimize API calls (parallel where possible)

---

## Checklist Before Deployment

1. Test locally with emulators
2. Check for console errors
3. Verify all API keys are set in Firebase Functions config
4. Update this file with modified files list
5. Deploy functions first, then test before updating frontend widget
