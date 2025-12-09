#!/bin/bash
# Startup script for Video Processor Service
# Starts the POT provider HTTP server, then the Node.js application

set -e

echo "=== Video Processor Service Starting ==="

# Configure Puppeteer to use system Chromium
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Additional Chrome flags for running in container
export CHROME_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu"

echo "Starting POT provider HTTP server on port 4416..."
echo "Using Chromium at: $PUPPETEER_EXECUTABLE_PATH"

# Start the POT provider HTTP server in background
# This is REQUIRED for yt-dlp to bypass YouTube's bot detection
cd /app/pot-server

# Start with explicit error output
node build/main.js --port 4416 2>&1 &
POT_PID=$!

# Give POT server more time to start (Chromium initialization takes time)
sleep 5

# Check if POT server started
if ! kill -0 $POT_PID 2>/dev/null; then
    echo "WARNING: POT provider failed to start. YouTube downloads may fail."
    echo "Checking for errors..."
else
    echo "POT provider started successfully (PID: $POT_PID)"
    # Verify it's responding
    if curl -s http://localhost:4416/ping > /dev/null 2>&1; then
        echo "POT provider HTTP endpoint verified"
    else
        echo "POT provider running but HTTP endpoint not responding yet"
    fi
fi

# Start the main video processor service
echo "Starting Video Processor Service on port ${PORT:-8080}..."
cd /app

# Run Node.js app
exec node src/index.js
