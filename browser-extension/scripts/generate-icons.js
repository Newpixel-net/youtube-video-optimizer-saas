/**
 * Generate PNG icons from SVG
 * Run with: node scripts/generate-icons.js
 *
 * Requires: npm install sharp
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, '..', 'icons');

// Ensure icons directory exists
if (!existsSync(iconsDir)) {
  mkdirSync(iconsDir, { recursive: true });
}

// Icon sizes needed for Chrome extension
const sizes = [16, 32, 48, 128];

// SVG template for icon
const createSvg = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgGradient" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#ec4899"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#bgGradient)"/>
  <path d="M52 40L88 64L52 88V40Z" fill="white"/>
  <circle cx="100" cy="28" r="8" fill="white" opacity="0.9"/>
  <circle cx="108" cy="20" r="4" fill="white" opacity="0.7"/>
</svg>`;

async function generateIcons() {
  try {
    // Try to use sharp if available
    const sharp = await import('sharp');

    for (const size of sizes) {
      const svg = createSvg(size);
      const outputPath = join(iconsDir, `icon${size}.png`);

      await sharp.default(Buffer.from(svg))
        .resize(size, size)
        .png()
        .toFile(outputPath);

      console.log(`Generated: icon${size}.png`);
    }

    console.log('All icons generated successfully!');

  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      console.log('Sharp not installed. Creating SVG placeholders instead.');
      console.log('To generate PNG icons, run: npm install sharp && node scripts/generate-icons.js');

      // Write SVG files as fallback
      for (const size of sizes) {
        const svg = createSvg(size);
        writeFileSync(join(iconsDir, `icon${size}.svg`), svg);
        console.log(`Created SVG: icon${size}.svg`);
      }

      console.log('\nNote: Chrome requires PNG icons. Convert SVGs to PNGs using:');
      console.log('- Online converter: https://svgtopng.com/');
      console.log('- Or install sharp: npm install sharp');

    } else {
      console.error('Error generating icons:', error);
    }
  }
}

generateIcons();
