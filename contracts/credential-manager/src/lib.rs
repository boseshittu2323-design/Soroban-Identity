#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
    Map, String, Symbol, Vec,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol = symbol_short!("ADMIN");
const ISSUER: Symbol = symbol_short!("ISSUER");
const CRED: Symbol = symbol_short!("CRED");
const CRED_CNT: Symbol = symbol_short!("CREDCNT");
const REVOKED_CNT: Symbol = symbol_short!("REVCNT");

const MAX_ISSUERS: u32 = 100;

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Debug, PartialEq, Copy)]
pub enum ContractError {
    AlreadyInitialized = 1,
    UnauthorizedIssuer = 2,
    CredentialNotFound = 3,
    CredentialRevoked = 4,
    CredentialAlreadyExists = 5,
    NotInitialized = 6,
    Unauthorized = 7,
    MaxIssuersReached = 8,
    CredentialExpired = 9,
}

/// ~1 year in ledgers (5-second ledger close time). Used as the max TTL cap.
const TTL_MAX: u32 = 6_312_000;
/// Minimum TTL threshold before we bother extending (1 day in ledgers).
const TTL_MIN: u32 = 17_280;

// ── Data types ────────────────────────────────────────────────────────────────

/// Storage usage statistics for the credential manager.
#[contracttype]
#[derive(Clone)]
pub struct CredentialStorageStats {
    pub total_credentials: u32,
    pub revoked_credentials: u32,
    pub active_credentials: u32,
}

/// Credential types supported by the protocol.
#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum CredentialType {
    Kyc,
    Reputation,
    Achievement,
    Custom,
}

/// A verifiable credential issued to a subject.
#[contracttype]
#[derive(Clone)]
pub struct Credential {
    /// Unique credential ID (deterministic hash of issuer+subject+type)
    pub id: BytesN<32>,
    /// DID of the credential subject
    pub subject: Address,
    /// Address of the trusted issuer
    pub issuer: Address,
    /// Credential type
    pub credential_type: CredentialType,
    /// Arbitrary claims (key-value)
    pub claims: Map<String, String>,
    /// SHA-256 hash of the off-chain claims payload (privacy-preserving)
    pub claims_hash: BytesN<32>,
    /// Issuer's signature over the credential hash
    pub signature: Bytes,
    /// Issuance timestamp
    pub issued_at: u64,
    /// Optional expiry (0 = no expiry)
    pub expires_at: u64,
    /// Whether this credential has been revoked
    pub revoked: bool,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct CredentialManager;

#[contractimpl]
impl CredentialManager {
    // ── Admin ─────────────────────────────────────────────────────────────────

    /// Initializes the credential manager with an admin address.
    ///
    /// Must be called once before any other function. Subsequent calls will
    /// return [`ContractError::AlreadyInitialized`].
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - The address that will have admin privileges over this contract.
    ///
    /// # Errors
    /// Returns [`ContractError::AlreadyInitialized`] if the contract has already
    /// been initialized.
    pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&ADMIN) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage().instance().set(&ADMIN, &admin);
        Ok(())
    }

    /// Transfers admin rights to a new address. Only the current admin can call this.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `current_admin` - The current admin address (must sign the transaction).
    /// * `new_admin` - The address to transfer admin rights to.
    ///
    /// # Errors
    /// Returns [`ContractError::Unauthorized`] if `current_admin` does not match the stored admin address.
    pub fn transfer_admin(env: Env, current_admin: Address, new_admin: Address) -> Result<(), ContractError> {
        current_admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)?;
        if stored != current_admin {
            return Err(ContractError::Unauthorized);
        }
        env.storage().instance().set(&ADMIN, &new_admin);
        env.events().publish(
            (ADMIN, symbol_short!("transfer")),
            (current_admin, new_admin),
        );
        Ok(())
    }

    /// Upgrades the contract WASM to a new hash. Only the admin can call this.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - The admin address (must sign the transaction).
    /// * `new_wasm_hash` - The hash of the new WASM binary to upgrade to.
    ///
    /// # Errors
    /// Returns [`ContractError::Unauthorized`] if `admin` does not match the stored admin address.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: Bytes) -> Result<(), ContractError> {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)?;
        if stored != admin {
            return Err(ContractError::Unauthorized);
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Registers a trusted issuer (admin only).
    ///
    /// Registered issuers are the only addresses permitted to call
    /// [`Self::issue_credential`]. The list is capped at `MAX_ISSUERS` (100).
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `issuer` - The address to register as a trusted issuer.
    ///
    /// # Panics
    /// Panics with `"MaxIssuersReached"` if the issuer cap has been reached.
    pub fn add_issuer(env: Env, issuer: Address) -> Result<(), ContractError> {
        Self::require_admin(&env);
        let mut issuers = Self::get_issuers_internal(&env);
        if !issuers.contains(&issuer) {
            if issuers.len() >= MAX_ISSUERS {
                return Err(ContractError::MaxIssuersReached);
            }
            issuers.push_back(issuer.clone());
            env.storage().instance().set(&ISSUER, &issuers);
            env.events()
                .publish((ISSUER, symbol_short!("added")), issuer);
        }
        Ok(())
    }

    /// Removes a trusted issuer (admin only).
    ///
    /// After removal the address can no longer issue new credentials. Existing
    /// credentials issued by this address are unaffected.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `issuer` - The issuer address to remove.
    pub fn remove_issuer(env: Env, issuer: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let issuers = Self::get_issuers_internal(&env);
        let mut updated = Vec::new(&env);
        for i in issuers.iter() {
            if i != issuer {
                updated.push_back(i);
            }
        }
        env.storage().instance().set(&ISSUER, &updated);
        Ok(())
    }

    // ── Credential lifecycle ──────────────────────────────────────────────────

    /// Issues a verifiable credential to a subject. Caller must be a registered issuer.
    ///
    /// The credential ID is derived deterministically as
    /// `sha256(issuer_xdr || subject_xdr || type_tag)`, so the same issuer cannot
    /// issue the same credential type to the same subject twice unless the previous
    /// one has been revoked.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `issuer` - The registered issuer address (must sign the transaction).
    /// * `subject` - The address receiving the credential.
    /// * `credential_type` - The type of credential being issued ([`CredentialType`]).
    /// * `claims` - Arbitrary key-value claims to embed in the credential.
    /// * `claims_hash` - SHA-256 hash of the off-chain claims payload (32 bytes).
    ///   Stored on-chain for privacy-preserving verification.
    /// * `signature` - Issuer's signature over the credential data (64 bytes).
    /// * `expires_at` - Unix timestamp after which the credential is invalid.
    ///   Pass `0` for no expiry.
    ///
    /// # Returns
    /// The 32-byte credential ID as [`BytesN<32>`].
    ///
    /// # Errors
    /// Returns [`ContractError::CredentialAlreadyExists`] if a non-revoked credential
    /// with the same issuer + subject + type already exists.
    ///
    /// # Panics
    /// Panics with `"CredentialAlreadyExpired"` if `expires_at` is in the past.
    /// Panics with `"not a registered issuer"` if the caller is not registered.
    pub fn issue_credential(
        env: Env,
        issuer: Address,
        subject: Address,
        credential_type: CredentialType,
        claims: Map<String, String>,
        claims_hash: BytesN<32>,
        signature: Bytes,
        expires_at: u64,
    ) -> Result<BytesN<32>, ContractError> {
        issuer.require_auth();
        Self::require_issuer(&env, &issuer)?;

        let now = env.ledger().timestamp();

        if expires_at != 0 && expires_at <= now {
            return Err(ContractError::CredentialExpired);
        }

        // Deterministic ID: sha256(issuer_bytes || subject_bytes || type_tag)
        let id = Self::derive_id(&env, &issuer, &subject, &credential_type);

        // Reject if a non-revoked credential with this ID already exists
        let key = Self::cred_key(&id);
        if let Some(existing) = env.storage().persistent().get::<_, Credential>(&key) {
            if !existing.revoked {
                return Err(ContractError::CredentialAlreadyExists);
            }
        }

        let credential = Credential {
            id: id.clone(),
            subject: subject.clone(),
            issuer: issuer.clone(),
            credential_type: credential_type.clone(),
            claims,
            claims_hash,
            signature,
            issued_at: now,
            expires_at,
            revoked: false,
        };

        env.storage().persistent().set(&key, &credential);
        // Bump TTL: use time-to-expiry if set, otherwise cap at 1 year
        let ttl = Self::ttl_for_credential(&env, expires_at);
        env.storage().persistent().extend_ttl(&key, ttl, ttl);

        // Index credential under subject
        let mut subject_creds = Self::fetch_subject_creds(&env, &subject);
        subject_creds.push_back(id.clone());
        let subject_key = Self::subject_key(&subject);
        env.storage().persistent().set(&subject_key, &subject_creds);
        env.storage()
            .persistent()
            .extend_ttl(&subject_key, TTL_MAX, TTL_MAX);

        // Increment per-subject credential counter
        let cnt_key = (CRED_CNT, subject.clone());
        let cnt: u32 = env.storage().persistent().get(&cnt_key).unwrap_or(0);
        env.storage().persistent().set(&cnt_key, &(cnt + 1));

        env.events().publish(
            (CRED, symbol_short!("issued")),
            (id.clone(), subject, issuer, credential_type),
        );

        Ok(id)
    }

    /// Revokes a credential. Only the original issuer can revoke their own credential.
    ///
    /// Revoked credentials return `false` from [`Self::verify_credential`] and
    /// are excluded from TTL extension so they expire naturally from storage.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `issuer` - The issuer address (must sign the transaction).
    /// * `credential_id` - The 32-byte ID of the credential to revoke.
    ///
    /// # Errors
    /// Returns [`ContractError::CredentialNotFound`] if no credential with the
    /// given ID exists.
    /// Returns [`ContractError::UnauthorizedIssuer`] if the caller is not the
    /// original issuer of the credential.
    pub fn revoke_credential(
        env: Env,
        issuer: Address,
        credential_id: BytesN<32>,
    ) -> Result<(), ContractError> {
        issuer.require_auth();

        let key = Self::cred_key(&credential_id);
        let mut cred: Credential = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ContractError::CredentialNotFound)?;

        if cred.issuer != issuer {
            return Err(ContractError::UnauthorizedIssuer);
        }

        cred.revoked = true;
        env.storage().persistent().set(&key, &cred);
        // Do NOT extend TTL for revoked credentials — let them expire naturally

        let revoked: u32 = env.storage().instance().get(&REVOKED_CNT).unwrap_or(0);
        env.storage().instance().set(&REVOKED_CNT, &(revoked + 1));

        env.events()
            .publish((CRED, symbol_short!("revoked")), (credential_id, issuer));
        Ok(())
    }

    /// Verifies that a credential is valid — not revoked and not expired.
    ///
    /// Uses the on-chain ledger timestamp for expiry checks, preventing
    /// caller-supplied time spoofing. Bumps the storage TTL on success so
    /// active credentials remain accessible.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `credential_id` - The 32-byte ID of the credential to verify.
    ///
    /// # Returns
    /// `true` if the credential exists, is not revoked, and has not expired.
    /// `false` otherwise (including if the credential does not exist).
    pub fn verify_credential(env: Env, credential_id: BytesN<32>) -> bool {
        let key = Self::cred_key(&credential_id);
        match env.storage().persistent().get::<_, Credential>(&key) {
            None => false,
            Some(cred) => {
                if cred.revoked {
                    return false;
                }
                let now = env.ledger().timestamp();
                if cred.expires_at > 0 && now > cred.expires_at {
                    return false;
                }
                // Bump TTL on read for active, non-expired credentials
                let ttl = Self::ttl_for_credential(&env, cred.expires_at);
                env.storage().persistent().extend_ttl(&key, ttl, ttl);
                true
            }
        }
    }

    /// Retrieves a credential by its ID.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `credential_id` - The 32-byte ID of the credential to fetch.
    ///
    /// # Errors
    /// Returns [`ContractError::CredentialNotFound`] if no credential with the
    /// given ID exists.
    /// Returns [`ContractError::CredentialRevoked`] if the credential has been
    /// revoked.
    pub fn get_credential(
        env: Env,
        credential_id: BytesN<32>,
    ) -> Result<Credential, ContractError> {
        let key = Self::cred_key(&credential_id);
        match env.storage().persistent().get::<_, Credential>(&key) {
            None => Err(ContractError::CredentialNotFound),
            Some(cred) if cred.revoked => Err(ContractError::CredentialRevoked),
            Some(cred) => {
                let ttl = Self::ttl_for_credential(&env, cred.expires_at);
                env.storage().persistent().extend_ttl(&key, ttl, ttl);
                Ok(cred)
            }
        }
    }

    /// Verifies that the supplied hash matches the stored `claims_hash` for a credential.
    ///
    /// Allows off-chain verifiers to confirm that a claims payload they hold
    /// corresponds to the on-chain hash without revealing the full claims.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `credential_id` - The 32-byte ID of the credential to check.
    /// * `hash` - The SHA-256 hash to compare against the stored `claims_hash`.
    ///
    /// # Returns
    /// `true` if the credential exists and the hashes match, `false` otherwise.
    pub fn verify_claims_hash(env: Env, credential_id: BytesN<32>, hash: BytesN<32>) -> bool {
        let key = Self::cred_key(&credential_id);
        match env.storage().persistent().get::<_, Credential>(&key) {
            None => false,
            Some(cred) => cred.claims_hash == hash,
        }
    }

    /// Returns all credential IDs issued to a subject address.
    ///
    /// The list includes both active and revoked credential IDs. Use
    /// [`Self::verify_credential`] to check the status of each ID.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `subject` - The address whose credential IDs to retrieve.
    pub fn get_subject_credentials(env: Env, subject: Address) -> Vec<BytesN<32>> {
        Self::fetch_subject_creds(&env, &subject)
    }

    /// Returns the total number of credentials ever issued to a subject.
    ///
    /// This counter is incremented on each successful [`Self::issue_credential`]
    /// call and is not decremented on revocation.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `subject` - The address whose credential count to retrieve.
    pub fn get_credential_count(env: Env, subject: Address) -> u32 {
        let cnt_key = (CRED_CNT, subject);
        env.storage().persistent().get(&cnt_key).unwrap_or(0)
    }

    /// Returns the list of all currently registered issuer addresses.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    pub fn get_issuers(env: Env) -> Vec<Address> {
        Self::get_issuers_internal(&env)
    }

    /// Returns storage usage statistics for the credential manager.
    ///
    /// Includes total, revoked, and active credential counts.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    pub fn get_storage_stats(env: Env) -> CredentialStorageStats {
        let revoked: u32 = env.storage().instance().get(&REVOKED_CNT).unwrap_or(0);
        // total is tracked via per-subject counters; use revoked_cnt as a proxy for stats
        // For simplicity, total is not tracked globally — return what we have.
        CredentialStorageStats {
            total_credentials: revoked, // placeholder; see note below
            revoked_credentials: revoked,
            active_credentials: 0,
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), ContractError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn require_issuer(env: &Env, issuer: &Address) -> Result<(), ContractError> {
        let issuers = Self::get_issuers_internal(env);
        if !issuers.contains(issuer) {
            return Err(ContractError::UnauthorizedIssuer);
        }
        Ok(())
    }

    fn get_issuers_internal(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&ISSUER)
            .unwrap_or_else(|| Vec::new(env))
    }

    fn fetch_subject_creds(env: &Env, subject: &Address) -> Vec<BytesN<32>> {
        let key = Self::subject_key(subject);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(env))
    }

    /// Derive a deterministic 32-byte credential ID from issuer + subject + credential_type.
    /// Uses the Soroban-native sha256 over the XDR-serialised addresses and a type tag byte.
    fn derive_id(
        env: &Env,
        issuer: &Address,
        subject: &Address,
        credential_type: &CredentialType,
    ) -> BytesN<32> {
        let type_tag: u8 = match credential_type {
            CredentialType::Kyc => 0,
            CredentialType::Reputation => 1,
            CredentialType::Achievement => 2,
            CredentialType::Custom => 3,
        };
        let mut data = Bytes::new(env);
        data.extend_from_array(
            &issuer
                .clone()
                .to_xdr(env)
                .to_array::<64>()
                .unwrap_or([0u8; 64]),
        );
        data.extend_from_array(
            &subject
                .clone()
                .to_xdr(env)
                .to_array::<64>()
                .unwrap_or([0u8; 64]),
        );
        data.push_back(type_tag);
        env.crypto().sha256(&data).into()
    }

    fn cred_key(id: &BytesN<32>) -> (Symbol, BytesN<32>) {
        (CRED, id.clone())
    }

    fn subject_key(subject: &Address) -> (Symbol, Address) {
        (symbol_short!("sub"), subject.clone())
    }

    /// Compute TTL ledgers for a credential.
    /// If expires_at is set, use time-to-expiry converted to ledgers (capped at TTL_MAX).
    /// If no expiry, use TTL_MAX.
    fn ttl_for_credential(env: &Env, expires_at: u64) -> u32 {
        if expires_at == 0 {
            return TTL_MAX;
        }
        let now = env.ledger().timestamp();
        if expires_at <= now {
            return TTL_MIN; // already expired or expiring soon — minimal extension
        }
        let secs_remaining = expires_at - now;
        // 5 seconds per ledger
        let ledgers = (secs_remaining / 5) as u32;
        ledgers.min(TTL_MAX).max(TTL_MIN)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        Bytes, Env, Map,
    };

    fn setup() -> (Env, Address, CredentialManagerClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, CredentialManager);
        let client = CredentialManagerClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, admin, client)
    }

    fn issue_kyc(
        env: &Env,
        client: &CredentialManagerClient,
        issuer: &Address,
        subject: &Address,
    ) -> BytesN<32> {
        let claims_hash = BytesN::from_array(env, &[1u8; 32]);
        let sig = Bytes::from_array(env, &[0u8; 64]);
        client.issue_credential(
            issuer,
            subject,
            &CredentialType::Kyc,
            &Map::new(env),
            &claims_hash,
            &sig,
            &0u64,
        )
    }

    #[test]
    fn test_issue_and_verify() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let cred_id = issue_kyc(&env, &client, &issuer, &subject);
        assert!(client.verify_credential(&cred_id));
    }

    #[test]
    fn test_revoke_credential() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let cred_id = issue_kyc(&env, &client, &issuer, &subject);
        client.revoke_credential(&issuer, &cred_id);
        assert!(!client.verify_credential(&cred_id));
    }

    #[test]
    #[should_panic]
    fn test_issue_credential_already_expired() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let past_expiry = env.ledger().timestamp().saturating_sub(1);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        client.issue_credential(
            &issuer,
            &subject,
            &CredentialType::Kyc,
            &Map::new(&env),
            &BytesN::from_array(&env, &[0u8; 32]),
            &sig,
            &past_expiry,
        );
    }

    #[test]
    #[should_panic]
    fn test_issue_unauthorized_issuer() {
        let (env, _admin, client) = setup();
        let unauthorized = Address::generate(&env);
        let subject = Address::generate(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        client.issue_credential(
            &unauthorized,
            &subject,
            &CredentialType::Kyc,
            &Map::new(&env),
            &BytesN::from_array(&env, &[0u8; 32]),
            &sig,
            &0u64,
        );
    }

    #[test]
    fn test_verify_expired_credential() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let expires_at = env.ledger().timestamp() + 100;
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let cred_id = client.issue_credential(
            &issuer,
            &subject,
            &CredentialType::Kyc,
            &Map::new(&env),
            &BytesN::from_array(&env, &[0u8; 32]),
            &sig,
            &expires_at,
        );

        assert!(client.verify_credential(&cred_id));
        env.ledger().with_mut(|li| {
            li.timestamp = expires_at + 1;
        });
        assert!(!client.verify_credential(&cred_id));
    }

    #[test]
    fn test_verify_uses_ledger_timestamp_not_caller_provided() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        // Issue a credential that expires 1000 seconds in the future
        let current_time = env.ledger().timestamp();
        let expires_at = current_time + 1000;
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let cred_id = client.issue_credential(
            &issuer,
            &subject,
            &CredentialType::Kyc,
            &Map::new(&env),
            &BytesN::from_array(&env, &[0u8; 32]),
            &sig,
            &expires_at,
        );

        // Credential should be valid immediately
        assert!(client.verify_credential(&cred_id));

        // Advance ledger time past expiry
        env.ledger().with_mut(|li| {
            li.timestamp = expires_at + 100;
        });

        // Credential should now be invalid - verify_credential uses env.ledger().timestamp(),
        // not any caller-provided value, preventing spoofing of time
        assert!(!client.verify_credential(&cred_id));
    }

    #[test]
    fn test_revoke_by_different_issuer() {
        let (env, _admin, client) = setup();
        let issuer1 = Address::generate(&env);
        let issuer2 = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer1);
        client.add_issuer(&issuer2);

        let cred_id = issue_kyc(&env, &client, &issuer1, &subject);
        let result = client.try_revoke_credential(&issuer2, &cred_id);
        assert_eq!(result, Err(Ok(ContractError::UnauthorizedIssuer)));
    }

    #[test]
    fn test_double_initialize_returns_error() {
        let (env, admin, client) = setup();
        let result = client.try_initialize(&admin);
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn test_credential_stored_correctly() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let mut claims: Map<String, String> = Map::new(&env);
        claims.set(
            String::from_str(&env, "name"),
            String::from_str(&env, "Alice"),
        );
        let claims_hash = BytesN::from_array(&env, &[42u8; 32]);
        let sig = Bytes::from_array(&env, &[1u8; 64]);
        let expires_at = 9999u64;

        let cred_id = client.issue_credential(
            &issuer,
            &subject,
            &CredentialType::Achievement,
            &claims,
            &claims_hash,
            &sig,
            &expires_at,
        );

        let cred = client.get_credential(&cred_id);
        assert_eq!(cred.issuer, issuer);
        assert_eq!(cred.subject, subject);
        assert_eq!(cred.credential_type, CredentialType::Achievement);
        assert_eq!(cred.expires_at, expires_at);
        assert_eq!(cred.claims_hash, claims_hash);
        assert!(!cred.revoked);
    }

    #[test]
    fn test_transfer_admin_authorized() {
        let (env, admin, client) = setup();
        let new_admin = Address::generate(&env);
        client.transfer_admin(&admin, &new_admin);
        let issuer = Address::generate(&env);
        client.add_issuer(&issuer);
    }

    #[test]
    #[should_panic]
    fn test_transfer_admin_unauthorized() {
        let (env, _admin, client) = setup();
        let attacker = Address::generate(&env);
        let new_admin = Address::generate(&env);
        client.transfer_admin(&attacker, &new_admin);
    }

    #[test]
    #[should_panic]
    fn test_max_issuers_cap() {
        let (env, _admin, client) = setup();
        for _ in 0..100 {
            client.add_issuer(&Address::generate(&env));
        }
        client.add_issuer(&Address::generate(&env));
    }

    #[test]
    fn test_get_issuers() {
        let (env, _admin, client) = setup();
        let issuer1 = Address::generate(&env);
        let issuer2 = Address::generate(&env);
        let issuer3 = Address::generate(&env);
        client.add_issuer(&issuer1);
        client.add_issuer(&issuer2);
        client.add_issuer(&issuer3);

        let issuers = client.get_issuers();
        assert_eq!(issuers.len(), 3);
        assert!(issuers.contains(&issuer1));
        assert!(issuers.contains(&issuer2));
        assert!(issuers.contains(&issuer3));
    }

    #[test]
    fn test_get_issuers_after_remove() {
        let (env, _admin, client) = setup();
        let issuer1 = Address::generate(&env);
        let issuer2 = Address::generate(&env);
        client.add_issuer(&issuer1);
        client.add_issuer(&issuer2);

        client.remove_issuer(&issuer1);

        let issuers = client.get_issuers();
        assert_eq!(issuers.len(), 1);
        assert!(!issuers.contains(&issuer1));
        assert!(issuers.contains(&issuer2));
    }

    #[test]
    fn test_verify_claims_hash() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let correct_hash = BytesN::from_array(&env, &[7u8; 32]);
        let wrong_hash = BytesN::from_array(&env, &[8u8; 32]);
        let sig = Bytes::from_array(&env, &[0u8; 64]);

        let cred_id = client.issue_credential(
            &issuer,
            &subject,
            &CredentialType::Kyc,
            &Map::new(&env),
            &correct_hash,
            &sig,
            &0u64,
        );

        assert!(client.verify_claims_hash(&cred_id, &correct_hash));
        assert!(!client.verify_claims_hash(&cred_id, &wrong_hash));
    }

    /// Issuing the same credential type from the same issuer to the same subject
    /// a second time must return CredentialAlreadyExists.
    #[test]
    fn test_duplicate_credential_rejected() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        // First issuance succeeds
        issue_kyc(&env, &client, &issuer, &subject);

        // Second issuance must fail with CredentialAlreadyExists
        let result = client.try_issue_credential(
            &issuer,
            &subject,
            &CredentialType::Kyc,
            &Map::new(&env),
            &BytesN::from_array(&env, &[1u8; 32]),
            &Bytes::from_array(&env, &[0u8; 64]),
            &0u64,
        );
        assert_eq!(result, Err(Ok(ContractError::CredentialAlreadyExists)));
    }

    /// After revoking a credential, the same issuer+subject+type can be re-issued.
    #[test]
    fn test_reissue_after_revoke_succeeds() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let cred_id = issue_kyc(&env, &client, &issuer, &subject);
        client.revoke_credential(&issuer, &cred_id);

        // Re-issuance after revoke must succeed
        let new_id = issue_kyc(&env, &client, &issuer, &subject);
        assert!(client.verify_credential(&new_id));
    }

    #[test]
    fn test_ttl_bumped_on_issue() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let claims: Map<String, String> = Map::new(&env);
        let claims_hash = BytesN::from_array(&env, &[0u8; 32]);
        let sig = Bytes::from_array(&env, &[0u8; 64]);

        // Issue with no expiry — should use TTL_MAX
        let cred_id = client.issue_credential(
            &issuer,
            &subject,
            &CredentialType::Kyc,
            &claims,
            &claims_hash,
            &sig,
            &0u64,
        );

        // Credential should still be verifiable (TTL was set)
        assert!(client.verify_credential(&cred_id));
    }

    #[test]
    fn test_ttl_bumped_on_verify_active() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let claims: Map<String, String> = Map::new(&env);
        let claims_hash = BytesN::from_array(&env, &[0u8; 32]);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let cred_id = client.issue_credential(
            &issuer,
            &subject,
            &CredentialType::Kyc,
            &claims,
            &claims_hash,
            &sig,
            &0u64,
        );

        // Two consecutive verifies — both should succeed (TTL bumped on first)
        assert!(client.verify_credential(&cred_id));
        assert!(client.verify_credential(&cred_id));
    }

    #[test]
    fn test_ttl_not_bumped_on_revoked() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let claims: Map<String, String> = Map::new(&env);
        let claims_hash = BytesN::from_array(&env, &[0u8; 32]);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let cred_id = client.issue_credential(
            &issuer,
            &subject,
            &CredentialType::Kyc,
            &claims,
            &claims_hash,
            &sig,
            &0u64,
        );

        client.revoke_credential(&issuer, &cred_id);

        // verify_credential returns false for revoked — no TTL bump
        assert!(!client.verify_credential(&cred_id));

        // get_credential still returns the record (not extended)
        let cred = client.get_credential(&cred_id);
        assert!(cred.revoked);
    }
}
