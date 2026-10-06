#!/usr/bin/env bash
# Build and deploy the Unveil contract to Stellar testnet, then write web/.env.
#
# Needs: Rust + the Stellar CLI (https://developers.stellar.org/docs/tools/cli/install-cli)
#   rustup target add wasm32v1-none
#
# Options (env vars):
#   TOKEN=xlm|usdc   which asset deposits use (default xlm: no trustline needed)
#   MIN_DEPOSIT=50   minimum deposit, whole units
#   WATCH_SECS=300   leak-watch window. 300s is good for a live demo; use 604800 (7 days) for real use
set -euo pipefail
cd "$(dirname "$0")/.."

NET=testnet
TOKEN=${TOKEN:-xlm}
MIN_DEPOSIT=${MIN_DEPOSIT:-50}
WATCH_SECS=${WATCH_SECS:-300}
USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 # Circle testnet USDC

if ! stellar keys address unveil-admin >/dev/null 2>&1; then
  echo "→ Creating and funding the admin/arbiter key 'unveil-admin'"
  stellar keys generate unveil-admin --network $NET --fund
fi
ADMIN=$(stellar keys address unveil-admin)

if [ "$TOKEN" = "usdc" ]; then
  ASSET="USDC:$USDC_ISSUER"; SYMBOL=USDC
else
  ASSET=native; SYMBOL=XLM
fi
TOKEN_ID=$(stellar contract id asset --asset "$ASSET" --network $NET)
# Make sure the asset's contract exists (no-op error if it already does).
stellar contract asset deploy --asset "$ASSET" --source unveil-admin --network $NET >/dev/null 2>&1 || true

echo "→ Building contract"
stellar contract build

echo "→ Deploying (deposit token $SYMBOL, min $MIN_DEPOSIT, watch ${WATCH_SECS}s)"
CONTRACT_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/unveil.wasm \
  --source unveil-admin --network $NET \
  -- \
  --admin "$ADMIN" \
  --token "$TOKEN_ID" \
  --min_deposit $((MIN_DEPOSIT * 10000000)) \
  --watch_secs "$WATCH_SECS")

cat > web/.env <<EOF
VITE_CONTRACT_ID=$CONTRACT_ID
VITE_TOKEN_SYMBOL=$SYMBOL
EOF

echo
echo "✓ Contract: $CONTRACT_ID"
echo "  https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"
echo "✓ Arbiter (admin) wallet: $ADMIN"
echo "  To act as arbiter in the app, import its secret into Freighter: stellar keys show unveil-admin"
echo "✓ Wrote web/.env. Next: cd web && npm install && npm start"
