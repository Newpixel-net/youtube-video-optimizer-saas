/**
 * Liquid Ether - GPU Fluid Simulation
 * Creates interactive fluid dynamics background effect
 */
(function() {
    'use strict';

    const CONFIG = {
        colors: ['#8b5cf6', '#ec4899', '#3b82f6', '#06b6d4'],
        mouseForce: 80,
        cursorSize: 2.5,
        autoDemo: true,
        autoSpeed: 0.8,
        resolution: 0.5,
        densityDissipation: 0.97,
        velocityDissipation: 0.98,
        pressureIterations: 20,
        splatRadius: 0.004
    };

    function hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? [
            parseInt(result[1], 16) / 255,
            parseInt(result[2], 16) / 255,
            parseInt(result[3], 16) / 255
        ] : [0.5, 0.2, 0.8];
    }

    class FluidSimulation {
        constructor(container) {
            this.container = container;
            this.canvas = document.createElement('canvas');
            this.canvas.style.cssText = 'width:100%;height:100%;display:block;position:absolute;top:0;left:0;';
            container.appendChild(this.canvas);

            const gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: false });
            if (!gl) {
                this.fallback();
                return;
            }
            this.gl = gl;

            // Get extensions for float textures
            this.ext = {
                float: gl.getExtension('OES_texture_float'),
                floatLinear: gl.getExtension('OES_texture_float_linear'),
                halfFloat: gl.getExtension('OES_texture_half_float'),
                halfFloatLinear: gl.getExtension('OES_texture_half_float_linear')
            };

            // Determine best texture format
            if (this.ext.float && this.ext.floatLinear) {
                this.texType = gl.FLOAT;
            } else if (this.ext.halfFloat && this.ext.halfFloatLinear) {
                this.texType = this.ext.halfFloat.HALF_FLOAT_OES;
            } else {
                this.texType = gl.UNSIGNED_BYTE;
            }

            // Mouse/touch state - support multiple pointers
            this.pointers = [];
            this.addPointer();

            this.colorIndex = 0;
            this.autoTime = 0;
            this.lastColorTime = 0;

            this.initShaders();
            this.initBuffers();
            this.resize();
            this.bindEvents();

            this.lastTime = performance.now();
            this.animate();
        }

        addPointer() {
            this.pointers.push({
                id: -1,
                x: 0.5,
                y: 0.5,
                dx: 0,
                dy: 0,
                down: false,
                moved: false,
                color: hexToRgb(CONFIG.colors[0])
            });
        }

        fallback() {
            this.container.style.background = `
                radial-gradient(ellipse at 30% 20%, rgba(139,92,246,0.4) 0%, transparent 50%),
                radial-gradient(ellipse at 70% 60%, rgba(236,72,153,0.4) 0%, transparent 50%),
                radial-gradient(ellipse at 40% 80%, rgba(59,130,246,0.3) 0%, transparent 50%),
                #0a0a0f
            `;
        }

        compile(type, source) {
            const gl = this.gl;
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.error('Shader compile error:', gl.getShaderInfoLog(shader));
                return null;
            }
            return shader;
        }

        createProgram(vs, fs) {
            const gl = this.gl;
            const prog = gl.createProgram();
            gl.attachShader(prog, vs);
            gl.attachShader(prog, fs);
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                console.error('Program link error:', gl.getProgramInfoLog(prog));
                return null;
            }
            const uniforms = {};
            const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
            for (let i = 0; i < n; i++) {
                const info = gl.getActiveUniform(prog, i);
                uniforms[info.name] = gl.getUniformLocation(prog, info.name);
            }
            return { program: prog, uniforms };
        }

        initShaders() {
            const gl = this.gl;

            const baseVS = `
                attribute vec2 aPosition;
                varying vec2 vUv;
                varying vec2 vL;
                varying vec2 vR;
                varying vec2 vT;
                varying vec2 vB;
                uniform vec2 texelSize;
                void main() {
                    vUv = aPosition * 0.5 + 0.5;
                    vL = vUv - vec2(texelSize.x, 0.0);
                    vR = vUv + vec2(texelSize.x, 0.0);
                    vT = vUv + vec2(0.0, texelSize.y);
                    vB = vUv - vec2(0.0, texelSize.y);
                    gl_Position = vec4(aPosition, 0.0, 1.0);
                }
            `;

            const vs = this.compile(gl.VERTEX_SHADER, baseVS);

            // Splat shader - creates colorful splashes
            this.splatProg = this.createProgram(vs, this.compile(gl.FRAGMENT_SHADER, `
                precision highp float;
                varying vec2 vUv;
                uniform sampler2D uTarget;
                uniform float aspectRatio;
                uniform vec3 color;
                uniform vec2 point;
                uniform float radius;
                void main() {
                    vec2 p = vUv - point;
                    p.x *= aspectRatio;
                    float d = length(p);
                    float strength = exp(-d * d / radius);
                    vec3 base = texture2D(uTarget, vUv).xyz;
                    vec3 splat = strength * color;
                    gl_FragColor = vec4(base + splat, 1.0);
                }
            `));

            // Advection - moves fluid
            this.advectionProg = this.createProgram(vs, this.compile(gl.FRAGMENT_SHADER, `
                precision highp float;
                varying vec2 vUv;
                uniform sampler2D uVelocity;
                uniform sampler2D uSource;
                uniform vec2 texelSize;
                uniform float dt;
                uniform float dissipation;
                void main() {
                    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
                    vec4 result = dissipation * texture2D(uSource, coord);
                    gl_FragColor = result;
                }
            `));

            // Divergence
            this.divergenceProg = this.createProgram(vs, this.compile(gl.FRAGMENT_SHADER, `
                precision highp float;
                varying vec2 vUv;
                varying vec2 vL;
                varying vec2 vR;
                varying vec2 vT;
                varying vec2 vB;
                uniform sampler2D uVelocity;
                void main() {
                    float L = texture2D(uVelocity, vL).x;
                    float R = texture2D(uVelocity, vR).x;
                    float T = texture2D(uVelocity, vT).y;
                    float B = texture2D(uVelocity, vB).y;
                    float div = 0.5 * (R - L + T - B);
                    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
                }
            `));

            // Pressure solver
            this.pressureProg = this.createProgram(vs, this.compile(gl.FRAGMENT_SHADER, `
                precision highp float;
                varying vec2 vUv;
                varying vec2 vL;
                varying vec2 vR;
                varying vec2 vT;
                varying vec2 vB;
                uniform sampler2D uPressure;
                uniform sampler2D uDivergence;
                void main() {
                    float L = texture2D(uPressure, vL).x;
                    float R = texture2D(uPressure, vR).x;
                    float T = texture2D(uPressure, vT).x;
                    float B = texture2D(uPressure, vB).x;
                    float C = texture2D(uDivergence, vUv).x;
                    float pressure = (L + R + B + T - C) * 0.25;
                    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
                }
            `));

            // Gradient subtraction
            this.gradientProg = this.createProgram(vs, this.compile(gl.FRAGMENT_SHADER, `
                precision highp float;
                varying vec2 vUv;
                varying vec2 vL;
                varying vec2 vR;
                varying vec2 vT;
                varying vec2 vB;
                uniform sampler2D uPressure;
                uniform sampler2D uVelocity;
                void main() {
                    float L = texture2D(uPressure, vL).x;
                    float R = texture2D(uPressure, vR).x;
                    float T = texture2D(uPressure, vT).x;
                    float B = texture2D(uPressure, vB).x;
                    vec2 velocity = texture2D(uVelocity, vUv).xy;
                    velocity.xy -= vec2(R - L, T - B);
                    gl_FragColor = vec4(velocity, 0.0, 1.0);
                }
            `));

            // Clear/fade shader
            this.clearProg = this.createProgram(vs, this.compile(gl.FRAGMENT_SHADER, `
                precision highp float;
                varying vec2 vUv;
                uniform sampler2D uTexture;
                uniform float value;
                void main() {
                    gl_FragColor = value * texture2D(uTexture, vUv);
                }
            `));

            // Display with enhanced colors
            this.displayProg = this.createProgram(vs, this.compile(gl.FRAGMENT_SHADER, `
                precision highp float;
                varying vec2 vUv;
                uniform sampler2D uTexture;
                void main() {
                    vec3 c = texture2D(uTexture, vUv).rgb;
                    // Boost colors for more vibrancy
                    c = pow(c, vec3(0.8));
                    c *= 1.4;
                    float brightness = max(c.r, max(c.g, c.b));
                    gl_FragColor = vec4(c, min(brightness * 1.2, 1.0));
                }
            `));
        }

        initBuffers() {
            const gl = this.gl;
            this.quad = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
        }

        createFBO(w, h) {
            const gl = this.gl;
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, this.texType, null);

            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            return { texture: tex, fbo, width: w, height: h };
        }

        createDoubleFBO(w, h) {
            let fbo1 = this.createFBO(w, h);
            let fbo2 = this.createFBO(w, h);
            return {
                width: w, height: h,
                get read() { return fbo1; },
                get write() { return fbo2; },
                swap() { const t = fbo1; fbo1 = fbo2; fbo2 = t; }
            };
        }

        resize() {
            const gl = this.gl;
            const w = this.container.clientWidth || window.innerWidth;
            const h = this.container.clientHeight || window.innerHeight;

            if (w === 0 || h === 0) {
                setTimeout(() => this.resize(), 100);
                return;
            }

            this.canvas.width = w;
            this.canvas.height = h;

            const simW = Math.floor(w * CONFIG.resolution);
            const simH = Math.floor(h * CONFIG.resolution);

            this.simWidth = simW;
            this.simHeight = simH;
            this.texelSize = [1 / simW, 1 / simH];
            this.aspectRatio = w / h;

            this.velocity = this.createDoubleFBO(simW, simH);
            this.density = this.createDoubleFBO(simW, simH);
            this.pressure = this.createDoubleFBO(simW, simH);
            this.divergence = this.createFBO(simW, simH);
        }

        bindEvents() {
            const getPointerPos = (e) => {
                const rect = this.canvas.getBoundingClientRect();
                return {
                    x: (e.clientX - rect.left) / rect.width,
                    y: 1.0 - (e.clientY - rect.top) / rect.height
                };
            };

            // Mouse events
            this.canvas.addEventListener('mousedown', (e) => {
                const pos = getPointerPos(e);
                this.pointers[0].down = true;
                this.pointers[0].x = pos.x;
                this.pointers[0].y = pos.y;
                this.colorIndex = (this.colorIndex + 1) % CONFIG.colors.length;
                this.pointers[0].color = hexToRgb(CONFIG.colors[this.colorIndex]);
            });

            this.canvas.addEventListener('mousemove', (e) => {
                const pos = getPointerPos(e);
                const pointer = this.pointers[0];
                pointer.dx = (pos.x - pointer.x) * 30;
                pointer.dy = (pos.y - pointer.y) * 30;
                pointer.x = pos.x;
                pointer.y = pos.y;
                pointer.moved = Math.abs(pointer.dx) > 0.001 || Math.abs(pointer.dy) > 0.001;
            });

            this.canvas.addEventListener('mouseup', () => {
                this.pointers[0].down = false;
            });

            this.canvas.addEventListener('mouseleave', () => {
                this.pointers[0].down = false;
            });

            // Touch events
            this.canvas.addEventListener('touchstart', (e) => {
                e.preventDefault();
                const touches = e.targetTouches;
                for (let i = 0; i < touches.length; i++) {
                    if (i >= this.pointers.length) this.addPointer();
                    const pos = getPointerPos(touches[i]);
                    this.pointers[i].id = touches[i].identifier;
                    this.pointers[i].down = true;
                    this.pointers[i].x = pos.x;
                    this.pointers[i].y = pos.y;
                    this.colorIndex = (this.colorIndex + 1) % CONFIG.colors.length;
                    this.pointers[i].color = hexToRgb(CONFIG.colors[this.colorIndex]);
                }
            }, { passive: false });

            this.canvas.addEventListener('touchmove', (e) => {
                e.preventDefault();
                const touches = e.targetTouches;
                for (let i = 0; i < touches.length; i++) {
                    const pointer = this.pointers.find(p => p.id === touches[i].identifier);
                    if (!pointer) continue;
                    const pos = getPointerPos(touches[i]);
                    pointer.dx = (pos.x - pointer.x) * 30;
                    pointer.dy = (pos.y - pointer.y) * 30;
                    pointer.x = pos.x;
                    pointer.y = pos.y;
                    pointer.moved = true;
                }
            }, { passive: false });

            this.canvas.addEventListener('touchend', (e) => {
                for (const touch of e.changedTouches) {
                    const pointer = this.pointers.find(p => p.id === touch.identifier);
                    if (pointer) pointer.down = false;
                }
            });

            window.addEventListener('resize', () => this.resize());
        }

        blit(target, clear = false) {
            const gl = this.gl;
            if (target) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
                gl.viewport(0, 0, target.width, target.height);
            } else {
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            }
            if (clear) {
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
            }
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }

        useProgram(prog) {
            const gl = this.gl;
            gl.useProgram(prog.program);
            gl.uniform2fv(prog.uniforms.texelSize, this.texelSize);
            const loc = gl.getAttribLocation(prog.program, 'aPosition');
            gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
            return prog.uniforms;
        }

        splat(x, y, dx, dy, color) {
            const gl = this.gl;
            const u = this.useProgram(this.splatProg);

            gl.uniform1i(u.uTarget, 0);
            gl.uniform1f(u.aspectRatio, this.aspectRatio);
            gl.uniform2f(u.point, x, y);
            gl.uniform1f(u.radius, CONFIG.splatRadius);

            // Splat velocity
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
            gl.uniform3f(u.color, dx * CONFIG.mouseForce, dy * CONFIG.mouseForce, 0);
            this.blit(this.velocity.write);
            this.velocity.swap();

            // Splat color - brighter colors
            gl.bindTexture(gl.TEXTURE_2D, this.density.read.texture);
            gl.uniform3f(u.color, color[0] * 0.8, color[1] * 0.8, color[2] * 0.8);
            gl.uniform1f(u.radius, CONFIG.splatRadius * 1.5);
            this.blit(this.density.write);
            this.density.swap();
        }

        step(dt) {
            const gl = this.gl;

            // Advect velocity
            let u = this.useProgram(this.advectionProg);
            gl.uniform1f(u.dt, dt);
            gl.uniform1f(u.dissipation, CONFIG.velocityDissipation);
            gl.uniform1i(u.uVelocity, 0);
            gl.uniform1i(u.uSource, 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
            this.blit(this.velocity.write);
            this.velocity.swap();

            // Advect density
            gl.uniform1f(u.dissipation, CONFIG.densityDissipation);
            gl.uniform1i(u.uSource, 1);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.density.read.texture);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
            this.blit(this.density.write);
            this.density.swap();

            // Divergence
            u = this.useProgram(this.divergenceProg);
            gl.uniform1i(u.uVelocity, 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
            this.blit(this.divergence);

            // Clear pressure
            u = this.useProgram(this.clearProg);
            gl.uniform1i(u.uTexture, 0);
            gl.uniform1f(u.value, 0.8);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.pressure.read.texture);
            this.blit(this.pressure.write);
            this.pressure.swap();

            // Solve pressure
            u = this.useProgram(this.pressureProg);
            gl.uniform1i(u.uDivergence, 1);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.divergence.texture);
            for (let i = 0; i < CONFIG.pressureIterations; i++) {
                gl.uniform1i(u.uPressure, 0);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, this.pressure.read.texture);
                this.blit(this.pressure.write);
                this.pressure.swap();
            }

            // Gradient subtraction
            u = this.useProgram(this.gradientProg);
            gl.uniform1i(u.uPressure, 0);
            gl.uniform1i(u.uVelocity, 1);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.pressure.read.texture);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.velocity.read.texture);
            this.blit(this.velocity.write);
            this.velocity.swap();
        }

        render() {
            const gl = this.gl;
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            const u = this.useProgram(this.displayProg);
            gl.uniform1i(u.uTexture, 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.density.read.texture);
            this.blit(null, true);
        }

        animate() {
            const now = performance.now();
            const dt = Math.min((now - this.lastTime) / 1000, 0.016);
            this.lastTime = now;

            // Auto demo - creates ambient flowing motion
            if (CONFIG.autoDemo) {
                this.autoTime += dt * CONFIG.autoSpeed;

                // Multiple flowing points for ambient effect
                const points = [
                    { ox: 0.3, oy: 0.3, sx: 0.7, sy: 0.5, dx: 1.1, dy: 0.9 },
                    { ox: 0.7, oy: 0.7, sx: 0.5, sy: 0.7, dx: 0.9, dy: 1.1 },
                    { ox: 0.5, oy: 0.5, sx: 0.6, sy: 0.6, dx: 0.8, dy: 1.3 }
                ];

                for (let i = 0; i < points.length; i++) {
                    const p = points[i];
                    const t = this.autoTime + i * 2;
                    const ax = p.ox + 0.25 * Math.sin(t * p.sx);
                    const ay = p.oy + 0.25 * Math.cos(t * p.sy);
                    const adx = Math.cos(t * p.dx) * 0.15;
                    const ady = Math.sin(t * p.dy) * 0.15;

                    const colorIdx = (i + Math.floor(this.autoTime * 0.3)) % CONFIG.colors.length;
                    this.splat(ax, ay, adx, ady, hexToRgb(CONFIG.colors[colorIdx]));
                }
            }

            // User input - much more responsive
            for (const p of this.pointers) {
                if (p.moved || p.down) {
                    const force = p.down ? 1.5 : 1.0;
                    this.splat(p.x, p.y, p.dx * force, p.dy * force, p.color);
                    p.moved = false;
                    // Maintain some momentum
                    p.dx *= 0.85;
                    p.dy *= 0.85;
                }
            }

            this.step(dt);
            this.render();

            requestAnimationFrame(() => this.animate());
        }
    }

    // Initialize
    function init() {
        const container = document.getElementById('liquid-ether-container');
        if (container) {
            try {
                new FluidSimulation(container);
            } catch (e) {
                console.error('Fluid simulation failed:', e);
                container.style.background = `
                    radial-gradient(ellipse at 30% 20%, rgba(139,92,246,0.4) 0%, transparent 50%),
                    radial-gradient(ellipse at 70% 60%, rgba(236,72,153,0.4) 0%, transparent 50%),
                    #0a0a0f
                `;
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
