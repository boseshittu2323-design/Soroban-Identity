# credential-manager

Soroban smart contract for issuing, verifying, and revoking verifiable credentials.

## Module structure

```
src/
  lib.rs          — Contract entry point; thin wrappers that delegate to submodules
  types.rs        — CredentialType enum and Credential struct
  keys.rs         — Storage key constants and key-builder helpers
  issuer.rs       — Issuer registry: add_issuer, remove_issuer, require_issuer
  credential.rs   — Credential lifecycle: issue_credential, get_credential, get_subject_credentials
  revocation.rs   — Revocation: revoke_credential, verify_credential
```

## Contract functions

| Function | Description |
|---|---|
| `initialize(admin)` | Set the contract admin |
| `add_issuer(issuer)` | Register a trusted issuer (admin only) |
| `remove_issuer(issuer)` | Remove a trusted issuer (admin only) |
| `issue_credential(issuer, subject, type, claims, sig, expires_at)` | Issue a credential; returns its 32-byte ID |
| `revoke_credential(issuer, credential_id)` | Revoke a credential (original issuer only) |
| `verify_credential(credential_id)` | Return true if credential exists, is not revoked, and is not expired |
| `get_credential(credential_id)` | Fetch a credential by ID |
| `get_subject_credentials(subject)` | List all credential IDs issued to a subject |
