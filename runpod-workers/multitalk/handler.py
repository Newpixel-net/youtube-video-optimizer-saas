"""
Multitalk RunPod Worker Handler

This handler processes video generation requests using the Multitalk ComfyUI workflow.
It downloads image/audio files, runs the workflow, and uploads the result to a presigned URL.

Key improvements over previous version:
- Download validation with status code checking
- Detailed error messages for debugging
- Workflow execution error detection
- Better logging throughout the process
"""

import runpod
import os
import time
import json
import requests
import random
import imghdr
from pathlib import Path


def validate_image_file(file_path):
    """Validate that the file is a valid image."""
    try:
        # Check file exists and has content
        if not os.path.exists(file_path):
            return False, "File does not exist"

        file_size = os.path.getsize(file_path)
        if file_size < 100:  # Too small to be a valid image
            return False, f"File too small ({file_size} bytes), likely an error response"

        # Check if it's a valid image format
        img_type = imghdr.what(file_path)
        if img_type is None:
            # Try reading first bytes to check for HTML error pages
            with open(file_path, 'rb') as f:
                header = f.read(100)
                if b'<!DOCTYPE' in header or b'<html' in header or b'<?xml' in header:
                    return False, "File contains HTML/XML (likely an error page)"
                if b'"error"' in header or b'"message"' in header:
                    return False, "File contains JSON error response"
            return False, "File is not a valid image format"

        return True, f"Valid {img_type} image ({file_size} bytes)"
    except Exception as e:
        return False, f"Validation error: {str(e)}"


def validate_audio_file(file_path):
    """Validate that the file is a valid audio file."""
    try:
        # Check file exists and has content
        if not os.path.exists(file_path):
            return False, "File does not exist"

        file_size = os.path.getsize(file_path)
        if file_size < 100:  # Too small to be a valid audio
            return False, f"File too small ({file_size} bytes), likely an error response"

        # Check for common audio file signatures
        with open(file_path, 'rb') as f:
            header = f.read(12)

            # Check for HTML error pages
            if b'<!DOCTYPE' in header or b'<html' in header:
                return False, "File contains HTML (likely an error page)"

            # MP3 signatures
            if header[:3] == b'ID3' or header[:2] == b'\xff\xfb' or header[:2] == b'\xff\xfa':
                return True, f"Valid MP3 audio ({file_size} bytes)"

            # WAV signature
            if header[:4] == b'RIFF' and header[8:12] == b'WAVE':
                return True, f"Valid WAV audio ({file_size} bytes)"

            # OGG signature
            if header[:4] == b'OggS':
                return True, f"Valid OGG audio ({file_size} bytes)"

            # M4A/AAC signature
            if header[4:8] == b'ftyp':
                return True, f"Valid M4A/AAC audio ({file_size} bytes)"

            # If file is large enough, assume it might be valid audio
            if file_size > 10000:
                return True, f"Assumed valid audio ({file_size} bytes)"

            return False, f"Unknown audio format (header: {header[:8].hex()})"
    except Exception as e:
        return False, f"Validation error: {str(e)}"


def upload_file(file_path, pre_signed_url):
    """Upload a file to the presigned URL with proper error handling."""
    try:
        if not os.path.exists(file_path):
            return False, f"File not found: {file_path}"

        file_size = os.path.getsize(file_path)
        print(f"runpod-worker-comfy - Uploading {file_path} ({file_size} bytes)")

        with open(file_path, 'rb') as file:
            headers = {
                'Content-Type': 'application/octet-stream'
            }
            response = requests.put(pre_signed_url, data=file, headers=headers, timeout=300)

        if response.status_code == 200:
            print(f"runpod-worker-comfy - Upload successful!")
            return True, "Upload successful"
        else:
            error_msg = f"Upload failed with status {response.status_code}: {response.text[:500]}"
            print(f"runpod-worker-comfy - {error_msg}")
            return False, error_msg
    except requests.exceptions.Timeout:
        return False, "Upload timed out after 300 seconds"
    except Exception as e:
        return False, f"Upload exception: {str(e)}"


def download_file(url, save_name):
    """Download a file with proper validation and error handling."""
    try:
        print(f"runpod-worker-comfy - Downloading from: {url[:100]}...")

        response = requests.get(url, timeout=120)

        # Check for HTTP errors
        if response.status_code != 200:
            return False, f"Download failed with HTTP {response.status_code}: {response.text[:200]}"

        # Check content type for obvious errors
        content_type = response.headers.get('Content-Type', '')
        if 'text/html' in content_type or 'application/json' in content_type:
            # Could be an error page - check content
            if len(response.content) < 10000:  # Small response, likely error
                try:
                    error_content = response.content.decode('utf-8', errors='ignore')[:500]
                    if 'error' in error_content.lower() or 'denied' in error_content.lower():
                        return False, f"URL returned error page: {error_content[:200]}"
                except:
                    pass

        # Check we got actual content
        if len(response.content) < 100:
            return False, f"Downloaded content too small ({len(response.content)} bytes)"

        save_path = f"input/{save_name}"

        # Ensure input directory exists
        os.makedirs("input", exist_ok=True)

        with open(save_path, 'wb') as f:
            f.write(response.content)

        print(f"runpod-worker-comfy - Saved to {save_path} ({len(response.content)} bytes)")
        return True, save_path

    except requests.exceptions.Timeout:
        return False, "Download timed out after 120 seconds"
    except requests.exceptions.RequestException as e:
        return False, f"Download request error: {str(e)}"
    except Exception as e:
        return False, f"Download exception: {str(e)}"


def generate_random_seed():
    """Generate a random seed for the workflow."""
    return random.randint(10**15, 10**16 - 1)


def check_server(url, retries=50, delay=500):
    """Check if the ComfyUI server is reachable."""
    for i in range(retries):
        try:
            response = requests.get(url, timeout=5)
            if response.status_code == 200:
                print(f"runpod-worker-comfy - API is reachable")
                return True
        except requests.RequestException:
            pass
        time.sleep(delay / 1000)

    print(f"runpod-worker-comfy - Failed to connect to server at {url} after {retries} attempts.")
    return False


def poll_result(url, prompt_id, node_id, timeout=600):
    """
    Poll for workflow completion with proper error handling.

    Returns:
        tuple: (success, result_or_error)
        - On success: (True, filename)
        - On failure: (False, error_message)
    """
    start_time = time.time()

    while time.time() - start_time < timeout:
        try:
            # Check execution queue for errors
            queue_response = requests.get(f"{url}/queue", timeout=10)
            if queue_response.status_code == 200:
                queue_data = queue_response.json()
                # Check if our prompt is in the running queue
                running = queue_data.get('queue_running', [])
                pending = queue_data.get('queue_pending', [])

                # Log queue status periodically
                if int(time.time() - start_time) % 30 == 0:
                    print(f"runpod-worker-comfy - Queue: {len(running)} running, {len(pending)} pending")

            # Check history for completion
            history_response = requests.get(f"{url}/history", timeout=10)
            if history_response.status_code != 200:
                time.sleep(2)
                continue

            history = history_response.json()

            if prompt_id in history:
                prompt_result = history[prompt_id]

                # Check for execution errors
                if 'status' in prompt_result:
                    status = prompt_result['status']
                    if status.get('status_str') == 'error':
                        # Extract error details
                        messages = status.get('messages', [])
                        error_details = []
                        for msg in messages:
                            if isinstance(msg, list) and len(msg) >= 2:
                                if msg[0] == 'execution_error':
                                    error_info = msg[1]
                                    node_type = error_info.get('node_type', 'Unknown')
                                    exception_message = error_info.get('exception_message', 'Unknown error')
                                    error_details.append(f"{node_type}: {exception_message}")

                        if error_details:
                            return False, f"Workflow execution error: {'; '.join(error_details)}"
                        return False, "Workflow execution failed with unknown error"

                # Check for outputs
                outputs = prompt_result.get('outputs', {})
                node_output = outputs.get(str(node_id), {})

                if 'gifs' in node_output and len(node_output['gifs']) > 0:
                    filename = node_output['gifs'][0]['filename']
                    print(f"runpod-worker-comfy - Workflow completed, output: {filename}")
                    return True, filename

                # Check if other nodes have errors that prevented our node from running
                if not outputs:
                    return False, "Workflow completed but produced no outputs"

                # Node hasn't produced output yet but workflow is in history
                # This shouldn't happen normally, but handle it
                available_nodes = list(outputs.keys())
                return False, f"Node {node_id} has no output. Available outputs from nodes: {available_nodes}"

            time.sleep(2)

        except requests.exceptions.RequestException as e:
            print(f"runpod-worker-comfy - Poll error: {str(e)}, retrying...")
            time.sleep(5)
        except Exception as e:
            return False, f"Poll exception: {str(e)}"

    return False, f"Workflow timed out after {timeout} seconds"


def handler(job):
    """Main handler for Multitalk video generation."""
    try:
        job_input = job.get('input', {})

        # Log job start
        print(f"runpod-worker-comfy - Starting job with {len(job_input)} parameters")

        # Validate required parameters
        required_params = [
            "image_url", "audio_url", "video_upload_url",
            "audio_crop_start_time", "audio_crop_end_time",
            "positive_prompt", "negative_prompt",
            "aspect_ratio", "scale_to_length", "scale_to_side",
            "fps", "num_frames",
            "embeds_audio_scale", "embeds_cfg_audio_scale",
            "embeds_multi_audio_type", "embeds_normalize_loudness",
            "steps", "seed", "scheduler"
        ]

        missing_params = [p for p in required_params if p not in job_input]
        if missing_params:
            return {"status": 400, "message": f"Missing required parameters: {', '.join(missing_params)}"}

        # Extract parameters
        image_url = job_input["image_url"]
        audio_url = job_input["audio_url"]
        video_upload_url = job_input["video_upload_url"]

        audio_crop_start_time = job_input["audio_crop_start_time"]
        audio_crop_end_time = job_input["audio_crop_end_time"]
        positive_prompt = job_input["positive_prompt"]
        negative_prompt = job_input["negative_prompt"]
        aspect_ratio = job_input["aspect_ratio"]
        scale_to_side = job_input["scale_to_side"]
        scale_to_length = int(job_input["scale_to_length"])
        fps = float(job_input["fps"])
        num_frames = int(job_input["num_frames"])
        steps = int(job_input["steps"])
        seed = int(job_input["seed"])
        scheduler = job_input["scheduler"]
        embeds_audio_scale = float(job_input["embeds_audio_scale"])
        embeds_cfg_audio_scale = float(job_input["embeds_cfg_audio_scale"])
        embeds_multi_audio_type = job_input["embeds_multi_audio_type"]
        embeds_normalize_loudness = bool(job_input["embeds_normalize_loudness"])

        # Generate random seed if requested
        seed = generate_random_seed() if seed == -1 else seed
        print(f"runpod-worker-comfy - Using seed: {seed}")
        print(f"runpod-worker-comfy - Frames: {num_frames}, FPS: {fps}, Duration: {num_frames/fps:.1f}s")

        # Download image with validation
        image_name = f"input_image_{generate_random_seed()}.png"
        success, result = download_file(image_url, image_name)
        if not success:
            return {"status": 500, "message": f"Image download failed: {result}"}

        image_path = result
        valid, validation_msg = validate_image_file(image_path)
        if not valid:
            return {"status": 500, "message": f"Image validation failed: {validation_msg}"}
        print(f"runpod-worker-comfy - Image validated: {validation_msg}")

        # Download audio with validation
        audio_name = f"input_audio_{generate_random_seed()}.mp3"
        success, result = download_file(audio_url, audio_name)
        if not success:
            return {"status": 500, "message": f"Audio download failed: {result}"}

        audio_path = result
        valid, validation_msg = validate_audio_file(audio_path)
        if not valid:
            return {"status": 500, "message": f"Audio validation failed: {validation_msg}"}
        print(f"runpod-worker-comfy - Audio validated: {validation_msg}")

        # Load workflow
        workflow_path = 'multitalk_api.json'
        if not os.path.exists(workflow_path):
            return {"status": 500, "message": f"Workflow file not found: {workflow_path}"}

        with open(workflow_path, 'r') as file:
            workflow = json.load(file)

        # Set workflow values
        workflow["218"]["inputs"]["image"] = image_name
        workflow["219"]["inputs"]["audio"] = audio_name

        workflow["223"]["inputs"]["start_time"] = audio_crop_start_time
        workflow["223"]["inputs"]["end_time"] = audio_crop_end_time

        workflow["135"]["inputs"]["positive_prompt"] = positive_prompt
        workflow["135"]["inputs"]["negative_prompt"] = negative_prompt

        workflow["233"]["inputs"]["aspect_ratio"] = aspect_ratio
        workflow["233"]["inputs"]["scale_to_side"] = scale_to_side
        workflow["233"]["inputs"]["scale_to_length"] = scale_to_length

        workflow["224"]["inputs"]["audio_scale"] = embeds_audio_scale
        workflow["224"]["inputs"]["audio_cfg_scale"] = embeds_cfg_audio_scale
        workflow["224"]["inputs"]["multi_audio_type"] = embeds_multi_audio_type
        workflow["224"]["inputs"]["normalize_loudness"] = embeds_normalize_loudness

        workflow["198"]["inputs"]["seed"] = seed
        workflow["198"]["inputs"]["steps"] = steps
        workflow["198"]["inputs"]["scheduler"] = scheduler

        workflow["226"]["inputs"]["value"] = fps
        workflow["228"]["inputs"]["value"] = num_frames

        print(f"runpod-worker-comfy - Workflow configured")

        # Check ComfyUI server
        comfy_url = "http://127.0.0.1:8188"
        if not check_server(comfy_url):
            return {"status": 500, "message": "ComfyUI server not reachable"}

        # Submit workflow
        prompt_data = {"prompt": workflow}
        response = requests.post(
            f"{comfy_url}/prompt",
            json=prompt_data,
            headers={'Content-Type': 'application/json'},
            timeout=30
        )

        if response.status_code != 200:
            return {"status": 500, "message": f"Failed to submit workflow: HTTP {response.status_code}"}

        response_data = response.json()
        if 'prompt_id' not in response_data:
            error_info = response_data.get('error', response_data.get('node_errors', 'Unknown error'))
            return {"status": 500, "message": f"Workflow rejected: {error_info}"}

        prompt_id = response_data["prompt_id"]
        print(f"runpod-worker-comfy - Workflow submitted, prompt_id: {prompt_id}")

        # Poll for result
        success, result = poll_result(url=comfy_url, prompt_id=prompt_id, node_id=221)

        if not success:
            return {"status": 500, "message": f"Workflow failed: {result}"}

        video_name = result
        video_path = f"output/{video_name}"

        # Verify output file exists
        if not os.path.exists(video_path):
            return {"status": 500, "message": f"Output video not found at {video_path}"}

        video_size = os.path.getsize(video_path)
        print(f"runpod-worker-comfy - Video generated: {video_path} ({video_size} bytes)")

        # Upload to presigned URL
        success, result = upload_file(video_path, video_upload_url)
        if not success:
            return {"status": 500, "message": f"Video upload failed: {result}"}

        print(f"runpod-worker-comfy - Job completed successfully")
        return {
            "status": 200,
            "message": "Video created successfully",
            "payload": {
                "video_size": video_size,
                "num_frames": num_frames,
                "duration": num_frames / fps
            }
        }

    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()
        print(f"runpod-worker-comfy - Exception: {error_trace}")
        return {"status": 500, "message": f"Handler exception: {str(e)}"}


# Start the RunPod serverless worker
runpod.serverless.start({"handler": handler})
