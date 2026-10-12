#!/bin/bash
# Double-click to launch TableBeats (Mac). Needs a local server so the browser allows camera access.
cd "$(dirname "$0")"
PORT=8123
(sleep 1.2 && open "http://localhost:$PORT") &
if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server $PORT
elif command -v npx >/dev/null 2>&1; then
  npx --yes serve -l $PORT .
else
  echo "Please install Python 3 (xcode-select --install) and run this again."
  read -n 1 -s -r -p "Press any key to close"
fi
