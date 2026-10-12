/* TableBeats core: pure helpers (perspective grid math, scales, presets). No DOM. */
(function (root) {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const midiName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // Scales are chosen so that any pad you hit sounds "right" together.
  const SCALES = {
    'Minor pentatonic': [0, 3, 5, 7, 10],
    'Major pentatonic': [0, 2, 4, 7, 9],
    'Blues': [0, 3, 5, 6, 7, 10],
    'Natural minor': [0, 2, 3, 5, 7, 8, 10],
    'Major': [0, 2, 4, 5, 7, 9, 11],
  };

  function scaleNotes(baseMidi, scaleName, count) {
    const s = SCALES[scaleName] || SCALES['Minor pentatonic'];
    const out = [];
    for (let i = 0; i < count; i++) out.push(baseMidi + s[i % s.length] + 12 * Math.floor(i / s.length));
    return out;
  }

  /* ---------- perspective mapping ----------
     corners = [TL, TR, BR, BL] as {x,y}. Returns M = [a..h] mapping the unit square
     (u,v) -> quad, so grid cells follow the table's perspective. */
  function squareToQuad(pts) {
    const [p0, p1, p2, p3] = pts;
    const sx = p0.x - p1.x + p2.x - p3.x;
    const sy = p0.y - p1.y + p2.y - p3.y;
    let a, b, c, d, e, f, g, h;
    if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
      a = p1.x - p0.x; b = p3.x - p0.x; c = p0.x;
      d = p1.y - p0.y; e = p3.y - p0.y; f = p0.y; g = 0; h = 0;
    } else {
      const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
      const det = dx1 * dy2 - dx2 * dy1;
      g = (sx * dy2 - dx2 * sy) / det;
      h = (dx1 * sy - sx * dy1) / det;
      a = p1.x - p0.x + g * p1.x; b = p3.x - p0.x + h * p3.x; c = p0.x;
      d = p1.y - p0.y + g * p1.y; e = p3.y - p0.y + h * p3.y; f = p0.y;
    }
    return [a, b, c, d, e, f, g, h];
  }

  function mapPoint(M, u, v) {
    const w = M[6] * u + M[7] * v + 1;
    return [(M[0] * u + M[1] * v + M[2]) / w, (M[3] * u + M[4] * v + M[5]) / w];
  }

  // Inverse of squareToQuad: maps a point in the quad back to grid space (u,v), 0..1 inside the grid.
  function invertMap(M) {
    const [a, b, c, d, e, f, g, h] = M;
    const A = e - f * h, B = c * h - b, C = b * f - c * e;
    const D = f * g - d, E = a - c * g, F = c * d - a * f;
    const G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
    return (x, y) => { const w = G * x + Hh * y + I; return [(A * x + B * y + C) / w, (D * x + E * y + F) / w]; };
  }

  // Four corners (TL,TR,BR,BL) of the pad at row r, col c.
  function padQuad(M, rows, cols, r, c) {
    const u0 = c / cols, u1 = (c + 1) / cols, v0 = r / rows, v1 = (r + 1) / rows;
    return [mapPoint(M, u0, v0), mapPoint(M, u1, v0), mapPoint(M, u1, v1), mapPoint(M, u0, v1)];
  }

  // n*n sample points inside a pad (inset 12% so neighbouring pads don't bleed).
  function padSamples(M, rows, cols, r, c, n) {
    const pts = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const u = (c + 0.12 + 0.76 * ((i + 0.5) / n)) / cols;
        const v = (r + 0.12 + 0.76 * ((j + 0.5) / n)) / rows;
        pts.push(mapPoint(M, u, v));
      }
    }
    return pts;
  }

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function hitTestPad(quads, x, y) {
    for (let i = 0; i < quads.length; i++) if (pointInPoly(x, y, quads[i])) return i;
    return -1;
  }

  /* ---------- presets ---------- */
  const P = (label, sound, note, vol) => ({ label, sound, note: note == null ? 60 : note, vol: vol == null ? 0.8 : vol });

  const PRESET_NAMES = ['Mini DJ set', 'Drum kit', 'Melody (any pad sounds good)', 'Blank'];

  function buildPreset(name, root, scale) {
    const minor = /minor|blues/i.test(scale);
    if (name === 'Drum kit') {
      return { rows: 2, cols: 4, pads: [
        P('Kick', 'kick'), P('Snare', 'snare'), P('Hat', 'hatC'), P('Open hat', 'hatO'),
        P('Clap', 'clap'), P('Tom', 'tomM'), P('Rim', 'rim'), P('Cowbell', 'cowbell')] };
    }
    if (name === 'Melody (any pad sounds good)') {
      const n = scaleNotes(60 + root, scale, 12);
      const pad = (i, snd) => P(midiName(n[i]), snd, n[i], 0.75);
      // top row = highest notes, bottom row (closest to you) = lowest
      const order = [8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3];
      return { rows: 3, cols: 4, pads: order.map((i) => pad(i, i >= 8 ? 'bell' : 'pluck')) };
    }
    if (name === 'Blank') {
      return { rows: 3, cols: 3, pads: Array.from({ length: 9 }, () => P('', 'none')) };
    }
    // Mini DJ set: drums on top, bass in the middle, harmony/FX on the bottom row.
    const bass = scaleNotes(36 + root, scale, 5);
    const mel = scaleNotes(60 + root, scale, 8);
    return { rows: 3, cols: 4, pads: [
      P('Kick', 'kick'), P('Snare', 'snare'), P('Hat', 'hatC'), P('Clap', 'clap'),
      P('Bass 1', 'bass', bass[0]), P('Bass 2', 'bass', bass[2]), P('Bass 3', 'bass', bass[3]), P('Bass 4', 'bass', bass[4]),
      P('Chord', minor ? 'chordMin' : 'chordMaj', 48 + root, 0.6), P('Pluck', 'pluck', mel[2]), P('Bell', 'bell', mel[4]), P('Zap', 'zap', 60, 0.6)] };
  }

  const api = { NOTE_NAMES, SCALES, PRESET_NAMES, midiName, midiToFreq, scaleNotes, squareToQuad, mapPoint, invertMap, padQuad, padSamples, pointInPoly, hitTestPad, buildPreset };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.TB = root.TB || {}; root.TB.core = api; }
})(typeof window !== 'undefined' ? window : globalThis);
