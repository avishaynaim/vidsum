#!/bin/sh
# Downloads Google MediaPipe (tasks-vision) and its face landmark model into vendor/mediapipe,
# which the server serves to the summary viewer's "Eye page-turn" (eye-scroll.js). Kept out of
# git (several MB). Run once on a new server: ./fetch-mediapipe.sh
set -e
VERSION=1.0.1
DIR="$(dirname "$0")/vendor/mediapipe"
mkdir -p "$DIR/wasm"
TMP=$(mktemp -d)
curl -fsSL "https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-$VERSION.tgz" | tar -xz -C "$TMP"
cp "$TMP/package/vision_bundle.mjs" "$DIR/"
cp "$TMP"/package/wasm/vision_wasm_internal.* "$DIR/wasm/"
cp "$TMP"/package/wasm/vision_wasm_nosimd_internal.* "$DIR/wasm/" 2>/dev/null || true
cp "$TMP/package/LICENSE" "$DIR/" 2>/dev/null || true
rm -rf "$TMP"
curl -fsSL -o "$DIR/face_landmarker.task" \
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
echo "MediaPipe $VERSION ready in $DIR"
