# Video Processor Service for Cloud Run
# Uses FFmpeg for video processing with reliable YouTube downloads

FROM node:20-slim

# Install FFmpeg, Python, git, Chromium (for POT server), and other dependencies
# Including fonts for ASS subtitle rendering (Arial, Impact, etc.)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libass9 \
    fontconfig \
    fonts-freefont-ttf \
    fonts-dejavu-core \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    ca-certificates \
    unzip \
    git \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer to use system Chromium (skip download)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install yt-dlp nightly (more frequent updates for YouTube changes)
# Using --break-system-packages since we're in a container
RUN pip3 install --break-system-packages --upgrade "yt-dlp[default]"

# Install bgutil-ytdlp-pot-provider plugin for yt-dlp
RUN pip3 install --break-system-packages bgutil-ytdlp-pot-provider

# Download and install the POT provider plugin
RUN mkdir -p /root/.config/yt-dlp/plugins && \
    cd /tmp && \
    curl -L -o pot-provider.zip https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/bgutil-ytdlp-pot-provider.zip && \
    unzip pot-provider.zip -d /root/.config/yt-dlp/plugins/ && \
    rm pot-provider.zip

# CRITICAL: Build the POT HTTP Server
# The POT provider needs to run as an HTTP server on port 4416
# Without this, yt-dlp cannot generate proof-of-origin tokens
WORKDIR /app/pot-server
RUN git clone --single-branch --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git . && \
    cd server && \
    npm install && \
    npm install puppeteer-core && \
    npx tsc && \
    mv build ../build && \
    mv node_modules ../node_modules && \
    cd .. && \
    rm -rf server .git

# Create puppeteer config to use system Chromium
RUN echo '{"executablePath":"/usr/bin/chromium","args":["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]}' > /app/pot-server/.puppeteerrc.json

# Verify yt-dlp installation
RUN yt-dlp --version && \
    echo "POT provider plugin installed" && \
    yt-dlp --list-plugins 2>/dev/null || echo "Plugins loaded"

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source code
COPY src/ ./src/

# Copy startup script
COPY start.sh ./
RUN chmod +x start.sh

# Create temp directory for video processing
RUN mkdir -p /tmp/video-processing

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV TEMP_DIR=/tmp/video-processing

# Memory settings for Node.js (prevent OOM)
ENV NODE_OPTIONS="--max-old-space-size=3072"

# Expose port (video processor)
EXPOSE 8080

# Health check with longer intervals and start period for heavy video processing workloads
# - interval: 60s (don't check too frequently during processing)
# - timeout: 30s (give health endpoint time to respond under load)
# - start-period: 30s (allow time for POT server + Node.js to start)
# - retries: 5 (be forgiving during video processing)
HEALTHCHECK --interval=60s --timeout=30s --start-period=30s --retries=5 \
    CMD curl -f http://localhost:8080/health || exit 1

# Run the service using startup script
CMD ["./start.sh"]
