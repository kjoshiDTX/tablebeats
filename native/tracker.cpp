/* TableBeats tracker in C++, compiled to WebAssembly (js/tracker.wasm, built by tools/build-wasm.sh).
   A line-for-line port of js/vision.js (cpuBackend + createTracker): background subtraction with
   shadow rejection, 2-of-4 denoise, connected blobs, background learning, fingertips, tracking and
   strike detection. Its output is identical to the JavaScript tracker's, frame for frame
   (tools/test-vision.mjs checks this), so the two can be benchmarked against each other honestly.

   To keep it bit-identical:
   - JS numbers are doubles: every computation here is double; only what JS keeps in a
     Float32Array (background, luminance) is stored as float.
   - Math.exp and Math.hypot come from JS (imports), so libm can't differ in the last bit.
   - Sorts are stable, like Array.prototype.sort; Math.round is reproduced exactly.
   Freestanding: no libc, no allocator. One tracker per module instance; tb_init() grows the
   instance's memory to fit w*h. The JS side (js/wasm.js) owns frames, timing and track objects. */

#include <stdint.h>

#define EXPORT(name) extern "C" __attribute__((export_name(name)))
#define IMPORT(name) extern "C" __attribute__((import_module("env"), import_name(name)))

IMPORT("exp") double js_exp(double);
IMPORT("hypot") double js_hypot(double, double);
IMPORT("prof_start") void prof_start(int stage);
IMPORT("prof_end") void prof_end(int stage);

enum { BGSUB = 0, BLOBS = 1, LEARN = 2, TRACK = 3 };

static inline double dabs(double x) { return __builtin_fabs(x); }
static inline double dmin(double a, double b) { return a < b ? a : b; }
static inline double dmax(double a, double b) { return a > b ? a : b; }
static inline int imin(int a, int b) { return a < b ? a : b; }
static inline int imax(int a, int b) { return a > b ? a : b; }
// JavaScript's Math.round: halves round up (toward +infinity)
static inline double js_round(double x) { double f = __builtin_floor(x); return x - f >= 0.5 ? f + 1 : f; }

/* ---------- memory ---------- */
extern "C" unsigned char __heap_base;
static uintptr_t brk_ = 0;
static void* alloc(uint32_t bytes) {
  if (!brk_) brk_ = (uintptr_t)&__heap_base;
  brk_ = (brk_ + 15) & ~(uintptr_t)15;
  void* p = (void*)brk_;
  brk_ += bytes;
  uintptr_t have = __builtin_wasm_memory_size(0) * 65536u;
  if (brk_ > have && __builtin_wasm_memory_grow(0, (brk_ - have + 65535) / 65536) < 0) return nullptr;
  return p;
}

/* ---------- state (mirrors createTracker's closure) ---------- */
static const int MAX_TIPS = 4, HIST = 8;
static const double TICK = 28, REFRACT = 110;

struct Track {               // field order fixed: js/wasm.js reads it through typed-array views
  double x, y, dx, dy, u, v, born, lastStrike;   // 8 doubles  (offset 0)
  double act[HIST], actT[HIST], trav[HIST];      // 24 doubles (offset 64)
  int32_t id, pad, n, strike;                    // 4 ints     (offset 256)
};
static_assert(sizeof(Track) == 272, "Track layout is shared with js/wasm.js");

struct Blob { int start, end, area; double bx, by, bn; };

static int W, H, N, MIN_AREA;
static double MATCH;
static uint8_t* frame;                 // RGBA input, written by JS
static float *bgR, *bgG, *bgB, *curY, *prevY;
static uint8_t *fg0, *fg;
static int32_t *label, *pix;
static Blob* blobs;                    // a blob has >= MIN_AREA pixels, so at most N / MIN_AREA of them
static double inv[9];                  // grid inverse map (core.invertMap coefficients), written by JS

static bool ready = false, seeded = false;
static int frames = 0, nextId = 1;
static double refT = 0, lastT = 0, entryX, entryY;
static Track tracks[MAX_TIPS], nextTracks[MAX_TIPS];
static int ntracks = 0;
static int strikeIdx[MAX_TIPS], nstrikes = 0;

EXPORT("tb_init") int tb_init(int w, int h) {
  W = w; H = h; N = w * h;
  MIN_AREA = imax(24, (int)js_round(N * 0.0015));
  MATCH = 0.12 * w;
  entryX = w / 2.0; entryY = h;
  frame = (uint8_t*)alloc(N * 4);
  bgR = (float*)alloc(N * 4); bgG = (float*)alloc(N * 4); bgB = (float*)alloc(N * 4);
  curY = (float*)alloc(N * 4); prevY = (float*)alloc(N * 4);
  fg0 = (uint8_t*)alloc(N); fg = (uint8_t*)alloc(N);
  label = (int32_t*)alloc(N * 4); pix = (int32_t*)alloc(N * 4);
  blobs = (Blob*)alloc((N / MIN_AREA + 1) * sizeof(Blob));
  return blobs != nullptr;
}

EXPORT("tb_frame") uint8_t* tb_frame() { return frame; }
EXPORT("tb_bg") float* tb_bg(int c) { return c == 0 ? bgR : c == 1 ? bgG : bgB; }
EXPORT("tb_inv") double* tb_inv() { return inv; }
EXPORT("tb_tracks") Track* tb_tracks() { return tracks; }
EXPORT("tb_track_count") int tb_track_count() { return ntracks; }
EXPORT("tb_strikes") int* tb_strikes() { return strikeIdx; }
EXPORT("tb_strike_count") int tb_strike_count() { return nstrikes; }
EXPORT("tb_frames") int tb_frames() { return frames; }
EXPORT("tb_next_id") int tb_next_id() { return nextId; }
EXPORT("tb_entry") double tb_entry(int k) { return k ? entryY : entryX; }
EXPORT("tb_ready") int tb_ready() { return ready; }

EXPORT("tb_reset") void tb_reset() { ready = false; seeded = false; frames = 0; ntracks = 0; }

// the background planes were filled by JS (resampled from another tracker): keep them
EXPORT("tb_seed") void tb_seed(int f, int id, double ex, double ey) {
  seeded = true; frames = f; nextId = id; entryX = ex; entryY = ey;
}

/* ---------- background subtraction (cpuBackend) ---------- */
static void bgInit() {
  for (int i = 0, p = 0; i < N; i++, p += 4) { bgR[i] = frame[p]; bgG[i] = frame[p + 1]; bgB[i] = frame[p + 2]; }
}

static int classify(double thr) {
  int fgCount = 0;
  for (int i = 0, p = 0; i < N; i++, p += 4) {
    const double r = frame[p], g = frame[p + 1], b = frame[p + 2];
    const double y = r * 0.3 + g * 0.59 + b * 0.11;
    curY[i] = (float)y;
    const double br = bgR[i], bgg = bgG[i], bb = bgB[i];
    const double by = br * 0.3 + bgg * 0.59 + bb * 0.11;
    const double dy = y - by;
    uint8_t on = 0;
    if (dabs(dy) > thr || dabs(r - br) + dabs(g - bgg) + dabs(b - bb) > thr * 2.4) {
      on = 1;
      const double ratio = y / (by + 1);
      if (dy < 0 && ratio > 0.4 && ratio < 0.95) { // darker: shadow if the colour is unchanged
        const double s = r + g + b + 1, bs = br + bgg + bb + 1;
        if (dabs(r / s - br / bs) + dabs(g / s - bgg / bs) < 0.045) on = 0;
      }
    }
    fg0[i] = on; fgCount += on;
  }
  // denoise: keep a pixel only if at least 2 of its 4 neighbours agree
  for (int y = 0; y < H; y++) {
    for (int x = 0; x < W; x++) {
      const int i = y * W + x;
      if (!fg0[i]) { fg[i] = 0; continue; }
      const int n = (x > 0 ? fg0[i - 1] : 1) + (x < W - 1 ? fg0[i + 1] : 1) + (y > 0 ? fg0[i - W] : 1) + (y < H - 1 ? fg0[i + W] : 1);
      fg[i] = n >= 2 ? 1 : 0;
    }
  }
  return fgCount;
}

static void learn(double fast, double slow) {
  for (int i = 0, p = 0; i < N; i++, p += 4) {
    const bool near = label[i] > 0 || fg0[i] || (i > 0 && label[i - 1] > 0) || (i < N - 1 && label[i + 1] > 0) ||
                      (i >= W && label[i - W] > 0) || (i < N - W && label[i + W] > 0);
    const double rate = near ? slow : fast;
    bgR[i] = (float)(bgR[i] + (frame[p] - (double)bgR[i]) * rate);
    bgG[i] = (float)(bgG[i] + (frame[p + 1] - (double)bgG[i]) * rate);
    bgB[i] = (float)(bgB[i] + (frame[p + 2] - (double)bgB[i]) * rate);
  }
}

/* ---------- blobs ---------- */
static int labelBlobs() {
  __builtin_memset(label, 0, N * 4);
  int nb = 0, top = 0, nl = 0;
  for (int s = 0; s < N; s++) {
    if (!fg[s] || label[s]) continue;
    nl++;
    const int start = top;
    int head = top;
    pix[top++] = s; label[s] = nl;
    double bx = 0, by = 0, bn = 0;
    while (head < top) {
      const int i = pix[head++], x = i % W, y = i / W;
      if (x == 0 || y == 0 || x == W - 1 || y == H - 1) { bx += x; by += y; bn++; }
      if (x > 0 && fg[i - 1] && !label[i - 1]) { label[i - 1] = nl; pix[top++] = i - 1; }
      if (x < W - 1 && fg[i + 1] && !label[i + 1]) { label[i + 1] = nl; pix[top++] = i + 1; }
      if (y > 0 && fg[i - W] && !label[i - W]) { label[i - W] = nl; pix[top++] = i - W; }
      if (y < H - 1 && fg[i + W] && !label[i + W]) { label[i + W] = nl; pix[top++] = i + W; }
    }
    const int area = top - start;
    if (area < MIN_AREA) { for (int k = start; k < top; k++) label[pix[k]] = -1; top = start; continue; } // too small to be a hand
    blobs[nb++] = Blob{start, top, area, bx, by, bn};
  }
  return nb;
}

/* ---------- process: returns 1 if (re)initialised, 0 otherwise ---------- */
EXPORT("tb_process") int tb_process(double now, double sens, int rows, int cols) {
  const double thr = 34 - 2 * sens; // luminance difference that counts as "something is there"
  nstrikes = 0;
  if (!ready) {
    if (!seeded) bgInit();
    seeded = false;
    classify(thr);
    __builtin_memcpy(prevY, curY, N * 4);
    ready = true; ntracks = 0; refT = lastT = now;
    return 1;
  }
  frames++;
  const bool tick = now - refT >= TICK;
  const double dt = dmin(200, dmax(1, now - lastT)); lastT = now;
  if (tick) { refT = now; __builtin_memcpy(prevY, curY, N * 4); }
  prof_start(BGSUB);
  const int fgCount = classify(thr);
  prof_end(BGSUB);
  // lighting change or camera bumped: most of the frame "changed" -> relearn the background
  if (fgCount > N * 0.55) { ready = false; frames = 0; return tb_process(now, sens, rows, cols); }

  prof_start(BLOBS);
  int nb = labelBlobs();
  prof_end(BLOBS);
  prof_start(LEARN);
  learn(1 - js_exp(-dt / 800), 1 - js_exp(-dt / 20000));
  prof_end(LEARN);
  prof_start(TRACK);
  for (int i = 1; i < nb; i++) { // stable insertion sort, biggest first
    const Blob b = blobs[i]; int j = i - 1;
    while (j >= 0 && blobs[j].area < b.area) { blobs[j + 1] = blobs[j]; j--; }
    blobs[j + 1] = b;
  }
  nb = imin(nb, MAX_TIPS);

  // fingertip of each blob = the part farthest from where the arm enters the frame
  double fx[MAX_TIPS], fy[MAX_TIPS];
  for (int bi = 0; bi < nb; bi++) {
    const Blob& bl = blobs[bi];
    double ex = entryX, ey = entryY;
    if (bl.bn > 2) {
      ex = bl.bx / bl.bn; ey = bl.by / bl.bn;
      if (bl.area > MIN_AREA * 4) { entryX += (ex - entryX) * 0.05; entryY += (ey - entryY) * 0.05; } // only arms teach it
    }
    double dm = 0;
    for (int k = bl.start; k < bl.end; k++) {
      const int i = pix[k], x = i % W, y = i / W;
      const double dd = (x - ex) * (x - ex) + (y - ey) * (y - ey);
      if (dd > dm) dm = dd;
    }
    const double cut = dmax(0, __builtin_sqrt(dm) - 2.5), cut2 = cut * cut;
    double sx = 0, sy = 0, sn = 0;
    for (int k = bl.start; k < bl.end; k++) {
      const int i = pix[k], x = i % W, y = i / W;
      if ((x - ex) * (x - ex) + (y - ey) * (y - ey) >= cut2) { sx += x; sy += y; sn++; }
    }
    fx[bi] = sx / sn; fy[bi] = sy / sn;
  }

  // match tips to existing tracks (nearest first)
  struct Pair { double d; int fi, ti; } pairs[MAX_TIPS * MAX_TIPS];
  int np = 0;
  for (int fi = 0; fi < nb; fi++) for (int ti = 0; ti < ntracks; ti++) {
    const double dd = js_hypot(fx[fi] - tracks[ti].x, fy[fi] - tracks[ti].y);
    if (dd < MATCH) pairs[np++] = Pair{dd, fi, ti};
  }
  for (int i = 1; i < np; i++) { // stable insertion sort, nearest first
    const Pair p = pairs[i]; int j = i - 1;
    while (j >= 0 && pairs[j].d > p.d) { pairs[j + 1] = pairs[j]; j--; }
    pairs[j + 1] = p;
  }
  bool fTaken[MAX_TIPS] = {}, used[MAX_TIPS] = {};
  int nn = 0;
  for (int k = 0; k < np; k++) {
    const int fi = pairs[k].fi, ti = pairs[k].ti;
    if (fTaken[fi] || used[ti]) continue;
    fTaken[fi] = used[ti] = true;
    Track t = tracks[ti];
    t.dx += fx[fi] - t.x; t.dy += fy[fi] - t.y; t.x = fx[fi]; t.y = fy[fi];
    nextTracks[nn++] = t;
  }
  for (int fi = 0; fi < nb; fi++) {
    if (fTaken[fi]) continue;
    Track t = {};
    t.id = nextId++; t.x = fx[fi]; t.y = fy[fi]; t.born = now; t.u = t.v = -1; t.pad = -1;
    nextTracks[nn++] = t;
  }
  ntracks = nn;
  for (int i = 0; i < nn; i++) tracks[i] = nextTracks[i];

  // per track: grid position, local activity, strike detection
  const int rad = imax(3, (int)js_round(W * 0.03));
  const double mthr = dmax(8, thr * 0.55);
  const double hi = 0.30 - 0.022 * sens, lo = hi * 0.35;
  for (int ti = 0; ti < ntracks; ti++) {
    Track& t = tracks[ti];
    const double gx = (t.x + 0.5) / W, gy = (t.y + 0.5) / H;
    const double wq = inv[6] * gx + inv[7] * gy + inv[8];
    const double u = (inv[0] * gx + inv[1] * gy + inv[2]) / wq, v = (inv[3] * gx + inv[4] * gy + inv[5]) / wq;
    t.u = u; t.v = v;
    t.pad = u >= 0 && u < 1 && v >= 0 && v < 1 ? (int)__builtin_floor(v * rows) * cols + (int)__builtin_floor(u * cols) : -1;
    if (!tick) continue;
    const int cx = (int)js_round(t.x), cy = (int)js_round(t.y);
    int moved = 0, cnt = 0;
    for (int y = imax(0, cy - rad); y <= imin(H - 1, cy + rad); y++) {
      for (int x = imax(0, cx - rad); x <= imin(W - 1, cx + rad); x++) {
        const int i = y * W + x; cnt++;
        if (dabs((double)curY[i] - (double)prevY[i]) > mthr) moved++;
      }
    }
    const double travel = js_hypot(t.dx, t.dy); t.dx = t.dy = 0;
    const double a = dmin(1, dmax((double)moved / cnt, travel / (W * 0.05)));
    if (t.n == HIST) { // keep the last HIST samples, oldest first
      for (int k = 1; k < HIST; k++) { t.act[k - 1] = t.act[k]; t.actT[k - 1] = t.actT[k]; t.trav[k - 1] = t.trav[k]; }
      t.n--;
    }
    t.act[t.n] = a; t.actT[t.n] = now; t.trav[t.n] = travel; t.n++;
    /* strike = a short, sharp burst of activity that stops dead (the table stops the finger).
       Lifting the finger is slower (a longer burst), and a hand sliding in travels far; neither counts. */
    const int n = t.n;
    t.strike = 0;
    if (n >= 3 && frames > 10 && t.pad >= 0 && now - t.lastStrike > REFRACT && a <= t.act[n - 2] * 0.45) {
      int len = 0; double peak = 0, travel2 = 0;
      for (int k = n - 2; k >= 0 && t.act[k] > lo; k--) { len++; peak = dmax(peak, t.act[k]); travel2 += t.trav[k]; }
      if (len >= 1 && len <= 2 && peak >= hi && travel2 < W * 0.06) { t.strike = 1; t.lastStrike = now; strikeIdx[nstrikes++] = ti; }
    }
  }
  prof_end(TRACK);
  return 0;
}
