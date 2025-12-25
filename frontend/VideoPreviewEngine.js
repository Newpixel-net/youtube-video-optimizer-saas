/**
 * VideoPreviewEngine - Client-side video preview compositor
 *
 * Renders scenes to a canvas with synchronized audio, transitions,
 * Ken Burns effects, and caption overlays.
 *
 * Usage:
 *   const engine = new VideoPreviewEngine(canvasElement, {
 *       width: 1280,
 *       height: 720,
 *       onTimeUpdate: (time) => {},
 *       onSceneChange: (sceneIndex) => {},
 *       onEnded: () => {}
 *   });
 *
 *   engine.loadScenes(scenesArray);
 *   engine.play();
 */

class VideoPreviewEngine {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // Dimensions
        this.width = options.width || 1280;
        this.height = options.height || 720;
        canvas.width = this.width;
        canvas.height = this.height;

        // State
        this.scenes = [];
        this.currentTime = 0;
        this.isPlaying = false;
        this.isSeeking = false;
        this.totalDuration = 0;
        this.currentSceneIndex = -1;

        // Audio
        this.audioElements = new Map(); // sceneId -> HTMLAudioElement
        this.musicElement = null;
        this.musicVolume = 0.3;
        this.voiceVolume = 1.0;

        // Media cache
        this.imageCache = new Map(); // url -> HTMLImageElement
        this.videoCache = new Map(); // url -> HTMLVideoElement

        // Animation
        this.animationFrameId = null;
        this.lastFrameTime = 0;

        // Callbacks
        this.onTimeUpdate = options.onTimeUpdate || (() => {});
        this.onSceneChange = options.onSceneChange || (() => {});
        this.onEnded = options.onEnded || (() => {});
        this.onLoadProgress = options.onLoadProgress || (() => {});
        this.onReady = options.onReady || (() => {});

        // Captions
        this.captionsEnabled = true;
        this.captionStyle = 'subtitle'; // 'subtitle' | 'karaoke' | 'dynamic'
        this.captionPosition = 'bottom'; // 'top' | 'center' | 'bottom'

        // Bind methods
        this._renderLoop = this._renderLoop.bind(this);
    }

    /**
     * Load scenes into the engine
     * @param {Array} scenes - Array of scene objects
     */
    async loadScenes(scenes) {
        this.scenes = scenes.map((scene, index) => ({
            ...scene,
            index,
            startTime: 0, // Will be calculated
            endTime: 0    // Will be calculated
        }));

        // Calculate timing
        this._calculateTiming();

        // Preload media
        await this._preloadMedia();

        // Render first frame
        this._renderFrame();

        this.onReady();
    }

    /**
     * Calculate start/end times for each scene
     */
    _calculateTiming() {
        let currentTime = 0;

        for (const scene of this.scenes) {
            scene.startTime = currentTime;
            scene.endTime = currentTime + (scene.visualDuration || scene.duration || 5);
            currentTime = scene.endTime;
        }

        this.totalDuration = currentTime;
    }

    /**
     * Preload all media (images, videos, audio)
     */
    async _preloadMedia() {
        const loadPromises = [];
        let loaded = 0;
        const total = this.scenes.length * 2; // image + audio per scene

        for (const scene of this.scenes) {
            // Load image
            if (scene.imageUrl && !scene.videoUrl) {
                loadPromises.push(
                    this._loadImage(scene.imageUrl).then(() => {
                        loaded++;
                        this.onLoadProgress(loaded / total);
                    })
                );
            }

            // Load video (for animated or stock video scenes)
            if (scene.videoUrl) {
                loadPromises.push(
                    this._loadVideo(scene.videoUrl).then(() => {
                        loaded++;
                        this.onLoadProgress(loaded / total);
                    })
                );
            }

            // Load voiceover audio
            if (scene.voiceoverUrl) {
                loadPromises.push(
                    this._loadAudio(scene.id, scene.voiceoverUrl).then(() => {
                        loaded++;
                        this.onLoadProgress(loaded / total);
                    })
                );
            }
        }

        await Promise.all(loadPromises);
    }

    /**
     * Load and cache an image
     */
    _loadImage(url) {
        return new Promise((resolve, reject) => {
            if (this.imageCache.has(url)) {
                resolve(this.imageCache.get(url));
                return;
            }

            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                this.imageCache.set(url, img);
                resolve(img);
            };
            img.onerror = () => {
                console.warn('Failed to load image:', url);
                resolve(null); // Don't reject, just continue
            };
            img.src = url;
        });
    }

    /**
     * Load and cache a video element
     */
    _loadVideo(url) {
        return new Promise((resolve, reject) => {
            if (this.videoCache.has(url)) {
                resolve(this.videoCache.get(url));
                return;
            }

            const video = document.createElement('video');
            video.crossOrigin = 'anonymous';
            video.muted = true; // Mute video, we use separate audio track
            video.playsInline = true;
            video.preload = 'auto';

            video.onloadeddata = () => {
                this.videoCache.set(url, video);
                resolve(video);
            };
            video.onerror = () => {
                console.warn('Failed to load video:', url);
                resolve(null);
            };
            video.src = url;
            video.load();
        });
    }

    /**
     * Load and cache audio element
     */
    _loadAudio(sceneId, url) {
        return new Promise((resolve, reject) => {
            if (this.audioElements.has(sceneId)) {
                resolve(this.audioElements.get(sceneId));
                return;
            }

            const audio = new Audio();
            audio.crossOrigin = 'anonymous';
            audio.preload = 'auto';

            audio.oncanplaythrough = () => {
                this.audioElements.set(sceneId, audio);
                resolve(audio);
            };
            audio.onerror = () => {
                console.warn('Failed to load audio:', url);
                resolve(null);
            };
            audio.src = url;
            audio.load();
        });
    }

    /**
     * Set background music
     */
    setBackgroundMusic(url, volume = 0.3) {
        if (this.musicElement) {
            this.musicElement.pause();
            this.musicElement = null;
        }

        if (url) {
            this.musicElement = new Audio(url);
            this.musicElement.loop = true;
            this.musicElement.volume = volume;
            this.musicVolume = volume;
        }
    }

    /**
     * Start playback
     */
    play() {
        if (this.isPlaying) return;

        this.isPlaying = true;
        this.lastFrameTime = performance.now();

        // Start music if available
        if (this.musicElement) {
            this.musicElement.currentTime = this.currentTime;
            this.musicElement.play().catch(() => {});
        }

        // Start voiceover for current scene
        this._syncAudio();

        // Start render loop
        this.animationFrameId = requestAnimationFrame(this._renderLoop);
    }

    /**
     * Pause playback
     */
    pause() {
        this.isPlaying = false;

        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }

        // Pause all audio
        this.audioElements.forEach(audio => audio.pause());
        if (this.musicElement) this.musicElement.pause();
    }

    /**
     * Stop playback and reset to beginning
     */
    stop() {
        this.pause();
        this.seek(0);
    }

    /**
     * Seek to specific time
     */
    seek(time) {
        this.isSeeking = true;
        this.currentTime = Math.max(0, Math.min(time, this.totalDuration));

        // Sync audio
        this._syncAudio();

        // Sync music
        if (this.musicElement) {
            this.musicElement.currentTime = this.currentTime;
        }

        // Render frame at new position
        this._renderFrame();

        this.onTimeUpdate(this.currentTime);
        this.isSeeking = false;
    }

    /**
     * Jump to specific scene
     */
    jumpToScene(sceneIndex) {
        const scene = this.scenes[sceneIndex];
        if (scene) {
            this.seek(scene.startTime);
        }
    }

    /**
     * Sync audio to current time
     */
    _syncAudio() {
        const currentScene = this._getSceneAtTime(this.currentTime);

        // Pause all audio first
        this.audioElements.forEach((audio, sceneId) => {
            if (!currentScene || sceneId !== currentScene.id) {
                audio.pause();
            }
        });

        // Play current scene's voiceover
        if (currentScene) {
            const audio = this.audioElements.get(currentScene.id);
            if (audio) {
                const sceneLocalTime = this.currentTime - currentScene.startTime;
                const voiceoverOffset = currentScene.voiceoverOffset || 0;
                const audioTime = sceneLocalTime - voiceoverOffset;

                if (audioTime >= 0 && audioTime < audio.duration) {
                    audio.currentTime = audioTime;
                    audio.volume = this.voiceVolume;
                    if (this.isPlaying) {
                        audio.play().catch(() => {});
                    }
                } else {
                    audio.pause();
                }
            }
        }
    }

    /**
     * Main render loop
     */
    _renderLoop(timestamp) {
        if (!this.isPlaying) return;

        // Calculate delta time
        const deltaTime = (timestamp - this.lastFrameTime) / 1000;
        this.lastFrameTime = timestamp;

        // Advance time
        this.currentTime += deltaTime;

        // Check if ended
        if (this.currentTime >= this.totalDuration) {
            this.currentTime = this.totalDuration;
            this.pause();
            this.onEnded();
            return;
        }

        // Render current frame
        this._renderFrame();

        // Update audio sync periodically
        if (Math.floor(this.currentTime * 2) !== Math.floor((this.currentTime - deltaTime) * 2)) {
            this._syncAudio();
        }

        // Notify time update
        this.onTimeUpdate(this.currentTime);

        // Continue loop
        this.animationFrameId = requestAnimationFrame(this._renderLoop);
    }

    /**
     * Render a single frame
     */
    _renderFrame() {
        // Clear canvas
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, this.width, this.height);

        // Get current scene(s)
        const currentScene = this._getSceneAtTime(this.currentTime);
        const prevScene = this._getPreviousScene(currentScene);

        if (!currentScene) return;

        // Check if we're in a transition
        const transitionProgress = this._getTransitionProgress(currentScene);

        if (transitionProgress !== null && prevScene) {
            // Render transition between scenes
            this._renderTransition(prevScene, currentScene, transitionProgress);
        } else {
            // Render single scene
            this._renderScene(currentScene);
        }

        // Render captions
        if (this.captionsEnabled && currentScene.caption) {
            this._renderCaption(currentScene);
        }

        // Update current scene index
        if (currentScene.index !== this.currentSceneIndex) {
            this.currentSceneIndex = currentScene.index;
            this.onSceneChange(this.currentSceneIndex);
        }
    }

    /**
     * Get scene at specific time
     */
    _getSceneAtTime(time) {
        return this.scenes.find(scene =>
            time >= scene.startTime && time < scene.endTime
        ) || this.scenes[this.scenes.length - 1];
    }

    /**
     * Get previous scene
     */
    _getPreviousScene(currentScene) {
        if (!currentScene || currentScene.index === 0) return null;
        return this.scenes[currentScene.index - 1];
    }

    /**
     * Calculate transition progress (0-1) or null if not in transition
     */
    _getTransitionProgress(scene) {
        if (!scene || scene.index === 0) return null;

        const transitionDuration = scene.transitionDuration || 0.5;
        const timeIntoScene = this.currentTime - scene.startTime;

        if (timeIntoScene < transitionDuration) {
            return timeIntoScene / transitionDuration;
        }

        return null;
    }

    /**
     * Render a single scene
     */
    _renderScene(scene, opacity = 1) {
        this.ctx.save();
        this.ctx.globalAlpha = opacity;

        // Check if scene has video or image
        if (scene.videoUrl && this.videoCache.has(scene.videoUrl)) {
            this._renderVideoScene(scene);
        } else if (scene.imageUrl) {
            this._renderImageScene(scene);
        } else {
            // Render placeholder
            this._renderPlaceholder(scene);
        }

        this.ctx.restore();
    }

    /**
     * Render scene with video
     */
    _renderVideoScene(scene) {
        const video = this.videoCache.get(scene.videoUrl);
        if (!video) return;

        // Calculate scene-local time
        const sceneLocalTime = this.currentTime - scene.startTime;

        // Sync video position
        if (Math.abs(video.currentTime - sceneLocalTime) > 0.2) {
            video.currentTime = sceneLocalTime;
        }

        // Play/pause based on engine state
        if (this.isPlaying && video.paused) {
            video.play().catch(() => {});
        } else if (!this.isPlaying && !video.paused) {
            video.pause();
        }

        // Draw video to canvas (cover fit)
        this._drawMediaCover(video, video.videoWidth, video.videoHeight);
    }

    /**
     * Render scene with image (with Ken Burns effect)
     */
    _renderImageScene(scene) {
        const img = this.imageCache.get(scene.imageUrl);
        if (!img) {
            this._renderPlaceholder(scene);
            return;
        }

        // Calculate Ken Burns effect
        const progress = (this.currentTime - scene.startTime) / (scene.endTime - scene.startTime);
        const kenBurns = scene.kenBurns || {
            startZoom: 1.0,
            endZoom: 1.15,
            startX: 0.5,
            startY: 0.5,
            endX: 0.5,
            endY: 0.5
        };

        // Interpolate zoom and position
        const zoom = kenBurns.startZoom + (kenBurns.endZoom - kenBurns.startZoom) * progress;
        const panX = (kenBurns.startX || 0.5) + ((kenBurns.endX || 0.5) - (kenBurns.startX || 0.5)) * progress;
        const panY = (kenBurns.startY || 0.5) + ((kenBurns.endY || 0.5) - (kenBurns.startY || 0.5)) * progress;

        // Apply transform and draw
        this.ctx.save();
        this.ctx.translate(this.width / 2, this.height / 2);
        this.ctx.scale(zoom, zoom);
        this.ctx.translate(
            -this.width / 2 + (panX - 0.5) * this.width * 0.1,
            -this.height / 2 + (panY - 0.5) * this.height * 0.1
        );

        this._drawMediaCover(img, img.width, img.height);
        this.ctx.restore();
    }

    /**
     * Draw media with cover fit (fills canvas, crops excess)
     */
    _drawMediaCover(media, mediaWidth, mediaHeight) {
        const canvasRatio = this.width / this.height;
        const mediaRatio = mediaWidth / mediaHeight;

        let drawWidth, drawHeight, offsetX, offsetY;

        if (mediaRatio > canvasRatio) {
            // Media is wider - fit height, crop width
            drawHeight = this.height;
            drawWidth = this.height * mediaRatio;
            offsetX = (this.width - drawWidth) / 2;
            offsetY = 0;
        } else {
            // Media is taller - fit width, crop height
            drawWidth = this.width;
            drawHeight = this.width / mediaRatio;
            offsetX = 0;
            offsetY = (this.height - drawHeight) / 2;
        }

        this.ctx.drawImage(media, offsetX, offsetY, drawWidth, drawHeight);
    }

    /**
     * Render placeholder for missing media
     */
    _renderPlaceholder(scene) {
        // Dark background
        this.ctx.fillStyle = '#1a1a2e';
        this.ctx.fillRect(0, 0, this.width, this.height);

        // Scene number
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        this.ctx.font = 'bold 48px system-ui';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(`Scene ${scene.index + 1}`, this.width / 2, this.height / 2);
    }

    /**
     * Render transition between two scenes
     */
    _renderTransition(fromScene, toScene, progress) {
        const transition = toScene.transition || 'cut';

        switch (transition) {
            case 'fade':
                this._renderFadeTransition(fromScene, toScene, progress);
                break;
            case 'slide':
                this._renderSlideTransition(fromScene, toScene, progress);
                break;
            case 'zoom':
                this._renderZoomTransition(fromScene, toScene, progress);
                break;
            case 'cut':
            default:
                // For cut, just show the new scene
                this._renderScene(toScene);
                break;
        }
    }

    /**
     * Fade transition
     */
    _renderFadeTransition(fromScene, toScene, progress) {
        // Render previous scene
        this._renderScene(fromScene, 1 - progress);

        // Render current scene on top with increasing opacity
        this._renderScene(toScene, progress);
    }

    /**
     * Slide transition
     */
    _renderSlideTransition(fromScene, toScene, progress) {
        const easeProgress = this._easeInOutCubic(progress);
        const offset = this.width * (1 - easeProgress);

        // Draw previous scene sliding out
        this.ctx.save();
        this.ctx.translate(-offset, 0);
        this._renderScene(fromScene);
        this.ctx.restore();

        // Draw current scene sliding in
        this.ctx.save();
        this.ctx.translate(this.width - offset, 0);
        this._renderScene(toScene);
        this.ctx.restore();
    }

    /**
     * Zoom transition
     */
    _renderZoomTransition(fromScene, toScene, progress) {
        const easeProgress = this._easeInOutCubic(progress);

        // Previous scene zooms in and fades out
        this.ctx.save();
        this.ctx.globalAlpha = 1 - easeProgress;
        this.ctx.translate(this.width / 2, this.height / 2);
        this.ctx.scale(1 + easeProgress * 0.3, 1 + easeProgress * 0.3);
        this.ctx.translate(-this.width / 2, -this.height / 2);
        this._renderScene(fromScene, 1);
        this.ctx.restore();

        // Current scene fades in
        this._renderScene(toScene, easeProgress);
    }

    /**
     * Easing function
     */
    _easeInOutCubic(t) {
        return t < 0.5
            ? 4 * t * t * t
            : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    /**
     * Render caption overlay
     */
    _renderCaption(scene) {
        const caption = scene.caption || scene.narration || '';
        if (!caption) return;

        const padding = 20;
        const fontSize = Math.round(this.height * 0.04); // 4% of height

        this.ctx.save();
        this.ctx.font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';

        // Calculate position
        let y;
        switch (this.captionPosition) {
            case 'top':
                y = this.height * 0.1;
                break;
            case 'center':
                y = this.height * 0.5;
                break;
            case 'bottom':
            default:
                y = this.height * 0.85;
                break;
        }

        // Word wrap
        const maxWidth = this.width - padding * 4;
        const lines = this._wrapText(caption, maxWidth);

        // Draw background
        const lineHeight = fontSize * 1.4;
        const totalHeight = lines.length * lineHeight;
        const bgY = y - totalHeight / 2 - padding / 2;

        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        this.ctx.roundRect(
            padding * 2,
            bgY,
            this.width - padding * 4,
            totalHeight + padding,
            8
        );
        this.ctx.fill();

        // Draw text
        this.ctx.fillStyle = '#ffffff';
        lines.forEach((line, index) => {
            this.ctx.fillText(
                line,
                this.width / 2,
                y - ((lines.length - 1) / 2 - index) * lineHeight
            );
        });

        this.ctx.restore();
    }

    /**
     * Word wrap text
     */
    _wrapText(text, maxWidth) {
        const words = text.split(' ');
        const lines = [];
        let currentLine = '';

        for (const word of words) {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            const metrics = this.ctx.measureText(testLine);

            if (metrics.width > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        }

        if (currentLine) {
            lines.push(currentLine);
        }

        return lines;
    }

    /**
     * Set voice volume
     */
    setVoiceVolume(volume) {
        this.voiceVolume = Math.max(0, Math.min(1, volume));
        this.audioElements.forEach(audio => {
            audio.volume = this.voiceVolume;
        });
    }

    /**
     * Set music volume
     */
    setMusicVolume(volume) {
        this.musicVolume = Math.max(0, Math.min(1, volume));
        if (this.musicElement) {
            this.musicElement.volume = this.musicVolume;
        }
    }

    /**
     * Enable/disable captions
     */
    setCaptionsEnabled(enabled) {
        this.captionsEnabled = enabled;
        this._renderFrame();
    }

    /**
     * Set caption style
     */
    setCaptionStyle(style) {
        this.captionStyle = style;
        this._renderFrame();
    }

    /**
     * Set caption position
     */
    setCaptionPosition(position) {
        this.captionPosition = position;
        this._renderFrame();
    }

    /**
     * Get current playback state
     */
    getState() {
        return {
            currentTime: this.currentTime,
            totalDuration: this.totalDuration,
            isPlaying: this.isPlaying,
            currentSceneIndex: this.currentSceneIndex,
            progress: this.totalDuration > 0 ? this.currentTime / this.totalDuration : 0
        };
    }

    /**
     * Update scene data (for timeline editing)
     */
    updateScene(sceneId, updates) {
        const scene = this.scenes.find(s => s.id === sceneId);
        if (scene) {
            Object.assign(scene, updates);
            this._calculateTiming();
            this._renderFrame();
        }
    }

    /**
     * Reorder scenes
     */
    reorderScenes(fromIndex, toIndex) {
        const [scene] = this.scenes.splice(fromIndex, 1);
        this.scenes.splice(toIndex, 0, scene);

        // Update indices
        this.scenes.forEach((s, i) => s.index = i);

        this._calculateTiming();
        this._renderFrame();
    }

    /**
     * Destroy engine and cleanup
     */
    destroy() {
        this.pause();

        // Clear audio
        this.audioElements.forEach(audio => {
            audio.pause();
            audio.src = '';
        });
        this.audioElements.clear();

        if (this.musicElement) {
            this.musicElement.pause();
            this.musicElement.src = '';
            this.musicElement = null;
        }

        // Clear video cache
        this.videoCache.forEach(video => {
            video.pause();
            video.src = '';
        });
        this.videoCache.clear();

        // Clear image cache
        this.imageCache.clear();

        // Clear canvas
        this.ctx.clearRect(0, 0, this.width, this.height);
    }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VideoPreviewEngine;
}
