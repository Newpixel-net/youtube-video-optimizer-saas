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
