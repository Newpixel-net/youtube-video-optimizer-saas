#!/bin/bash

# Generate PNG icons from SVG using ImageMagick (convert) or Inkscape
# Run from browser-extension directory: ./scripts/create-icons.sh

SCRIPT_DIR="$(dirname "$0")"
ICONS_DIR="$SCRIPT_DIR/../icons"

# SVG source
SVG_FILE="$ICONS_DIR/icon.svg"

# Sizes needed for Chrome extension
SIZES=(16 32 48 128)

echo "Generating PNG icons..."

# Check if ImageMagick is available
if command -v convert &> /dev/null; then
    for size in "${SIZES[@]}"; do
        convert -background none -resize ${size}x${size} "$SVG_FILE" "$ICONS_DIR/icon${size}.png"
        echo "Generated: icon${size}.png"
    done
    echo "Done! Icons generated successfully."

# Check if Inkscape is available
elif command -v inkscape &> /dev/null; then
    for size in "${SIZES[@]}"; do
        inkscape -w $size -h $size "$SVG_FILE" -o "$ICONS_DIR/icon${size}.png"
        echo "Generated: icon${size}.png"
    done
    echo "Done! Icons generated successfully."

# Check if rsvg-convert is available
elif command -v rsvg-convert &> /dev/null; then
    for size in "${SIZES[@]}"; do
        rsvg-convert -w $size -h $size "$SVG_FILE" -o "$ICONS_DIR/icon${size}.png"
        echo "Generated: icon${size}.png"
    done
    echo "Done! Icons generated successfully."

else
    echo "No SVG converter found. Please install one of the following:"
    echo "  - ImageMagick: sudo apt install imagemagick"
    echo "  - Inkscape: sudo apt install inkscape"
    echo "  - librsvg: sudo apt install librsvg2-bin"
    echo ""
    echo "Or convert the SVG manually using an online tool:"
    echo "  https://svgtopng.com/"
    echo ""
    echo "SVG file location: $SVG_FILE"
    exit 1
fi
