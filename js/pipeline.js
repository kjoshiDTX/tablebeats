/* TableBeats vision pipeline: camera frame -> tracker, on the CPU or the GPU.
   - cpu: drawImage the video into a small 2D canvas, getImageData, background subtraction in JS.
   - gpu: upload the video as a WebGL texture, downscale + background subtraction in fragment
     shaders (js/gpu.js), read back only the foreground mask.
   Blobs, fingertips and strikes run on the CPU either way (js/vision.js). Shared by the app and
   bench.html so the benchmark measures exactly what the app runs.
   With `adaptive`, a governor (js/quality.js) lowers the processing resolution, and as a last
   resort skips every other frame, when vision goes over its time budget; the background model is
   carried across resolution changes, so nothing has to be relearned. */
(function (root) {
  'use strict';
  const { vision: V, perf, gpu, quality } = root.TB;

  /* video: the <video> element. backend: 'auto' (GPU when available) | 'cpu' | 'gpu'.
     readback: GPU mask readback, 'sync' | 'async' (see js/gpu.js).
     adaptive: false, or { budgetMs } to degrade gracefully (w*h is then the top quality level). */
  function create({ video, w, h, backend, readback, adaptive }) {
    const cv = document.createElement('canvas');
    const cx = cv.getContext('2d', { willReadFrequently: true });
    let want = backend || 'auto', tracker = null, gov = null;
    const top = { w, h };

    function build(prev) {
      cv.width = w; cv.height = h;
      let be = null;
      if (want !== 'cpu' && gpu) be = gpu.createBackend(w, h, readback);
      if (!be) be = V.cpuBackend(w, h);
      tracker = V.createTracker(w, h, { backend: be, prof: perf, seed: prev });
      if (prev && prev.backend.dispose) prev.backend.dispose(); // after the seed has read its background
    }
    build(null);

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
      if (tracker.backend.lost) { want = 'cpu'; build(null); } // GPU context lost: carry on on the CPU
      if (gov && !gov.take()) return null;
      perf.start('vision');
      perf.start('capture');
      const d = tracker.backend.capture ? tracker.backend.capture(video, flipX, flipY) : captureCPU(flipX, flipY);
      perf.end('capture');
      const res = tracker.process(d, now, o);
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
      get renderer() { return tracker.backend.renderer || 'CPU (JavaScript)'; },
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
