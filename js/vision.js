/* TableBeats vision: finds fingertips in low-res camera frames and detects finger strikes.
   Pure (no DOM), so it can be tested with synthetic frames in node.

   Pipeline per frame:
   1. Background model (RGB) -> foreground mask. Shadows (darker, same colour) are ignored.
      Foreground pixels learn into the background very slowly, so a resting hand stays visible.
   2. Connected blobs. The arm enters from a frame edge; the fingertip is the point of the blob
      farthest from where it enters. This is what picks the pad, not "which pad has the most hand".
   3. Each tip is tracked frame to frame with its local motion ("activity": how much the image
      changed right around the tip). A strike is a burst of activity that stops abruptly
      (the finger hits the table). The hand never has to leave the pad, so repeated taps count. */
(function (root) {
  'use strict';

  /* Background subtraction on the CPU (the reference implementation; js/gpu.js does the same in a
     WebGL fragment shader). A backend owns the background model and turns a frame into
     fg0 (raw foreground), fg (denoised foreground) and curY (luminance). */
  function cpuBackend(w, h) {
    const N = w * h;
    const bgR = new Float32Array(N), bgG = new Float32Array(N), bgB = new Float32Array(N);
    return {
      name: 'cpu', w, h,
      init(d) {
        for (let i = 0, p = 0; i < N; i++, p += 4) { bgR[i] = d[p]; bgG[i] = d[p + 1]; bgB[i] = d[p + 2]; }
      },
      // carry the background over from a backend at another resolution (nearest neighbour)
      seed(prev) {
        const src = prev.bgRGB && prev.bgRGB();
        if (!src) return false;
        for (let y = 0; y < h; y++) {
          const sy = Math.min(prev.h - 1, Math.floor((y + 0.5) * prev.h / h));
          for (let x = 0; x < w; x++) {
            const j = sy * prev.w + Math.min(prev.w - 1, Math.floor((x + 0.5) * prev.w / w)), i = y * w + x;
            bgR[i] = src[0][j]; bgG[i] = src[1][j]; bgB[i] = src[2][j];
          }
        }
        return true;
      },
      bgRGB() { return [bgR, bgG, bgB]; },
      /* thr: luminance difference that counts as "something is there". Returns the fg0 pixel count. */
      classify(d, thr, fg0, fg, curY) {
        let fgCount = 0;
        for (let i = 0, p = 0; i < N; i++, p += 4) {
          const r = d[p], g = d[p + 1], b = d[p + 2];
          const y = r * 0.3 + g * 0.59 + b * 0.11;
          curY[i] = y;
          const br = bgR[i], bgg = bgG[i], bb = bgB[i];
          const by = br * 0.3 + bgg * 0.59 + bb * 0.11;
          const dy = y - by;
          let on = 0;
          if (Math.abs(dy) > thr || Math.abs(r - br) + Math.abs(g - bgg) + Math.abs(b - bb) > thr * 2.4) {
            on = 1;
            const ratio = y / (by + 1);
            if (dy < 0 && ratio > 0.4 && ratio < 0.95) { // darker: shadow if the colour is unchanged
              const s = r + g + b + 1, bs = br + bgg + bb + 1;
              if (Math.abs(r / s - br / bs) + Math.abs(g / s - bgg / bs) < 0.045) on = 0;
            }
          }
          fg0[i] = on; fgCount += on;
        }
        // denoise: keep a pixel only if at least 2 of its 4 neighbours agree
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (!fg0[i]) { fg[i] = 0; continue; }
            const n = (x > 0 ? fg0[i - 1] : 1) + (x < w - 1 ? fg0[i + 1] : 1) + (y > 0 ? fg0[i - w] : 1) + (y < h - 1 ? fg0[i + w] : 1);
            fg[i] = n >= 2 ? 1 : 0;
          }
        }
        return fgCount;
      },
      /* background learning. Pixels on or next to a hand blob (label > 0) learn at `slow`,
         everything else at `fast`. */
      learn(d, label, fg0, fast, slow) {
        for (let i = 0, p = 0; i < N; i++, p += 4) {
          const near = label[i] > 0 || fg0[i] || (i > 0 && label[i - 1] > 0) || (i < N - 1 && label[i + 1] > 0) || (i >= w && label[i - w] > 0) || (i < N - w && label[i + w] > 0);
          const rate = near ? slow : fast;
          bgR[i] += (d[p] - bgR[i]) * rate; bgG[i] += (d[p + 1] - bgG[i]) * rate; bgB[i] += (d[p + 2] - bgB[i]) * rate;
        }
      },
    };
  }

  const NOPROF = { start() {}, end() {} };

  /* opts.backend: a background-subtraction backend for (w, h) (default: CPU).
     opts.prof: { start(name), end(name) } stage timer (js/perf.js).
     opts.seed: a previous tracker (other resolution) to inherit the background model from, so
     switching resolution doesn't relearn a hand that is in view as background. */
  function createTracker(w, h, opts) {
    opts = opts || {};
    const N = w * h;
    const be = opts.backend || cpuBackend(w, h);
    const prof = opts.prof || NOPROF;
    const curY = new Float32Array(N), prevY = new Float32Array(N); // prevY = frame ~33 ms ago
    const TICK = 28; // activity is measured over >= this many ms, so 30 and 60 fps cameras behave alike
    const fg0 = new Uint8Array(N), fg = new Uint8Array(N);
    const label = new Int32Array(N), pix = new Int32Array(N);
    const MIN_AREA = Math.max(24, Math.round(N * 0.0015));
    const MAX_TIPS = 4, HIST = 8, MATCH = 0.12 * w, REFRACT = 110;
    let ready = false, frames = 0, nextId = 1, refT = 0, lastT = 0;
    let entryX = w / 2, entryY = h; // where arms usually come from; learned from blobs touching the edge
    let tracks = [];
    let seeded = false;
    if (opts.seed && be.seed(opts.seed.backend)) {
      const s = opts.seed;
      seeded = true; frames = s.frames; nextId = s.nextId;
      entryX = s.entry[0] * w / s.w; entryY = s.entry[1] * h / s.h;
    }

    function reset() { ready = false; seeded = false; frames = 0; tracks = []; }

    /* d: RGBA pixels (w*h*4). o: { toGrid(xn,yn)->[u,v], rows, cols, sens (1..10) }.
       Returns { tips: tracks, strikes: [track...], relearned } */
    function process(d, now, o) {
      const sens = o.sens || 6;
      const thr = 34 - 2 * sens; // luminance difference that counts as "something is there"
      if (!ready) {
        if (!seeded) be.init(d);
        seeded = false;
        be.classify(d, thr, fg0, fg, curY);
        prevY.set(curY);
        ready = true; tracks = []; refT = lastT = now;
        return { tips: tracks, strikes: [], relearned: true };
      }
      frames++;
      const tick = now - refT >= TICK;
      const dt = Math.min(200, Math.max(1, now - lastT)); lastT = now;
      if (tick) { refT = now; prevY.set(curY); }
      prof.start('bgsub');
      const fgCount = be.classify(d, thr, fg0, fg, curY);
      prof.end('bgsub');
      // lighting change or camera bumped: most of the frame "changed" -> relearn the background
      if (fgCount > N * 0.55) { ready = false; frames = 0; return process(d, now, o); }

      prof.start('blobs');
      // connected blobs (4-connectivity), pixel lists stored back to back in `pix`
      label.fill(0);
      const blobs = [];
      let top = 0, nl = 0;
      for (let s = 0; s < N; s++) {
        if (!fg[s] || label[s]) continue;
        nl++;
        const start = top;
        let head = top;
        pix[top++] = s; label[s] = nl;
        let bx = 0, by2 = 0, bn = 0;
        while (head < top) {
          const i = pix[head++], x = i % w, y = (i - x) / w;
          if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { bx += x; by2 += y; bn++; }
          if (x > 0 && fg[i - 1] && !label[i - 1]) { label[i - 1] = nl; pix[top++] = i - 1; }
          if (x < w - 1 && fg[i + 1] && !label[i + 1]) { label[i + 1] = nl; pix[top++] = i + 1; }
          if (y > 0 && fg[i - w] && !label[i - w]) { label[i - w] = nl; pix[top++] = i - w; }
          if (y < h - 1 && fg[i + w] && !label[i + w]) { label[i + w] = nl; pix[top++] = i + w; }
        }
        const area = top - start;
        if (area < MIN_AREA) { for (let k = start; k < top; k++) label[pix[k]] = -1; top = start; continue; } // too small to be a hand
        blobs.push({ start, end: top, area, bx, by: by2, bn });
      }
      prof.end('blobs');
      // background learning (time based, so frame rate doesn't matter). Hands, and a 1px ring around
      // them, learn very slowly (~20 s); everything else adapts in about a second.
      prof.start('learn');
      be.learn(d, label, fg0, 1 - Math.exp(-dt / 800), 1 - Math.exp(-dt / 20000));
      prof.end('learn');
      prof.start('track');
      blobs.sort((a, b) => b.area - a.area);
      blobs.length = Math.min(blobs.length, MAX_TIPS);

      // fingertip of each blob = the part farthest from where the arm enters the frame
      const found = [];
      for (const bl of blobs) {
        let ex = entryX, ey = entryY;
        if (bl.bn > 2) {
          ex = bl.bx / bl.bn; ey = bl.by / bl.bn;
          if (bl.area > MIN_AREA * 4) { entryX += (ex - entryX) * 0.05; entryY += (ey - entryY) * 0.05; } // only arms teach it
        }
        let dmax = 0;
        for (let k = bl.start; k < bl.end; k++) {
          const i = pix[k], x = i % w, y = (i - x) / w, dd = (x - ex) * (x - ex) + (y - ey) * (y - ey);
          if (dd > dmax) dmax = dd;
        }
        const cut = Math.max(0, Math.sqrt(dmax) - 2.5), cut2 = cut * cut;
        let sx = 0, sy = 0, sn = 0;
        for (let k = bl.start; k < bl.end; k++) {
          const i = pix[k], x = i % w, y = (i - x) / w;
          if ((x - ex) * (x - ex) + (y - ey) * (y - ey) >= cut2) { sx += x; sy += y; sn++; }
        }
        found.push({ x: sx / sn, y: sy / sn });
      }

      // match tips to existing tracks (nearest first)
      const next = [], used = new Set();
      const pairs = [];
      found.forEach((f, fi) => tracks.forEach((t, ti) => { const dd = Math.hypot(f.x - t.x, f.y - t.y); if (dd < MATCH) pairs.push([dd, fi, ti]); }));
      pairs.sort((a, b) => a[0] - b[0]);
      const fTaken = new Set();
      for (const [, fi, ti] of pairs) {
        if (fTaken.has(fi) || used.has(ti)) continue;
        fTaken.add(fi); used.add(ti);
        const t = tracks[ti], f = found[fi];
        t.dx += f.x - t.x; t.dy += f.y - t.y; t.x = f.x; t.y = f.y;
        next.push(t);
      }
      found.forEach((f, fi) => {
        if (!fTaken.has(fi)) next.push({ id: nextId++, x: f.x, y: f.y, dx: 0, dy: 0, act: [], actT: [], trav: [], born: now, lastStrike: 0, u: -1, v: -1, pad: -1 });
      });
      tracks = next;

      // per track: grid position, local activity, strike detection
      const rad = Math.max(3, Math.round(w * 0.03));
      const mthr = Math.max(8, thr * 0.55);
      const hi = 0.30 - 0.022 * sens, lo = hi * 0.35;
      const strikes = [];
      for (const t of tracks) {
        const [u, v] = o.toGrid((t.x + 0.5) / w, (t.y + 0.5) / h);
        t.u = u; t.v = v;
        t.pad = u >= 0 && u < 1 && v >= 0 && v < 1 ? Math.floor(v * o.rows) * o.cols + Math.floor(u * o.cols) : -1;
        if (!tick) continue;
        const cx = Math.round(t.x), cy = Math.round(t.y);
        let moved = 0, cnt = 0;
        for (let y = Math.max(0, cy - rad); y <= Math.min(h - 1, cy + rad); y++) {
          for (let x = Math.max(0, cx - rad); x <= Math.min(w - 1, cx + rad); x++) {
            const i = y * w + x; cnt++;
            if (Math.abs(curY[i] - prevY[i]) > mthr) moved++;
          }
        }
        const travel = Math.hypot(t.dx, t.dy); t.dx = t.dy = 0;
        const a = Math.min(1, Math.max(moved / cnt, travel / (w * 0.05)));
        t.act.push(a); t.actT.push(now); t.trav.push(travel);
        if (t.act.length > HIST) { t.act.shift(); t.actT.shift(); t.trav.shift(); }
        /* strike = a short, sharp burst of activity that stops dead (the table stops the finger).
           Lifting the finger is slower (a longer burst), and a hand sliding in travels far; neither counts. */
        const n = t.act.length;
        t.strike = false;
        if (n >= 3 && frames > 10 && t.pad >= 0 && now - t.lastStrike > REFRACT && a <= t.act[n - 2] * 0.45) {
          let len = 0, peak = 0, travel2 = 0;
          for (let k = n - 2; k >= 0 && t.act[k] > lo; k--) { len++; peak = Math.max(peak, t.act[k]); travel2 += t.trav[k]; }
          if (len >= 1 && len <= 2 && peak >= hi && travel2 < w * 0.06) { t.strike = true; t.lastStrike = now; strikes.push(t); }
        }
      }
      prof.end('track');
      return { tips: tracks, strikes, relearned: false };
    }

    /* The finger that just hit the table: the tip over a pad with the most activity in the last
       `ms` milliseconds. Used when the microphone hears a tap. */
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

    return { process, reset, strikingTip, w, h, backend: be, get tracks() { return tracks; }, get ready() { return ready; },
      get frames() { return frames; }, get nextId() { return nextId; }, get entry() { return [entryX, entryY]; } };
  }

  const api = { createTracker, cpuBackend };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.TB = root.TB || {}; root.TB.vision = api; }
})(typeof window !== 'undefined' ? window : globalThis);
