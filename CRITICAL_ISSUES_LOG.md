# Critical Issues Log

This document contains critical problems encountered during development and their **actual solutions**. Reference this file before debugging similar issues to avoid wasting hours going in circles.

---

## Issue #1: Firebase Functions Firestore Permission Error

**Date**: 2024-11-28

**Symptom**:
- `getUserProfile` cloud function throws "PERMISSION_DENIED" errors when trying to read/write to Firestore
- Error message: `7 PERMISSION_DENIED: Missing or insufficient permissions`
- The function works locally but fails when deployed to Firebase

**What DID NOT fix it (wasted time)**:
- Modifying Firestore security rules
- Adding IAM roles in Google Cloud Console
- Adding debug logging to trace the issue
- Simplifying the function code
- Checking service account permissions
- Creating new service accounts

**The ACTUAL fix**:
The Firebase Admin SDK was initialized without an explicit project ID:

```javascript
// WRONG - causes permission errors in some deployment contexts
admin.initializeApp();
```

**Solution** - Explicitly pass the project ID:

```javascript
// CORRECT - always works
admin.initializeApp({
  projectId: 'ytseo-6d1b0'  // Your actual Firebase project ID
});
```

**Why this happens**:
Firebase Admin SDK relies on environment variables (`GCLOUD_PROJECT`, `FIREBASE_CONFIG`) for automatic project detection. In some deployment contexts, these may not be properly set or the SDK fails to detect them correctly, causing it to connect to the wrong project or fail authentication entirely.

**File location**: `functions/index.js` (lines 12-15)

**Time wasted**: ~4+ hours

---

## Security Audit - 2025-11-29

### Security Fixes Applied

The following security vulnerabilities were identified and fixed:

#### CRITICAL (Fixed)
1. **setupAdmin privilege escalation** - Any user could become admin
2. **Legacy functions without authentication** - 7 functions callable without login
3. **Firestore analyses collection open** - Anyone could read/write all data
4. **deleteAnalysis no ownership check** - Anyone could delete any record

#### HIGH (Fixed)
1. **adminSetCustomLimits input validation** - Could inject arbitrary fields
2. **Error message information disclosure** - Stack traces exposed to users
3. **Console.log with sensitive data** - Request data logged in plain text
4. **No rate limiting** - No burst protection on expensive operations

#### MEDIUM (Fixed/Documented)
1. **getHistory limit not bounded** - Could request unlimited records
2. **Firebase API key needs restriction** - See checklist below
3. **Storage thumbnails publicly readable** - Expected behavior, documented

---

## Production Security Checklist

### Firebase API Key Restriction (IMPORTANT)

The Firebase API key in the frontend (`AIzaSyAGczY5ZEIJdTq25BpQdia3lv2I556wOZo`) is public by design, but should be restricted in Google Cloud Console:

1. Go to [Google Cloud Console > APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials)
2. Click on the API key used by the web app
3. Under "Application restrictions":
   - Select "HTTP referrers (websites)"
   - Add your production domains:
     - `https://ytseo-6d1b0.web.app/*`
     - `https://ytseo-6d1b0.firebaseapp.com/*`
     - `https://yourdomain.com/*` (if using custom domain)
4. Under "API restrictions":
   - Select "Restrict key"
   - Enable only: Firebase Auth API, Cloud Firestore API, Firebase Installations API, Identity Toolkit API
5. Click "Save"

### Additional Production Recommendations

- [ ] **Enable Firebase App Check** - Verify requests come from your app
  - https://firebase.google.com/docs/app-check
  - Protects against API abuse from scripts/bots

- [ ] **Set up Cloud Armor** - DDoS protection for Cloud Functions
  - https://cloud.google.com/armor/docs

- [ ] **Configure billing alerts** - Prevent unexpected charges
  - Set up budget alerts at $10, $50, $100 thresholds
  - https://console.cloud.google.com/billing

- [ ] **Enable audit logging** - Track admin actions
  - https://console.cloud.google.com/logs

- [ ] **Rotate API keys periodically**
  - OpenAI API key
  - YouTube API key
  - RunPod API key

- [ ] **Review Firestore rules** before major releases
  - Run `firebase emulators:exec --only firestore "npm test"`

### CORS Configuration

All Cloud Functions use `functions.https.onCall()` which automatically handles CORS:
- Only accepts requests from Firebase client SDKs
- Validates the Firebase app origin
- No manual CORS configuration needed

If you add `functions.https.onRequest()` functions in the future, you'll need to handle CORS manually using the `cors` npm package.

### Storage Security Notes

Thumbnail images in `/thumbnails/{userId}/` are intentionally public for display purposes. This is expected behavior and is secure because:

1. **No enumeration possible** - Firebase Storage doesn't support listing files; you must know the exact path
2. **Unpredictable filenames** - Files use pattern `{timestamp}_{randomSeed}.png` (e.g., `1732892400000_847293847.png`)
3. **User ID required** - Must know the target user's UID to access their folder
4. **Write protection** - Only authenticated users can write to their own folder

If you need fully private thumbnails:

1. Update `storage.rules`:
```javascript
match /thumbnails/{userId}/{fileName} {
  allow read: if request.auth != null && request.auth.uid == userId;
  allow write: if request.auth != null && request.auth.uid == userId;
}
```

2. Use Firebase Storage signed URLs or download URLs with tokens instead of direct public URLs.

---

## Issue #2: History 500 Error (Recurring - Fixed 4+ times)

**Date**: 2025-11-29

**Symptom**:
- Activity History page shows "Failed to load history"
- Console shows "Failed to load resource: the server responded with a status of 500"
- Error occurs when calling `getAllHistory`, `getCompetitorHistory`, `getTrendHistory`, or `getThumbnailHistory` functions

**What DID NOT fix it (recurring issue)**:
- Previous fixes only applied to `getOptimizationHistory` function
- The fix kept "coming back" because other history functions were not fixed
- A duplicate file `functions/getOptimizationHistory.js` existed with buggy code

**Root Cause**:
Unsafe timestamp serialization in history functions. The code used:
```javascript
// WRONG - fails when createdAt is not a proper Firestore Timestamp
createdAt: data.createdAt?.toDate().toISOString(),
timestamp: data.createdAt?.toMillis() || Date.now()
```

The optional chaining `?.` only checks if `createdAt` is nullish, NOT if it has the expected methods (`toDate`, `toMillis`). When `createdAt` exists but is a different format (number, serialized `_seconds`, Date object), these methods don't exist and the call fails.

**The ACTUAL fix**:
Use a safe timestamp handler that checks for all possible formats:
```javascript
const getTimestamp = (field) => {
  if (!field) return Date.now();
  if (typeof field === 'number') return field;
  if (typeof field.toMillis === 'function') return field.toMillis();
  if (field._seconds) return field._seconds * 1000;
  if (field instanceof Date) return field.getTime();
  return Date.now();
};
```

And never include raw `createdAt` in the response (non-serializable Firestore object).

**Functions Fixed**:
- `getAllHistory` (used by Activity History page)
- `getCompetitorHistory`
- `getTrendHistory`
- `getThumbnailHistory`
- `getOptimizationHistory` (was already fixed)

**Deployment Command**:
```bash
firebase deploy --only functions:getAllHistory,functions:getCompetitorHistory,functions:getTrendHistory,functions:getThumbnailHistory
```

Or deploy all functions:
```bash
firebase deploy --only functions
```

**File location**: `functions/index.js` (lines ~2823-3090)

**Also removed**: `functions/getOptimizationHistory.js` (duplicate file with buggy code)

**Related commits**:
- `6ad1a92` - First fix for getOptimizationHistory
- `fd051e7` - Added safe timestamp handling
- `b62e05e` - Fixed ALL history functions (final fix)

**Time wasted**: ~6+ hours across multiple sessions

---

## Issue #3: Creative Studio Image Generation Models - Imagen vs Gemini API

**Date**: 2025-12-01

**Symptom**:
- `ai.getGenerativeModel is not a function` error when generating images
- Reference images (Style/Character) not working with Imagen 4 models
- Confusion about which models are available in Google AI Studio

**What DID NOT fix it**:
- Removing working Imagen 4 models (they were actually working!)
- Using `ai.getGenerativeModel()` method (wrong SDK method)
- Assuming Imagen 3 API was available (it's NOT in Google AI Studio)

**Root Cause**:
Two separate issues combined:

1. **Imagen 4 works but doesn't support reference images** - Imagen 4 and Imagen 4 Ultra use `ai.models.generateImages()` API and work perfectly for regular generation, but don't support style/character references.

2. **Imagen 3 is NOT available in Google AI Studio** - Only in Vertex AI. The available Gemini image models are:
   - `gemini-3-pro-image-preview` (Nano Banana Pro)
   - `gemini-2.5-flash-image` (Nano Banana)

3. **Wrong SDK method** - The `@google/genai` SDK does NOT have `getGenerativeModel()`. It uses:
   - `ai.models.generateContent()` for Gemini models
   - `ai.models.generateImages()` for Imagen models

**The ACTUAL fix**:

**1. Keep Imagen 4 models (they work!)**:
```javascript
// Frontend modelsConfig - Keep these!
{ key: 'imagen-4', name: 'Imagen 4', supportsReferenceImages: false },
{ key: 'imagen-4-ultra', name: 'Imagen 4 Ultra', supportsReferenceImages: false },
```

**2. Add Gemini Image models for reference support**:
```javascript
{ key: 'nano-banana-pro', name: 'Nano Banana Pro', supportsReferenceImages: true },
{ key: 'nano-banana', name: 'Nano Banana', supportsReferenceImages: true },
```

**3. Use correct SDK methods in backend**:
```javascript
// For Gemini Image models (Nano Banana)
const result = await ai.models.generateContent({
  model: 'gemini-3-pro-image-preview',
  contents: [{ role: 'user', parts: contentParts }],
  config: {
    responseModalities: ['image', 'text']
  }
});

// For Imagen models (Imagen 4)
const response = await ai.models.generateImages({
  model: 'imagen-4.0-generate-001',
  prompt: finalPrompt,
  config: imagenConfig
});
```

**4. "Auto" should default to Imagen 4 (working model)**:
```javascript
const imagenModelMap = {
  'auto': 'imagen-4.0-generate-001',  // Default to working model
  'imagen-4': 'imagen-4.0-generate-001',
  'imagen-4-ultra': 'imagen-4.0-ultra-generate-001'
};
```

**Model Capabilities Summary**:

| Model | API Method | Reference Images | Status |
|-------|------------|------------------|--------|
| Imagen 4 | `generateImages()` | No | Working |
| Imagen 4 Ultra | `generateImages()` | No | Working |
| Nano Banana Pro | `generateContent()` | Yes (multimodal) | Beta |
| Nano Banana | `generateContent()` | Yes (multimodal) | Beta |
| DALL-E 3/2 | OpenAI API | No | Working |

**Key Lesson**:
Never remove working functionality! Imagen 4 was working perfectly. Add new options as alternatives, don't replace what works.

**Additional Fixes Applied (2025-12-01)**:

1. **Indentation/Brace Alignment** - The Gemini generation block had inconsistent indentation causing mismatched braces. The entire block was rewritten with proper alignment.

2. **Fallback Model Fix** - Line ~7058 had a bad fallback:
   ```javascript
   // WRONG - Imagen 3 doesn't exist in Google AI Studio!
   const imagenModelId = imagenModelMap[model] || 'imagen-3.0-generate-001';

   // CORRECT - Default to working Imagen 4
   const imagenModelId = imagenModelMap[model] || 'imagen-4.0-generate-001';
   ```

3. **Token Initialization** - Added token initialization directly in `generateCreativeImage` to prevent "Insufficient tokens. Need X, have 0" errors for new users whose token document wasn't created yet.

**File locations**:
- `functions/index.js` (lines ~7029-7300 for model handling)
- `frontend/creative-studio.html` (modelsConfig around line 5569)

**Time wasted**: ~3 hours

---

## Template for Future Issues

### Issue #X: [Title]

**Date**: YYYY-MM-DD

**Symptom**:
- What error messages appeared
- What behavior was observed

**What DID NOT fix it**:
- List failed attempts

**The ACTUAL fix**:
- The specific code/config change that solved it

**Why this happens**:
- Root cause explanation

**File location**: path/to/file.ext

**Time wasted**: X hours

---
