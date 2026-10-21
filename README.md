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

Preliminary numbers (1-2 runs per cell, bench.html, M2 Pro; vision ms per camera frame, skipped
frames count as 0):

| 4x CPU throttle | mean | p95 | frames processed | strikes |
|---|---:|---:|---:|---:|
| CPU, no fallback | 6.5-10.0 | 12.7-18.0 | 100% | 58-102 |
| CPU, fallback | 4.1 | 11.3 | 50% (128x72, every 2nd) | 69 |
| GPU, no fallback | 6.7-8.1 | 16.0-25.3 | 100% | 79-88 |
| GPU, fallback | 3.4 | 8.9 | 50% (128x72, every 2nd) | 55 |

```
npm run bench -- --backends cpu,gpu --throttle 4 --adaptive 8   # fallback on, 8 ms budget
```
