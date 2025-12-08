/**
 * Generate simple PNG icons without external dependencies
 * Uses raw PNG format with minimal compression
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { deflateSync } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, '..', 'icons');

// Ensure icons directory exists
if (!existsSync(iconsDir)) {
  mkdirSync(iconsDir, { recursive: true });
}

// Icon sizes
const sizes = [16, 32, 48, 128];

// Colors (gradient approximation)
const topColor = { r: 236, g: 72, b: 153 };    // #ec4899
const bottomColor = { r: 139, g: 92, b: 246 }; // #8b5cf6
const white = { r: 255, g: 255, b: 255 };

/**
 * Interpolate between two colors
 */
function interpolateColor(c1, c2, t) {
  return {
    r: Math.round(c1.r + (c2.r - c1.r) * t),
    g: Math.round(c1.g + (c2.g - c1.g) * t),
    b: Math.round(c1.b + (c2.b - c1.b) * t)
  };
}

/**
 * Create image data with gradient background and play button
 */
function createImageData(size) {
  const data = new Uint8Array(size * size * 4);

  const cornerRadius = Math.round(size * 0.22); // Rounded corners

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Check if pixel is within rounded rectangle
      const inRect = isInRoundedRect(x, y, size, size, cornerRadius);

      if (!inRect) {
        // Transparent
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 0;
        continue;
      }

      // Gradient based on diagonal position
      const t = (x + y) / (2 * size);
      const bgColor = interpolateColor(topColor, bottomColor, t);

      // Check if inside play button triangle
      const inPlay = isInPlayButton(x, y, size);

      // Check if inside sparkle (small white circle)
      const inSparkle = isInSparkle(x, y, size);

      if (inPlay || inSparkle) {
        // White
        data[i] = white.r;
        data[i + 1] = white.g;
        data[i + 2] = white.b;
        data[i + 3] = 255;
      } else {
        // Gradient background
        data[i] = bgColor.r;
        data[i + 1] = bgColor.g;
        data[i + 2] = bgColor.b;
        data[i + 3] = 255;
      }
    }
  }

  return data;
}

/**
 * Check if point is inside rounded rectangle
 */
function isInRoundedRect(x, y, width, height, radius) {
  // Check corners
  if (x < radius && y < radius) {
    // Top-left corner
    const dx = x - radius;
    const dy = y - radius;
    return dx * dx + dy * dy <= radius * radius;
  }
  if (x >= width - radius && y < radius) {
    // Top-right corner
    const dx = x - (width - radius - 1);
    const dy = y - radius;
    return dx * dx + dy * dy <= radius * radius;
  }
  if (x < radius && y >= height - radius) {
    // Bottom-left corner
    const dx = x - radius;
    const dy = y - (height - radius - 1);
    return dx * dx + dy * dy <= radius * radius;
  }
  if (x >= width - radius && y >= height - radius) {
    // Bottom-right corner
    const dx = x - (width - radius - 1);
    const dy = y - (height - radius - 1);
    return dx * dx + dy * dy <= radius * radius;
  }

  return true;
}

/**
 * Check if point is inside play button triangle
 * Triangle vertices (normalized 0-1): (0.4, 0.3), (0.4, 0.7), (0.7, 0.5)
 */
function isInPlayButton(x, y, size) {
  const nx = x / size;
  const ny = y / size;

  // Triangle vertices
  const x1 = 0.4, y1 = 0.3;
  const x2 = 0.4, y2 = 0.7;
  const x3 = 0.7, y3 = 0.5;

  // Barycentric coordinates
  const denom = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
  const a = ((y2 - y3) * (nx - x3) + (x3 - x2) * (ny - y3)) / denom;
  const b = ((y3 - y1) * (nx - x3) + (x1 - x3) * (ny - y3)) / denom;
  const c = 1 - a - b;

  return a >= 0 && b >= 0 && c >= 0;
}

/**
 * Check if point is inside sparkle circles
 */
function isInSparkle(x, y, size) {
  const nx = x / size;
  const ny = y / size;

  // Main sparkle circle
  const cx1 = 0.78, cy1 = 0.22, r1 = 0.06;
  const dist1 = Math.sqrt((nx - cx1) ** 2 + (ny - cy1) ** 2);
  if (dist1 <= r1) return true;

  // Small sparkle circle
  const cx2 = 0.84, cy2 = 0.16, r2 = 0.03;
  const dist2 = Math.sqrt((nx - cx2) ** 2 + (ny - cy2) ** 2);
  if (dist2 <= r2) return true;

  return false;
}

/**
 * Create PNG file buffer
 */
function createPNG(width, height, rgba) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8);   // bit depth
  ihdrData.writeUInt8(6, 9);   // color type (RGBA)
  ihdrData.writeUInt8(0, 10);  // compression
  ihdrData.writeUInt8(0, 11);  // filter
  ihdrData.writeUInt8(0, 12);  // interlace
  const ihdr = createChunk('IHDR', ihdrData);

  // IDAT chunk (compressed image data)
  // Add filter byte (0 = no filter) before each row
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter byte
    for (let x = 0; x < width * 4; x++) {
      rawData[y * (1 + width * 4) + 1 + x] = rgba[y * width * 4 + x];
    }
  }
  const compressed = deflateSync(rawData, { level: 9 });
  const idat = createChunk('IDAT', compressed);

  // IEND chunk
  const iend = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

/**
 * Create PNG chunk with CRC
 */
function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type);
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcData);

  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc >>> 0, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

/**
 * CRC32 calculation for PNG
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = crc ^ buffer[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xedb88320;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return crc ^ 0xffffffff;
}

/**
 * Generate all icons
 */
function generateIcons() {
  console.log('Generating PNG icons...');

  for (const size of sizes) {
    const rgba = createImageData(size);
    const png = createPNG(size, size, rgba);
    const filename = join(iconsDir, `icon${size}.png`);
    writeFileSync(filename, png);
    console.log(`Generated: icon${size}.png (${size}x${size})`);
  }

  console.log('Done! All icons generated successfully.');
}

generateIcons();
