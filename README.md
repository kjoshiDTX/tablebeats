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
