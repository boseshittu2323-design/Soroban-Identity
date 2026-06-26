# Architecture

## Overview

Soroban Identity is composed of three layers:

```
┌─────────────────────────────────────────┐
│              dApps / Frontend           │
├─────────────────────────────────────────┤
│           TypeScript SDK                │
│   IdentityClient  |  CredentialClient   │
├──────────────────┬──────────────────────┤
│ identity-registry│  credential-manager  │  ← Soroban contracts
└──────────────────┴──────────────────────┘
         Stellar Network (Soroban)
```

## Contracts

### identity-registry

Manages DID documents on-chain.

| Function | Description |
|---|---|
| `initialize(admin)` | One-time setup |
| `transfer_admin(current_admin, new_admin)` | Transfer admin rights (current admin only) |
| `create_did(controller, metadata)` | Mint a new DID |
| `update_did(controller, metadata)` | Update metadata |
| `deactivate_did(controller)` | Soft-delete a DID |
| `resolve_did(controller)` | Read a DID document |
| `has_active_did(controller)` | Boolean check |

### credential-manager

Issues and verifies verifiable credentials. A maximum of **100 issuers** (`MAX_ISSUERS`) can be registered at any time; `add_issuer` panics with `MaxIssuersReached` if the cap is hit.

| Function | Description |
|---|---|
| `initialize(admin)` | One-time setup |
| `transfer_admin(current_admin, new_admin)` | Transfer admin rights (current admin only) |
| `add_issuer(issuer)` | Register a trusted issuer (admin) |
| `remove_issuer(issuer)` | Remove an issuer (admin) |
| `issue_credential(issuer, subject, type, claims, claims_hash, sig, expires)` | Issue a credential |
| `revoke_credential(issuer, id)` | Revoke a credential |
| `verify_credential(id)` | Check validity |
| `verify_claims_hash(id, hash)` | Verify off-chain claims hash matches stored hash |
| `get_credential(id)` | Fetch full credential |

## DID Format

```
did:stellar:<bech32-stellar-address>
```

Example: `did:stellar:GABC...XYZ`

This is W3C DID-compatible and portable across any dApp that integrates the SDK.

## Credential Flow

```
Issuer                Subject               Verifier
  │                     │                      │
  │── issue_credential ─▶│                      │
  │                     │── present cred id ──▶│
  │                     │                      │── verify_credential
  │                     │                      │◀─ true / false
```

## Privacy

- Claims are stored on-chain as key-value pairs (public by default)
- For sensitive data, pass a SHA-256 hash of the off-chain claims payload as `claims_hash` to `issue_credential`; the raw claims can be stored off-chain (e.g. IPFS or encrypted storage) and verified on-chain with `verify_claims_hash(id, hash)`
- ZKP integration is planned for selective disclosure without revealing raw claims

## Contract Events

### identity-registry

| Event topic | Payload | Emitted by |
|---|---|---|
| `(IDENTITY, "created")` | `(controller: Address, timestamp: u64)` | `create_did` |
| `(IDENTITY, "updated")` | `(controller: Address, metadata_hash: BytesN<32>)` | `update_did` |
| `(IDENTITY, "deactivated")` | `(controller: Address, timestamp: u64)` | `deactivate_did` |

### credential-manager

| Event topic | Payload | Emitted by |
|---|---|---|
| `(CRED, "issued")` | `(id: BytesN<32>, subject: Address, issuer: Address, type: CredentialType)` | `issue_credential` |
| `(CRED, "revoked")` | `(id: BytesN<32>, issuer: Address)` | `revoke_credential` |

## Storage

- `persistent` storage is used for DID documents and credentials (survives ledger expiry with TTL bumps)
- `instance` storage is used for admin and issuer registry


## Deployment

### Prerequisites

- [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli) installed
- Rust toolchain with `wasm32-unknown-unknown` target: `rustup target add wasm32-unknown-unknown`

### 1. Build Contracts

```bash
cargo build --target wasm32-unknown-unknown --release --manifest-path contracts/Cargo.toml
```

Compiled `.wasm` files will be in `contracts/target/wasm32-unknown-unknown/release/`.

### 2. Deploy to Testnet

```bash
# Deploy identity-registry
stellar contract deploy \
  --wasm contracts/target/wasm32-unknown-unknown/release/identity_registry.wasm \
  --source <SECRET_KEY> \
  --network testnet

# Deploy credential-manager
stellar contract deploy \
  --wasm contracts/target/wasm32-unknown-unknown/release/credential_manager.wasm \
  --source <SECRET_KEY> \
  --network testnet
```

Each command prints a contract ID — save these for the next step.

### 3. Initialize Contracts

```bash
# Initialize identity-registry
stellar contract invoke \
  --id <IDENTITY_REGISTRY_CONTRACT_ID> \
  --source <SECRET_KEY> \
  --network testnet \
  -- initialize \
  --admin <ADMIN_ADDRESS>

# Initialize credential-manager
stellar contract invoke \
  --id <CREDENTIAL_MANAGER_CONTRACT_ID> \
  --source <SECRET_KEY> \
  --network testnet \
  -- initialize \
  --admin <ADMIN_ADDRESS>
```

### 4. Deploy to Mainnet

Replace `--network testnet` with `--network mainnet` in all commands above. Mainnet requires funded accounts — use [Stellar Laboratory](https://laboratory.stellar.org) or an exchange to fund your deployer key.

```bash
stellar contract deploy \
  --wasm contracts/target/wasm32-unknown-unknown/release/identity_registry.wasm \
  --source <SECRET_KEY> \
  --network mainnet
```

### 5. Configure the SDK

Pass the deployed contract IDs to the SDK clients:

```typescript
import { IdentityClient } from '@soroban-identity/sdk';

const client = new IdentityClient({
  rpcUrl: 'https://soroban-testnet.stellar.org',       // or mainnet RPC
  networkPassphrase: 'Test SDF Network ; September 2015', // or mainnet passphrase
  identityRegistryId: '<IDENTITY_REGISTRY_CONTRACT_ID>',
  credentialManagerId: '<CREDENTIAL_MANAGER_CONTRACT_ID>',
});
```

### Reference

- [Stellar CLI docs](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli)
- [Soroban contract deployment guide](https://developers.stellar.org/docs/build/smart-contracts/getting-started/deploy-to-testnet)
