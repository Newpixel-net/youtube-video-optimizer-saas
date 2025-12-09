# Video Processor Service for Cloud Run
# Uses FFmpeg for video processing with reliable YouTube downloads

FROM node:20-slim

# Install FFmpeg, Python, git, and other dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    ca-certificates \
    unzip \
    git \
    && rm -rf /var/lib/apt/lists/*

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
    npx tsc && \
    mv build ../build && \
    mv node_modules ../node_modules && \
    cd .. && \
    rm -rf server .git

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

# Expose port (video processor)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Run the service using startup script
CMD ["./start.sh"]
