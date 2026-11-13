#!/usr/bin/env bash
# Build both contracts (run inside WSL/Linux with Rust + wasm32 target).
#   bash tools/build.sh   -> evidence/wellkeep_vault.wasm, then evidence/wellkeep_pool.wasm (which embeds the vault; v1 stays as evidence/borehole_pool.wasm)
# Needs: rustup with wasm32-unknown-unknown, and `npm i binaryen` for wasm-opt (path below).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/bh-target}"
WASMOPT="${WASMOPT:-$HOME/tools/node_modules/.bin/wasm-opt}"
# --cfg near makes near-sdk use the real on-chain host functions (panic messages, hashing). Without it the
# panic text is lost ("unreachable") and hashing falls back to bundled Rust code.
export RUSTFLAGS="--cfg near"

opt() { "$WASMOPT" -Oz --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int --strip-debug --strip-producers "$1" -o "$2"; }

# 1. the vault first: the pool embeds its exact bytes
cd "$here/vault"
cargo build --release --target wasm32-unknown-unknown
opt "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/wellkeep_vault.wasm" "$here/evidence/wellkeep_vault.wasm"

# 2. the pool
cd "$here/contract"
cargo build --release --target wasm32-unknown-unknown
opt "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/borehole_pool.wasm" "$here/evidence/wellkeep_pool.wasm"

ls -l "$here/evidence/wellkeep_vault.wasm" "$here/evidence/wellkeep_pool.wasm"
sha256sum "$here/evidence/wellkeep_vault.wasm" "$here/evidence/wellkeep_pool.wasm"
