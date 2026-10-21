/* TableBeats quality governor: keeps vision inside its frame budget on slow devices.
   Watches the p95 vision time over a short window and walks a ladder of cheaper settings:
   lower processing resolution first (background subtraction, blobs and learning scale with the
   pixel count), then, if even the smallest image is over budget, processing only every other
   camera frame (halves the load on the main thread; each processed frame costs the same).
   Not on the ladder: the camera resolution. Getting a frame is mostly a fixed cost per frame
   (asking for 640x360 instead of 1280x720 saved only 25% of it) and it cost ~40% of the strikes. Steps back up only when the level above is
   predicted to fit with room to spare, for a while (hysteresis, so it doesn't oscillate).
   Pure (no DOM): fed one number per camera frame, testable in node. */
(function (root) {
  'use strict';

  // w*h of the processing image and how many camera frames per processed frame
  const LEVELS = [
    { w: 256, h: 144, every: 1 },
    { w: 192, h: 108, every: 1 },
    { w: 160, h: 90, every: 1 },
    { w: 128, h: 72, every: 1 },
    { w: 128, h: 72, every: 2 },
  ];

  /* budgetMs: p95 vision time per processed frame we can afford. window: frames per decision. */
  function createGovernor({ budgetMs = 8, window = 30, levels = LEVELS } = {}) {
    let level = 0, n = 0, frame = 0, calm = 0;
    const win = [];

    // how much more the level above costs, as if all of it scaled with the pixel count (the
    // fixed per-frame part doesn't, so this overestimates: we step up a little late, never early)
    const upRatio = (l) => levels[l - 1].w * levels[l - 1].h / (levels[l].w * levels[l].h);
    const p95 = () => { const v = win.slice().sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(0.95 * v.length))]; };

    return {
      get level() { return level; },
      get settings() { return levels[level]; },
      levels,
      budgetMs,
      // should this camera frame be processed?
      take() { return frame++ % levels[level].every === 0; },
      /* report a processed frame's vision time. Returns the new level if it changed, else -1. */
      record(ms) {
        win.push(ms); if (win.length > window) win.shift();
        if (++n < window) return -1; // a full window at this level before deciding
        const q = p95();
        if (q > budgetMs && level < levels.length - 1) { level++; n = 0; win.length = 0; calm = 0; return level; }
        // up only if the level above would still be under 70% of the budget, for 3 windows'
        // worth of frames in a row
        if (level > 0) {
          const predicted = q * upRatio(level);
          calm = predicted < budgetMs * 0.7 ? calm + 1 : 0;
          if (calm >= 3 * window) { level--; n = 0; win.length = 0; calm = 0; return level; }
        }
        return -1;
      },
      reset() { level = 0; n = 0; frame = 0; calm = 0; win.length = 0; },
    };
  }

  const api = { createGovernor, LEVELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.TB = root.TB || {}; root.TB.quality = api; }
})(typeof window !== 'undefined' ? window : globalThis);
