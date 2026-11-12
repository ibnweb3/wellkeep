#!/usr/bin/env bash
# Reproducible-ish build of the pool contract (run inside WSL/Linux with Rust + wasm32 target).
#   bash tools/build.sh   -> evidence/borehole_pool.wasm and its sha256
# Needs: rustup with wasm32-unknown-unknown, and `npm i binaryen` for wasm-opt (path below).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here/contract"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/bh-target}" cargo build --release --target wasm32-unknown-unknown
raw="${CARGO_TARGET_DIR:-$HOME/bh-target}/wasm32-unknown-unknown/release/borehole_pool.wasm"
WASMOPT="${WASMOPT:-$HOME/tools/node_modules/.bin/wasm-opt}"
"$WASMOPT" -Oz --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int \
  --strip-debug --strip-producers "$raw" -o "$here/evidence/borehole_pool.wasm"
ls -l "$here/evidence/borehole_pool.wasm"
sha256sum "$here/evidence/borehole_pool.wasm"
