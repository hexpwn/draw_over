#!/usr/bin/env bash
# Builds loadable extension folders (and zips) for Chrome and Firefox.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
for target in chrome firefox; do
  out="dist/$target"
  mkdir -p "$out"
  cp src/background.js src/content.js "$out/"
  cp -r src/icons "$out/"
  cp "src/manifest.$target.json" "$out/manifest.json"
  (cd "$out" && zip -qrX "../draw-over-$target.zip" .)
  echo "built $out  ->  dist/draw-over-$target.zip"
done
