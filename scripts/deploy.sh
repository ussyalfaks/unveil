#!/usr/bin/env bash
# Build and deploy the Unveil contract to Stellar testnet, register the default
# platform (#0 "Unveil"), then write apps/frontend/.env.local.
#
# Needs: Rust + the Stellar CLI (https://developers.stellar.org/docs/tools/cli/install-cli)
#   rustup target add wasm32v1-none
#
# Options (env vars):
#   TOKEN=xlm|usdc   which asset deposits use (default xlm: no trustline needed)
#   MIN_DEPOSIT=50   minimum deposit, whole units
#   WATCH_SECS=300   leak-watch window. 300s is good for a live demo; use 604800 (7 days) for real use
#   PLATFORM_FEE=1   fee per reveal on the default platform, whole units (paid only if the anon approves)
#   PROTOCOL_FEE_BPS=1000   protocol's cut of every platform fee, basis points (1000 = 10%, max 3000)
#   TREASURY=G…      receives the protocol's cut (default: the admin wallet)
set -euo pipefail
cd "$(dirname "$0")/.."

NET=testnet
TOKEN=${TOKEN:-xlm}
MIN_DEPOSIT=${MIN_DEPOSIT:-50}
WATCH_SECS=${WATCH_SECS:-300}
PLATFORM_FEE=${PLATFORM_FEE:-1}
PROTOCOL_FEE_BPS=${PROTOCOL_FEE_BPS:-1000}
USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 # Circle testnet USDC

if ! stellar keys address unveil-admin >/dev/null 2>&1; then
  echo "→ Creating and funding the admin/arbiter key 'unveil-admin'"
  stellar keys generate unveil-admin --network $NET --fund
fi
ADMIN=$(stellar keys address unveil-admin)
TREASURY=${TREASURY:-$ADMIN}

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

echo "→ Deploying (deposit token $SYMBOL, min $MIN_DEPOSIT, watch ${WATCH_SECS}s, protocol cut ${PROTOCOL_FEE_BPS} bps)"
CONTRACT_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/unveil.wasm \
  --source unveil-admin --network $NET \
  -- \
  --admin "$ADMIN" \
  --token "$TOKEN_ID" \
  --min_deposit $((MIN_DEPOSIT * 10000000)) \
  --watch_secs "$WATCH_SECS" \
  --treasury "$TREASURY" \
  --protocol_fee_bps "$PROTOCOL_FEE_BPS")

echo "→ Registering the default platform #0 \"Unveil\" (fee $PLATFORM_FEE $SYMBOL; admin is owner, payout and arbiter)"
PLATFORM_ID=$(stellar contract invoke --id "$CONTRACT_ID" --source unveil-admin --network $NET -- \
  register_platform \
  --owner "$ADMIN" \
  --name Unveil \
  --fee_to "$ADMIN" \
  --arbiter "$ADMIN" \
  --fee $((PLATFORM_FEE * 10000000)))

if [ -d apps/frontend ]; then
  cat > apps/frontend/.env.local <<EOF
NEXT_PUBLIC_CONTRACT_ID=$CONTRACT_ID
NEXT_PUBLIC_TOKEN_SYMBOL=$SYMBOL
NEXT_PUBLIC_NETWORK=$NET
NEXT_PUBLIC_PLATFORM_ID=$PLATFORM_ID
EOF
fi

echo
echo "✓ Contract: $CONTRACT_ID"
echo "  https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"
echo "✓ Default platform: #$PLATFORM_ID \"Unveil\""
echo "✓ Admin, platform owner and arbiter wallet: $ADMIN"
echo "  To act as arbiter in the app, import its secret into your wallet: stellar keys show unveil-admin"
echo "  Then open the Arbiter tab and set up the evidence key."
echo "✓ Wrote apps/frontend/.env.local. Next: npm run dev"
