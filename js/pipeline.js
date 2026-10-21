/* TableBeats vision pipeline: camera frame -> tracker, on the CPU or the GPU.
   - cpu: drawImage the video into a small 2D canvas, getImageData, the whole tracker in JS.
   - wasm: the same capture, the whole tracker in C++ compiled to WebAssembly (js/wasm.js,
     native/tracker.cpp). Identical results to cpu. The module loads in the background: until it
     is ready (or if it can't load) the JS tracker runs, and it's swapped in between two frames
     with the background model carried over, so nothing visible happens.
   - gpu: upload the video as a WebGL texture, downscale + background subtraction in fragment
     shaders (js/gpu.js), read back only the foreground mask; blobs and tracking in JS.
   Shared by the app and bench.html so the benchmark measures exactly what the app runs.
   With `adaptive`, a governor (js/quality.js) lowers the processing resolution, and as a last
   resort skips every other frame, when vision goes over its time budget; the background model is
   carried across resolution changes, so nothing has to be relearned. */
(function (root) {
  'use strict';
  const { vision: V, perf, gpu, quality, wasm } = root.TB;
  const WASM_URL = 'js/tracker.wasm';

  /* video: the <video> element. backend: 'auto' | 'gpu' | 'wasm' | 'cpu'. Each falls back to the next
     one available: auto and gpu try GPU, then WebAssembly, then JS; wasm tries WebAssembly, then JS.
     onchange(): called when the running backend changes by itself (WebAssembly finished loading).
     readback: GPU mask readback, 'sync' | 'async' (see js/gpu.js).
     adaptive: false, or { budgetMs } to degrade gracefully (w*h is then the top quality level). */
  function create({ video, w, h, backend, readback, adaptive, onchange }) {
    const cv = document.createElement('canvas');
    const cx = cv.getContext('2d', { willReadFrequently: true });
    let want = backend || 'auto', tracker = null, gov = null, failed = false;
    const top = { w, h };

    function build(prev) {
      cv.width = w; cv.height = h;
      let be = null, next = null;
      if ((want === 'auto' || want === 'gpu') && gpu && !failed) be = gpu.createBackend(w, h, readback);
      if (!be && want !== 'cpu' && wasm && wasm.ready && !failed) {
        try { next = wasm.createTracker(w, h, { prof: perf, seed: prev }); } catch (e) { console.warn('TableBeats:', e.message); }
      }
      tracker = next || V.createTracker(w, h, { backend: be || V.cpuBackend(w, h), prof: perf, seed: prev });
      if (prev && prev.backend.dispose) prev.backend.dispose(); // after the seed has read its background
    }
    build(null);
    // WebAssembly arrives a moment after start-up: switch over if it's what this setting would pick
    if (wasm) wasm.load(WASM_URL).then((ok) => {
      if (ok && tracker.backend.name === 'cpu' && want !== 'cpu') { build(tracker); perf.reset(); if (onchange) onchange(); }
    });

    function captureCPU(flipX, flipY) {
      cx.save();
      if (flipX) { cx.translate(w, 0); cx.scale(-1, 1); }
      if (flipY) { cx.translate(0, h); cx.scale(1, -1); }
      cx.drawImage(video, 0, 0, w, h);
      cx.restore();
      return cx.getImageData(0, 0, w, h).data;
    }

    function resize(s) { w = s.w; h = s.h; build(tracker); }
    function setAdaptive(opts) {
      gov = opts && quality ? quality.createGovernor({ budgetMs: opts.budgetMs, levels: quality.LEVELS.filter((l) => l.w <= top.w) }) : null;
      if (w !== top.w) resize(top);
    }
    setAdaptive(adaptive);

    /* One camera frame. o: tracker options (toGrid, rows, cols, sens). Returns the tracker result,
       or null when the governor skips this frame. */
    function frame(now, o, flipX, flipY) {
      if (tracker.backend.lost) { want = 'wasm'; build(null); } // GPU context lost: carry on on the CPU
      if (gov && !gov.take()) return null;
      perf.start('vision');
      perf.start('capture');
      const d = tracker.backend.capture ? tracker.backend.capture(video, flipX, flipY) : captureCPU(flipX, flipY);
      perf.end('capture');
      perf.start('tracker'); // everything after capture: the part that differs between JS and WebAssembly
      let res;
      try { res = tracker.process(d, now, o); } catch (e) {
        if (tracker.backend.name === 'cpu') throw e;
        // the GPU or WebAssembly tracker failed (a driver, or app files of mixed versions in the
        // browser cache): the JS tracker takes over for this session; the user loses one frame
        console.warn(`TableBeats: ${tracker.backend.name} tracker failed (${e.message}); using JavaScript`);
        failed = true; build(null); if (onchange) onchange();
        res = { tips: [], strikes: [], relearned: true };
      }
      perf.end('tracker');
      const ms = perf.end('vision');
      perf.flush();
      res.ms = ms;
      if (gov && gov.record(ms) >= 0 && gov.settings.w !== w) resize(gov.settings); // from the next frame
      return res;
    }

    return {
      frame,
      get tracker() { return tracker; },
      get backend() { return tracker.backend.name + (tracker.backend.readback === 'async' ? ' async' : ''); },
      get renderer() { return tracker.backend.renderer || (tracker.backend.name === 'wasm' ? 'CPU (WebAssembly, C++)' : 'CPU (JavaScript)'); },
      get w() { return w; }, get h() { return h; },
      // quality level: 0 = full; settings = { w, h, every }
      get quality() { return gov ? { level: gov.level, of: gov.levels.length, ...gov.settings, budgetMs: gov.budgetMs } : null; },
      setAdaptive,
      setBackend(name) { if (name === want) return; want = name; build(tracker); perf.reset(); },
      setReadback(mode) { readback = mode; if (tracker.backend.readback) tracker.backend.readback = mode; },
      reset() { tracker.reset(); },
    };
  }

  root.TB.pipeline = { create };
})(typeof window !== 'undefined' ? window : globalThis);
