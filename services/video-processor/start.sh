#!/bin/bash
# Startup script for Video Processor Service
# Starts the Node.js application FIRST (for health checks), then POT provider
# Includes graceful shutdown handling and health monitoring

set -e

echo "=== Video Processor Service Starting ==="
echo "Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# Configure Puppeteer to use system Chromium
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Additional Chrome flags for running in container
export CHROME_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu"

# Memory settings for Node.js (prevent OOM kills)
export NODE_OPTIONS="--max-old-space-size=3072"

# Track PIDs for cleanup
POT_PID=""
NODE_PID=""

# Graceful shutdown handler
cleanup() {
    echo ""
    echo "=== Graceful shutdown initiated ==="
    echo "Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

    # Stop Node.js app first (let it finish current request if possible)
    if [ -n "$NODE_PID" ] && kill -0 $NODE_PID 2>/dev/null; then
        echo "Stopping Node.js application (PID: $NODE_PID)..."
        kill -SIGTERM $NODE_PID 2>/dev/null || true
        # Wait up to 30s for graceful shutdown
        for i in {1..30}; do
            if ! kill -0 $NODE_PID 2>/dev/null; then
                break
            fi
            sleep 1
        done
        # Force kill if still running
        kill -SIGKILL $NODE_PID 2>/dev/null || true
    fi

    # Stop POT server
    if [ -n "$POT_PID" ] && kill -0 $POT_PID 2>/dev/null; then
        echo "Stopping POT provider (PID: $POT_PID)..."
        kill -SIGTERM $POT_PID 2>/dev/null || true
        sleep 2
        kill -SIGKILL $POT_PID 2>/dev/null || true
    fi

    echo "Shutdown complete"
    exit 0
}

# Register signal handlers
trap cleanup SIGTERM SIGINT SIGHUP

# Log system resources
echo "System resources:"
echo "  Memory: $(free -m | awk '/^Mem:/ {print $2}') MB total"
echo "  CPU cores: $(nproc)"
echo "  Disk space: $(df -h /tmp | awk 'NR==2 {print $4}') available"

# CRITICAL: Start the main video processor service FIRST
# This ensures Cloud Run health checks pass quickly
echo ""
echo "Starting Video Processor Service on port ${PORT:-8080}..."
cd /app

# Run Node.js app in background
node src/index.js &
NODE_PID=$!

echo "Video Processor started (PID: $NODE_PID)"

# Wait for Node.js to be ready (quick check)
for i in {1..10}; do
    if curl -s http://localhost:${PORT:-8080}/health > /dev/null 2>&1; then
        echo "Video Processor health check passed"
        break
    fi
    sleep 1
done

# NOW start POT server in background (after main app is ready)
echo ""
echo "Starting POT provider HTTP server on port 4416..."
cd /app/pot-server

# Start with explicit error output and memory limit
node --max-old-space-size=512 build/main.js --port 4416 2>&1 &
POT_PID=$!

echo "POT provider starting in background (PID: $POT_PID)"
echo "=== Service startup complete ==="
echo ""

# Health monitoring loop
HEALTH_CHECK_INTERVAL=60

while true; do
    sleep $HEALTH_CHECK_INTERVAL &
    wait $! 2>/dev/null || true

    # Check if main Node process is still running
    if ! kill -0 $NODE_PID 2>/dev/null; then
        echo "ERROR: Video Processor exited unexpectedly"
        cleanup
    fi

    # Check and log POT server status
    if [ -n "$POT_PID" ] && ! kill -0 $POT_PID 2>/dev/null; then
        echo "WARNING: POT server not running, restarting..."
        cd /app/pot-server
        node --max-old-space-size=512 build/main.js --port 4416 2>&1 &
        POT_PID=$!
        sleep 3
    fi
done
