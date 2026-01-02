# Multitalk RunPod Worker

This worker handles video generation using the Multitalk ComfyUI workflow for lip-sync video creation.

## Improvements in This Version

The handler has been updated with:

1. **Download Validation** - Verifies HTTP status codes and file content before processing
2. **File Validation** - Checks that downloaded images/audio are valid formats (not error pages)
3. **Workflow Error Detection** - Checks ComfyUI execution queue for errors
4. **Detailed Error Messages** - Returns specific error information for debugging
5. **Better Logging** - Logs progress throughout the generation process

## Error Codes

| Status | Meaning |
|--------|---------|
| 200 | Success - video generated and uploaded |
| 400 | Missing required parameters |
| 500 | Processing error (see message for details) |

## Common Error Messages

- `Image download failed: HTTP 403` - Image URL expired or access denied
- `Image validation failed: File contains HTML` - URL returned error page instead of image
- `Audio download failed: ...` - Similar issues with audio URL
- `Workflow execution error: ...` - ComfyUI workflow failed (includes node details)
- `Video upload failed: ...` - Failed to upload to presigned URL

## Deployment

1. Copy `handler.py` and `multitalk_api.json` to your RunPod worker
2. Ensure the ComfyUI server is running on port 8188
3. Deploy the worker to your RunPod endpoint

## Required Input Parameters

```json
{
  "image_url": "https://...",
  "audio_url": "https://...",
  "video_upload_url": "https://presigned-upload-url...",
  "audio_crop_start_time": "0:00",
  "audio_crop_end_time": "0:10",
  "positive_prompt": "...",
  "negative_prompt": "...",
  "aspect_ratio": "16:9",
  "scale_to_length": 1280,
  "scale_to_side": "None",
  "fps": 16,
  "num_frames": 160,
  "embeds_audio_scale": 1.0,
  "embeds_cfg_audio_scale": 2.0,
  "embeds_multi_audio_type": "para",
  "embeds_normalize_loudness": true,
  "steps": 4,
  "seed": -1,
  "scheduler": "lcm"
}
```

## Testing

To test the handler locally:

```python
test_job = {
    "input": {
        "image_url": "https://your-test-image.png",
        "audio_url": "https://your-test-audio.mp3",
        "video_upload_url": "https://your-presigned-url",
        # ... other params
    }
}

result = handler(test_job)
print(result)
```
