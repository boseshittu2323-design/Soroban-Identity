# Soroban Identity Contracts

This directory contains the three on-chain contracts that power the Soroban Identity protocol:

- **identity-registry** — DID creation, resolution, and lifecycle
- **credential-manager** — verifiable credential issuance and verification
- **reputation** — score aggregation and anti-sybil signals

## Canonical admin initialization pattern

Every contract in this repository that accepts an admin must follow the same
initialization sequence. Keeping the steps identical makes security reviews
straightforward: a fix to the pattern is applied once and copied to each contract.

### Steps

1. **`require_uninitialized`** — abort with `AlreadyInitialized` if the `ADMIN`
   instance key is already set.
2. **`set_admin`** — persist the admin address under the shared `ADMIN` symbol.
3. **Emit an init event** — publish `(ADMIN, "init")` with the admin address so
   indexers can observe deployment.

### Reference implementation

```rust
// Follows the canonical pattern documented in contracts/README.md
pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
    Self::require_uninitialized(&env)?;
    Self::set_admin(&env, &admin);
    env.events().publish((ADMIN, symbol_short!("init")), admin);
    Ok(())
}

fn require_uninitialized(env: &Env) -> Result<(), ContractError> {
    if env.storage().instance().has(&ADMIN) {
        return Err(ContractError::AlreadyInitialized);
    }
    Ok(())
}

fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&ADMIN, admin);
}
```

### Rules for new contracts

- Do **not** skip the init event — downstream tooling relies on it.
- Do **not** allow re-initialization; use `transfer_admin` for admin changes.
- Copy the helper names (`require_uninitialized`, `set_admin`) verbatim so
  grepping the repo finds every implementation.

## Storage key conventions

Persistent data is keyed by short `Symbol` namespaces (for example `IDENTITY`,
`CRED`, `SUB`) rather than raw byte prefixes. Each contract defines named
constants at the top of `src/lib.rs` so keys are grep-friendly and cannot be
accidentally duplicated. Unit tests in each crate assert that namespace symbols
and byte-string prefixes (where used) are pairwise distinct.
