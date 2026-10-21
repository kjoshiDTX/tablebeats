#!/bin/sh
# Builds js/tracker.wasm from native/tracker.cpp. The .wasm is committed, so the app itself still needs
# no build step; run this after changing the C++. Uses Zig's bundled clang (PyPI "ziglang", via uv),
# so nothing has to be installed system-wide.
#   -target wasm32-freestanding  no libc, no WASI: the module imports only what native/tracker.cpp declares
#   -mbulk-memory                memset/memcpy become memory.fill/memory.copy instructions
#   -O3, no -ffast-math          the C++ must stay bit-identical to js/vision.js
set -e
cd "$(dirname "$0")/.."
uv run --quiet --with ziglang==0.17.0 python -m ziglang c++ \
  -target wasm32-freestanding -O3 -mbulk-memory -nostdlib -fno-exceptions -fno-rtti -Wall -Wextra \
  -Wl,--no-entry -Wl,--strip-all \
  -o js/tracker.wasm native/tracker.cpp
echo "js/tracker.wasm: $(wc -c < js/tracker.wasm | tr -d ' ') bytes"
