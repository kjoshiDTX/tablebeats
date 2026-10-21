# TableBeats

Tap your table, make music. Runs entirely in your browser (Chrome or Safari on a Mac). No accounts, nothing uploaded.

## Run it
Double-click `start.command` (first time: right-click > Open). It starts a tiny local server and opens
http://localhost:8123. Manual alternative: `python3 -m http.server 8123` in this folder.

## Use it
1. Start camera, allow access. Drag the 4 yellow corners onto your table; the grid follows the perspective.
2. Pick a kit, or import real sounds (below). Click any pad on screen to select/edit it.
3. Tap the table. Record = 1-bar count-in, then everything you play lands on the Timeline.
4. Click timeline cells to add/remove hits by hand. Record session saves an audio file.

Tip: set up with the screen open, then tilt the lid down. Corners, pads and library are saved.

## Tap detection
The camera tracks your fingertip (white ring). The pad under the fingertip is the pad that plays,
no matter where the rest of your hand or arm is.
- Tap (default): the mic hears each tap, so every tap counts, even fast repeated taps on one pad.
  It learns to ignore its own sound from the speakers (move your hands off the table for a second
  while a loop plays to help it learn). Headphones work best.
- Camera only: fires on a short, sharp fingertip strike. No mic needed, but less reliable.

## Real hip-hop / house sounds
Download free royalty-free packs (links are inside the app), unzip, then Add folder... in the Sound library.
Do not re-share the packs themselves (SampleRadar terms).

Keys: 1-7 / Q-U / A-J / Z-M map to pads (shown in each pad's corner). Space = play/stop loop.

## Performance: vision on the GPU

The camera pipeline (js/pipeline.js) runs per frame: **capture** (get a 256x144 frame), **bgsub**
(background subtraction + denoise), **blobs** (connected components), **learn** (update the
background model), **track** (fingertips, strikes). It can run on the CPU (plain JS, js/vision.js)
or the GPU (js/gpu.js, WebGL2): the frame is uploaded as a texture and downscaled, background
subtraction and learning run as fragment shaders against an RGBA32F background model that never
leaves the GPU, and only the foreground mask is read back for blobs and tracking. Pick it under
*How taps are detected > Vision runs on* (Auto = GPU when WebGL2 + float render targets exist).
*Show detection details* shows per-stage p50/p95.

Median of 3 runs x 600 frames, synthetic camera (bench.html), Chrome 155, M2 Pro. 6x = Chrome CPU
throttling, a stand-in for an entry-level phone (it slows the main thread, not the GPU):

| vision ms / frame | CPU p50 | CPU p95 | GPU p50 | GPU p95 | GPU async p50 | GPU async p95 |
|---|---:|---:|---:|---:|---:|---:|
| M2 Pro | 2.43 | 5.04 | 2.43 | 5.47 | **1.61** | 4.46 |
| 6x CPU throttle | 11.55 | 26.7 | **6.45** | 24.9 | 6.80 | 19.0 |

What the traces showed (Perfetto):
- On a fast CPU the plain GPU port is not faster. Capture drops from 1.75 to 0.39 ms and the JS
  background maths (0.5 ms) disappears, but `readPixels` waits for the GPU to finish the frame:
  1.8 ms of round trip. On a slow CPU the saved JS work dominates: median 11.6 -> 6.5 ms.
- Async readback (`?readback=async`: pixel buffer + fence, read next frame) removes the GPU wait;
  what's left is one IPC round trip to the GPU process (~0.7 ms; Chrome's `getBufferSubData`
  always waits for it). Median 2.43 -> 1.61 ms, but tips are one camera frame old and it still
  blocks when the GPU falls behind, so the app keeps the synchronous readback.
- The first benchmark runs had GPU p95s of 30-40 ms. The trace showed the GPU process's main
  thread busy for up to 105 ms in `RasterDecoderImpl::DoReadbackARGBImagePixelsINTERNAL`: reading
  back the benchmark's own synthetic-camera canvas for `captureStream()`, with our `readPixels`
  queued behind it. A real camera doesn't do that; moving the synthetic scene to CPU canvases
  brought the GPU p95 from 8-39 ms down to 4.5-6.2 ms.

Run it yourself:
```
npm install
npm run bench -- --throttle 6            # CPU, GPU, GPU async; traces in bench-out/
uv run tools/trace/stages.py bench-out/trace-cpu.json bench-out/trace-gpu.json
npm test                                 # tracker tests (node, no browser)
```
Open any `bench-out/trace-*.json` in https://ui.perfetto.dev: the stages are `tb:*` slices on the
renderer main thread; the GPU process's `CrGpuMain` thread shows what a readback waited on.
Or open http://localhost:8123/bench.html and press Run.

## Graceful degradation on slow devices

With *Adapt to slow devices* on (default), a governor (js/quality.js) watches the p95 vision
time over 30-frame windows. When it's over budget (8 ms, half a 60 Hz frame) it steps down a
ladder: processing resolution 256x144 -> 192x108 -> 160x90 -> 128x72, then processing every
other camera frame. The background model is resampled to the new size, so a hand in view is not
relearned as background. It steps back up only when the level above is predicted to fit under
70% of the budget for 90 frames straight, so it doesn't flap. The debug overlay shows the level.

Not on the ladder: camera resolution. Asking for 640x360 instead of 1280x720 saved only 25% of
capture time (it's mostly a fixed per-frame cost) and lost ~40% of strikes in the benchmark.

Median of 2 runs x 600 frames per cell (bench.html, M2 Pro). Vision ms per camera frame, skipped
frames count as 0; strikes = taps detected in the same synthetic scene:

| CPU backend | mean | p95 | frames processed | strikes |
|---|---:|---:|---:|---:|
| 1x, no fallback | 2.83 | 4.69 | 100% | 38-48 |
| 1x, fallback | 2.38 | 4.18 | 100% (mostly 192x108) | 49-60 |
| 4x, no fallback | 8.26 | 15.3 | 100% | 58-102 |
| 4x, fallback | **4.12** | **10.1** | 55% (mostly 128x72, every 2nd) | 62-69 |
| 6x, no fallback | 9.71 | 18.2 | 100% | 83-94 |
| 6x, fallback | **4.68** | **11.2** | 50% (128x72, every 2nd) | 63-73 |

On a throttled CPU the fallback halves the mean and cuts p95 by 35-40%. Most of that comes from
skipping frames: processing at 128x72 instead of 256x144 saves less than you'd think, because
getting the frame (capture) costs the same at any processing size. Skipping costs ~25% of strikes
in Camera-only mode; Tap mode times taps from the mic, so there it only makes the fingertip
position update less often. The GPU backend improves too (6x p95 32 -> 20 ms) but its p95 is
dominated by readback stalls that vary a lot from run to run on this machine (16-38 ms).

```
npm run bench -- --backends cpu,gpu --throttle 4 --adaptive 8   # fallback on, 8 ms budget
```

## The tracker in C++ (WebAssembly)

`native/tracker.cpp` is the tracker (background subtraction, shadow rejection, denoise, blob
labelling, background learning, fingertips, tracking, strike detection) ported line for line from
js/vision.js and compiled to a 9 KB WebAssembly module, `js/tracker.wasm`. Pick *CPU (WebAssembly,
C++)* under *Vision runs on*; Auto tries GPU, then WebAssembly, then JavaScript.

- **Same output as the JS tracker, bit for bit.** Doubles wherever JS uses numbers, float32
  wherever JS keeps a Float32Array, stable sorts, JS's `Math.round`, and `Math.exp`/`Math.hypot`
  imported from the JS engine so libm can't differ in the last bit. `npm test` runs both trackers
  on 400 frames (perspective grid, two arms, a hand not touching the edge, a lighting jump that
  forces a relearn, a resolution switch) and compares every track field and every strike.
  Mutants (a changed shadow threshold, a changed arm-entry rate) fail it.
- **No change for users while it loads.** The app starts on the JS tracker; the module loads in the
  background and takes over between two frames, keeping the learned background. If it can't load,
  or the GPU/WebAssembly tracker throws (e.g. a browser cache serving app files of different
  versions, which really happened while testing this), the JS tracker carries on and at most one
  frame is lost. The camera loop schedules its next frame before processing, so one bad frame can
  never stop tracking.
- **Build:** `tools/build-wasm.sh` (Zig's clang via `uv`, nothing to install;
  `-target wasm32-freestanding`, no libc). The .wasm is committed, so the app still needs no build;
  CI rebuilds it and fails if the committed file doesn't match the C++.

Median of 3 runs x 600 frames (bench.html, M2 Pro). "tracker" is everything after getting the
camera frame (identical code for both), including copying the frame into WebAssembly memory
(5 us):

| ms per frame | JS tracker p50 | Wasm p50 | JS p95 | Wasm p95 |
|---|---:|---:|---:|---:|
| 1x | 0.520 | **0.390** (-25%) | 1.46 | **0.97** (-34%) |
| 4x CPU throttle | 2.58 | **1.90** (-26%) | 7.13 | **4.65** (-35%) |
| 6x CPU throttle | 3.54 | **2.84** (-20%) | 7.73 | 7.10 |

By stage (1x, p50): background learning 0.205 -> 0.110 ms, blobs 0.060 -> 0.050, tracking
0.025 -> 0.010, background subtraction 0.180 -> 0.155 (V8's JIT already does well on that loop).
The whole frame improves less (p50 2.10 -> 2.00 ms) because getting the frame from the camera is
most of it, and that's the same code either way. A `-msimd128` build gave identical output and no
speedup (the per-pixel branches don't vectorise), so the shipped build is scalar and runs on more
browsers.

```
tools/build-wasm.sh                                    # after editing native/tracker.cpp
npm run bench -- --backends cpu,wasm --throttle 4
```

## Performance agent and CI regression check

`tools/perf_agent/agent.py` is a LangGraph agent that reads the benchmark's Chrome traces with
Perfetto's trace processor:

```
measure -> compare -> analyst <-> tools -> report
```

- **measure**: per-stage frame times from the `tb:*` slices; names the slowest stage per backend.
- **compare** (when given a base commit's traces): for each stage, the change in p50 and p95 with
  a 95% bootstrap interval. The bootstrap resamples whole runs, then frames within each run, since
  frames of one run share its conditions. A stage regresses only when the entire interval is
  above +10% (p50) or +20% (p95) and it got at least 0.1 ms slower, so noise alone can't fail a
  build. The verdict comes from this step, never from the model.
- **analyst**: Claude (`claude-opus-5-5`, Anthropic SDK) with read-only tools over the traces: stage
  table, slowest frames with their stage breakdown, what Chrome's threads were doing during a frame,
  and raw Perfetto SQL. It writes the explanation: which stage, spread or spikes, likely cause.
  Skipped when there are no Anthropic credentials (or `--no-llm`).
- **report**: Markdown table + analysis, to stdout, `--report file` and the GitHub job summary.
  Exit status 1 when any stage regressed. Tested on 3+3 runs: identical code passed (GPU vision
  moved +16% from run-to-run noise, inside its interval); a 0.5 ms busy-wait injected into
  `blobs` was flagged as +902% p50 on both backends and nothing else was.

```
uv run tools/perf_agent/agent.py --head bench-out/trace-*.json            # bottleneck only
uv run tools/perf_agent/agent.py --base old/trace-*.json --head new/trace-*.json --report perf.md
uv run tools/perf_agent/test_agent.py bench-out/trace-cpu.json           # graph test, stubbed Claude
```

`.github/workflows/perf.yml` runs this on every push to main and every pull request: it benchmarks
the base commit and the new one on the same runner (3 interleaved runs each, CPU and GPU backends),
runs the agent, uploads the traces, and fails the job on a regression. Add an `ANTHROPIC_API_KEY`
repository secret to get Claude's analysis in the job summary. CI runners have no GPU, so the GPU
backend runs on SwiftShader there: it still catches regressions in that code path, but its
absolute numbers say nothing about real devices.
