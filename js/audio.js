/* TableBeats audio engine: built-in synthesized kit (no sample files needed), reverb,
   metronome click, custom samples, and session recording. */
(function (root) {
  'use strict';
  const TB = (root.TB = root.TB || {});
  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  const SOUNDS = [
    { id: 'none', name: '(silent)', group: '—' },
    { id: 'kick', name: 'Kick', group: 'Drums' },
    { id: 'kick808', name: 'Deep 808 kick', group: 'Drums' },
    { id: 'snare', name: 'Snare', group: 'Drums' },
    { id: 'clap', name: 'Clap', group: 'Drums' },
    { id: 'hatC', name: 'Hi-hat (closed)', group: 'Drums' },
    { id: 'hatO', name: 'Hi-hat (open)', group: 'Drums' },
    { id: 'rim', name: 'Rim click', group: 'Drums' },
    { id: 'tomL', name: 'Tom (low)', group: 'Drums' },
    { id: 'tomM', name: 'Tom (mid)', group: 'Drums' },
    { id: 'tomH', name: 'Tom (high)', group: 'Drums' },
    { id: 'cowbell', name: 'Cowbell', group: 'Drums' },
    { id: 'shaker', name: 'Shaker', group: 'Drums' },
    { id: 'crash', name: 'Crash', group: 'Drums' },
    { id: 'bass', name: 'Bass', group: 'Melodic (pick a note)', note: true },
    { id: 'pluck', name: 'Pluck', group: 'Melodic (pick a note)', note: true },
    { id: 'keys', name: 'Electric keys', group: 'Melodic (pick a note)', note: true },
    { id: 'lead', name: 'Lead synth', group: 'Melodic (pick a note)', note: true },
    { id: 'bell', name: 'Bell', group: 'Melodic (pick a note)', note: true },
    { id: 'chordMaj', name: 'Chord (major)', group: 'Melodic (pick a note)', note: true },
    { id: 'chordMin', name: 'Chord (minor)', group: 'Melodic (pick a note)', note: true },
    { id: 'zap', name: 'Zap', group: 'FX' },
    { id: 'laser', name: 'Laser', group: 'FX' },
  ];
  TB.SOUNDS = SOUNDS;

  class Engine {
    constructor() { this.ctx = null; this.samples = {}; this.rec = null; }

    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      const c = (this.ctx = new AC({ latencyHint: 'interactive' }));
      this.master = c.createGain();
      this.master.gain.value = 0.9;
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.15;
      this.master.connect(comp);
      comp.connect(c.destination);
      this.recDest = c.createMediaStreamDestination();
      comp.connect(this.recDest);

      // noise buffer (2 s) used by all percussive sounds
      const nb = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const d = nb.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = nb;

      // reverb: generated impulse response, decaying stereo noise
      const len = Math.floor(c.sampleRate * 1.6);
      const ir = c.createBuffer(2, len, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      }
      const conv = c.createConvolver(); conv.buffer = ir;
      this.revIn = c.createGain(); this.revIn.gain.value = 0.18;
      const wet = c.createGain(); wet.gain.value = 0.8;
      this.revIn.connect(conv); conv.connect(wet); wet.connect(this.master);
      if (c.state === 'suspended') c.resume();
    }

    setMaster(v) { if (this.ctx) this.master.gain.value = v; }
    setReverb(v) { if (this.ctx) this.revIn.gain.value = v; }

    addSample(id, buf) { this.samples[id] = buf; }
    hasSample(id) { return !!this.samples[id]; }
    async decode(arrayBuffer) {
      this.init();
      return new Promise((res, rej) => this.ctx.decodeAudioData(arrayBuffer, res, rej));
    }

    /* Play one pad. `when` = audio-clock time (0 = now). */
    trigger(pad, when, vel) {
      if (!this.ctx || !pad || pad.sound === 'none') return;
      const c = this.ctx;
      const t = Math.max(when || 0, c.currentTime);
      const g = c.createGain();
      g.gain.value = (pad.vol == null ? 0.8 : pad.vol) * (vel == null ? 1 : vel);
      g.connect(this.master);
      g.connect(this.revIn);
      const note = pad.note == null ? 60 : pad.note;
      switch (pad.sound) {
        case 'kick': return this._kick(t, g, 160, 42, 0.14, 0.45);
        case 'kick808': return this._kick(t, g, 110, 36, 0.3, 1.0);
        case 'snare': this._noise(t, g, 'highpass', 1800, 0.7, 0.8, 0.2); return this._tone(t, g, 'triangle', 190, 120, 0.5, 0.12);
        case 'clap':
          this._noise(t, g, 'bandpass', 1400, 1, 0.7, 0.03);
          this._noise(t + 0.012, g, 'bandpass', 1400, 1, 0.7, 0.03);
          this._noise(t + 0.024, g, 'bandpass', 1400, 1, 0.8, 0.03);
          return this._noise(t + 0.036, g, 'bandpass', 1300, 1, 0.8, 0.2);
        case 'hatC': return this._noise(t, g, 'highpass', 7500, 0.7, 0.5, 0.05);
        case 'hatO': return this._noise(t, g, 'highpass', 7000, 0.7, 0.45, 0.35);
        case 'rim': this._tone(t, g, 'triangle', 880, 700, 0.6, 0.04); return this._noise(t, g, 'bandpass', 2500, 2, 0.4, 0.03);
        case 'tomL': return this._tone(t, g, 'sine', 150, 90, 0.9, 0.35);
        case 'tomM': return this._tone(t, g, 'sine', 210, 130, 0.9, 0.3);
        case 'tomH': return this._tone(t, g, 'sine', 290, 180, 0.9, 0.25);
        case 'cowbell': return this._cowbell(t, g);
        case 'shaker': return this._noise(t, g, 'bandpass', 6000, 1.2, 0.5, 0.09, 0.012);
        case 'crash': return this._noise(t, g, 'highpass', 4000, 0.6, 0.35, 1.4);
        case 'zap': return this._zap(t, g);
        case 'laser': return this._tone(t, g, 'sine', 2200, 300, 0.5, 0.22);
        case 'bass': return this._bass(t, g, note);
        case 'pluck': return this._pluck(t, g, note);
        case 'keys': return this._keys(t, g, note);
        case 'lead': return this._lead(t, g, note);
        case 'bell': return this._bell(t, g, note);
        case 'chordMaj': return this._chord(t, g, note, 4);
        case 'chordMin': return this._chord(t, g, note, 3);
        case 'sample': {
          const buf = this.samples[pad.sampleId];
          if (!buf) return;
          const s = c.createBufferSource(); s.buffer = buf; s.connect(g); s.start(t);
          return;
        }
      }
    }

    click(t, accent) {
      const c = this.ctx; if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = accent ? 1600 : 1100; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(accent ? 0.35 : 0.22, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + 0.06);
    }

    /* ---- building blocks ---- */
    _env(param, t, peak, attack, decay) {
      param.setValueAtTime(0.0001, t);
      param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
      param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    }
    _tone(t, out, type, f0, f1, peak, decay) {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t + decay);
      this._env(g.gain, t, peak, 0.002, decay);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + decay + 0.05);
    }
    _kick(t, out, f0, f1, sweep, decay) {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
      g.gain.setValueAtTime(1, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + decay);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + decay + 0.05);
    }
    _noise(t, out, ftype, freq, q, peak, decay, attack) {
      const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = this.noiseBuf;
      f.type = ftype; f.frequency.value = freq; f.Q.value = q;
      this._env(g.gain, t, peak, attack || 0.002, decay);
      s.connect(f); f.connect(g); g.connect(out);
      s.start(t, Math.random() * 0.4); s.stop(t + decay + 0.06);
    }
    _cowbell(t, out) {
      const c = this.ctx, g = c.createGain(), f = c.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 800; f.Q.value = 0.8;
      this._env(g.gain, t, 0.5, 0.002, 0.35);
      [587, 845].forEach((fr) => { const o = c.createOscillator(); o.type = 'square'; o.frequency.value = fr; o.connect(f); o.start(t); o.stop(t + 0.4); });
      f.connect(g); g.connect(out);
    }
    _zap(t, out) {
      const c = this.ctx, o = c.createOscillator(), f = c.createBiquadFilter(), g = c.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(1800, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.28);
      f.type = 'lowpass'; f.frequency.value = 3200;
      this._env(g.gain, t, 0.5, 0.003, 0.3);
      o.connect(f); f.connect(g); g.connect(out);
      o.start(t); o.stop(t + 0.35);
    }

    /* ---- melodic voices ---- */
    _bass(t, out, m) {
      const c = this.ctx, fr = midiToFreq(m), g = c.createGain(), f = c.createBiquadFilter();
      f.type = 'lowpass'; f.Q.value = 4;
      f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(180, t + 0.35);
      this._env(g.gain, t, 0.85, 0.004, 0.5);
      const a = c.createOscillator(); a.type = 'sawtooth'; a.frequency.value = fr;
      const b = c.createOscillator(); b.type = 'sine'; b.frequency.value = fr;
      a.connect(f); b.connect(f); f.connect(g); g.connect(out);
      a.start(t); b.start(t); a.stop(t + 0.6); b.stop(t + 0.6);
    }
    _pluck(t, out, m) {
      const c = this.ctx, fr = midiToFreq(m), g = c.createGain(), f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(4000, t); f.frequency.exponentialRampToValueAtTime(500, t + 0.45);
      this._env(g.gain, t, 0.55, 0.003, 0.6);
      const a = c.createOscillator(); a.type = 'sawtooth'; a.frequency.value = fr;
      const b = c.createOscillator(); b.type = 'triangle'; b.frequency.value = fr * 2;
      a.connect(f); b.connect(f); f.connect(g); g.connect(out);
      a.start(t); b.start(t); a.stop(t + 0.7); b.stop(t + 0.7);
    }
    _keys(t, out, m) {
      const c = this.ctx, fr = midiToFreq(m), g = c.createGain();
      const car = c.createOscillator(); car.type = 'sine'; car.frequency.value = fr;
      const mod = c.createOscillator(); mod.type = 'sine'; mod.frequency.value = fr;
      const mg = c.createGain();
      mg.gain.setValueAtTime(fr * 1.6, t); mg.gain.exponentialRampToValueAtTime(fr * 0.05, t + 0.7);
      mod.connect(mg); mg.connect(car.frequency);
      this._env(g.gain, t, 0.55, 0.004, 0.9);
      car.connect(g); g.connect(out);
      car.start(t); mod.start(t); car.stop(t + 1); mod.stop(t + 1);
    }
    _lead(t, out, m) {
      const c = this.ctx, fr = midiToFreq(m), g = c.createGain(), f = c.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 3800;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.4, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.15);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      const lfo = c.createOscillator(), lg = c.createGain();
      lfo.frequency.value = 5.5; lg.gain.value = 8; lfo.connect(lg);
      [['sawtooth', -7], ['square', 7]].forEach(([ty, det]) => {
        const o = c.createOscillator(); o.type = ty; o.frequency.value = fr; o.detune.value = det;
        lg.connect(o.detune); o.connect(f); o.start(t); o.stop(t + 0.75);
      });
      lfo.start(t); lfo.stop(t + 0.75);
      f.connect(g); g.connect(out);
    }
    _bell(t, out, m) {
      const c = this.ctx, fr = midiToFreq(m), g = c.createGain();
      this._env(g.gain, t, 0.5, 0.002, 1.6);
      [[1, 1], [2.76, 0.35], [5.4, 0.12]].forEach(([r, a]) => {
        const o = c.createOscillator(), pg = c.createGain();
        o.type = 'sine'; o.frequency.value = fr * r; pg.gain.value = a;
        o.connect(pg); pg.connect(g); o.start(t); o.stop(t + 1.7);
      });
      g.connect(out);
    }
    _chord(t, out, m, third) {
      const c = this.ctx, g = c.createGain(), f = c.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.setValueAtTime(2200, t); f.frequency.exponentialRampToValueAtTime(600, t + 1);
      this._env(g.gain, t, 0.28, 0.01, 1.1);
      [0, third, 7].forEach((iv) => {
        [-6, 6].forEach((det) => {
          const o = c.createOscillator(); o.type = 'sawtooth';
          o.frequency.value = midiToFreq(m + iv); o.detune.value = det;
          o.connect(f); o.start(t); o.stop(t + 1.2);
        });
      });
      f.connect(g); g.connect(out);
    }

    /* ---- recording the whole session to a file ---- */
    startRecording() {
      this.init();
      const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
      const mime = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
      this.rec = new MediaRecorder(this.recDest.stream, mime ? { mimeType: mime } : {});
      this.chunks = [];
      this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
      this.recMime = mime || this.rec.mimeType;
      this.rec.start();
    }
    stopRecording() {
      return new Promise((res) => {
        this.rec.onstop = () => {
          const type = this.recMime || 'audio/webm';
          const blob = new Blob(this.chunks, { type });
          res({ blob, url: URL.createObjectURL(blob), ext: /mp4/.test(type) ? 'm4a' : 'webm' });
        };
        this.rec.stop();
      });
    }
  }
  TB.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
