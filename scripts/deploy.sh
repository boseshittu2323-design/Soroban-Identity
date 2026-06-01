#!/usr/bin/env bash
# Deploy Soroban Identity contracts to Stellar network
set -euo pipefail

# Parse command line arguments
NETWORK="testnet"
while [[ $# -gt 0 ]]; do
  case $1 in
    --network)
      NETWORK="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--network testnet|mainnet|local]"
      exit 1
      ;;
  esac
done

# Network configuration
case "$NETWORK" in
  testnet)
    STELLAR_NETWORK="testnet"
    STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
    ;;
  mainnet)
    STELLAR_NETWORK="mainnet"
    STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-mainnet.stellar.org}"
    ;;
  local)
    STELLAR_NETWORK="local"
    STELLAR_RPC_URL="${STELLAR_RPC_URL:-http://localhost:8000/soroban/rpc}"
    ;;
  *)
    echo "Error: Invalid network '$NETWORK'. Must be testnet, mainnet, or local."
    exit 1
    ;;
esac

# ─── Secret key security checks ─────────────────────────────────────────────
# STELLAR_SECRET_KEY should always be injected by a secrets manager, never
# typed into an interactive shell or stored in a .env file committed to git.
#
# Recommended approaches:
#   GitHub Actions : store as a repository secret; access via ${{ secrets.STELLAR_SECRET_KEY }}
#   AWS            : aws secretsmanager get-secret-value --secret-id stellar/deploy-key --query SecretString --output text
#   HashiCorp Vault: vault kv get -field=key secret/stellar
#   1Password CLI  : op read "op://vault/stellar-deploy/key"
#
# For mainnet deployments, strongly consider hardware wallet signing
# (Ledger via stellar-hd-wallet) to avoid exposing the raw key at all.

if [[ -z "${STELLAR_SECRET_KEY:-}" ]]; then
  echo "Error: STELLAR_SECRET_KEY is not set."
  echo "  Inject it from a secrets manager — do not paste it into your shell."
  exit 1
fi

# Warn when shell history is recording (key may end up in ~/.bash_history etc.)
if [[ -n "${HISTFILE:-}" ]] && [[ "${HISTCONTROL:-}" != *ignorespace* ]]; then
  echo "WARNING: Shell history is active. If you exported STELLAR_SECRET_KEY in"
  echo "         this terminal the raw key may be saved to: ${HISTFILE}"
  echo "         Prefix the export with a space (HISTCONTROL=ignorespace) or use"
  echo "         a secrets manager to avoid this."
  echo ""
fi

# Extra gate for mainnet: require explicit acknowledgement and add a delay so
# accidental runs can be aborted before any irreversible action is taken.
if [[ "$NETWORK" == "mainnet" ]]; then
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "  WARNING: Deploying to MAINNET with a live secret key."
  echo "  Verify that STELLAR_SECRET_KEY was injected from a"
  echo "  secrets manager and is NOT present in CI logs, shell"
  echo "  history, or any committed file."
  echo "  Press Ctrl+C within 10 seconds to abort."
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo ""
  sleep 10
fi

SOURCE_ACCOUNT="$STELLAR_SECRET_KEY"

# Retry configuration with exponential backoff
MAX_RETRIES="${MAX_RETRIES:-3}"
RETRY_DELAY="${RETRY_DELAY:-2}"

# Retry function with exponential backoff
retry_command() {
  local max_attempts="$MAX_RETRIES"
  local delay="$RETRY_DELAY"
  local attempt=1

  while [ "$attempt" -le "$max_attempts" ]; do
    echo "Attempt $attempt/$max_attempts..."
    if "$@"; then
      return 0
    fi
    echo "Failed. Retrying in ${delay}s..."
    sleep "$delay"
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done

  echo "All attempts failed."
  return 1
}

# Print active network
echo "========================================"
echo "  Deployment Configuration"
echo "========================================"
echo "  Network:  $STELLAR_NETWORK"
echo "  RPC URL:  $STELLAR_RPC_URL"
echo "  Max Retries:  $MAX_RETRIES"
echo "  Initial Retry Delay:  ${RETRY_DELAY}s"
echo "========================================"
echo ""

# Check for existing deployment
DEPLOYED_ENV="$(dirname "$0")/../deployed.env"
if [[ -f "$DEPLOYED_ENV" ]]; then
  echo "==> Found existing deployment configuration"
  source "$DEPLOYED_ENV"
  
  # Check if contracts are already deployed and initialized
  if [[ -n "${IDENTITY_REGISTRY_ID:-}" && -n "${CREDENTIAL_MANAGER_ID:-}" && -n "${REPUTATION_ID:-}" ]]; then
    echo "==> Checking existing contracts..."
    
    # Test if contracts are accessible and initialized
    CONTRACTS_EXIST=true
    for contract_id in "$IDENTITY_REGISTRY_ID" "$CREDENTIAL_MANAGER_ID" "$REPUTATION_ID"; do
      if ! stellar contract invoke --id "$contract_id" --source "$SOURCE_ACCOUNT" --network "$STELLAR_NETWORK" --rpc-url "$STELLAR_RPC_URL" -- --help >/dev/null 2>&1; then
        CONTRACTS_EXIST=false
        break
      fi
    done
    
    if [[ "$CONTRACTS_EXIST" == "true" ]]; then
      echo "==> Contracts already deployed and accessible:"
      echo "  identity-registry:  $IDENTITY_REGISTRY_ID"
      echo "  credential-manager: $CREDENTIAL_MANAGER_ID"
      echo "  reputation:         $REPUTATION_ID"
      echo "==> Skipping deployment (contracts already exist)"
      echo "==> To force re-deployment, delete deployed.env and run again"
      exit 0
    else
      echo "==> Existing contracts not accessible, proceeding with fresh deployment"
    fi
  fi
fi

echo "==> Building contracts..."
if ! (cd contracts && cargo build --target wasm32-unknown-unknown --release); then
  echo "Error: Failed to build contracts"
  exit 1
fi

REGISTRY_WASM="contracts/target/wasm32-unknown-unknown/release/identity_registry.wasm"
CREDENTIAL_WASM="contracts/target/wasm32-unknown-unknown/release/credential_manager.wasm"
REPUTATION_WASM="contracts/target/wasm32-unknown-unknown/release/reputation.wasm"

# Verify WASM files exist
for wasm_file in "$REGISTRY_WASM" "$CREDENTIAL_WASM" "$REPUTATION_WASM"; do
  if [[ ! -f "$wasm_file" ]]; then
    echo "Error: WASM file not found: $wasm_file"
    exit 1
  fi
done

echo "==> Deploying identity-registry..."
if ! REGISTRY_ID=$(retry_command stellar contract deploy \
  --wasm "$REGISTRY_WASM" \
  --source "$SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK" \
  --rpc-url "$STELLAR_RPC_URL"); then
  echo "Error: Failed to deploy identity-registry contract"
  exit 1
fi
echo "identity-registry: $REGISTRY_ID"

echo "==> Deploying credential-manager..."
if ! CREDENTIAL_ID=$(retry_command stellar contract deploy \
  --wasm "$CREDENTIAL_WASM" \
  --source "$SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK" \
  --rpc-url "$STELLAR_RPC_URL"); then
  echo "Error: Failed to deploy credential-manager contract"
  exit 1
fi
echo "credential-manager: $CREDENTIAL_ID"

echo "==> Deploying reputation..."
if ! REPUTATION_ID=$(retry_command stellar contract deploy \
  --wasm "$REPUTATION_WASM" \
  --source "$SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK" \
  --rpc-url "$STELLAR_RPC_URL"); then
  echo "Error: Failed to deploy reputation contract"
  exit 1
fi
echo "reputation: $REPUTATION_ID"

echo "==> Initializing contracts..."
if ! ADMIN_ADDRESS=$(stellar keys address "$SOURCE_ACCOUNT" --network "$STELLAR_NETWORK"); then
  echo "Error: Failed to get admin address from source account"
  exit 1
fi

if ! retry_command stellar contract invoke \
  --id "$REGISTRY_ID" \
  --source "$SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- initialize --admin "$ADMIN_ADDRESS"; then
  echo "Error: Failed to initialize identity-registry contract"
  exit 1
fi

if ! retry_command stellar contract invoke \
  --id "$CREDENTIAL_ID" \
  --source "$SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- initialize --admin "$ADMIN_ADDRESS"; then
  echo "Error: Failed to initialize credential-manager contract"
  exit 1
fi

if ! retry_command stellar contract invoke \
  --id "$REPUTATION_ID" \
  --source "$SOURCE_ACCOUNT" \
  --network "$STELLAR_NETWORK" \
  --rpc-url "$STELLAR_RPC_URL" \
  -- initialize --admin "$ADMIN_ADDRESS"; then
  echo "Error: Failed to initialize reputation contract"
  exit 1
fi

DEPLOYED_ENV="$(dirname "$0")/../deployed.env"
cat > "$DEPLOYED_ENV" <<EOF
IDENTITY_REGISTRY_ID=$REGISTRY_ID
CREDENTIAL_MANAGER_ID=$CREDENTIAL_ID
REPUTATION_ID=$REPUTATION_ID
EOF

echo ""
echo "========================================"
echo "  Deployment Summary"
echo "========================================"
echo "  Network:            $STELLAR_NETWORK"
echo "  RPC URL:            $STELLAR_RPC_URL"
echo "  identity-registry:  $REGISTRY_ID"
echo "  credential-manager: $CREDENTIAL_ID"
echo "  reputation:         $REPUTATION_ID"
echo "========================================"
echo ""
echo "Contract IDs written to deployed.env"
echo "Update sdk/src/index.ts with the IDs above."
