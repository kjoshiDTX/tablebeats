/* TableBeats WebAssembly tracker: native/tracker.cpp (a C++ port of js/vision.js) compiled to
   js/tracker.wasm, wrapped in the same interface as vision.createTracker, so js/pipeline.js can use
   either. Same output frame for frame (tools/test-vision.mjs).
   Loading is asynchronous and optional: until the module is ready, or if it can't load at all
   (old browser, blocked fetch), the app simply keeps using the JavaScript tracker. */
(function (root) {
  'use strict';
  const STAGES = ['bgsub', 'blobs', 'learn', 'track']; // stage ids in native/tracker.cpp
  const NOPROF = { start() {}, end() {} };
  const TRACK_DOUBLES = 34, TRACK_INTS = 68, HIST = 8;  // struct Track, 272 bytes
  let mod = null, loading = null;
  const coefCache = new WeakMap();

  /* The grid map as 9 coefficients. core.invertMap attaches them; an older cached core.js (browsers
     cache the app's scripts independently) doesn't, so rebuild the same projective map from where
     it sends the 4 corners of the unit square. */
  function coefOf(toGrid) {
    if (toGrid.coef) return toGrid.coef;
    if (!coefCache.has(toGrid)) {
      const q = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => { const [u, v] = toGrid(x, y); return { x: u, y: v }; });
      const core = root.TB && root.TB.core ? root.TB.core : require('./core.js'); // browser : node
      const [a, b, c, d, e, f, g, h] = core.squareToQuad(q);
      coefCache.set(toGrid, [a, b, c, d, e, f, g, h, 1]);
    }
    return coefCache.get(toGrid);
  }

  /* Compile the module once (a URL, or bytes in node). Resolves to true when usable, never rejects. */
  function load(src) {
    if (!loading) {
      loading = (async () => {
        try {
          if (typeof WebAssembly !== 'object') return false;
          const bytes = typeof src === 'string' ? await (await fetch(src)).arrayBuffer() : src;
          mod = await WebAssembly.compile(bytes);
          return true;
        } catch (e) {
          console.warn('TableBeats: WebAssembly tracker unavailable, using JavaScript:', e.message);
          return false;
        }
      })();
    }
    return loading;
  }

  /* Same options and interface as vision.createTracker. One module instance per tracker:
     each has its own memory, sized for w*h. */
  function createTracker(w, h, opts) {
    if (!mod) throw new Error('wasm tracker not loaded');
    opts = opts || {};
    const N = w * h, prof = opts.prof || NOPROF;
    const X = new WebAssembly.Instance(mod, { env: {
      exp: Math.exp, hypot: Math.hypot, // the JS engine's own, so results match vision.js to the bit
      prof_start: (k) => prof.start(STAGES[k]), prof_end: (k) => prof.end(STAGES[k]),
    } }).exports;
    if (!X.tb_init(w, h)) throw new Error('wasm tracker: out of memory');
    const buf = X.memory.buffer; // memory only grows in tb_init, so these views stay valid
    const frame = new Uint8Array(buf, X.tb_frame(), N * 4);
    const bg = [0, 1, 2].map((c) => new Float32Array(buf, X.tb_bg(c), N));
    const inv = new Float64Array(buf, X.tb_inv(), 9);
    const tf = new Float64Array(buf, X.tb_tracks(), 4 * TRACK_DOUBLES), ti = new Int32Array(buf, X.tb_tracks(), 4 * TRACK_INTS);
    const strikeIdx = new Int32Array(buf, X.tb_strikes(), 4);
    let tracks = [];

    const backend = {
      name: 'wasm', w, h,
      bgRGB() { return bg.map((a) => a.slice()); },
      // carry the background over from another tracker (nearest neighbour, like cpuBackend.seed)
      seed(prev) {
        const src = prev.bgRGB && prev.bgRGB();
        if (!src) return false;
        for (let y = 0; y < h; y++) {
          const sy = Math.min(prev.h - 1, Math.floor((y + 0.5) * prev.h / h));
          for (let x = 0; x < w; x++) {
            const j = sy * prev.w + Math.min(prev.w - 1, Math.floor((x + 0.5) * prev.w / w)), i = y * w + x;
            bg[0][i] = src[0][j]; bg[1][i] = src[1][j]; bg[2][i] = src[2][j];
          }
        }
        return true;
      },
    };
    if (opts.seed && backend.seed(opts.seed.backend)) {
      const s = opts.seed;
      X.tb_seed(s.frames, s.nextId, s.entry[0] * w / s.w, s.entry[1] * h / s.h);
    }

    function readTracks() {
      const out = [];
      for (let k = 0, n = X.tb_track_count(); k < n; k++) {
        const f = k * TRACK_DOUBLES, i = k * TRACK_INTS + 64, len = ti[i + 2];
        out.push({ id: ti[i], x: tf[f], y: tf[f + 1], dx: tf[f + 2], dy: tf[f + 3], u: tf[f + 4], v: tf[f + 5],
          born: tf[f + 6], lastStrike: tf[f + 7], pad: ti[i + 1], strike: !!ti[i + 3],
          act: Array.from(tf.subarray(f + 8, f + 8 + len)), actT: Array.from(tf.subarray(f + 8 + HIST, f + 8 + HIST + len)),
          trav: Array.from(tf.subarray(f + 8 + 2 * HIST, f + 8 + 2 * HIST + len)) });
      }
      return out;
    }

    function process(d, now, o) {
      prof.start('copy'); // the frame into WebAssembly memory: a cost the JS tracker doesn't have
      frame.set(d);
      prof.end('copy');
      inv.set(coefOf(o.toGrid));
      const relearned = X.tb_process(now, o.sens || 6, o.rows, o.cols) === 1;
      tracks = readTracks();
      const strikes = [];
      for (let k = 0, n = X.tb_strike_count(); k < n; k++) strikes.push(tracks[strikeIdx[k]]);
      return { tips: tracks, strikes, relearned };
    }

    // identical to vision.js
    function strikingTip(now, ms) {
      let best = null, bv = 0.03;
      for (const t of tracks) {
        if (t.pad < 0 || !t.act) continue;
        let m = 0;
        for (let k = 0; k < t.act.length; k++) if (now - t.actT[k] <= ms && t.act[k] > m) m = t.act[k];
        if (m > bv) { bv = m; best = t; }
      }
      return best;
    }

    return { process, strikingTip, w, h, backend, reset() { X.tb_reset(); tracks = []; },
      get tracks() { return tracks; }, get ready() { return !!X.tb_ready(); },
      get frames() { return X.tb_frames(); }, get nextId() { return X.tb_next_id(); }, get entry() { return [X.tb_entry(0), X.tb_entry(1)]; } };
  }

  const api = { load, createTracker, get ready() { return !!mod; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.TB = root.TB || {}; root.TB.wasm = api; }
})(typeof window !== 'undefined' ? window : globalThis);
