#!/bin/bash
# Startup script for Video Processor Service
# Starts the POT provider HTTP server, then the Node.js application
# Includes graceful shutdown handling and health monitoring

set -e

echo "=== Video Processor Service Starting ==="
echo "Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# Configure Puppeteer to use system Chromium
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

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

# Function to check and restart POT server if needed
check_pot_server() {
    if [ -n "$POT_PID" ] && ! kill -0 $POT_PID 2>/dev/null; then
        echo "WARNING: POT server crashed, restarting..."
        cd /app/pot-server
        node build/main.js --port 4416 2>&1 &
        POT_PID=$!
        sleep 3
        if kill -0 $POT_PID 2>/dev/null; then
            echo "POT server restarted successfully (PID: $POT_PID)"
        else
            echo "ERROR: POT server failed to restart"
        fi
    fi
}

# Log system resources
echo "System resources:"
echo "  Memory: $(free -m | awk '/^Mem:/ {print $2}') MB total"
echo "  CPU cores: $(nproc)"
echo "  Disk space: $(df -h /tmp | awk 'NR==2 {print $4}') available"

echo ""
echo "Starting POT provider HTTP server on port 4416..."
echo "Using Chromium at: $PUPPETEER_EXECUTABLE_PATH"

# Start the POT provider HTTP server in background
# This is REQUIRED for yt-dlp to bypass YouTube's bot detection
cd /app/pot-server

# Start with explicit error output and memory limit
node --max-old-space-size=512 build/main.js --port 4416 2>&1 &
POT_PID=$!

# Give POT server more time to start (Chromium initialization takes time)
echo "Waiting for POT server to initialize..."
sleep 5

# Check if POT server started
if ! kill -0 $POT_PID 2>/dev/null; then
    echo "WARNING: POT provider failed to start. YouTube downloads may fail."
    echo "Continuing anyway - Video Download API will be used as primary method."
else
    echo "POT provider started successfully (PID: $POT_PID)"
    # Verify it's responding
    for i in {1..5}; do
        if curl -s http://localhost:4416/ping > /dev/null 2>&1; then
            echo "POT provider HTTP endpoint verified"
            break
        fi
        echo "POT endpoint not ready yet, waiting... (attempt $i/5)"
        sleep 2
    done
fi

# Start the main video processor service
echo ""
echo "Starting Video Processor Service on port ${PORT:-8080}..."
echo "Node.js memory limit: ${NODE_OPTIONS}"
cd /app

# Run Node.js app in background so we can monitor it
node src/index.js &
NODE_PID=$!

echo "Video Processor started (PID: $NODE_PID)"
echo "=== Service startup complete ==="
echo ""

# Health monitoring loop
# Checks POT server health and memory usage periodically
HEALTH_CHECK_INTERVAL=60
LAST_CHECK=$(date +%s)

while true; do
    # Wait for any child process to exit or timeout
    sleep $HEALTH_CHECK_INTERVAL &
    wait $! 2>/dev/null || true

    # Check if main Node process is still running
    if ! kill -0 $NODE_PID 2>/dev/null; then
        echo "ERROR: Video Processor exited unexpectedly"
        cleanup
    fi

    # Periodic health check
    NOW=$(date +%s)
    if [ $((NOW - LAST_CHECK)) -ge $HEALTH_CHECK_INTERVAL ]; then
        LAST_CHECK=$NOW

        # Check memory usage
        MEM_USED=$(free -m | awk '/^Mem:/ {print $3}')
        MEM_TOTAL=$(free -m | awk '/^Mem:/ {print $2}')
        MEM_PERCENT=$((MEM_USED * 100 / MEM_TOTAL))

        if [ $MEM_PERCENT -gt 85 ]; then
            echo "WARNING: High memory usage: ${MEM_PERCENT}% (${MEM_USED}/${MEM_TOTAL} MB)"
        fi

        # Check and potentially restart POT server
        check_pot_server
    fi
done
