/**
 * GPU Encoder Utilities
 *
 * Provides GPU detection and FFmpeg encoding parameters for NVENC acceleration.
 * Falls back to CPU encoding (libx264) when GPU is not available.
 *
 * Performance comparison:
 * - GPU (NVENC h264_nvenc): ~15-30 seconds per 45-second clip
 * - CPU (libx264 veryfast): ~2-5 minutes per 45-second clip
 */

import { execSync } from 'child_process';

// Cache GPU availability to avoid repeated checks
let gpuAvailable = null;
let gpuCheckError = null;

/**
 * Check if NVIDIA GPU and NVENC are available
 * @returns {boolean} True if GPU encoding is available
 */
export function isGpuAvailable() {
  // Return cached result if already checked
  if (gpuAvailable !== null) {
    return gpuAvailable;
  }

  // Check environment variable first (set by Cloud Run or deploy.sh)
  const gpuEnv = process.env.GPU_ENABLED;

  // If explicitly disabled, return false
  if (gpuEnv === 'false') {
    console.log('[GPU] GPU disabled via environment variable');
    gpuAvailable = false;
    return false;
  }

  // CLOUD RUN GPU MODE: If GPU_ENABLED=true, trust it and skip hardware checks
  // Cloud Run GPU instances have GPU available but nvidia-smi may not work during cold start
  // The actual NVENC encoding will fail gracefully if GPU isn't available
  if (gpuEnv === 'true') {
    console.log('[GPU] GPU_ENABLED=true - assuming GPU available (Cloud Run GPU mode)');
    console.log('[GPU] ✓ GPU acceleration enabled - will use h264_nvenc');
    gpuAvailable = true;
    return true;
  }

  // AUTO MODE: Run hardware checks
  try {
    // Method 1: Check if nvidia-smi is available (indicates NVIDIA driver is installed)
    try {
      const nvidiaSmi = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
        encoding: 'utf8',
        timeout: 5000
      }).trim();
      console.log(`[GPU] NVIDIA GPU detected: ${nvidiaSmi}`);
    } catch (e) {
      console.log('[GPU] nvidia-smi not available, GPU likely not present');
      gpuAvailable = false;
      gpuCheckError = 'nvidia-smi not found';
      return false;
    }

    // Method 2: Test actual NVENC encoding capability
    try {
      const result = execSync('ffmpeg -f lavfi -i color=c=black:s=64x64:d=0.1 -c:v h264_nvenc -f null - 2>&1', {
        timeout: 15000,
        encoding: 'utf8'
      });
      console.log('[GPU] NVENC encoding test successful');
    } catch (e) {
      const errorOutput = e.stdout || e.stderr || e.message || 'Unknown error';
      console.log('[GPU] NVENC encoding test failed:', errorOutput.substring(0, 200));
      gpuCheckError = 'NVENC encoding test failed';
      gpuAvailable = false;
      return false;
    }

    gpuAvailable = true;
    console.log('[GPU] ✓ GPU acceleration enabled - using h264_nvenc');
    return true;

  } catch (error) {
    console.error('[GPU] Error checking GPU availability:', error.message);
    gpuAvailable = false;
    gpuCheckError = error.message;
    return false;
  }
}

/**
 * Get encoding parameters based on GPU availability
 * @param {Object} options Encoding options
 * @param {string} options.quality - 'high', 'medium', 'low' (default: 'medium')
 * @param {boolean} options.forceGpu - Force GPU check even if cached (default: false)
 * @returns {Object} FFmpeg encoding parameters
 */
export function getEncodingParams(options = {}) {
  const { quality = 'medium', forceGpu = false } = options;

  // Reset cache if force check requested
  if (forceGpu) {
    gpuAvailable = null;
  }

  const useGpu = isGpuAvailable();

  if (useGpu) {
    return getGpuEncodingParams(quality);
  } else {
    return getCpuEncodingParams(quality);
  }
}

/**
 * Get GPU (NVENC) encoding parameters
 * @param {string} quality - 'high', 'medium', 'low'
 * @returns {Object} GPU encoding parameters
 */
function getGpuEncodingParams(quality) {
  // NVENC quality presets:
  // - p1 (fastest) to p7 (highest quality)
  // - For real-time streaming, p1-p3 is recommended
  // - For offline encoding, p4-p7 is better

  const qualityPresets = {
    high: {
      preset: 'p5',  // High quality preset
      cq: 20,        // Constant quality (lower = better quality)
      bitrate: null  // Use CQ mode for quality
    },
    medium: {
      preset: 'p4',  // Balanced preset
      cq: 23,        // Good balance of quality and size
      bitrate: null
    },
    low: {
      preset: 'p2',  // Fast preset
      cq: 28,        // Lower quality, smaller file
      bitrate: null
    }
  };

  const preset = qualityPresets[quality] || qualityPresets.medium;

  return {
    type: 'gpu',
    encoder: 'h264_nvenc',
    encoderArgs: [
      '-pix_fmt', 'yuv420p',  // CRITICAL: Ensure compatible pixel format for all players
      '-c:v', 'h264_nvenc',
      '-preset', preset.preset,
      '-rc', 'vbr',           // Variable bitrate mode
      '-cq', preset.cq.toString(),  // Constant quality value
      '-b:v', '0',            // Let CQ control bitrate
      '-maxrate', '10M',      // Cap maximum bitrate
      '-bufsize', '20M',      // Buffer size for rate control
      '-profile:v', 'high',   // H.264 High Profile for better compression
      '-level', '4.1',        // Compatibility level
      '-g', '30',             // Keyframe every 30 frames (1 sec at 30fps)
      '-bf', '0',             // Disable B-frames for maximum compatibility
      '-strict_gop', '1',     // NVENC: Enforce strict GOP structure
      '-forced-idr', '1',     // NVENC: Force IDR frames at keyframe positions
      '-spatial-aq', '1',     // Spatial adaptive quantization (better quality)
      '-temporal-aq', '1',    // Temporal adaptive quantization
      '-fps_mode', 'cfr',     // Force constant frame rate (fixes VFR input from MediaRecorder)
    ],
    audioEncoder: 'aac',
    audioArgs: [
      '-c:a', 'aac',
      '-b:a', '128k'
    ],
    // Note: hwaccel removed - let FFmpeg handle GPU memory automatically
    // Using explicit hwaccel with filter chains can cause issues
    hwaccel: [],
    description: `GPU (NVENC) - ${quality} quality`
  };
}

/**
 * Get CPU (libx264) encoding parameters
 * @param {string} quality - 'high', 'medium', 'low'
 * @returns {Object} CPU encoding parameters
 */
function getCpuEncodingParams(quality) {
  const qualityPresets = {
    high: {
      preset: 'medium',  // Better quality, slower
      crf: 20
    },
    medium: {
      preset: 'veryfast', // Balanced
      crf: 23
    },
    low: {
      preset: 'ultrafast', // Fastest
      crf: 28
    }
  };

  const preset = qualityPresets[quality] || qualityPresets.medium;

  return {
    type: 'cpu',
    encoder: 'libx264',
    encoderArgs: [
      '-c:v', 'libx264',
      '-preset', preset.preset,
      '-crf', preset.crf.toString(),
      '-threads', '0',  // Auto-detect thread count
    ],
    audioEncoder: 'aac',
    audioArgs: [
      '-c:a', 'aac',
      '-b:a', '128k'
    ],
    hwaccel: [],  // No hardware acceleration
    description: `CPU (libx264) - ${quality} quality`
  };
}

/**
 * Get FFmpeg video filter chain for GPU or CPU processing
 * @param {Object} options Filter options
 * @param {boolean} options.useGpu - Whether to use GPU filters
 * @param {number} options.targetWidth - Target output width
 * @param {number} options.targetHeight - Target output height
 * @returns {Object} Filter configuration
 */
export function getVideoFilters(options = {}) {
  const { useGpu, targetWidth = 1080, targetHeight = 1920 } = options;

  // Note: For complex filter graphs with crop/overlay, we typically use CPU filters
  // as they are more flexible. GPU filters (scale_cuda, etc.) are better for simple
  // scaling operations but have limited support for complex filter chains.

  // Current approach: Use GPU for encoding only, CPU for filters
  // This provides best compatibility while still getting 10-20x speed improvement

  return {
    // Standard CPU filters work with both GPU and CPU encoding
    scale: `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase`,
    crop: `crop=${targetWidth}:${targetHeight}`,
    setsar: 'setsar=1',

    // For future GPU filter support (requires CUDA filter graph)
    // scaleGpu: `scale_cuda=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase`,
    // overlayGpu: 'overlay_cuda=...',
  };
}

/**
 * Build FFmpeg args for video encoding
 * @param {Object} params Build parameters
 * @param {string} params.inputFile - Input video file path
 * @param {string} params.outputFile - Output video file path
 * @param {string} params.videoFilter - Video filter string
 * @param {string} params.audioFilter - Audio filter string
 * @param {number} params.fps - Target FPS
 * @param {string} params.quality - Encoding quality preset
 * @returns {string[]} FFmpeg arguments array
 */
export function buildEncodingArgs(params) {
  const { inputFile, outputFile, videoFilter, audioFilter, fps = 30, quality = 'medium' } = params;

  const encoding = getEncodingParams({ quality });
  const args = [];

  // Input file with hardware acceleration if GPU
  if (encoding.type === 'gpu' && encoding.hwaccel.length > 0) {
    // For now, skip hwaccel input as it can cause compatibility issues
    // with complex filter chains. The encoding itself will still use GPU.
    // args.push(...encoding.hwaccel);
  }
  args.push('-i', inputFile);

  // Video filter
  if (videoFilter) {
    args.push('-vf', videoFilter);
  }

  // Audio filter
  if (audioFilter) {
    args.push('-af', audioFilter);
  }

  // Encoding parameters
  args.push(...encoding.encoderArgs);
  args.push(...encoding.audioArgs);

  // Output settings
  args.push(
    '-r', fps.toString(),
    '-movflags', '+faststart',
    '-y',  // Overwrite output
    outputFile
  );

  console.log(`[GPU] Using ${encoding.description}`);
  console.log(`[GPU] FFmpeg args: ${args.slice(0, 10).join(' ')}...`);

  return args;
}

/**
 * Get GPU status information for health checks and debugging
 * @returns {Object} GPU status information
 */
export function getGpuStatus() {
  const available = isGpuAvailable();

  let gpuInfo = null;
  if (available) {
    try {
      gpuInfo = execSync('nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader', {
        encoding: 'utf8',
        timeout: 5000
      }).trim();
    } catch (e) {
      gpuInfo = 'Unable to query GPU info';
    }
  }

  return {
    available,
    error: gpuCheckError,
    info: gpuInfo,
    encoder: available ? 'h264_nvenc' : 'libx264',
    expectedSpeed: available ? '15-30 seconds per clip' : '2-5 minutes per clip'
  };
}

export default {
  isGpuAvailable,
  getEncodingParams,
  getVideoFilters,
  buildEncodingArgs,
  getGpuStatus
};
