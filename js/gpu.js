/* TableBeats GPU vision: background subtraction in WebGL2 fragment shaders.
   Same maths as cpuBackend in js/vision.js, one fragment per pixel:
   1. capture: the camera frame is uploaded as a texture and box-filtered down to w*h (with the
      flips) in a shader, instead of drawImage + getImageData on a CPU canvas.
   2. classify: foreground test + shadow rejection + 2-of-4-neighbour denoise. The result
      (fg, fg0, luminance) is read back as one RGBA8 texture; blobs and tracking stay on the CPU.
   3. learn: the background model (RGBA32F, ping-pong) is updated on the GPU from the CPU's blob
      labels, so the model itself never leaves the GPU.
   Readback: 'sync' reads the mask with readPixels, which stalls until the GPU has run the whole
   frame (~1.8 ms on an M2, more than the shader work saves). 'async' reads into a pixel buffer
   behind a fence and copies it out on the next frame, when the GPU is long done. That copy is
   still one IPC round trip to Chrome's GPU process (getBufferSubData always waits for it, ~0.7 ms),
   but no longer waits on the GPU. The catch: tips are one camera frame old, and when the GPU
   falls behind (fence not passed yet) it blocks anyway, which made its p95 worse than 'sync' in
   some throttled runs. So the app uses 'sync'; 'async' is opt-in (?readback=async, bench.html).
   Needs WebGL2 + EXT_color_buffer_float (32-bit float render targets: the slow learning rate is
   ~0.001 per frame, which 8- or 16-bit storage would round away). Returns null without them. */
(function (root) {
  'use strict';

  const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

  const HEAD = `#version 300 es
precision highp float;
precision highp int;
out vec4 o;
`;

  // video -> w*h, 4 bilinear taps (~ a box filter over the source pixels under each output pixel)
  const FS_CAPTURE = HEAD + `
uniform sampler2D src;
uniform vec2 size, flip;
vec3 tap(vec2 uv) { return texture(src, mix(uv, 1.0 - uv, flip)).rgb; }
void main() {
  vec2 uv = gl_FragCoord.xy / size, e = 0.25 / size;
  o = vec4((tap(uv + vec2(-e.x, -e.y)) + tap(uv + vec2(e.x, -e.y)) + tap(uv + vec2(-e.x, e.y)) + tap(uv + e)) * 0.25, 1.0);
}`;

  const FS_INIT = HEAD + `
uniform sampler2D frame;
void main() { o = vec4(texelFetch(frame, ivec2(gl_FragCoord.xy), 0).rgb * 255.0, 1.0); }`;

  const FS_CLASSIFY = HEAD + `
uniform sampler2D frame, bg;
uniform float thr;
uniform ivec2 size;
const vec3 LUMA = vec3(0.3, 0.59, 0.11);
float fgAt(ivec2 q) {
  vec3 c = texelFetch(frame, q, 0).rgb * 255.0, b = texelFetch(bg, q, 0).rgb;
  float y = dot(c, LUMA), by = dot(b, LUMA), dy = y - by;
  vec3 dc = abs(c - b);
  if (abs(dy) <= thr && dc.r + dc.g + dc.b <= thr * 2.4) return 0.0;
  float ratio = y / (by + 1.0);
  if (dy < 0.0 && ratio > 0.4 && ratio < 0.95) { // darker: shadow if the colour is unchanged
    float s = c.r + c.g + c.b + 1.0, bs = b.r + b.g + b.b + 1.0;
    if (abs(c.r / s - b.r / bs) + abs(c.g / s - b.g / bs) < 0.045) return 0.0;
  }
  return 1.0;
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  float f0 = fgAt(q), f = 0.0;
  if (f0 > 0.5) { // denoise: keep a pixel only if at least 2 of its 4 neighbours agree
    float n = (q.x > 0 ? fgAt(q - ivec2(1, 0)) : 1.0) + (q.x < size.x - 1 ? fgAt(q + ivec2(1, 0)) : 1.0)
            + (q.y > 0 ? fgAt(q - ivec2(0, 1)) : 1.0) + (q.y < size.y - 1 ? fgAt(q + ivec2(0, 1)) : 1.0);
    f = n >= 2.0 ? 1.0 : 0.0;
  }
  o = vec4(f, f0, dot(texelFetch(frame, q, 0).rgb, LUMA), 1.0);
}`;

  const FS_LEARN = HEAD + `
uniform sampler2D frame, bg, cls;
uniform highp isampler2D lab;
uniform float fast, slow;
uniform ivec2 size;
bool blob(ivec2 q) { return texelFetch(lab, q, 0).r > 0; }
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  bool near = texelFetch(cls, q, 0).g > 0.5 || blob(q)
    || (q.x > 0 && blob(q - ivec2(1, 0))) || (q.x < size.x - 1 && blob(q + ivec2(1, 0)))
    || (q.y > 0 && blob(q - ivec2(0, 1))) || (q.y < size.y - 1 && blob(q + ivec2(0, 1)));
  vec3 b = texelFetch(bg, q, 0).rgb;
  o = vec4(b + (texelFetch(frame, q, 0).rgb * 255.0 - b) * (near ? slow : fast), 1.0);
}`;

  let G = null; // one shared WebGL2 context for every backend size

  function context() {
    if (G) return G.lost ? null : G;
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
    const prog = (fs) => {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
      }
      gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
      const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
      return { p, u };
    };
    // one triangle that covers the viewport
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    try {
      G = { gl, canvas, lost: false,
        capture: prog(FS_CAPTURE), init: prog(FS_INIT), classify: prog(FS_CLASSIFY), learn: prog(FS_LEARN),
        video: tex(gl, gl.RGBA8, 1, 1, gl.LINEAR) };
    } catch (e) { console.warn('TableBeats GPU vision disabled:', e.message); return null; }
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    G.renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    if (canvas.addEventListener) canvas.addEventListener('webglcontextlost', () => { G.lost = true; });
    return G;
  }

  function tex(gl, fmt, w, h, filter) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    return t;
  }

  function target(gl, t) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return f;
  }

  /* A backend for w*h with the same interface as cpuBackend, plus capture(src, flipX, flipY),
     which must run once per frame before tracker.process(null, ...). readback: 'sync' | 'async'. */
  function createBackend(w, h, readback) {
    const g = context();
    if (!g) return null;
    const gl = g.gl, N = w * h;
    const frame = tex(gl, gl.RGBA8, w, h), cls = tex(gl, gl.RGBA8, w, h), lab = tex(gl, gl.R32I, w, h);
    const bg = [tex(gl, gl.RGBA32F, w, h), tex(gl, gl.RGBA32F, w, h)];
    const fFrame = target(gl, frame), fCls = target(gl, cls), fBg = bg.map((t) => target(gl, t));
    const px = new Uint8Array(N * 4);
    // usage is only a hint; a *_READ hint makes Chrome allocate readback shadows WebGL never uses
    const pbo = [0, 1].map(() => { const b = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b); gl.bufferData(gl.PIXEL_PACK_BUFFER, N * 4, gl.STREAM_COPY); return b; });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const fence = [null, null];
    let cur = 0, vw = 0, vh = 0, slot = 0;

    // mask of the previous frame if its fence has passed, else of this frame (blocking)
    function readAsync() {
      const prev = 1 - slot, f = fence[prev];
      const ready = f && gl.getSyncParameter(f, gl.SYNC_STATUS) === gl.SIGNALED;
      if (ready) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo[prev]);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
      }
      if (f) { gl.deleteSync(f); fence[prev] = null; }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo[slot]);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      fence[slot] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.flush();
      if (!ready) gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); // first frame, or the GPU is behind
      slot = prev;
      return ready;
    }

    function draw(prog, fbo, texs, uni) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(prog.p);
      Object.keys(texs).forEach((name, k) => {
        gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, texs[name]); gl.uniform1i(prog.u[name], k);
      });
      if (prog.u.size) gl.uniform2i(prog.u.size, w, h);
      if (uni) uni(prog.u);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    return {
      name: 'gpu', w, h, renderer: g.renderer, readback: readback || 'sync', blocked: 0,
      get lost() { return g.lost; },
      capture(src, flipX, flipY) {
        gl.bindTexture(gl.TEXTURE_2D, g.video);
        const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
        if (sw !== vw || sh !== vh) { // texStorage is immutable: new texture when the camera size changes
          gl.deleteTexture(g.video); g.video = tex(gl, gl.RGBA8, sw, sh, gl.LINEAR); vw = sw; vh = sh;
        }
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fFrame);
        gl.viewport(0, 0, w, h);
        gl.useProgram(g.capture.p);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, g.video); gl.uniform1i(g.capture.u.src, 0);
        gl.uniform2f(g.capture.u.size, w, h); gl.uniform2f(g.capture.u.flip, flipX ? 1 : 0, flipY ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return null;
      },
      init() { draw(g.init, fBg[cur], { frame }); },
      seed(prev) {
        const src = prev.bgRGB && prev.bgRGB();
        if (!src) return false;
        const a = new Float32Array(N * 4);
        for (let y = 0; y < h; y++) {
          const sy = Math.min(prev.h - 1, Math.floor((y + 0.5) * prev.h / h));
          for (let x = 0; x < w; x++) {
            const j = sy * prev.w + Math.min(prev.w - 1, Math.floor((x + 0.5) * prev.w / w)), p = (y * w + x) * 4;
            a[p] = src[0][j]; a[p + 1] = src[1][j]; a[p + 2] = src[2][j]; a[p + 3] = 1;
          }
        }
        gl.bindTexture(gl.TEXTURE_2D, bg[cur]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, a);
        return true;
      },
      // read the background model back (only when switching resolution or backend)
      bgRGB() {
        const a = new Float32Array(N * 4), r = new Float32Array(N), gg = new Float32Array(N), b = new Float32Array(N);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fBg[cur]);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, a);
        for (let i = 0; i < N; i++) { r[i] = a[i * 4]; gg[i] = a[i * 4 + 1]; b[i] = a[i * 4 + 2]; }
        return [r, gg, b];
      },
      classify(d, thr, fg0, fg, curY) {
        draw(g.classify, fCls, { frame, bg: bg[cur] }, (u) => gl.uniform1f(u.thr, thr));
        if (this.readback === 'async') { if (!readAsync()) this.blocked++; }
        else gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); // waits for the GPU
        let fgCount = 0;
        for (let i = 0, p = 0; i < N; i++, p += 4) {
          fg[i] = px[p] >> 7; const f0 = px[p + 1] >> 7; fg0[i] = f0; fgCount += f0;
          curY[i] = px[p + 2];
        }
        return fgCount;
      },
      learn(d, label, fg0, fast, slow) {
        gl.bindTexture(gl.TEXTURE_2D, lab);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED_INTEGER, gl.INT, label);
        draw(g.learn, fBg[1 - cur], { frame, bg: bg[cur], cls, lab }, (u) => { gl.uniform1f(u.fast, fast); gl.uniform1f(u.slow, slow); });
        cur = 1 - cur; // not read back: the next classify uses it straight from GPU memory
      },
      dispose() {
        [frame, cls, lab, ...bg].forEach((t) => gl.deleteTexture(t));
        [fFrame, fCls, ...fBg].forEach((f) => gl.deleteFramebuffer(f));
        pbo.forEach((b) => gl.deleteBuffer(b));
        fence.forEach((f) => f && gl.deleteSync(f));
      },
    };
  }

  const api = { createBackend, get renderer() { const g = context(); return g ? g.renderer : null; } };
  root.TB = root.TB || {}; root.TB.gpu = api;
})(typeof window !== 'undefined' ? window : globalThis);
