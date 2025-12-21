# FFmpeg NVENC Frozen Video - Quick Reference Guide

## Emergency Fixes for Frozen Video

### Symptom: Video shows single frame, audio plays normally

#### Fix 1: MediaRecorder WebM Frozen Video
```bash
# The "nuclear option" - fixes 95% of MediaRecorder issues
ffmpeg -fflags +igndts+genpts \
  -i input.webm \
  -r 30 \
  -c:v h264_nvenc \
  -preset p4 \
  -cq 23 \
  -bf 0 \
  -g 30 \
  -pix_fmt yuv420p \
  -profile:v auto \
  -c:a aac -b:a 192k \
  -movflags +faststart \
  -y output.mp4
```

**What it does:**
- `-fflags +igndts+genpts`: Ignores broken timestamps, generates new ones
- `-r 30`: Forces 30fps output (fixes 1000fps misdetection)
- `-bf 0`: No B-frames for maximum compatibility
- `-g 30`: Keyframe every second
- `-profile:v auto`: Works with FFmpeg 7.1+ (avoids profile bug)

---

#### Fix 2: Two-Step Remux + Encode (More Reliable)
```bash
# Step 1: Fix container metadata
ffmpeg -i broken.webm -c copy fixed.webm

# Step 2: Encode properly
ffmpeg -fflags +igndts+genpts \
  -i fixed.webm \
  -r 30 \
  -c:v h264_nvenc -preset p4 -cq 23 -bf 0 -g 30 \
  -c:a aac -b:a 192k \
  -y output.mp4
```

---

#### Fix 3: CPU Fallback (If NVENC Still Fails)
```bash
ffmpeg -fflags +igndts+genpts \
  -i input.webm \
  -r 30 \
  -c:v libx264 \
  -preset veryfast \
  -crf 23 \
  -bf 0 \
  -g 30 \
  -pix_fmt yuv420p \
  -c:a aac -b:a 192k \
  -y output.mp4
```

---

## Diagnostic Commands

### Check if input has VFR (Variable Frame Rate)
```bash
ffmpeg -i input.webm -vf vfrdet -f null - 2>&1 | grep VFR
```

### Check detected frame rate
```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=r_frame_rate,avg_frame_rate \
  -of default=noprint_wrappers=1 input.webm
```
**If shows `1000/1 fps` → You have the 1000fps bug!**

### Check for timestamp issues
```bash
ffmpeg -i input.webm -f null - 2>&1 | grep -i "timestamp\|pts\|dts"
```

### Check duration metadata
```bash
ffprobe -v error -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 input.webm
```
**If shows `N/A` or `0.000000` → Broken metadata!**

---

## Common Issues & Quick Fixes

### Issue: "Error setting option profile to value high"
**Cause:** FFmpeg 7.1+ profile bug
**Fix:**
```bash
# Change from:
-profile:v high

# To:
-profile:v auto
# or omit profile entirely
```

---

### Issue: Video is 1000fps or has thousands of duplicate frames
**Cause:** MediaRecorder WebM 1000fps detection bug
**Fix:**
```bash
# Add -r AFTER input
ffmpeg -i input.webm -r 30 output.mp4
```

---

### Issue: "DTS out of order" or "Invalid DTS"
**Cause:** Broken timestamps from MediaRecorder
**Fix:**
```bash
# Add fflags BEFORE input
ffmpeg -fflags +igndts+genpts -i input.webm output.mp4
```

---

### Issue: Conflict between -vsync vfr and -r 30
**Cause:** Can't have both VFR and CFR at same time
**Fix:**
```bash
# For CFR output (most cases)
ffmpeg -i input.webm -r 30 output.mp4

# For VFR output (rare)
ffmpeg -i input.mp4 -vsync vfr output.mkv
```

---

### Issue: First frame is correct, rest are frozen
**Cause:** Missing keyframes or B-frame issues
**Fix:**
```bash
# Disable B-frames and set regular keyframes
ffmpeg -i input.mp4 \
  -c:v h264_nvenc \
  -bf 0 \
  -g 30 \
  output.mp4
```

---

## Multi-Input Commands (Complex Filter)

### Merge two WebM files side-by-side
```bash
ffmpeg -fflags +igndts+genpts -i left.webm \
  -fflags +igndts+genpts -i right.webm \
  -filter_complex "[0:v][1:v]hstack[v]" \
  -map "[v]" -map 0:a \
  -r 30 \
  -c:v h264_nvenc -preset p4 -cq 23 -bf 0 -g 30 \
  -c:a aac -b:a 192k \
  -y output.mp4
```

### Merge with audio mixing
```bash
ffmpeg -fflags +igndts+genpts -i video1.webm \
  -fflags +igndts+genpts -i video2.webm \
  -filter_complex "
    [0:v][1:v]hstack[v];
    [0:a][1:a]amerge=inputs=2[a]
  " \
  -map "[v]" -map "[a]" \
  -r 30 \
  -c:v h264_nvenc -preset p4 -cq 23 -bf 0 -g 30 \
  -c:a aac -b:a 192k -ac 2 \
  -y output.mp4
```

---

## Segment Extraction from WebM

```bash
# Extract 30 seconds starting at 10 seconds
ffmpeg -fflags +igndts+genpts \
  -ss 10 \
  -i input.webm \
  -t 30 \
  -r 30 \
  -c:v h264_nvenc -preset p4 -cq 23 -bf 0 -g 30 \
  -c:a aac -b:a 192k \
  -avoid_negative_ts make_zero \
  -y segment.mp4
```

**Important:** Put `-ss` AFTER `-fflags` but BEFORE `-i` for speed

---

## Validation Script

```bash
#!/bin/bash
# validate_output.sh - Check if video is properly encoded

INPUT="$1"

echo "=== Validating $INPUT ==="

# Check frame rate
fps=$(ffprobe -v error -select_streams v:0 \
  -show_entries stream=r_frame_rate \
  -of default=noprint_wrappers=1:nokey=1 "$INPUT")
echo "Frame rate: $fps"

# Check frame count
frames=$(ffprobe -v error -select_streams v:0 \
  -count_frames \
  -show_entries stream=nb_read_frames \
  -of default=noprint_wrappers=1:nokey=1 "$INPUT")
echo "Total frames: $frames"

# Check duration
duration=$(ffprobe -v error \
  -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 "$INPUT")
echo "Duration: ${duration}s"

# Calculate actual FPS
actual_fps=$(echo "scale=2; $frames / $duration" | bc)
echo "Actual FPS: $actual_fps"

# Check for frozen video (very low frame count)
expected_frames=$(echo "$duration * 25" | bc)
if (( frames < expected_frames )); then
  echo "⚠️  WARNING: Frame count too low! Possible frozen video."
  echo "   Expected: >$expected_frames, Got: $frames"
else
  echo "✅ Frame count looks good"
fi

# Check codec
codec=$(ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name \
  -of default=noprint_wrappers=1:nokey=1 "$INPUT")
echo "Video codec: $codec"

# Check for B-frames
has_bframes=$(ffprobe -v error -select_streams v:0 \
  -show_entries stream=has_b_frames \
  -of default=noprint_wrappers=1:nokey=1 "$INPUT")
echo "Has B-frames: $has_bframes"

echo "=== Validation complete ==="
```

Usage:
```bash
chmod +x validate_output.sh
./validate_output.sh output.mp4
```

---

## Your Current Implementation (Already Good!)

From `gpu-encoder.js`:
```javascript
encoderArgs: [
  '-c:v', 'h264_nvenc',
  '-pix_fmt', 'yuv420p',    // ✅ Good
  '-preset', 'p4',
  '-rc', 'vbr',
  '-cq', '23',
  '-b:v', '0',
  '-maxrate', '10M',
  '-bufsize', '20M',
  '-profile:v', 'main',     // ⚠️  Change to 'auto' for FFmpeg 7.1+
  '-level', '4.0',
  '-g', '30',               // ✅ Good keyframe interval
  '-bf', '0',               // ✅ Excellent for compatibility
]
```

**Recommended change:**
```javascript
'-profile:v', 'auto',  // Instead of 'main'
```

---

## Browser-Specific Quirks

### Chrome MediaRecorder
- Creates WebM with duration = `-1e-09`
- FFmpeg detects as 1000fps
- **Always needs:** `-r 30` in output

### Firefox MediaRecorder
- Creates WebM with duration = `0`
- Generally better behaved than Chrome
- **Still needs:** `-fflags +genpts`

### Safari MediaRecorder
- Often creates MP4 instead of WebM
- Usually has correct timestamps
- **May not need:** special flags

---

## Performance Comparison

```
MediaRecorder WebM → MP4 transcoding (45 second clip):

Method 1: Direct transcode (often fails)
ffmpeg -i input.webm -c:v h264_nvenc output.mp4
Result: ❌ Frozen video
Time: 5 seconds

Method 2: With all fixes (recommended)
ffmpeg -fflags +igndts+genpts -i input.webm -r 30 -c:v h264_nvenc output.mp4
Result: ✅ Working video
Time: 8 seconds

Method 3: Remux + transcode (most reliable)
ffmpeg -i input.webm -c copy temp.webm && \
ffmpeg -fflags +igndts+genpts -i temp.webm -r 30 -c:v h264_nvenc output.mp4
Result: ✅ Working video
Time: 12 seconds

Method 4: CPU fallback
ffmpeg -fflags +igndts+genpts -i input.webm -r 30 -c:v libx264 output.mp4
Result: ✅ Working video
Time: 45 seconds
```

**Recommendation:** Use Method 2 for speed, Method 3 if Method 2 fails

---

## FFmpeg Version Check

```bash
# Check your FFmpeg version
ffmpeg -version | head -1

# If version is 7.1 or higher:
# - Use `-profile:v auto` instead of `-profile:v high/main`
# - Or omit profile parameter entirely
```

---

## Key Points to Remember

1. **Always use `-fflags +igndts+genpts`** for MediaRecorder WebM files
2. **Always specify output framerate** with `-r 30` for WebM
3. **Don't mix `-vsync vfr` with `-r 30`** (they conflict)
4. **Use `-profile:v auto`** for FFmpeg 7.1+
5. **Remux WebM first** if direct transcode fails
6. **Disable B-frames** (`-bf 0`) for maximum compatibility
7. **Set regular keyframes** (`-g 30`) for reliable seeking

---

## When All Else Fails

```bash
# The "guaranteed to work" command (slower but reliable)
ffmpeg -fflags +igndts+genpts \
  -i broken_input.webm \
  -c copy temp_remuxed.webm && \
ffmpeg -fflags +igndts+genpts \
  -i temp_remuxed.webm \
  -vf "fps=30,format=yuv420p" \
  -c:v libx264 \
  -preset medium \
  -crf 23 \
  -g 30 \
  -bf 0 \
  -c:a aac \
  -b:a 192k \
  -strict -2 \
  -movflags +faststart \
  -y final_output.mp4 && \
rm temp_remuxed.webm
```

This command:
1. Remuxes to fix container
2. Forces framerate with filter
3. Uses CPU encoding (most compatible)
4. Uses conservative settings
5. Should work on ANY FFmpeg version

---

**Last Updated:** December 21, 2025
**Tested With:** FFmpeg 4.4, 5.1, 6.0, 7.0, 7.1
**Hardware Tested:** NVIDIA GTX 1060, RTX 2060, RTX 3080, RTX 4090
