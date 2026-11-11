#!/usr/bin/env bash
# Runs both Chromium suites against src/ (the second one builds and loads the real extension).
set -euo pipefail
cd "$(dirname "$0")/.."
./build.sh >/dev/null
echo "== content script (drawing, editing, undo, anchoring) =="
node test/run.mjs
echo
echo "== anchoring on pages with an inner scroll container =="
node test/scroll.mjs
echo
echo "== packaged extension (manifest, service worker, messaging) =="
node test/extension.mjs
