# YouTube Video Optimizer SaaS - Complete Platform Documentation

> **Purpose**: This document provides a comprehensive summary of the platform architecture, patterns, and workflows. Use this as context when starting a new conversation with Claude to build new features.

---

## TABLE OF CONTENTS

1. [Tech Stack & Architecture](#1-tech-stack--architecture)
2. [Project Structure](#2-project-structure)
3. [Firebase Configuration](#3-firebase-configuration)
4. [All Pages & Views](#4-all-pages--views)
5. [Component Patterns](#5-component-patterns)
6. [Velvet Aurora Theme System](#6-velvet-aurora-theme-system)
7. [State Management](#7-state-management)
8. [Cloud Functions API](#8-cloud-functions-api)
9. [Security & Rules](#9-security--rules)
10. [Page Creation Workflow](#10-page-creation-workflow)
11. [Mobile Responsiveness](#11-mobile-responsiveness)
12. [Form Patterns](#12-form-patterns)
13. [Loading & Error States](#13-loading--error-states)

---

## 1. TECH STACK & ARCHITECTURE

### Frontend
- **Framework**: Vanilla JavaScript (Single Page Application)
- **Styling**: Tailwind CSS (via CDN: cdn.tailwindcss.com) + Custom CSS
- **UI Pattern**: Component-based with render functions
- **No build step** - direct HTML/CSS/JS

### Backend
- **Platform**: Firebase
  - **Authentication**: Firebase Auth (Email/Password + Google OAuth)
  - **Database**: Firestore (NoSQL)
  - **Functions**: Cloud Functions (Node.js 18+)
  - **Storage**: Cloud Storage (for thumbnails & report images)
  - **Hosting**: Firebase Hosting

### External APIs
- **OpenAI**: GPT-4 for AI content generation
- **YouTube Data API v3**: Video metadata and analysis
- **RunPod**: AI image generation (thumbnails)

### Key Dependencies (functions/package.json)
```json
{
  "firebase-functions": "^4.x",
  "firebase-admin": "^11.x",
  "openai": "^4.x",
  "googleapis": "^126.x",
  "axios": "^1.x"
}
```

---

## 2. PROJECT STRUCTURE

```
youtube-video-optimizer-saas/
├── frontend/                          # Static files (Firebase Hosting)
│   ├── dual-auth-widget.html         # Main SPA (8,305 lines) - ALL views
│   ├── admin-plans.html              # Admin plan management page
│   └── enterprise.html               # Enterprise suite features
├── functions/                         # Firebase Cloud Functions
│   ├── index.js                      # Backend (6,004 lines) - 50+ functions
│   ├── setup-firestore.js            # Database initialization
│   ├── package.json                  # Node.js dependencies
│   └── .env.example                  # Environment template
├── firebase.json                     # Firebase configuration
├── .firebaserc                       # Project ID (ytseo-6d1b0)
├── firestore.rules                   # Firestore security rules
├── firestore.indexes.json            # Query indexes (10 indexes)
├── storage.rules                     # Storage security rules
└── deploy.sh                         # Deployment script
```

---

## 3. FIREBASE CONFIGURATION

### Project Details
- **Project ID**: `ytseo-6d1b0`
- **Auth Domain**: `ytseo-6d1b0.firebaseapp.com`
- **Storage Bucket**: `ytseo-6d1b0.firebasestorage.app`
- **Region**: us-central1

### Firebase Config (Frontend)
```javascript
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyAGczY5ZEIJdTq25BpQdia3lv2I556wOZo",
    authDomain: "ytseo-6d1b0.firebaseapp.com",
    projectId: "ytseo-6d1b0",
    storageBucket: "ytseo-6d1b0.firebasestorage.app",
    messagingSenderId: "382790048044",
    appId: "1:382790048044:web:cd427679ff72108c1f3489"
};

firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const functions = firebase.functions();
const db = firebase.firestore();
```

### Firestore Collections

| Collection | Purpose | Key Fields |
|-----------|---------|------------|
| `users` | User profiles | uid, email, subscription, usage, bonusUses, isAdmin |
| `optimizations` | Warp Optimizer results | userId, videoUrl, titles[], description, tags[], createdAt |
| `competitorHistory` | Competitor analysis | userId, competitorUrl, analysis, createdAt |
| `trendHistory` | Trend predictions | userId, niche, predictions[], createdAt |
| `thumbnailHistory` | Generated thumbnails | userId, title, imageUrl, style, createdAt |
| `placementFinderHistory` | Placement results | userId, niche, placements[], createdAt |
| `channelAuditHistory` | Channel audits | userId, channelUrl, scores, recommendations, createdAt |
| `campaignReports` | Admin reports | adminId, clientId, reportName, images[], status |
| `userNotifications` | Real-time notifications | userId, type, message, isRead, createdAt |
| `subscriptionPlans` | Plan configurations | id, name, limits, pricing, features |
| `adminUsers` | Admin registry | uid, email, role, createdAt |
| `settings` | System settings | quotaSettings.resetTimeMinutes |
| `usageLogs` | Audit trail | userId, action, timestamp, metadata |

### User Document Structure
```javascript
{
  uid: string,
  email: string,
  displayName: string,
  photoURL: string,
  createdAt: Timestamp,
  lastLoginAt: Timestamp,
  isActive: boolean,
  isAdmin: boolean,
  subscription: {
    plan: 'free' | 'lite' | 'pro' | 'enterprise',
    status: 'active' | 'cancelled',
    startDate: Timestamp,
    endDate: Timestamp | null,
    autoRenew: boolean
  },
  usage: {
    warpOptimizer: { usedToday: number, limit: number, lastResetAt: Timestamp },
    competitorAnalysis: { usedToday: number, limit: number, lastResetAt: Timestamp },
    trendPredictor: { usedToday: number, limit: number, lastResetAt: Timestamp },
    thumbnailGenerator: { usedToday: number, limit: number, lastResetAt: Timestamp },
    channelAudit: { usedToday: number, limit: number, lastResetAt: Timestamp }
  },
  bonusUses: { [toolType]: number },
  customLimits: { [toolType]: number },
  notes: string
}
```

### Firestore Indexes
```json
// firestore.indexes.json
{
  "indexes": [
    { "collectionGroup": "optimizations", "fields": [{"userId": "ASC"}, {"createdAt": "DESC"}] },
    { "collectionGroup": "competitorHistory", "fields": [{"userId": "ASC"}, {"createdAt": "DESC"}] },
    { "collectionGroup": "trendHistory", "fields": [{"userId": "ASC"}, {"createdAt": "DESC"}] },
    { "collectionGroup": "thumbnailHistory", "fields": [{"userId": "ASC"}, {"createdAt": "DESC"}] },
    { "collectionGroup": "placementFinderHistory", "fields": [{"userId": "ASC"}, {"createdAt": "DESC"}] },
    { "collectionGroup": "campaignReports", "fields": [{"adminId": "ASC"}, {"createdAt": "DESC"}] },
    { "collectionGroup": "campaignReports", "fields": [{"clientId": "ASC"}, {"createdAt": "DESC"}] },
    { "collectionGroup": "userNotifications", "fields": [{"userId": "ASC"}, {"createdAt": "DESC"}] },
    { "collectionGroup": "userNotifications", "fields": [{"userId": "ASC"}, {"isRead": "ASC"}, {"createdAt": "DESC"}] }
  ]
}
```

### Firebase Storage Paths
```
/thumbnails/{userId}/{fileName}        # AI-generated thumbnails (public read)
/campaign-reports/{reportId}/{fileName} # Report images (authenticated read)
```

---

## 4. ALL PAGES & VIEWS

The app is a **Single Page Application** - all views render into `#app-root`.

### View Registry

| View Name | URL Path | Render Function | Purpose |
|-----------|----------|-----------------|---------|
| initializing | - | `renderInitializing()` | App loading state |
| login | / | `renderLogin()` | User authentication |
| register | /register | `renderRegister()` | New user signup |
| forgot-password | /reset | `renderForgotPassword()` | Password recovery |
| dashboard | /dashboard | `renderDashboard()` | Main dashboard |
| optimizer | /optimizer | `renderOptimizer()` | Warp Optimizer tool |
| results | /results | `renderResults()` | Optimization results |
| history | /history | `renderHistory()` | History browser (tabbed) |
| competitor | /competitor | `renderCompetitor()` | Competitor analysis |
| trends | /trends | `renderTrends()` | Trend predictor |
| thumbnail | /thumbnail | `renderThumbnail()` | Thumbnail generator |
| placement | /placement | `renderPlacement()` | Placement finder |
| channelAudit | /channel-audit | `renderChannelAudit()` | Channel Audit Pro |
| admin | /admin | `renderAdmin()` | Admin panel |
| adminReports | /admin/reports | `renderAdminReports()` | Admin reports management |
| reportEditor | /report-editor | `renderReportEditor()` | Create/edit reports |
| clientReports | /reports | `renderClientReports()` | Client reports list |
| viewReport | /report/:id | `renderViewReport()` | View single report |

### Navigation Pattern
```javascript
// Navigation methods
app.goToDashboard = function() { state.currentView = 'dashboard'; app.render(); }
app.goToOptimizer = function() { state.currentView = 'optimizer'; app.render(); }
app.goToResults = function() { state.currentView = 'results'; app.render(); }
// ... etc for each view

// Main render function
app.render = function() {
    var html = '';
    switch(state.currentView) {
        case 'login': html = renderLogin(); break;
        case 'dashboard': html = renderDashboard(); break;
        case 'optimizer': html = renderOptimizer(); break;
        // ... all views
    }
    document.getElementById('app-root').innerHTML = html;
    // Post-render setup (event listeners, carousels, etc.)
}
```

---

## 5. COMPONENT PATTERNS

### Layout Structure
```html
<div class="velvet-aurora">
    <div class="velvet-orbs"><!-- Animated background orbs --></div>
</div>
<div id="app-root">
    <!-- Global header (when authenticated) -->
    <div class="global-header">
        <div class="notification-bell"><!-- Bell with badge --></div>
        <!-- User menu -->
    </div>

    <!-- View container -->
    <div class="view-container min-h-screen">
        <div class="content-wrapper max-w-6xl mx-auto px-4 py-8">
            <!-- Page content -->
        </div>
    </div>
</div>
```

### Button Components
```html
<!-- Primary Button -->
<button class="btn-primary w-full">
    Submit
</button>

<!-- Secondary Button -->
<button class="btn-secondary">
    Cancel
</button>

<!-- Google OAuth Button -->
<button class="google-btn">
    <img src="google-icon.svg" /> Continue with Google
</button>

<!-- Icon Button -->
<button class="p-3 rounded-xl bg-gradient-to-r from-green-500 to-emerald-600 text-white">
    <span>✓</span>
</button>
```

### Card Components
```html
<!-- Tool Card -->
<div class="tool-card cursor-pointer" onclick="app.goToOptimizer()">
    <div class="card-icon">🚀</div>
    <h3 class="card-title">Warp Optimizer</h3>
    <p class="card-subtitle">Optimize your video titles</p>
</div>

<!-- Living Aurora Card (Premium) -->
<div class="living-aurora aurora-emerald cursor-pointer" onclick="app.goToFeature()">
    <div class="aurora-orb aurora-orb-1"></div>
    <div class="aurora-orb aurora-orb-2"></div>
    <div class="aurora-orb aurora-orb-3"></div>
    <div class="aurora-orb aurora-orb-4"></div>
    <div class="aurora-content">
        <div class="card-icon">📊</div>
        <h3>Premium Feature</h3>
        <p>Feature description</p>
    </div>
</div>

<!-- Report Card -->
<div class="report-card">
    <div class="report-header">
        <h3>Campaign Report</h3>
        <span class="status-badge status-sent">Sent</span>
    </div>
    <div class="report-body"><!-- Content --></div>
</div>
```

### Tab Components
```html
<!-- Tabs Container -->
<div class="tabs-container bg-gray-100 p-1 rounded-xl">
    <button class="tab-btn active" onclick="app.switchTab('all')">All</button>
    <button class="tab-btn" onclick="app.switchTab('warp')">Warp Optimizer</button>
    <button class="tab-btn" onclick="app.switchTab('competitor')">Competitor</button>
</div>

<!-- Mobile Scrollable Tabs -->
<div class="history-tabs-container overflow-x-auto scrollbar-hide">
    <div class="flex gap-2 pb-2" style="min-width: max-content;">
        <!-- Tab buttons -->
    </div>
</div>
```

### Form Input Components
```html
<!-- Text Input -->
<div class="form-group">
    <label class="block text-sm font-medium text-gray-700 mb-2">
        Email Address
    </label>
    <input
        type="email"
        id="email-input"
        class="input-field w-full"
        placeholder="your@email.com"
        required
    />
</div>

<!-- Select Dropdown -->
<div class="form-group">
    <label class="block text-sm font-medium text-gray-700 mb-2">
        Country
    </label>
    <select id="country-select" class="input-field w-full">
        <option value="us">United States</option>
        <option value="uk">United Kingdom</option>
    </select>
</div>

<!-- Textarea -->
<textarea
    id="description"
    class="input-field w-full"
    rows="4"
    placeholder="Enter description..."
></textarea>
```

### Progress/Loading Components
```html
<!-- Progress Bar with Steps -->
<div class="loading-container">
    <div class="progress-percentage text-2xl font-bold">${progress}%</div>
    <div class="progress-bar-container bg-gray-200 rounded-full h-3 overflow-hidden">
        <div class="progress-bar-fill bg-gradient-to-r from-indigo-500 to-purple-500"
             style="width: ${progress}%"></div>
    </div>
    <div class="loading-steps mt-6 space-y-3">
        ${steps.map(step => `
            <div class="loading-step ${step.status}">
                <span class="step-icon">${step.icon}</span>
                <span>${step.name}</span>
            </div>
        `).join('')}
    </div>
</div>

<!-- Spinner -->
<div class="spinner"></div>
```

### Notification Components
```html
<!-- Notification Bell -->
<div class="notification-bell" onclick="app.toggleNotifications()">
    🔔
    ${unreadCount > 0 ? `<span class="notification-badge">${unreadCount}</span>` : ''}
</div>

<!-- Notification Dropdown -->
<div class="notification-dropdown ${isOpen ? '' : 'hidden'}">
    <div class="notification-header">Notifications</div>
    <div class="notification-list">
        ${notifications.map(n => `
            <div class="notification-item ${n.isRead ? 'read' : 'unread'}">
                <p>${n.message}</p>
                <span class="notification-time">${formatTime(n.createdAt)}</span>
            </div>
        `).join('')}
    </div>
</div>
```

---

## 6. VELVET AURORA THEME SYSTEM

### Time-Aware Color Palette
```css
:root {
    /* Night (9pm - 6am) - Purple/Indigo */
    --aurora-night-primary: #6366f1;
    --aurora-night-secondary: #8b5cf6;
    --aurora-night-tertiary: #a855f7;

    /* Morning (6am - 12pm) - Amber/Orange */
    --aurora-morning-primary: #f59e0b;
    --aurora-morning-secondary: #fb923c;
    --aurora-morning-tertiary: #fbbf24;

    /* Afternoon (12pm - 6pm) - Green/Cyan */
    --aurora-afternoon-primary: #22c55e;
    --aurora-afternoon-secondary: #34d399;
    --aurora-afternoon-tertiary: #10b981;

    /* Evening (6pm - 9pm) - Orange/Red */
    --aurora-evening-primary: #f97316;
    --aurora-evening-secondary: #ef4444;
    --aurora-evening-tertiary: #ec4899;
}
```

### Velvet Aurora Background
```css
.velvet-aurora {
    position: fixed;
    inset: 0;
    z-index: -1;
    background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 50%, #16213e 100%);
    overflow: hidden;
}

.velvet-orbs {
    position: absolute;
    inset: 0;
}

/* Individual orbs with drift animations */
.velvet-orb-coral {
    position: absolute;
    width: 500px;
    height: 500px;
    background: radial-gradient(circle, rgba(255, 182, 193, 0.15) 0%, transparent 70%);
    filter: blur(60px);
    animation: driftCoral 35s ease-in-out infinite;
}

/* Similar for other orbs: amber, lavender, teal */
```

### Living Aurora Cards
```css
.living-aurora {
    position: relative;
    border-radius: 1rem;
    overflow: hidden;
    background: linear-gradient(135deg,
        var(--aurora-primary) 0%,
        var(--aurora-secondary) 50%,
        var(--aurora-tertiary) 100%);
}

.living-aurora::before {
    content: '';
    position: absolute;
    inset: 0;
    background: inherit;
    animation: auroraFlow 15s ease-in-out infinite;
}

.living-aurora:hover::before {
    animation-duration: 7.5s; /* Speed up on hover */
}

/* Variants */
.aurora-emerald {
    --aurora-primary: #22c55e;
    --aurora-secondary: #10b981;
    --aurora-tertiary: #14b8a6;
}

.aurora-gold {
    --aurora-primary: #f59e0b;
    --aurora-secondary: #fbbf24;
    --aurora-tertiary: #f97316;
}
```

### Time-Based Theme Update
```javascript
function updateAuroraTheme() {
    const hour = new Date().getHours();
    let period;

    if (hour >= 6 && hour < 12) period = 'morning';
    else if (hour >= 12 && hour < 18) period = 'afternoon';
    else if (hour >= 18 && hour < 21) period = 'evening';
    else period = 'night';

    document.documentElement.classList.remove(
        'aurora-morning', 'aurora-afternoon', 'aurora-evening', 'aurora-night'
    );
    document.documentElement.classList.add(`aurora-${period}`);
}

// Update every hour
setInterval(updateAuroraTheme, 3600000);
updateAuroraTheme();
```

---

## 7. STATE MANAGEMENT

### Global State Object
```javascript
var state = {
    // View & Navigation
    currentView: 'initializing',
    initializing: true,

    // Authentication
    user: null,              // Firebase User object
    profile: null,           // User profile from Firestore
    isAdmin: false,

    // UI State
    loading: false,
    error: null,
    success: null,

    // Loading Progress
    loadingProgress: 0,
    loadingStep: 0,
    loadingSteps: [],

    // Results & History
    currentResults: null,
    resultsTab: 'titles',    // 'titles' | 'description' | 'tags'
    historyData: [],
    historyTab: 'all',       // 'all' | 'optimization' | 'competitor' | etc.

    // Feature-Specific Results
    competitorResults: null,
    trendResults: null,
    thumbnailJob: null,
    channelAuditResults: null,

    // Admin
    adminUsers: [],
    adminQuotaSettings: null,
    campaignReports: [],
    clientReports: [],

    // Quota/Limits
    quotaInfo: {},
    resetTimeMinutes: 1440,
    bonusHistory: [],

    // Notifications
    notifications: [],
    unreadCount: 0,

    // Modals
    lightboxOpen: false,
    lightboxImages: [],
    lightboxIndex: 0,
    showBonusHistory: false,
    sendModalReportId: null
};
```

### State Update Pattern
```javascript
// Update state and re-render
function updateState(updates) {
    Object.assign(state, updates);
    app.render();
}

// Example usage
app.handleOptimize = async function() {
    state.loading = true;
    state.loadingProgress = 0;
    state.loadingSteps = [
        { name: 'Fetching video data', icon: '🔍', status: 'active' },
        { name: 'Analyzing content', icon: '🧠', status: 'pending' },
        { name: 'Generating titles', icon: '✨', status: 'pending' },
        { name: 'Creating description', icon: '📝', status: 'pending' }
    ];
    app.render();

    try {
        const result = await functions.httpsCallable('optimizeVideo')({ videoUrl });
        state.currentResults = result.data;
        state.currentView = 'results';
        state.loading = false;
    } catch (error) {
        state.error = error.message;
        state.loading = false;
    }
    app.render();
};
```

### Auth State Listener
```javascript
auth.onAuthStateChanged(async function(user) {
    if (user) {
        state.user = user;

        // Get profile and quota info
        const result = await functions.httpsCallable('getUserProfile')();
        state.profile = result.data.profile;
        state.quotaInfo = result.data.quotaInfo;
        state.isAdmin = state.profile.isAdmin === true;

        // Start real-time notification listener
        startNotificationListener(user.uid);

        state.currentView = 'dashboard';
    } else {
        state.user = null;
        state.profile = null;
        state.isAdmin = false;
        stopNotificationListener();
        state.currentView = 'login';
    }
    state.initializing = false;
    app.render();
});
```

### Real-Time Notification Listener
```javascript
var notificationUnsubscribe = null;

function startNotificationListener(userId) {
    stopNotificationListener();

    notificationUnsubscribe = db.collection('userNotifications')
        .where('userId', '==', userId)
        .where('isRead', '==', false)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .onSnapshot(function(snapshot) {
            state.notifications = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            state.unreadCount = state.notifications.length;
            app.render();
        });
}

function stopNotificationListener() {
    if (notificationUnsubscribe) {
        notificationUnsubscribe();
        notificationUnsubscribe = null;
    }
}
```

---

## 8. CLOUD FUNCTIONS API

### Function Categories

#### Authentication & User Management
```javascript
// Get user profile with quota info
functions.httpsCallable('getUserProfile')()
// Returns: { profile, quotaInfo, isAdmin }

// Update last login
functions.httpsCallable('updateLastLogin')()
```

#### Core Optimization Tools
```javascript
// Video Optimizer (Warp Optimizer)
functions.httpsCallable('optimizeVideo')({ videoUrl, contentType })
// Returns: { titles[], description, tags[], seoScore, videoInfo }

// Competitor Analysis
functions.httpsCallable('analyzeCompetitor')({ competitorUrl })
// Returns: { analysis, keywords[], gaps[], opportunities[] }

// Trend Predictor
functions.httpsCallable('predictTrends')({ niche, country })
// Returns: { trends[], predictions[], topPerformers[] }

// Thumbnail Generator
functions.httpsCallable('generateThumbnail')({ title, style, customPrompt })
// Returns: { jobId, status } (poll with checkThumbnailStatus)

functions.httpsCallable('checkThumbnailStatus')({ jobId })
// Returns: { status, imageUrl, progress }

// Placement Finder
functions.httpsCallable('findPlacements')({ niche, country })
// Returns: { placements[] }

// Channel Audit
functions.httpsCallable('auditChannel')({ channelUrl })
// Returns: { scores, recommendations[], earnings, cpm }
```

#### History Functions
```javascript
// Get all history (combined)
functions.httpsCallable('getAllHistory')({ limit, offset })
// Returns: { items[], hasMore }

// Get specific history types
functions.httpsCallable('getOptimizationHistory')({ limit })
functions.httpsCallable('getCompetitorHistory')({ limit })
functions.httpsCallable('getTrendHistory')({ limit })
functions.httpsCallable('getThumbnailHistory')({ limit })
functions.httpsCallable('getPlacementFinderHistory')({ limit })
functions.httpsCallable('getChannelAuditHistory')({ limit })

// Delete history items
functions.httpsCallable('deleteOptimization')({ optimizationId })
functions.httpsCallable('deleteCompetitorAnalysis')({ analysisId })
// ... etc for each type
```

#### Campaign Reports (Enterprise)
```javascript
// Admin functions
functions.httpsCallable('createCampaignReport')({ clientId, reportName, images, analysis })
functions.httpsCallable('updateCampaignReport')({ reportId, updates })
functions.httpsCallable('deleteCampaignReport')({ reportId })
functions.httpsCallable('getAdminReports')({ limit })
functions.httpsCallable('sendReportToClient')({ reportId })
functions.httpsCallable('uploadReportImages')({ reportId, images })
functions.httpsCallable('analyzeReportImages')({ reportId, images, context })

// Client functions
functions.httpsCallable('getClientReports')({ limit })
functions.httpsCallable('getCampaignReport')({ reportId })
functions.httpsCallable('markReportViewed')({ reportId })
```

#### Notifications
```javascript
functions.httpsCallable('getUnreadNotifications')()
functions.httpsCallable('markNotificationRead')({ notificationId })
```

#### Admin Functions
```javascript
functions.httpsCallable('adminGetUsers')({ limit, offset, search })
functions.httpsCallable('adminUpdateUserPlan')({ userId, plan })
functions.httpsCallable('adminSetCustomLimits')({ userId, limits })
functions.httpsCallable('adminGrantBonusUses')({ userId, toolType, amount })
functions.httpsCallable('adminGetQuotaSettings')()
functions.httpsCallable('adminSetQuotaSettings')({ resetTimeMinutes })
functions.httpsCallable('adminGetAnalytics')()
```

### API Call Pattern
```javascript
app.doSomething = async function() {
    state.loading = true;
    state.error = null;
    app.render();

    try {
        const result = await functions.httpsCallable('functionName')({
            param1: 'value1',
            param2: 'value2'
        });

        // Handle success
        state.someData = result.data;
        state.success = 'Operation completed!';
    } catch (error) {
        // Handle error
        console.error('Error:', error);
        state.error = error.message || 'Something went wrong';
    }

    state.loading = false;
    app.render();
};
```

---

## 9. SECURITY & RULES

### Firestore Security Rules Pattern
```javascript
// firestore.rules
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Helper functions
    function isAuthenticated() {
      return request.auth != null;
    }

    function isAdmin() {
      return isAuthenticated() &&
             exists(/databases/$(database)/documents/adminUsers/$(request.auth.uid));
    }

    function isOwner(userId) {
      return isAuthenticated() && request.auth.uid == userId;
    }

    // Users collection
    match /users/{userId} {
      allow read: if isOwner(userId) || isAdmin();
      allow update: if isOwner(userId) &&
                      request.resource.data.diff(resource.data).affectedKeys()
                        .hasOnly(['displayName', 'photoURL', 'lastLoginAt']);
      allow create, delete: if false; // Cloud Functions only
    }

    // History collections (same pattern for all)
    match /optimizations/{docId} {
      allow read: if isAuthenticated() &&
                    resource.data.userId == request.auth.uid;
      allow delete: if isAuthenticated() &&
                      resource.data.userId == request.auth.uid;
      allow create, update: if false; // Cloud Functions only
    }

    // Notifications
    match /userNotifications/{docId} {
      allow read: if isAuthenticated() &&
                    resource.data.userId == request.auth.uid;
      allow update: if isAuthenticated() &&
                      resource.data.userId == request.auth.uid &&
                      request.resource.data.diff(resource.data).affectedKeys()
                        .hasOnly(['isRead']);
      allow create, delete: if false; // Cloud Functions only
    }

    // Public collections
    match /subscriptionPlans/{docId} {
      allow read: if true;
      allow write: if isAdmin();
    }
  }
}
```

### Storage Rules
```javascript
// storage.rules
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // Thumbnails - public read, user write to own folder
    match /thumbnails/{userId}/{fileName} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == userId;
    }

    // Campaign reports - authenticated read, Cloud Functions write
    match /campaign-reports/{reportId}/{fileName} {
      allow read: if request.auth != null;
      allow write: if false; // Cloud Functions only
    }

    // Deny all other paths
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

### Backend Auth Verification
```javascript
// functions/index.js
async function verifyAuth(context) {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    }
    return context.auth.uid;
}

async function requireAdmin(context) {
    const uid = await verifyAuth(context);
    const adminDoc = await db.collection('adminUsers').doc(uid).get();
    if (!adminDoc.exists) {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
    return uid;
}

// Rate limiting
function checkRateLimit(userId, action, maxRequestsPerMinute = 10) {
    const key = `${userId}:${action}`;
    const now = Date.now();
    // ... rate limit logic
}
```

---

## 10. PAGE CREATION WORKFLOW

### Step 1: Add View to State
```javascript
// In state object, add any state needed for the new view
var state = {
    // ... existing state
    newFeatureData: null,
    newFeatureLoading: false,
    newFeatureError: null
};
```

### Step 2: Create Render Function
```javascript
function renderNewFeature() {
    return `
        <div class="view-container min-h-screen">
            <div class="content-wrapper max-w-6xl mx-auto px-4 py-8">
                <!-- Header -->
                <div class="mb-8">
                    <button onclick="app.goToDashboard()" class="text-white/80 hover:text-white mb-4 inline-flex items-center gap-2">
                        ← Back to Dashboard
                    </button>
                    <h1 class="text-3xl font-bold text-white">New Feature</h1>
                    <p class="text-white/60 mt-2">Feature description here</p>
                </div>

                <!-- Main Content Card -->
                <div class="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20">
                    ${state.newFeatureLoading ? `
                        <div class="text-center py-12">
                            <div class="spinner mx-auto"></div>
                            <p class="text-white/60 mt-4">Loading...</p>
                        </div>
                    ` : `
                        <!-- Feature content here -->
                        <form onsubmit="app.handleNewFeature(event)">
                            <div class="form-group">
                                <label class="block text-white/80 mb-2">Input Field</label>
                                <input type="text" id="new-feature-input" class="input-field w-full" required />
                            </div>
                            <button type="submit" class="btn-primary w-full mt-6">
                                Submit
                            </button>
                        </form>
                    `}
                </div>

                <!-- Error Display -->
                ${state.newFeatureError ? `
                    <div class="alert-error mt-4">${escapeHtml(state.newFeatureError)}</div>
                ` : ''}
            </div>
        </div>
    `;
}
```

### Step 3: Add to Main Render Switch
```javascript
app.render = function() {
    var html = '';

    switch(state.currentView) {
        // ... existing cases
        case 'newFeature':
            html = renderNewFeature();
            break;
    }

    // Add global header if authenticated
    if (state.user && !['login', 'register', 'forgot-password'].includes(state.currentView)) {
        html = renderGlobalHeader() + html;
    }

    document.getElementById('app-root').innerHTML = html;

    // Post-render setup
    setupEventListeners();
};
```

### Step 4: Add Navigation Method
```javascript
app.goToNewFeature = function() {
    state.currentView = 'newFeature';
    state.newFeatureData = null;
    state.newFeatureError = null;
    app.render();
};
```

### Step 5: Add Handler Functions
```javascript
app.handleNewFeature = async function(event) {
    event.preventDefault();

    const inputValue = document.getElementById('new-feature-input').value.trim();

    if (!inputValue) {
        state.newFeatureError = 'Please enter a value';
        app.render();
        return;
    }

    state.newFeatureLoading = true;
    state.newFeatureError = null;
    app.render();

    try {
        const result = await functions.httpsCallable('newFeatureFunction')({
            input: inputValue
        });

        state.newFeatureData = result.data;
        state.currentView = 'newFeatureResults';
    } catch (error) {
        console.error('Error:', error);
        state.newFeatureError = error.message || 'Something went wrong';
    }

    state.newFeatureLoading = false;
    app.render();
};
```

### Step 6: Add Dashboard Link
```javascript
// In renderDashboard(), add a tool card
<div class="tool-card cursor-pointer" onclick="app.goToNewFeature()">
    <div class="card-icon">🆕</div>
    <h3 class="card-title">New Feature</h3>
    <p class="card-subtitle">Description of the new feature</p>
</div>
```

### Step 7: Create Cloud Function (if needed)
```javascript
// functions/index.js
exports.newFeatureFunction = functions.https.onCall(async (data, context) => {
    // Verify authentication
    const uid = await verifyAuth(context);

    // Check rate limit
    checkRateLimit(uid, 'newFeature', 10);

    // Check usage quota
    await checkUsageLimit(uid, 'newFeature');

    // Process the request
    const { input } = data;

    if (!input) {
        throw new functions.https.HttpsError('invalid-argument', 'Input is required');
    }

    // Do something with the input
    const result = await processInput(input);

    // Save to history
    await db.collection('newFeatureHistory').add({
        userId: uid,
        input: input,
        result: result,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Increment usage
    await incrementUsage(uid, 'newFeature');

    return { success: true, result };
});
```

### Step 8: Add Firestore Index (if needed)
```json
// firestore.indexes.json
{
  "collectionGroup": "newFeatureHistory",
  "fields": [
    { "fieldPath": "userId", "order": "ASCENDING" },
    { "fieldPath": "createdAt", "order": "DESCENDING" }
  ]
}
```

---

## 11. MOBILE RESPONSIVENESS

### Breakpoints
```css
/* Mobile First Approach */
@media (max-width: 375px) { /* Small phones */ }
@media (max-width: 768px) { /* Mobile */ }
@media (min-width: 769px) and (max-width: 1024px) { /* Tablet */ }
@media (min-width: 1024px) { /* Desktop */ }
@media (min-width: 1280px) { /* Large desktop */ }
```

### Mobile Container Classes
```css
.mobile-wide-container {
    width: 100%;
    max-width: 100vw;
    padding: 0 1rem;
}

.mobile-full-screen {
    min-height: 100vh;
    min-height: 100dvh; /* Dynamic viewport height */
}

.mobile-padding {
    padding: 1.25rem;
}
```

### Mobile Touch Targets
```css
/* Minimum 44px touch targets (Apple HIG) */
@media (max-width: 768px) {
    .btn-primary, .btn-secondary {
        min-height: 50px;
        font-size: 17px;
    }

    .input-field {
        min-height: 48px;
        font-size: 16px; /* Prevents iOS zoom */
    }
}
```

### Swipeable Mobile Cards
```html
<div class="mobile-swipe-container overflow-x-auto scrollbar-hide">
    <div class="flex gap-4 pb-4" style="scroll-snap-type: x mandatory;">
        ${items.map(item => `
            <div class="mobile-swipe-card" style="scroll-snap-align: center; min-width: 85%;">
                <!-- Card content -->
            </div>
        `).join('')}
    </div>
</div>
<div class="mobile-swipe-dots flex justify-center gap-2 mt-4">
    ${items.map((_, i) => `
        <div class="dot ${i === 0 ? 'active' : ''}" data-index="${i}"></div>
    `).join('')}
</div>
```

### Scrollable Tabs (Mobile)
```html
<div class="history-tabs-container overflow-x-auto scrollbar-hide">
    <div class="flex gap-2 pb-2" style="min-width: max-content;">
        <button class="tab-btn whitespace-nowrap">Tab 1</button>
        <button class="tab-btn whitespace-nowrap">Tab 2</button>
        <button class="tab-btn whitespace-nowrap">Tab 3</button>
    </div>
</div>
```

### Hide Scrollbars
```css
.scrollbar-hide {
    -ms-overflow-style: none;
    scrollbar-width: none;
}
.scrollbar-hide::-webkit-scrollbar {
    display: none;
}
```

---

## 12. FORM PATTERNS

### Standard Form Structure
```html
<form onsubmit="app.handleFormSubmit(event)">
    <!-- Text Input -->
    <div class="form-group mb-4">
        <label class="block text-white/80 text-sm font-medium mb-2">
            Label Text
        </label>
        <input
            type="text"
            id="input-id"
            class="input-field w-full"
            placeholder="Placeholder text..."
            required
            minlength="3"
            maxlength="100"
        />
    </div>

    <!-- Select -->
    <div class="form-group mb-4">
        <label class="block text-white/80 text-sm font-medium mb-2">
            Select Option
        </label>
        <select id="select-id" class="input-field w-full" required>
            <option value="">Choose...</option>
            <option value="opt1">Option 1</option>
            <option value="opt2">Option 2</option>
        </select>
    </div>

    <!-- Textarea -->
    <div class="form-group mb-4">
        <label class="block text-white/80 text-sm font-medium mb-2">
            Description
        </label>
        <textarea
            id="textarea-id"
            class="input-field w-full"
            rows="4"
            placeholder="Enter description..."
        ></textarea>
    </div>

    <!-- Submit Button -->
    <button type="submit" class="btn-primary w-full" ${state.loading ? 'disabled' : ''}>
        ${state.loading ? '<span class="spinner-small"></span> Processing...' : 'Submit'}
    </button>
</form>
```

### Form Validation
```javascript
app.handleFormSubmit = async function(event) {
    event.preventDefault();

    // Get form values
    const inputValue = document.getElementById('input-id').value.trim();
    const selectValue = document.getElementById('select-id').value;
    const textareaValue = document.getElementById('textarea-id').value.trim();

    // Custom validation
    if (!inputValue) {
        state.error = 'Please enter a value';
        app.render();
        return;
    }

    if (!utils.validateUrl(inputValue)) {
        state.error = 'Please enter a valid URL';
        app.render();
        return;
    }

    // Proceed with submission
    state.loading = true;
    state.error = null;
    app.render();

    // ... API call
};

// Utility validators
var utils = {
    validateEmail: function(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    },
    validateUrl: function(url) {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    },
    escapeHtml: function(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
```

### Input Field Styles
```css
.input-field {
    padding: 1rem 1.25rem;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    font-size: 1rem;
    transition: all 0.2s ease;
}

.input-field:focus {
    border-color: #7c3aed;
    box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.3);
    outline: none;
}

.input-field::placeholder {
    color: rgba(255, 255, 255, 0.4);
}
```

---

## 13. LOADING & ERROR STATES

### Loading States

#### Spinner
```html
<div class="spinner"></div>

<style>
.spinner {
    border: 3px solid rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}
</style>
```

#### Progress Bar with Steps
```javascript
// State
state.loadingProgress = 0;
state.loadingSteps = [
    { name: 'Fetching data', icon: '🔍', status: 'completed' },
    { name: 'Analyzing content', icon: '🧠', status: 'active' },
    { name: 'Generating results', icon: '✨', status: 'pending' }
];

// Render
function renderLoadingProgress() {
    return `
        <div class="loading-container text-center">
            <div class="text-4xl font-bold text-white mb-4">
                ${state.loadingProgress}%
            </div>
            <div class="progress-bar-container bg-white/20 rounded-full h-3 overflow-hidden mb-8">
                <div class="progress-bar-fill bg-gradient-to-r from-indigo-500 to-purple-500 h-full transition-all duration-300"
                     style="width: ${state.loadingProgress}%"></div>
            </div>
            <div class="loading-steps space-y-3">
                ${state.loadingSteps.map(step => `
                    <div class="loading-step flex items-center gap-3 ${step.status}">
                        <span class="step-icon text-2xl ${step.status === 'active' ? 'animate-bounce' : ''}">${step.icon}</span>
                        <span class="text-white/80">${step.name}</span>
                        ${step.status === 'completed' ? '<span class="text-green-400">✓</span>' : ''}
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

// Progress simulation
function simulateProgress() {
    const interval = setInterval(() => {
        if (state.loadingProgress < 30) {
            state.loadingProgress += Math.random() * 5;
        } else if (state.loadingProgress < 90) {
            state.loadingProgress += Math.random() * 2;
        }

        // Update steps based on progress
        if (state.loadingProgress > 30) state.loadingSteps[0].status = 'completed';
        if (state.loadingProgress > 30) state.loadingSteps[1].status = 'active';
        if (state.loadingProgress > 60) state.loadingSteps[1].status = 'completed';
        if (state.loadingProgress > 60) state.loadingSteps[2].status = 'active';

        app.render();

        if (state.loadingProgress >= 90) {
            clearInterval(interval);
        }
    }, 200);
}
```

### Error States

#### Error Alert
```html
${state.error ? `
    <div class="alert-error bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-4">
        ${escapeHtml(state.error)}
    </div>
` : ''}
```

#### Success Alert
```html
${state.success ? `
    <div class="alert-success bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg mb-4">
        ${escapeHtml(state.success)}
    </div>
` : ''}
```

#### Empty State
```html
<div class="empty-state text-center py-12">
    <div class="text-6xl mb-4">📭</div>
    <h3 class="text-xl font-semibold text-white mb-2">No Results Yet</h3>
    <p class="text-white/60 mb-6">Start by optimizing your first video</p>
    <button onclick="app.goToOptimizer()" class="btn-primary">
        Get Started
    </button>
</div>
```

#### Error Handling Pattern
```javascript
app.handleSomething = async function() {
    state.loading = true;
    state.error = null;
    state.success = null;
    app.render();

    try {
        const result = await functions.httpsCallable('someFunction')(data);
        state.someData = result.data;
        state.success = 'Operation completed successfully!';
    } catch (error) {
        console.error('Error:', error);

        // User-friendly error messages
        if (error.code === 'resource-exhausted') {
            state.error = 'You have reached your daily limit. Please upgrade or wait for reset.';
        } else if (error.code === 'unauthenticated') {
            state.error = 'Please log in to continue.';
            state.currentView = 'login';
        } else {
            state.error = error.message || 'Something went wrong. Please try again.';
        }
    }

    state.loading = false;
    app.render();

    // Auto-clear success message
    if (state.success) {
        setTimeout(() => {
            state.success = null;
            app.render();
        }, 5000);
    }
};
```

---

## QUICK REFERENCE

### Adding a New Feature Checklist

1. [ ] Add state variables to `state` object
2. [ ] Create `renderNewFeature()` function
3. [ ] Add case to main `render()` switch
4. [ ] Create `app.goToNewFeature()` navigation method
5. [ ] Create handler functions (`app.handleNewFeature()`)
6. [ ] Add tool card to dashboard
7. [ ] Create Cloud Function in `functions/index.js`
8. [ ] Add Firestore collection and indexes if needed
9. [ ] Update Firestore security rules
10. [ ] Test mobile responsiveness
11. [ ] Deploy: `firebase deploy`

### Common Imports (Frontend)
```html
<!-- Firebase SDKs -->
<script src="https://www.gstatic.com/firebasejs/9.x/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/9.x/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/9.x/firebase-firestore-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/9.x/firebase-functions-compat.js"></script>

<!-- Tailwind CSS -->
<script src="https://cdn.tailwindcss.com"></script>
```

### Deployment Commands
```bash
# Deploy everything
firebase deploy

# Deploy only functions
firebase deploy --only functions

# Deploy only hosting
firebase deploy --only hosting

# Deploy only rules
firebase deploy --only firestore:rules,storage:rules
```

---

**Last Updated**: November 2024
**Project ID**: ytseo-6d1b0
**Main File**: frontend/dual-auth-widget.html (8,305 lines)
**Backend**: functions/index.js (6,004 lines, 50+ Cloud Functions)
