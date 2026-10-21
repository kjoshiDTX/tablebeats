/* TableBeats perf: per-stage timers for the vision pipeline.
   Each stage keeps its last 240 durations (for p50/p95 in the debug overlay and the benchmark).
   With `trace` on, every stage is also a User Timing measure named "tb:<stage>", which shows up
   as a slice in a Chrome trace (category blink.user_timing) and so in Perfetto. */
(function (root) {
  'use strict';
  const LEN = 240;
  const now = () => performance.now();
  const open = {}, rings = {};

  function record(name, ms) {
    let r = rings[name];
    if (!r) r = rings[name] = { a: new Float64Array(LEN), n: 0 };
    r.a[r.n % LEN] = ms; r.n++;
  }

  const perf = {
    trace: false,
    start(name) { open[name] = now(); },
    end(name) {
      const t1 = now(), t0 = open[name];
      if (t0 === undefined) return 0;
      open[name] = undefined;
      perf.record(name, t1 - t0); // via perf so the benchmark can hook it
      if (perf.trace) performance.measure('tb:' + name, { start: t0, end: t1 });
      return t1 - t0;
    },
    record,
    // measures stay in the performance timeline until cleared; the trace already has them
    flush() { if (perf.trace) performance.clearMeasures(); },
    // { n, mean, p50, p95, max } over the last LEN samples (null if none yet)
    stats(name) {
      const r = rings[name];
      if (!r || !r.n) return null;
      const v = Array.from(r.a.subarray(0, Math.min(r.n, LEN))).sort((x, y) => x - y);
      const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
      return { n: v.length, mean: v.reduce((s, x) => s + x, 0) / v.length, p50: q(0.5), p95: q(0.95), max: v[v.length - 1] };
    },
    reset() { for (const k in rings) delete rings[k]; },
  };

  root.TB = root.TB || {}; root.TB.perf = perf;
})(typeof window !== 'undefined' ? window : globalThis);
