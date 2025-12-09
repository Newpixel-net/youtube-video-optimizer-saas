#!/bin/bash
# Startup script for Video Processor Service
# Starts the POT provider HTTP server, then the Node.js application

set -e

echo "=== Video Processor Service Starting ==="
echo "Starting POT provider HTTP server on port 4416..."

# Start the POT provider HTTP server in background
# This is REQUIRED for yt-dlp to bypass YouTube's bot detection
cd /app/pot-server
node build/main.js --port 4416 &
POT_PID=$!

# Give POT server time to start
sleep 2

# Check if POT server started
if ! kill -0 $POT_PID 2>/dev/null; then
    echo "WARNING: POT provider failed to start. YouTube downloads may fail."
else
    echo "POT provider started successfully (PID: $POT_PID)"
fi

# Start the main video processor service
echo "Starting Video Processor Service on port ${PORT:-8080}..."
cd /app

# Run Node.js app
exec node src/index.js
