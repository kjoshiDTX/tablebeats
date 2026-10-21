/* TableBeats vision benchmark. Draws a deterministic scene (frame k always looks the same), streams it
   into a <video> with captureStream, and runs the app's pipeline (js/pipeline.js) once per display
   frame. Results land in window.__bench for tools/bench/run.mjs (puppeteer + Chrome tracing). */
(function () {
  'use strict';
  const { pipeline, perf, core } = window.TB;
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const PW = 256, PH = 144, SW = 1280, SH = 720, WARMUP = 60;
  const STAGES = ['vision', 'capture', 'bgsub', 'blobs', 'learn', 'track'];

  /* ---------- synthetic camera ---------- */
  /* CPU-backed on purpose (and so are the canvases drawn into it): captureStream() of a GPU canvas reads every frame back on the GPU
     process's main thread (RasterDecoderImpl::DoReadbackARGBImagePixels in the trace), and the GPU
     backend's readPixels queued behind it for up to 140 ms. A real camera hands Chrome GPU frames
     with no readback, so that stall was the benchmark's, not the app's. */
  const scene = $('scene'), sx = scene.getContext('2d', { willReadFrequently: true });
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const table = document.createElement('canvas'); table.width = SW; table.height = SH;
  (function paintTable() { // wood-ish grain + a lamp gradient
    const t = table.getContext('2d', { willReadFrequently: true }); // CPU, like the scene canvas
    t.fillStyle = '#8a5a3c'; t.fillRect(0, 0, SW, SH);
    for (let i = 0; i < 260; i++) {
      t.strokeStyle = `rgba(${40 + rnd() * 60},${20 + rnd() * 30},10,${0.08 + rnd() * 0.12})`;
      t.lineWidth = 1 + rnd() * 6; const y = rnd() * SH;
      t.beginPath(); t.moveTo(0, y); t.bezierCurveTo(SW * 0.3, y + rnd() * 40 - 20, SW * 0.7, y + rnd() * 40 - 20, SW, y + rnd() * 30 - 15); t.stroke();
    }
    const g = t.createRadialGradient(SW * 0.4, SH * 0.2, 50, SW * 0.5, SH * 0.5, SW * 0.8);
    g.addColorStop(0, 'rgba(255,240,210,.25)'); g.addColorStop(1, 'rgba(0,0,0,.35)');
    t.fillStyle = g; t.fillRect(0, 0, SW, SH);
  })();
  const noise = [0, 1, 2, 3].map(() => { // sensor noise, cycled
    const c = document.createElement('canvas'); c.width = SW / 2; c.height = SH / 2;
    const n = c.getContext('2d', { willReadFrequently: true }), im = n.createImageData(c.width, c.height);
    for (let i = 0; i < im.data.length; i += 4) { const v = rnd() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 18; }
    n.putImageData(im, 0, 0); return c;
  });
  // a fingertip path over a 3x4 pad grid: glide to a pad, tap it 3 times, move on
  function tip(k, phase, x0) {
    const pad = Math.floor((k + phase) / 90) % 6, local = (k + phase) % 90;
    const px = x0 + (pad % 3) * 170, py = 230 + Math.floor(pad / 3) * 150;
    const tap = local > 30 && local % 14 < 3 ? 18 : 0;
    return [px + Math.sin(k / 23 + phase) * 12, py + tap];
  }
  function arm(x, y, ex, ey, shade) {
    sx.save(); sx.lineCap = 'round';
    sx.strokeStyle = 'rgba(0,0,0,.28)'; sx.lineWidth = 70; // shadow on the table
    sx.beginPath(); sx.moveTo(ex + 40, ey); sx.lineTo(x + 30, y + 26); sx.stroke();
    sx.strokeStyle = shade; sx.lineWidth = 64;
    sx.beginPath(); sx.moveTo(ex, ey); sx.lineTo(x, y + 40); sx.stroke();
    sx.lineWidth = 26; sx.beginPath(); sx.moveTo(x, y + 40); sx.lineTo(x, y); sx.stroke(); // finger
    sx.restore();
  }
  function drawScene(k) {
    sx.drawImage(table, 0, 0);
    sx.globalCompositeOperation = 'overlay'; sx.drawImage(noise[k % 4], 0, 0, SW, SH); sx.globalCompositeOperation = 'source-over';
    if (k > 20) {
      const [ax, ay] = tip(k, 0, 300); arm(ax, ay, ax - 120, SH + 40, '#d9a07e');
      const [bx, by] = tip(k, 45, 420); if (k > 200) arm(bx, by, bx + 160, SH + 40, '#c98d6b');
    }
  }

  /* ---------- run ---------- */
  const video = $('video');
  async function startVideo() {
    if (video.srcObject) return;
    drawScene(0);
    video.srcObject = scene.captureStream(60);
    await video.play();
  }

  const Mn = core.squareToQuad([{ x: 0.18, y: 0.28 }, { x: 0.82, y: 0.28 }, { x: 0.94, y: 0.88 }, { x: 0.06, y: 0.88 }]);
  const opts = { toGrid: core.invertMap(Mn), rows: 3, cols: 4, sens: 6 };
  const pct = (v, p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  function summarize(a) {
    const v = a.slice().sort((x, y) => x - y);
    return { n: v.length, mean: v.reduce((s, x) => s + x, 0) / v.length, p50: pct(v, 0.5), p95: pct(v, 0.95), max: v[v.length - 1] };
  }

  async function run(backend, frames) {
    await startVideo();
    perf.trace = true;
    const [be, readback] = backend.split('-'); // cpu | gpu | gpu-async
    const pipe = pipeline.create({ video, w: PW, h: PH, backend: be, readback });
    const samples = {}; STAGES.forEach((s) => (samples[s] = []));
    const rec = perf.record;
    let k = 0, measuring = false, tips = 0, strikes = 0;
    perf.record = (name, ms) => { rec(name, ms); if (measuring && samples[name]) samples[name].push(ms); };
    $('status').textContent = `${backend.toUpperCase()}: running…`;
    performance.mark('bench:' + backend + ':start');
    await new Promise((done) => {
      const step = () => {
        drawScene(k);
        measuring = k >= WARMUP;
        if (k === WARMUP) performance.mark('bench:measure'); // tools/trace/stages.py starts here
        const res = pipe.frame(performance.now(), opts, false, false);
        if (measuring) { tips += res.tips.length; strikes += res.strikes.length; }
        k++;
        if (k >= WARMUP + frames) return done();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step); // one frame per display frame (requestVideoFrameCallback never fires headless)
    });
    performance.mark('bench:' + backend + ':end');
    perf.record = rec;
    const out = { backend: pipe.backend, renderer: pipe.renderer, frames, tips, strikes, stages: {} };
    if (pipe.tracker.backend.readback === 'async') out.extra = `blocked on ${pipe.tracker.backend.blocked} of ${WARMUP + frames} frames`;
    STAGES.forEach((s) => { if (samples[s].length) out.stages[s] = summarize(samples[s]); });
    show(out);
    return out;
  }

  function show(r) {
    const body = $('results').tBodies[0];
    STAGES.forEach((s) => {
      const v = r.stages[s]; if (!v) return;
      const tr = document.createElement('tr');
      [s === 'vision' ? r.backend.toUpperCase() : '', s === 'vision' ? r.renderer : '', s,
        v.mean.toFixed(3), v.p50.toFixed(3), v.p95.toFixed(3), v.max.toFixed(3)].forEach((x) => {
        const td = document.createElement('td'); td.textContent = x; tr.appendChild(td);
      });
      if (s === 'vision') tr.style.fontWeight = '600';
      body.appendChild(tr);
    });
  }

  window.__bench = { run, results: [], done: false };
  async function runAll(list) {
    const frames = +q.get('frames') || +$('framesIn').value || 600;
    $('runBtn').disabled = true;
    for (const b of list) window.__bench.results.push(await run(b, frames));
    $('status').textContent = 'done';
    $('runBtn').disabled = false;
    window.__bench.done = true;
  }
  const ALL = ['cpu', 'gpu', 'gpu-async'];
  $('runBtn').onclick = () => runAll(ALL);
  if (q.has('run')) runAll(q.get('backend') ? [q.get('backend')] : ALL);
})();
