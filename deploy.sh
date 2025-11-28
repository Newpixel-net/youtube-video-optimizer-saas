#!/bin/bash

# YouTube Ads Tool - Quick Deployment Script
# This script guides you through deploying the Firebase Functions

echo "════════════════════════════════════════════════════════"
echo "   YouTube Ads Tool - Firebase Functions Deployment"
echo "════════════════════════════════════════════════════════"
echo ""

# Check if Firebase CLI is installed
if ! command -v firebase &> /dev/null
then
    echo "❌ Firebase CLI not found!"
    echo "Install it with: npm install -g firebase-tools"
    exit 1
fi

echo "✅ Firebase CLI found"
echo ""

# Check if logged in to Firebase
echo "Checking Firebase authentication..."
firebase login:list &> /dev/null
if [ $? -ne 0 ]; then
    echo "🔑 Logging in to Firebase..."
    firebase login
fi

echo "✅ Authenticated with Firebase"
echo ""

# Navigate to functions directory
cd functions

# Install dependencies
echo "📦 Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

echo "✅ Dependencies installed"
echo ""

# Go back to root
cd ..

# Check if Firebase project is initialized
if [ ! -f ".firebaserc" ]; then
    echo "🎯 Initializing Firebase project..."
    firebase init
else
    echo "✅ Firebase project already initialized"
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo "   API Keys Configuration"
echo "════════════════════════════════════════════════════════"
echo ""
echo "You need to set two API keys:"
echo ""
echo "1️⃣  OpenAI API Key"
echo "   Get from: https://platform.openai.com/api-keys"
echo ""
echo "2️⃣  YouTube Data API Key"
echo "   Get from: https://console.cloud.google.com/apis/credentials"
echo ""

read -p "Press ENTER when you have both API keys ready..."

echo ""
echo "Setting OpenAI API Key..."
read -p "Paste your OpenAI API key (starts with sk-): " OPENAI_KEY
firebase functions:config:set openai.key="$OPENAI_KEY"

echo ""
echo "Setting YouTube API Key..."
read -p "Paste your YouTube Data API key: " YOUTUBE_KEY
firebase functions:config:set youtube.key="$YOUTUBE_KEY"

echo ""
echo "✅ API keys configured"
echo ""

# Verify configuration
echo "Verifying configuration..."
firebase functions:config:get
echo ""

# Deploy Firestore rules
echo "════════════════════════════════════════════════════════"
echo "   Deploying Firestore Rules & Indexes"
echo "════════════════════════════════════════════════════════"
echo ""
firebase deploy --only firestore:rules,firestore:indexes

# Deploy functions
echo ""
echo "════════════════════════════════════════════════════════"
echo "   Deploying Cloud Functions"
echo "════════════════════════════════════════════════════════"
echo ""
echo "This may take 2-5 minutes..."
echo ""

firebase deploy --only functions

if [ $? -eq 0 ]; then
    echo ""
    echo "════════════════════════════════════════════════════════"
    echo "   ✅ DEPLOYMENT SUCCESSFUL!"
    echo "════════════════════════════════════════════════════════"
    echo ""
    echo "Your functions are now live! 🎉"
    echo ""
    echo "Deployed functions:"
    echo "  • analyzeVideo"
    echo "  • generateComments"
    echo "  • optimizeCampaign"
    echo "  • analyzeCompetitors"
    echo "  • searchHistory"
    echo "  • saveAnalysis"
    echo "  • deleteAnalysis"
    echo ""
    echo "Next steps:"
    echo "1. Test your functions (optional): node test-deployment.js"
    echo "2. Start building the frontend widget"
    echo ""
    echo "View your functions:"
    echo "firebase console"
    echo ""
else
    echo ""
    echo "════════════════════════════════════════════════════════"
    echo "   ❌ DEPLOYMENT FAILED"
    echo "════════════════════════════════════════════════════════"
    echo ""
    echo "Check the error messages above and try again."
    echo ""
fi
