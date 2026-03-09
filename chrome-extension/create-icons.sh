#!/bin/bash
# Script to create simple placeholder icons for the FormStatus Chrome extension
# You can replace these with proper icons later

ICON_DIR="$(dirname "$0")/icons"

# Create icons directory if it doesn't exist
mkdir -p "$ICON_DIR"

# Create a simple SVG icon (you can customize this)
cat > "$ICON_DIR/icon.svg" << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="20" fill="#6366f1"/>
  <path d="M64 32c-17.673 0-32 14.327-32 32s14.327 32 32 32 32-14.327 32-32-14.327-32-32-32zm0 56c-13.255 0-24-10.745-24-24s10.745-24 24-24 24 10.745 24 24-10.745 24-24 24z" fill="white" opacity="0.3"/>
  <path d="M90 64c0 14.36-11.64 26-26 26s-26-11.64-26-26 11.64-26 26-26 26 11.64 26 26zm-4 0c0-12.15-9.85-22-22-22s-22 9.85-22 22 9.85 22 22 22 22-9.85 22-22z" fill="white"/>
  <circle cx="50" cy="58" r="4" fill="white"/>
  <circle cx="78" cy="58" r="4" fill="white"/>
  <path d="M56 72c0 4.418 3.582 8 8 8s8-3.582 8-8" stroke="white" stroke-width="3" fill="none" stroke-linecap="round"/>
</svg>
EOF

echo "SVG icon created at $ICON_DIR/icon.svg"
echo ""
echo "To create PNG icons from the SVG, you can use one of these methods:"
echo ""
echo "1. Using ImageMagick:"
echo "   convert -background none -resize 16x16 icons/icon.svg icons/icon16.png"
echo "   convert -background none -resize 32x32 icons/icon.svg icons/icon32.png"
echo "   convert -background none -resize 48x48 icons/icon.svg icons/icon48.png"
echo "   convert -background none -resize 128x128 icons/icon.svg icons/icon128.png"
echo ""
echo "2. Online tools: https://cloudconvert.com/svg-to-png"
echo ""
echo "3. For now, creating simple colored squares as placeholders..."
echo ""

# Create simple placeholder PNG files using base64
# These are minimal 1x1 colored squares that browsers will scale

# 16x16 blue square (base64)
echo "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVQ4T2nk5uamgAT4gQ4f6KxAHAAX3wFzVYs1IAAAAASUVORK5CYII=" | base64 -d > "$ICON_DIR/icon16.png"

# 32x32
echo "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAFklEQVQ4T2nk5uamgAT4gQ4f6KxAHAAX3wFzVYs1IAAAAASUVORK5CYII=" | base64 -d > "$ICON_DIR/icon32.png"

# 48x48
echo "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAFklEQVQ4T2nk5uamgAT4gQ4f6KxAHAAX3wFzVYs1IAAAAASUVORK5CYII=" | base64 -d > "$ICON_DIR/icon48.png"

# 128x128
echo "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAAFklEQVQ4T2nk5uamgAT4gQ4f6KxAHAAX3wFzVYs1IAAAAASUVORK5CYII=" | base64 -d > "$ICON_DIR/icon128.png"

echo "Placeholder icons created!"
echo ""
echo "Note: These are minimal placeholder icons. For better quality icons,"
echo "please replace them with proper PNG files or use the SVG file with"
echo "an icon converter tool."
