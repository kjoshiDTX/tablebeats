// Tracker tests on synthetic frames (CPU backend, no browser): node tools/test-vision.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const V = createRequire(import.meta.url)('../js/vision.js');

// textured table + an arm from the bottom edge whose fingertip taps every 12 frames
function frame(w, h, k, tipX = 80) {
  const d = new Uint8ClampedArray(w * h * 4);
  const s = w / 256, tx = tipX * s, ty = (60 + (k % 12 < 3 ? 6 : 0)) * s;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4, n = ((x * 7 + y * 13 + k * 3) % 5) - 2;
    let r = 120 + ((x >> 3) % 2) * 10 + n, g = 90 + n, b = 70 + n;
    if (k > 20 && y > ty && Math.abs(x - tx - (y - ty) * 0.2) < (7 + (y - ty) * 0.05) * s) { r = 220; g = 170; b = 140; }
    d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
  }
  return d;
}
const opts = { toGrid: (x, y) => [x, y], rows: 3, cols: 4, sens: 6 };

let t = V.createTracker(256, 144), strikes = 0, last;
for (let k = 0; k < 200; k++) { last = t.process(frame(256, 144, k), k * 33.3, opts); strikes += last.strikes.length; }
assert.equal(last.tips.length, 1, 'one fingertip');
assert.ok(Math.abs(last.tips[0].x - 80) < 3 && Math.abs(last.tips[0].y - 61) < 5, `tip at the finger, got ${last.tips[0].x},${last.tips[0].y}`);
assert.ok(strikes >= 10, `taps detected as strikes (${strikes})`);
console.log('ok  fingertip + strikes', { strikes });

// switching resolution keeps the learned background: no relearn, the resting hand stays visible
const small = V.createTracker(128, 72, { seed: t });
const r = small.process(frame(128, 72, 200), 200 * 33.3, opts);
assert.equal(r.relearned, true, 'first frame initialises tracking state');
const r2 = small.process(frame(128, 72, 201), 201 * 33.3, opts);
assert.equal(r2.tips.length, 1, 'hand still seen after the resolution switch');
assert.ok(Math.abs(r2.tips[0].x - 40) < 3, `tip scaled to the new resolution, got ${r2.tips[0].x}`);
console.log('ok  background survives a resolution switch');

// a hand present when the background is (re)learned from scratch is invisible: what seeding avoids
const fresh = V.createTracker(128, 72);
fresh.process(frame(128, 72, 200), 0, opts);
assert.equal(fresh.process(frame(128, 72, 201), 33, opts).tips.length, 0);
console.log('ok  (control) relearning from scratch loses the hand');

// graceful degradation: over budget -> step down; comfortably under -> step back up, no flapping
const Q = createRequire(import.meta.url)('../js/quality.js');
const g = Q.createGovernor({ budgetMs: 8, window: 30 });
const px = (s) => s.w * s.h;
const run = (msAtFull, frames) => { // vision cost scales with pixel count
  const changes = [];
  for (let i = 0; i < frames; i++) if (g.take()) { const lv = g.record(msAtFull * px(g.settings) / px(Q.LEVELS[0])); if (lv >= 0) changes.push(lv); }
  return changes;
};
assert.deepEqual(run(4, 300), [], 'fast device stays at full quality');
const down = run(16, 300); // 16 ms at 256x144 (a slow phone): 192x108 is 9 ms, 160x90 is 6.3 ms
assert.equal(g.settings.w, 160, `settles at 160x90, got ${g.settings.w} via ${down}`);
assert.deepEqual(run(16, 600), [], 'stays put while the load is unchanged');
run(3, 1200);
assert.equal(g.level, 0, 'climbs back to full quality once the device is fast again');
const g2 = Q.createGovernor({ budgetMs: 8 });
for (let i = 0; i < 400; i++) if (g2.take()) g2.record(40);
assert.equal(g2.settings.every, 2, 'last resort: skip every other frame');
console.log('ok  quality governor steps down, holds, recovers, skips frames last');
