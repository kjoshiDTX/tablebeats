/* TableBeats app: camera -> fingertip tracking -> sound, loop recorder, UI.
   Two ways a tap registers:
   - Tap (default): the mic hears the tap (exact timing, every tap counts), the camera's fingertip
     tracker says which pad. The mic polls on a 4 ms timer, so a tap sounds almost instantly.
   - Camera only: the tracker fires when a fingertip makes a short, sharp strike (js/vision.js). */
(function () {
  'use strict';
  const { core, Engine, SOUNDS, pipeline, perf } = window.TB;
  const $ = (id) => document.getElementById(id);
  const engine = new Engine();

  /* ================= state ================= */
  const STORE = 'tablebeats.v1';
  const DEFAULT_CORNERS = [{ x: 0.18, y: 0.28 }, { x: 0.82, y: 0.28 }, { x: 0.94, y: 0.88 }, { x: 0.06, y: 0.88 }];
  function defaults() {
    const pre = core.buildPreset('Mini DJ set', 9, 'Minor pentatonic');
    return {
      rows: pre.rows, cols: pre.cols, pads: pre.pads,
      corners: DEFAULT_CORNERS.map((c) => ({ ...c })),
      flipX: false, flipY: false, locked: false, mode: 'knock', detectV: 2, sens: 6, debug: false, backend: 'auto',
      bpm: 100, bars: 2, quant: true, metro: true,
      keyRoot: 9, scale: 'Minor pentatonic', preset: 'Mini DJ set', reverb: 0.18, master: 0.9,
    };
  }
  function load() {
    try {
      const j = JSON.parse(localStorage.getItem(STORE));
      if (j && j.pads && j.corners && j.corners.length === 4 && j.rows && j.cols && j.pads.length === j.rows * j.cols) {
        if (!j.detectV) { j.detectV = 2; j.mode = 'knock'; } // new tap detection: switch old saves to Tap mode once
        return Object.assign(defaults(), j);
      }
    } catch (e) { /* ignore */ }
    return defaults();
  }
  const S = load();
  let sel = 0;
  let saveTimer;
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } }, 300); };

  const soundDef = (id) => SOUNDS.find((s) => s.id === id) || SOUNDS[0];
  const padName = (p) => p.label || (p.sound === 'none' ? '' : soundDef(p.sound).name);

  /* ================= geometry ================= */
  const tl = $('timeline'), tctx = tl.getContext('2d');
  const TL_W = 1200, TL_GUT = 104, TL_HEAD = 22, TL_ROWH = 24;
  const W = 960, H = 540, PW = 256, PH = 144;
  let Mn, toGrid, quads = [];
  const pv = []; // per-pad display state
  function rebuildGeom() {
    Mn = core.squareToQuad(S.corners);
    toGrid = core.invertMap(Mn);
    quads = [];
    for (let r = 0; r < S.rows; r++) {
      for (let c = 0; c < S.cols; c++) quads.push(core.padQuad(Mn, S.rows, S.cols, r, c).map(([x, y]) => [x * W, y * H]));
    }
    while (pv.length < quads.length) pv.push({ flash: 0 });
    pv.length = quads.length;
    const th = TL_HEAD + quads.length * TL_ROWH;
    if (tl.height !== th) tl.height = th; // resizing clears the canvas, so only when the grid size changes
  }

  /* ================= audio glue ================= */
  let audioReady = false;
  function ensureAudio() {
    engine.init();
    if (!audioReady) { audioReady = true; engine.setMaster(S.master); engine.setReverb(S.reverb); }
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, ensureAudio, { once: true, capture: true }));

  function hit(i) {
    const p = S.pads[i]; if (!p) return;
    engine.trigger(p, 0, 1); // fire first: nothing before this line may add latency
    pv[i].flash = performance.now();
    if (T.recording) recordEvent(i);
  }

  /* ================= camera + vision ================= */
  const video = $('video');
  const stage = $('stage'), sctx = stage.getContext('2d');
  // vision runs on the GPU (WebGL shaders) when it can, else on the CPU; see js/pipeline.js
  const pipe = pipeline.create({ video, w: PW, h: PH, backend: S.backend, readback: /[?&]readback=async\b/.test(location.search) ? 'async' : 'sync' });
  perf.trace = S.debug || /[?&]trace\b/.test(location.search); // stage timings as User Timing (Perfetto)
  let camOn = false, stream = null;

  async function startCamera(deviceId) {
    const msg = $('stageMsg');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg.innerHTML = 'Camera needs a local server.<br>Double-click <b>start.command</b> (or run <code>python3 -m http.server 8123</code>) and open <b>http://localhost:8123</b>.';
      msg.hidden = false; return;
    }
    ensureAudio();
    try {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      // ask for the highest frame rate available (lower latency); never *require* anything
      const v = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } };
      if (deviceId) v.deviceId = { ideal: deviceId };
      try { stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false }); }
      catch (err) { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
      video.srcObject = stream;
      await video.play();
      camOn = true; pipe.reset();
      if (S.mode === 'knock') enableMic();
      $('stageMsg').hidden = true;
      $('startBtn').textContent = 'Restart camera';
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const cs = $('cameraSel');
      const cur = stream.getVideoTracks()[0].getSettings().deviceId;
      cs.innerHTML = '';
      devs.forEach((d, k) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || 'Camera ' + (k + 1); cs.appendChild(o); });
      if (cur) cs.value = cur;
      startVisionLoop();
    } catch (e) {
      msg.innerHTML = 'Could not open the camera: ' + (e.name || e.message) + '.<br>Allow camera access for this page and try again.';
      msg.hidden = false;
    }
  }

  let visionLoopOn = false;
  function startVisionLoop() {
    if (visionLoopOn) return;
    visionLoopOn = true;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const cb = (now) => { if (camOn) vision(now); video.requestVideoFrameCallback(cb); };
      video.requestVideoFrameCallback(cb);
    } else {
      const loop = () => { if (camOn && video.readyState >= 2) vision(performance.now()); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
  }

  let visMs = 0;
  function vision() {
    if (video.readyState < 2) return;
    const t0 = performance.now();
    const res = pipe.frame(t0, { toGrid, rows: S.rows, cols: S.cols, sens: S.sens }, S.flipX, S.flipY);
    if (S.mode === 'motion') for (const t of res.strikes) { hit(t.pad); lastTapMark = { x: t.x, y: t.y, t: t0 }; }
    visMs = visMs * 0.9 + res.ms * 0.1;
  }

  /* ================= tap (microphone) detection =================
     The mic decides WHEN (a tap on a table is a sharp click), the fingertip tracker decides WHERE.
     The app's own sound also reaches the mic through the speakers, so we watch what we're playing
     (outAn) and learn how loud that echo is; a mic click must be clearly louder than the echo. */
  let micOn = false, micAn = null, micBuf = null, micStream = null, micTimer = 0, floor = 0.01, lastKnock = 0, micLevel = 0;
  let outAn = null, outBuf = null, outHold = 0, echoGain = 0.5, micEnv = 0, lastTapMark = null;
  async function enableMic() {
    if (micOn) return;
    ensureAudio();
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const src = engine.ctx.createMediaStreamSource(micStream);
      micAn = engine.ctx.createAnalyser(); micAn.fftSize = 256; micAn.smoothingTimeConstant = 0;
      micBuf = new Float32Array(micAn.fftSize);
      src.connect(micAn);
      if (!outAn) {
        outAn = engine.ctx.createAnalyser(); outAn.fftSize = 256; outAn.smoothingTimeConstant = 0;
        outBuf = new Float32Array(outAn.fftSize);
        engine.master.connect(outAn);
      }
      micOn = true;
      $('micNote').textContent = 'Listening. Tap the table with a fingertip; the camera picks the pad under that finger.';
      micTimer = setInterval(micStep, 4);
    } catch (e) {
      $('micNote').textContent = 'Microphone unavailable (' + (e.name || 'error') + '). Falling back to camera-only mode.';
      S.mode = 'motion'; syncUI();
    }
  }
  function disableMic() {
    if (!micOn) return;
    clearInterval(micTimer); micOn = false;
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
  }
  const peakOf = (buf) => { let m = 0; for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > m) m = a; } return m; };
  function micStep() {
    micAn.getFloatTimeDomainData(micBuf);
    outAn.getFloatTimeDomainData(outBuf);
    const peak = peakOf(micBuf), now = performance.now();
    outHold = Math.max(peakOf(outBuf), outHold * 0.94); // our own output, held ~100 ms to cover speaker delay
    micLevel = Math.max(peak, micLevel * 0.95);
    if (peak < floor * 2 + 0.02) floor = floor * 0.995 + peak * 0.005;
    const prevEnv = micEnv;
    micEnv = Math.max(peak, micEnv * 0.85);
    const moving = pipe.tracker.strikingTip(now, 300);
    // hands still but the mic hears our sound: that's pure speaker echo, learn its level
    if (!moving && outHold > 0.01) echoGain = Math.max(echoGain * 0.9997, Math.min(4, peak / outHold));
    else echoGain *= 0.99995;
    if (S.mode !== 'knock') return;
    const thr = Math.max(0.02, floor * 3) * (1.6 - 0.1 * S.sens);
    // a tap = sudden rise (not a sustained sound), above the noise floor and above the speaker echo
    if (peak > thr && peak > prevEnv * 1.8 && peak > echoGain * outHold * 1.5 && now - lastKnock > 60) {
      lastKnock = now;
      const tip = pipe.tracker.strikingTip(now, 220);
      if (tip) { hit(tip.pad); lastTapMark = { x: tip.x, y: tip.y, t: now }; }
    }
  }

  /* ================= loop recorder ================= */
  const T = { running: false, recording: false, start: 0, nextBeat: 0, schedFrom: 0, events: [], layers: [], layerId: 0 };
  const beatDur = () => 60 / S.bpm;
  const loopBeats = () => S.bars * 4;
  let schedTimer = 0;

  function tStart(countIn) {
    ensureAudio();
    const c = engine.ctx, bd = beatDur();
    const now = c.currentTime + 0.06;
    T.start = now + (countIn ? 4 * bd : 0);
    T.schedFrom = now;
    T.nextBeat = countIn ? -4 : 0;
    T.running = true;
    clearInterval(schedTimer);
    schedTimer = setInterval(schedule, 20);
    schedule();
  }
  function tStop() { T.running = false; T.recording = false; clearInterval(schedTimer); }

  function schedule() {
    if (!T.running) return;
    const c = engine.ctx, bd = beatDur(), len = bd * loopBeats();
    const horizon = c.currentTime + 0.1;
    for (;;) {
      const tm = T.start + T.nextBeat * bd;
      if (tm >= horizon) break;
      if (S.metro && tm >= c.currentTime - 0.01) engine.click(tm, ((T.nextBeat % 4) + 4) % 4 === 0);
      T.nextBeat++;
    }
    const a = T.schedFrom, b = horizon;
    if (b > T.start && T.events.length) {
      const k0 = Math.max(0, Math.floor((a - T.start) / len)), k1 = Math.floor((b - T.start) / len);
      for (let k = k0; k <= k1; k++) {
        for (const ev of T.events) {
          const tm = T.start + k * len + ev.beat * bd;
          if (tm >= a && tm < b && ev.rec !== k) {
            const pad = S.pads[ev.pad];
            if (pad) {
              engine.trigger(pad, tm, ev.vel);
              const delay = Math.max(0, (tm - c.currentTime) * 1000);
              setTimeout(() => { if (pv[ev.pad]) pv[ev.pad].flash = performance.now(); }, delay);
            }
          }
        }
      }
    }
    T.schedFrom = b;
  }

  function recordEvent(i) {
    if (!T.running) return;
    const c = engine.ctx, bd = beatDur(), lb = loopBeats();
    const raw = (c.currentTime - T.start) / bd;
    if (raw < 0) return; // still counting in
    let k = Math.floor(raw / lb), within = raw - k * lb;
    if (S.quant) { within = Math.round(within * 4) / 4; if (within >= lb) { within = 0; k++; } }
    T.events.push({ pad: i, beat: within, vel: 1, layer: T.layerId, rec: k });
  }

  function syncTransportButtons() {
    $('recBtn').classList.toggle('active', T.recording);
    $('recBtn').textContent = T.recording ? '● Recording' : '● Record';
    $('playBtn').textContent = T.running ? '■ Stop' : '▶ Play loop';
  }
  $('recBtn').onclick = () => {
    ensureAudio();
    if (T.recording) { T.recording = false; }
    else {
      if (!T.running) tStart(true);
      T.recording = true; T.layerId++; T.layers.push(T.layerId);
    }
    syncTransportButtons();
  };
  $('playBtn').onclick = () => {
    ensureAudio();
    if (T.running) tStop(); else tStart(false);
    syncTransportButtons();
  };
  $('undoBtn').onclick = () => {
    const id = T.layers.pop();
    if (id != null) T.events = T.events.filter((e) => e.layer !== id);
  };
  $('clearBtn').onclick = () => { T.events = []; T.layers = []; };

  function updateTransportUI() {
    const el = $('loopStatus');
    if (!T.running) { el.textContent = T.events.length ? `Loop ready · ${T.events.length} hits` : 'No loop yet — press Record, then tap'; $('posFill').style.width = '0%'; return; }
    const c = engine.ctx, bd = beatDur(), len = bd * loopBeats();
    const pos = (c.currentTime - T.start) / len;
    if (pos < 0) { el.textContent = 'Count-in… ' + Math.ceil(-pos * loopBeats()); $('posFill').style.width = '0%'; return; }
    $('posFill').style.width = ((pos - Math.floor(pos)) * 100).toFixed(1) + '%';
    el.textContent = `${T.recording ? 'Recording' : 'Playing'} · ${S.bars} bar${S.bars > 1 ? 's' : ''} · ${T.events.length} hits`;
  }

  /* ================= session recording (to audio file) ================= */
  let sessOn = false, sessT0 = 0;
  $('sessBtn').onclick = async () => {
    ensureAudio();
    if (!sessOn) { engine.startRecording(); sessOn = true; sessT0 = performance.now(); $('sessBtn').classList.add('active'); $('sessBtn').textContent = '■ Stop & save take'; }
    else {
      sessOn = false; $('sessBtn').classList.remove('active'); $('sessBtn').textContent = '⏺ Record session';
      $('sessTime').textContent = '';
      const r = await engine.stopRecording();
      const n = $('takes').children.length + 1;
      const name = `tablebeats-take-${n}.${r.ext}`;
      const div = document.createElement('div'); div.className = 'take';
      const au = document.createElement('audio'); au.controls = true; au.src = r.url;
      const a = document.createElement('a'); a.href = r.url; a.download = name; a.textContent = 'Download ' + name;
      div.append(au, a); $('takes').prepend(div);
    }
  };

  /* ================= drawing ================= */
  function drawStage(now) {
    if (camOn && video.readyState >= 2) {
      sctx.save();
      if (S.flipX) { sctx.translate(W, 0); sctx.scale(-1, 1); }
      if (S.flipY) { sctx.translate(0, H); sctx.scale(1, -1); }
      sctx.drawImage(video, 0, 0, W, H);
      sctx.restore();
    } else {
      const g = sctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#20232b'); g.addColorStop(1, '#14161b');
      sctx.fillStyle = g; sctx.fillRect(0, 0, W, H);
    }
    const n = quads.length;
    const tips = camOn ? pipe.tracker.tracks : [];
    const tipPads = new Set(tips.map((t) => t.pad).filter((p) => p >= 0));
    sctx.lineJoin = 'round';
    for (let i = 0; i < n; i++) {
      const q = quads[i], p = S.pads[i], v = pv[i];
      const hue = (i * 360 / n) % 360;
      const f = Math.max(0, 1 - (now - v.flash) / 260);
      let alpha = 0.14 + 0.55 * f;
      if (tipPads.has(i)) alpha += 0.12;
      sctx.beginPath();
      sctx.moveTo(q[0][0], q[0][1]);
      for (let k = 1; k < 4; k++) sctx.lineTo(q[k][0], q[k][1]);
      sctx.closePath();
      sctx.fillStyle = `hsla(${hue},85%,58%,${alpha})`; sctx.fill();
      sctx.lineWidth = i === sel ? 3.5 : 1.5;
      sctx.strokeStyle = i === sel ? '#fff' : 'rgba(255,255,255,.55)'; sctx.stroke();
      const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
      const name = padName(p);
      if (name) {
        sctx.font = '600 17px system-ui, sans-serif'; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
        sctx.lineWidth = 4; sctx.strokeStyle = 'rgba(0,0,0,.7)'; sctx.strokeText(name, cx, cy);
        sctx.fillStyle = '#fff'; sctx.fillText(name, cx, cy);
      }
      const key = KEYMAP_REV[i];
      if (key) {
        sctx.font = '11px ui-monospace, monospace'; sctx.textAlign = 'left'; sctx.textBaseline = 'top';
        sctx.fillStyle = 'rgba(255,255,255,.8)'; sctx.fillText(key.toUpperCase(), q[0][0] + 6, q[0][1] + 5);
      }
    }
    // fingertips the camera sees: this is the spot a tap will land on
    const sx = W / PW, sy = H / PH;
    for (const t of tips) {
      const x = (t.x + 0.5) * sx, y = (t.y + 0.5) * sy, over = t.pad >= 0;
      sctx.beginPath(); sctx.arc(x, y, 9, 0, Math.PI * 2);
      sctx.lineWidth = 2.5; sctx.strokeStyle = over ? '#fff' : 'rgba(255,255,255,.35)'; sctx.stroke();
      sctx.beginPath(); sctx.arc(x, y, 2.5, 0, Math.PI * 2); sctx.fillStyle = over ? '#fff' : 'rgba(255,255,255,.35)'; sctx.fill();
      if (S.debug && t.act.length) {
        const a = t.act[t.act.length - 1];
        sctx.fillStyle = 'rgba(0,0,0,.6)'; sctx.fillRect(x + 13, y - 20, 8, 40);
        sctx.fillStyle = '#ffd23f'; sctx.fillRect(x + 13, y + 20 - 40 * a, 8, 40 * a);
      }
    }
    if (lastTapMark && now - lastTapMark.t < 250) {
      const k = (now - lastTapMark.t) / 250;
      sctx.beginPath(); sctx.arc((lastTapMark.x + 0.5) * sx, (lastTapMark.y + 0.5) * sy, 10 + 26 * k, 0, Math.PI * 2);
      sctx.lineWidth = 3; sctx.strokeStyle = `rgba(255,210,63,${1 - k})`; sctx.stroke();
    }
    if (S.debug && camOn) {
      sctx.font = '12px ui-monospace, monospace'; sctx.textAlign = 'left'; sctx.textBaseline = 'bottom';
      const st = (k) => { const v = perf.stats(k); return v ? `${k} ${v.p50.toFixed(2)}/${v.p95.toFixed(2)}` : ''; };
      const lines = [
        `vision ${visMs.toFixed(1)} ms on ${pipe.backend.toUpperCase()} · tips ${tips.length}` + (micOn ? ` · echo ${echoGain.toFixed(2)}` : ''),
        'p50/p95 ms: ' + ['vision', 'capture', 'bgsub', 'blobs', 'learn', 'track'].map(st).filter(Boolean).join(' · '),
      ];
      lines.forEach((info, k) => {
        const y = H - 9 - (lines.length - 1 - k) * 20;
        sctx.fillStyle = 'rgba(0,0,0,.6)'; sctx.fillRect(6, y - 15, sctx.measureText(info).width + 12, 18);
        sctx.fillStyle = '#fff'; sctx.fillText(info, 12, y);
      });
    }
    if (!S.locked) {
      S.corners.forEach((c, k) => {
        sctx.beginPath(); sctx.arc(c.x * W, c.y * H, 11, 0, Math.PI * 2);
        sctx.fillStyle = '#ffd23f'; sctx.fill(); sctx.lineWidth = 2; sctx.strokeStyle = '#111'; sctx.stroke();
        sctx.fillStyle = '#111'; sctx.font = '700 12px system-ui'; sctx.textAlign = 'center'; sctx.textBaseline = 'middle';
        sctx.fillText(String(k + 1), c.x * W, c.y * H + 1);
      });
    }
  }
  /* ================= timeline (FL-style step grid of every recorded hit) ================= */
  function drawTimeline(now) {
    const n = S.pads.length, steps = loopBeats() * 4, cw = (TL_W - TL_GUT) / steps, h = tl.height;
    tctx.fillStyle = '#181b22'; tctx.fillRect(0, 0, TL_W, h);
    tctx.font = '12px system-ui, sans-serif'; tctx.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const y = TL_HEAD + i * TL_ROWH, hue = (i * 360 / n) % 360;
      tctx.fillStyle = i % 2 ? '#1c2029' : '#20242d'; tctx.fillRect(TL_GUT, y, TL_W - TL_GUT, TL_ROWH);
      tctx.fillStyle = i === sel ? '#3a2233' : '#151820'; tctx.fillRect(0, y, TL_GUT, TL_ROWH);
      tctx.fillStyle = `hsl(${hue},85%,58%)`; tctx.fillRect(0, y, 5, TL_ROWH);
      tctx.fillStyle = '#e8eaf0'; tctx.textAlign = 'left';
      tctx.fillText((padName(S.pads[i]) || '—').slice(0, 13), 12, y + TL_ROWH / 2);
    }
    for (let s = 0; s <= steps; s++) {
      const x = TL_GUT + s * cw, bar = s % 16 === 0, beat = s % 4 === 0;
      tctx.fillStyle = bar ? '#5a6172' : beat ? '#3a4050' : '#2a2f3a';
      tctx.fillRect(Math.round(x), TL_HEAD - (bar ? 22 : 0), 1, h);
      if (bar && s < steps) { tctx.fillStyle = '#8b93a3'; tctx.textAlign = 'left'; tctx.fillText(String(s / 16 + 1), x + 4, TL_HEAD / 2); }
    }
    for (const ev of T.events) {
      if (ev.pad >= n) continue;
      const x = TL_GUT + ev.beat * 4 * cw, y = TL_HEAD + ev.pad * TL_ROWH;
      tctx.fillStyle = `hsl(${(ev.pad * 360 / n) % 360},85%,60%)`;
      tctx.fillRect(x + 1, y + 3, Math.max(cw - 2, 4), TL_ROWH - 6);
    }
    if (T.running) {
      const bd = beatDur(), pos = (engine.ctx.currentTime - T.start) / (bd * loopBeats());
      if (pos >= 0) {
        const x = TL_GUT + (pos - Math.floor(pos)) * (TL_W - TL_GUT);
        tctx.fillStyle = T.recording ? '#ff3b5c' : '#ffd23f'; tctx.fillRect(Math.round(x) - 1, 0, 2, h);
      }
    }
  }
  tl.addEventListener('pointerdown', (e) => {
    const r = tl.getBoundingClientRect();
    const x = (e.clientX - r.left) * TL_W / r.width, y = (e.clientY - r.top) * tl.height / r.height;
    const row = Math.floor((y - TL_HEAD) / TL_ROWH);
    if (row < 0 || row >= S.pads.length) return;
    ensureAudio();
    if (x < TL_GUT) { sel = row; syncPadEditor(); engine.trigger(S.pads[row], 0, 1); return; }
    const steps = loopBeats() * 4, step = Math.floor((x - TL_GUT) / ((TL_W - TL_GUT) / steps));
    if (step < 0 || step >= steps) return;
    const b0 = step / 4, b1 = b0 + 0.25;
    const before = T.events.length;
    T.events = T.events.filter((ev) => !(ev.pad === row && ev.beat >= b0 - 1e-6 && ev.beat < b1 - 1e-6));
    if (T.events.length === before) { T.events.push({ pad: row, beat: b0, vel: 1, layer: 0, rec: -1 }); engine.trigger(S.pads[row], 0, 1); }
  });

  /* ================= sound library (IndexedDB; survives reloads) ================= */
  let db = null, libSel = null;
  let lib = []; // {id,name,folder}
  const AUDIO_EXT = /\.(wav|mp3|ogg|flac|aif|aiff|m4a|aac)$/i;
  function openDB() {
    return new Promise((res) => {
      try {
        const rq = indexedDB.open('tablebeats-lib', 1);
        rq.onupgradeneeded = () => { rq.result.createObjectStore('m', { keyPath: 'id' }); rq.result.createObjectStore('d', { keyPath: 'id' }); };
        rq.onsuccess = () => res((db = rq.result));
        rq.onerror = () => res(null);
      } catch (e) { res(null); }
    });
  }
  const idb = (store, mode, fn) => new Promise((res) => {
    if (!db) return res(null);
    try { const rq = fn(db.transaction(store, mode).objectStore(store)); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); } catch (e) { res(null); }
  });
  async function ensureSample(id) {
    if (engine.hasSample(id)) return true;
    const rec = await idb('d', 'readonly', (s) => s.get(id));
    if (!rec) return false;
    try { engine.addSample(id, await engine.decode(rec.data)); return true; } catch (e) { return false; }
  }
  async function addFiles(files) {
    const list = Array.from(files).filter((f) => (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name));
    if (!list.length) { $('libNote').textContent = 'No audio files found in that selection.'; return; }
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      $('libNote').textContent = `Importing ${i + 1} / ${list.length}…`;
      const id = 'L' + Date.now().toString(36) + i + Math.random().toString(36).slice(2, 6);
      const rel = f.webkitRelativePath || '';
      const meta = { id, name: f.name.replace(/\.[^.]+$/, ''), folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '' };
      const data = await f.arrayBuffer();
      if (db) { await idb('d', 'readwrite', (s) => s.put({ id, data })); await idb('m', 'readwrite', (s) => s.put(meta)); }
      else { try { engine.addSample(id, await engine.decode(data.slice(0))); } catch (e) { continue; } } // no storage: keep decoded for this session
      lib.push(meta);
      if (i % 25 === 0) renderLib();
    }
    lib.sort((a, b) => (a.folder + a.name).localeCompare(b.folder + b.name));
    renderLib();
    $('libNote').textContent = `${lib.length} sounds in your library. Click one to hear it.`;
  }
  const libFiltered = () => { const q = $('libSearch').value.trim().toLowerCase(); return q ? lib.filter((m) => (m.folder + ' ' + m.name).toLowerCase().includes(q)) : lib; };
  function renderLib() {
    const el = $('libList'), items = libFiltered();
    el.innerHTML = '';
    if (!items.length) { el.innerHTML = '<div class="empty">Nothing here yet. Download a free pack (see below), unzip it, then use “Add folder…”.</div>'; return; }
    const frag = document.createDocumentFragment();
    items.slice(0, 400).forEach((m) => {
      const d = document.createElement('div'); d.className = 'item' + (m.id === libSel ? ' sel' : '');
      d.textContent = (m.folder ? m.folder.split('/').pop() + ' / ' : '') + m.name; d.title = m.folder + '/' + m.name;
      d.onclick = async () => {
        libSel = m.id; renderLib(); ensureAudio();
        if (await ensureSample(m.id)) engine.trigger({ sound: 'sample', sampleId: m.id, vol: 0.9 }, 0, 1);
      };
      frag.appendChild(d);
    });
    el.appendChild(frag);
    if (items.length > 400) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = `Showing 400 of ${items.length}. Use search to narrow down.`; el.appendChild(d); }
  }
  async function assignSample(padIdx, m) {
    if (!(await ensureSample(m.id))) return;
    const p = S.pads[padIdx]; if (!p) return;
    p.sampleId = m.id; p.sound = 'sample'; p.label = m.name.slice(0, 14); p.vol = p.vol == null ? 0.8 : p.vol;
  }
  function bindLibrary() {
  on('libFiles', 'change', (e) => { addFiles(e.target.files).then(() => { e.target.value = ''; }); });
  on('libFolder', 'change', (e) => { addFiles(e.target.files).then(() => { e.target.value = ''; }); });
  on('libSearch', 'input', renderLib);
  on('libAssign', 'click', async () => {
    const m = lib.find((x) => x.id === libSel); if (!m) { $('libNote').textContent = 'Click a sound in the list first.'; return; }
    await assignSample(sel, m); syncPadEditor(); save();
  });
  on('libFill', 'click', async () => {
    const items = libFiltered(); if (!items.length) return;
    let start = Math.max(0, items.findIndex((x) => x.id === libSel));
    if (start + S.pads.length > items.length) start = Math.max(0, items.length - S.pads.length);
    await Promise.all(S.pads.map((_, i) => items[start + i] ? assignSample(i, items[start + i]) : null));
    syncPadEditor(); save();
    $('libNote').textContent = `Filled ${Math.min(S.pads.length, items.length - start)} pads. Rename or swap any pad in the editor.`;
  });
  on('libClear', 'click', async () => {
    if (!confirm('Remove all sounds from your library?')) return;
    await idb('m', 'readwrite', (s) => s.clear()); await idb('d', 'readwrite', (s) => s.clear());
    lib = []; libSel = null; engine.samples = {};
    S.pads.forEach((p) => { if (p.sound === 'sample') p.sound = 'none'; });
    renderLib(); syncPadEditor(); save();
  });
  }
  async function initLibrary() {
    await openDB();
    const metas = await idb('m', 'readonly', (s) => s.getAll());
    lib = (metas || []).sort((a, b) => (a.folder + a.name).localeCompare(b.folder + b.name));
    renderLib();
    if (lib.length) $('libNote').textContent = `${lib.length} sounds in your library. Click one to hear it.`;
    // decode only what the pads use, so first hits are instant
    await Promise.all(S.pads.map(async (p) => { if (p.sound === 'sample') { if (!(await ensureSample(p.sampleId))) p.sound = 'none'; } }));
    syncPadEditor();
  }

  function frame(now) {
    requestAnimationFrame(frame);
    drawStage(now);
    drawTimeline(now);
    updateTransportUI();
    if (micOn) $('micMeter').style.width = Math.min(100, micLevel * 300) + '%';
    if (sessOn) $('sessTime').textContent = ((performance.now() - sessT0) / 1000).toFixed(0) + 's';
  }

  /* ================= stage pointer interaction ================= */
  let drag = -1;
  function canvasPos(e) {
    const r = stage.getBoundingClientRect();
    return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height];
  }
  stage.addEventListener('pointerdown', (e) => {
    const [x, y] = canvasPos(e);
    if (!S.locked) {
      let bi = -1, bd = 22 * 22;
      S.corners.forEach((c, k) => { const dd = (c.x * W - x) ** 2 + (c.y * H - y) ** 2; if (dd < bd) { bd = dd; bi = k; } });
      if (bi >= 0) { drag = bi; stage.setPointerCapture(e.pointerId); return; }
    }
    const i = core.hitTestPad(quads, x, y);
    if (i >= 0) { sel = i; syncPadEditor(); hit(i); }
  });
  stage.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const [x, y] = canvasPos(e);
    S.corners[drag] = { x: Math.min(1, Math.max(0, x / W)), y: Math.min(1, Math.max(0, y / H)) };
    rebuildGeom(); save();
  });
  const endDrag = () => { drag = -1; };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  /* ================= keyboard ================= */
  const ROWKEYS = ['1234567', 'qwertyu', 'asdfghj', 'zxcvbnm'];
  let KEYMAP = {}, KEYMAP_REV = [];
  function rebuildKeys() {
    KEYMAP = {}; KEYMAP_REV = [];
    for (let r = 0; r < S.rows; r++) for (let c = 0; c < S.cols; c++) {
      const k = ROWKEYS[r] && ROWKEYS[r][c];
      if (k) { KEYMAP[k] = r * S.cols + c; KEYMAP_REV[r * S.cols + c] = k; }
    }
  }
  document.addEventListener('keydown', (e) => {
    const t = e.target.tagName;
    if (t === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox' && e.target.type !== 'radio') return;
    if (t === 'SELECT' || t === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); $('playBtn').click(); return; }
    if (e.repeat) return;
    const i = KEYMAP[e.key.toLowerCase()];
    if (i != null) { e.preventDefault(); hit(i); }
  });

  /* ================= side panel ================= */
  function fillSelect(el, opts, val) { el.innerHTML = ''; opts.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; el.appendChild(o); }); if (val != null) el.value = val; }
  function fillSoundSel(p) {
    const el = $('padSound'); el.innerHTML = '';
    const groups = {};
    SOUNDS.forEach((s) => (groups[s.group] = groups[s.group] || []).push(s));
    if (p.sampleId && engine.hasSample(p.sampleId)) groups['My sound'] = [{ id: 'sample', name: 'My uploaded sound' }];
    Object.keys(groups).forEach((g) => {
      const og = document.createElement('optgroup'); og.label = g;
      groups[g].forEach((s) => { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name; og.appendChild(o); });
      el.appendChild(og);
    });
  }
  function syncPadEditor() {
    const p = S.pads[sel]; if (!p) return;
    const r = Math.floor(sel / S.cols) + 1, c = (sel % S.cols) + 1;
    $('padTitle').textContent = `Pad ${sel + 1} · row ${r}, col ${c}` + (KEYMAP_REV[sel] ? ` · key ${KEYMAP_REV[sel].toUpperCase()}` : '');
    $('padLabel').value = p.label || '';
    fillSoundSel(p);
    $('padSound').value = p.sound;
    $('noteRow').hidden = !soundDef(p.sound).note;
    $('padNote').value = p.note == null ? 60 : p.note;
    $('padVol').value = p.vol == null ? 0.8 : p.vol;
  }
  function syncUI() {
    $('presetSel').value = S.preset; $('keySel').value = S.keyRoot; $('scaleSel').value = S.scale;
    $('rowsIn').value = S.rows; $('colsIn').value = S.cols;
    $('flipX').checked = S.flipX; $('flipY').checked = S.flipY; $('lockGrid').checked = S.locked;
    $('modeMotion').checked = S.mode === 'motion'; $('modeKnock').checked = S.mode === 'knock';
    $('sens').value = S.sens; $('debug').checked = S.debug; $('backendSel').value = S.backend;
    $('backendInfo').textContent = 'Running on: ' + pipe.renderer;
    $('micRow').hidden = S.mode !== 'knock';
    $('bpm').value = S.bpm; $('bpmVal').textContent = S.bpm; $('bars').value = S.bars;
    $('quant').checked = S.quant; $('metro').checked = S.metro;
    $('master').value = S.master; $('reverb').value = S.reverb;
    syncPadEditor(); syncTransportButtons();
  }
  const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

  // populate static selects
  fillSelect($('presetSel'), core.PRESET_NAMES.map((n) => [n, n]));
  fillSelect($('keySel'), core.NOTE_NAMES.map((n, i) => [i, n]));
  fillSelect($('scaleSel'), Object.keys(core.SCALES).map((n) => [n, n]));
  const noteOpts = []; for (let m = 24; m <= 96; m++) noteOpts.push([m, core.midiName(m)]);
  fillSelect($('padNote'), noteOpts);

  on('loadPresetBtn', 'click', () => {
    S.preset = $('presetSel').value; S.keyRoot = +$('keySel').value; S.scale = $('scaleSel').value;
    const pre = core.buildPreset(S.preset, S.keyRoot, S.scale);
    S.rows = pre.rows; S.cols = pre.cols; S.pads = pre.pads; sel = 0;
    T.events = []; T.layers = [];
    rebuildGeom(); rebuildKeys(); syncUI(); save();
  });
  function resizeGrid() {
    const nr = Math.min(4, Math.max(1, +$('rowsIn').value || 1)), nc = Math.min(6, Math.max(1, +$('colsIn').value || 1));
    const old = S.pads, oc = S.cols, orr = S.rows, pads = [];
    for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) pads.push(r < orr && c < oc ? old[r * oc + c] : { label: '', sound: 'none', note: 60, vol: 0.8 });
    S.rows = nr; S.cols = nc; S.pads = pads; sel = Math.min(sel, pads.length - 1);
    T.events = T.events.filter((e) => e.pad < pads.length);
    rebuildGeom(); rebuildKeys(); syncUI(); save();
  }
  on('rowsIn', 'change', resizeGrid); on('colsIn', 'change', resizeGrid);
  on('flipX', 'change', () => { S.flipX = $('flipX').checked; pipe.reset(); save(); });
  on('flipY', 'change', () => { S.flipY = $('flipY').checked; pipe.reset(); save(); });
  on('lockGrid', 'change', () => { S.locked = $('lockGrid').checked; save(); });
  on('resetCorners', 'click', () => { S.corners = DEFAULT_CORNERS.map((c) => ({ ...c })); rebuildGeom(); save(); });
  const setMode = (m) => { S.mode = m; $('micRow').hidden = m !== 'knock'; if (m === 'knock') enableMic(); else disableMic(); save(); };
  on('modeMotion', 'change', () => setMode('motion')); on('modeKnock', 'change', () => setMode('knock'));
  on('sens', 'input', () => { S.sens = +$('sens').value; save(); });
  on('debug', 'change', () => { S.debug = $('debug').checked; perf.trace = S.debug; save(); });
  on('backendSel', 'change', () => { S.backend = $('backendSel').value; pipe.setBackend(S.backend); syncUI(); save(); });
  on('resetBg', 'click', () => pipe.reset());

  on('padLabel', 'input', () => { S.pads[sel].label = $('padLabel').value; save(); });
  on('padSound', 'change', () => {
    const p = S.pads[sel]; p.sound = $('padSound').value;
    $('noteRow').hidden = !soundDef(p.sound).note; save(); ensureAudio(); engine.trigger(p, 0, 1);
  });
  on('padNote', 'change', () => { const p = S.pads[sel]; p.note = +$('padNote').value; save(); ensureAudio(); engine.trigger(p, 0, 1); });
  on('padVol', 'input', () => { S.pads[sel].vol = +$('padVol').value; save(); });
  on('padPreview', 'click', () => { ensureAudio(); hit(sel); });
  on('master', 'input', () => { S.master = +$('master').value; engine.setMaster(S.master); save(); });
  on('reverb', 'input', () => { S.reverb = +$('reverb').value; engine.setReverb(S.reverb); save(); });
  on('bpm', 'input', () => { S.bpm = +$('bpm').value; $('bpmVal').textContent = S.bpm; if (T.running) tStart(false); save(); });
  on('bars', 'change', () => { S.bars = +$('bars').value; if (T.running) tStart(false); save(); });
  on('quant', 'change', () => { S.quant = $('quant').checked; save(); });
  on('metro', 'change', () => { S.metro = $('metro').checked; save(); });
  on('startBtn', 'click', () => startCamera($('cameraSel').value || undefined));
  on('cameraSel', 'change', () => startCamera($('cameraSel').value));

  /* ================= boot ================= */
  rebuildGeom(); rebuildKeys(); syncUI();
  bindLibrary(); initLibrary();
  // Tap mode's mic starts together with the camera (Start camera is the user gesture)
  requestAnimationFrame(frame);
  window.TableBeats = { S, hit, engine, T, pv, rebuildGeom, pipe, get tracker() { return pipe.tracker; }, get echoGain() { return echoGain; }, get visMs() { return visMs; } }; // handy for debugging in the console
})();
