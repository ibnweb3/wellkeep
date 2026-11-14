#!/usr/bin/env bash
# Writes evidence/state-init.json: the pool's exact initial storage, from the contract's own Borsh layout.
# The pool's address is derived from this plus the code hash, so the same file lets anyone recompute it.
# Run inside WSL/Linux. Parameters are the live build's (1 hour hold and vote window; USDC has 6 decimals).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$here/web/public/demo/leaves.json','utf8')).root)")"
USDC=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
cd "$here/contract"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/bh-target-host}" cargo run --release --quiet --features state-tool --example state -- \
  bh-signer-a.testnet bh-signer-b.testnet "$root" 150 3600 3600 5 8 4000000 1000000 2000000 3000000 70 2 2 "$USDC" > "$here/evidence/state-init.json"
cat "$here/evidence/state-init.json" | head -c 200; echo
