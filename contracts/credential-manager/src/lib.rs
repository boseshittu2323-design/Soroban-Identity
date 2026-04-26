#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, symbol_short,
    Address, Bytes, BytesN, Env, Map, String, Symbol, Vec,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol = symbol_short!("ADMIN");
const ISSUER: Symbol = symbol_short!("ISSUER");
const CRED: Symbol = symbol_short!("CRED");
const IDSEQ: Symbol = symbol_short!("IDSEQ");
const REVOKED_CNT: Symbol = symbol_short!("REVCNT");

const MAX_CREDENTIALS_PER_TYPE_PER_ISSUER: u32 = 5;

const MAX_ISSUERS: u32 = 100;

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Debug, PartialEq, Copy)]
pub enum ContractError {
    AlreadyInitialized       = 1,
    UnauthorizedIssuer       = 2,
    CredentialNotFound       = 3,
    CredentialRevoked        = 4,
}

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
    /// Unique credential ID (hash)
    pub id: BytesN<32>,
    /// DID of the credential subject
    pub subject: Address,
    /// Address of the trusted issuer
    pub issuer: Address,
    /// Credential type
    pub credential_type: CredentialType,
    /// Arbitrary claims (key-value)
    pub claims: Map<String, String>,
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

    pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&ADMIN) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage().instance().set(&ADMIN, &admin);
        Ok(())
    }

    /// Transfer admin rights to a new address. Only the current admin can call this.
    pub fn transfer_admin(env: Env, current_admin: Address, new_admin: Address) {
        current_admin.require_auth();
        let stored: Address = env.storage().instance().get(&ADMIN).expect("not initialized");
        if stored != current_admin {
            panic!("not the admin");
        }
        env.storage().instance().set(&ADMIN, &new_admin);
        env.events().publish(
            (ADMIN, symbol_short!("transfer")),
            (current_admin, new_admin),
        );
    }

    /// Upgrade the contract WASM. Only the admin can call this.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: Bytes) {
        admin.require_auth();
        let stored: Address = env.storage().instance().get(&ADMIN).expect("not initialized");
        if stored != admin {
            panic!("not the admin");
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Register a trusted issuer (admin only).
    pub fn add_issuer(env: Env, issuer: Address) {
        Self::require_admin(&env);
        let mut issuers = Self::get_issuers_internal(&env);
        if !issuers.contains(&issuer) {
            if issuers.len() >= MAX_ISSUERS {
                panic!("MaxIssuersReached");
            }
            issuers.push_back(issuer.clone());
            env.storage().instance().set(&ISSUER, &issuers);
            env.events().publish((ISSUER, symbol_short!("added")), issuer);
        }
    }

    /// Remove a trusted issuer (admin only).
    pub fn remove_issuer(env: Env, issuer: Address) {
        Self::require_admin(&env);
        let issuers = Self::get_issuers_internal(&env);
        let mut updated = Vec::new(&env);
        for i in issuers.iter() {
            if i != issuer {
                updated.push_back(i);
            }
        }
        env.storage().instance().set(&ISSUER, &updated);
    }

    // ── Credential lifecycle ──────────────────────────────────────────────────

    /// Issue a credential to a subject. Caller must be a registered issuer.
    pub fn issue_credential(
        env: Env,
        issuer: Address,
        subject: Address,
        credential_type: CredentialType,
        claims: Map<String, String>,
        signature: Bytes,
        expires_at: u64,
    ) -> BytesN<32> {
        issuer.require_auth();
        Self::require_issuer(&env, &issuer);

        // Enforce per-issuer-per-type-per-subject limit
        let type_key = Self::issuer_type_key(&issuer, &subject, &credential_type);
        let existing: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&type_key)
            .unwrap_or_else(|| Vec::new(&env));

        // Count only active (non-revoked, non-expired) credentials
        let now = env.ledger().timestamp();
        let active_count = existing.iter().filter(|id| {
            match env.storage().persistent().get::<(Symbol, BytesN<32>), Credential>(&Self::cred_key(id)) {
                None => false,
                Some(c) => !c.revoked && (c.expires_at == 0 || c.expires_at > now),
            }
        }).count() as u32;

        if active_count >= MAX_CREDENTIALS_PER_TYPE_PER_ISSUER {
            panic!("CredentialLimitExceeded");
        }

        if expires_at != 0 && expires_at <= now {
            panic!("CredentialAlreadyExpired");
        }

        let id = Self::generate_id(&env, now);

        let credential = Credential {
            id: id.clone(),
            subject: subject.clone(),
            issuer: issuer.clone(),
            credential_type: credential_type.clone(),
            claims,
            signature,
            issued_at: now,
            expires_at,
            revoked: false,
        };

        let key = Self::cred_key(&id);
        env.storage().persistent().set(&key, &credential);

        // Index credential under subject
        let mut subject_creds = Self::fetch_subject_creds(&env, &subject);
        subject_creds.push_back(id.clone());
        let subject_key = Self::subject_key(&subject);
        env.storage().persistent().set(&subject_key, &subject_creds);

        // Increment per-subject credential counter
        let cnt_key = (CRED_CNT, subject.clone());
        let cnt: u32 = env.storage().persistent().get(&cnt_key).unwrap_or(0);
        env.storage().persistent().set(&cnt_key, &(cnt + 1));

        // Index credential under issuer+subject+type
        let mut type_creds = existing;
        type_creds.push_back(id.clone());
        env.storage().persistent().set(&type_key, &type_creds);

        env.events().publish((CRED, symbol_short!("issued")), (issuer, subject));

        id
    }

    /// Revoke a credential. Only the original issuer can revoke.
    pub fn revoke_credential(env: Env, issuer: Address, credential_id: BytesN<32>) -> Result<(), ContractError> {
        issuer.require_auth();

        let key = Self::cred_key(&credential_id);
        let mut cred: Credential = env
            .storage()
            .persistent()
            .get(&key)
            .expect("credential not found");

        if cred.issuer != issuer {
            return Err(ContractError::UnauthorizedIssuer);
        }

        cred.revoked = true;
        env.storage().persistent().set(&key, &cred);
        let revoked: u32 = env.storage().instance().get(&REVOKED_CNT).unwrap_or(0);
        env.storage().instance().set(&REVOKED_CNT, &(revoked + 1));
        env.events().publish((CRED, symbol_short!("revoked")), credential_id);
        Ok(())
    }

    /// Verify a credential is valid (not revoked, not expired).
    pub fn verify_credential(env: Env, credential_id: BytesN<32>) -> bool {
        let key = Self::cred_key(&credential_id);
        match env.storage().persistent().get::<(Symbol, BytesN<32>), Credential>(&key) {
            None => false,
            Some(cred) => {
                if cred.revoked {
                    return false;
                }
                if cred.expires_at > 0 && env.ledger().timestamp() > cred.expires_at {
                    return false;
                }
                true
            }
        }
    }

    /// Get a credential by ID. Returns CredentialNotFound if it never existed,
    /// or CredentialRevoked if it was issued but later revoked.
    pub fn get_credential(env: Env, credential_id: BytesN<32>) -> Result<Credential, ContractError> {
        let key = Self::cred_key(&credential_id);
        match env.storage().persistent().get::<(Symbol, BytesN<32>), Credential>(&key) {
            None => Err(ContractError::CredentialNotFound),
            Some(cred) if cred.revoked => Err(ContractError::CredentialRevoked),
            Some(cred) => Ok(cred),
        }
    }

    /// List all credential IDs for a subject.
    pub fn get_subject_credentials(env: Env, subject: Address) -> Vec<BytesN<32>> {
        Self::fetch_subject_creds(&env, &subject)
    }

    /// Get the total number of credentials issued to a subject (decremented on revoke).
    pub fn get_credential_count(env: Env, subject: Address) -> u32 {
        let cnt_key = (CRED_CNT, subject);
        env.storage().persistent().get(&cnt_key).unwrap_or(0)
    }

    /// Get the list of all registered issuers. No auth required — read-only.
    pub fn get_issuers(env: Env) -> Vec<Address> {
        Self::get_issuers_internal(&env)
    }

    /// Get storage usage statistics.
    pub fn get_storage_stats(env: Env) -> CredentialStorageStats {
        let total: u32 = env.storage().instance().get(&IDSEQ).unwrap_or(0);
        let revoked: u32 = env.storage().instance().get(&REVOKED_CNT).unwrap_or(0);
        CredentialStorageStats {
            total_credentials: total,
            revoked_credentials: revoked,
            active_credentials: total.saturating_sub(revoked),
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) {
        let admin: Address = env.storage().instance().get(&ADMIN).expect("not initialized");
        admin.require_auth();
    }

    fn require_issuer(env: &Env, issuer: &Address) {
        let issuers = Self::get_issuers_internal(env);
        if !issuers.contains(issuer) {
            panic!("not a registered issuer");
        }
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

    /// Generate a unique 32-byte credential ID from the current timestamp and
    /// a per-contract sequence counter to prevent collisions within the same ledger.
    fn generate_id(env: &Env, timestamp: u64) -> BytesN<32> {
        let seq: u64 = env.storage().instance().get(&IDSEQ).unwrap_or(0);
        env.storage().instance().set(&IDSEQ, &(seq + 1));

        let mut data = Bytes::new(env);
        data.extend_from_array(&timestamp.to_be_bytes());
        data.extend_from_array(&seq.to_be_bytes());
        env.crypto().sha256(&data).into()
    }

    fn cred_key(id: &BytesN<32>) -> (Symbol, BytesN<32>) {
        (CRED, id.clone())
    }

    fn subject_key(subject: &Address) -> (Symbol, Address) {
        (symbol_short!("sub"), subject.clone())
    }

    fn issuer_type_key(issuer: &Address, subject: &Address, credential_type: &CredentialType) -> (Symbol, Address, Address, CredentialType) {
        (symbol_short!("it"), issuer.clone(), subject.clone(), credential_type.clone())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Ledger as _}, Bytes, Env, Map};

    fn setup() -> (Env, Address, CredentialManagerClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, CredentialManager);
        let client = CredentialManagerClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, admin, client)
    }

    /// issue_credential stores the credential and verify_credential returns true.
    #[test]
    fn test_issue_and_verify() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);

        client.add_issuer(&issuer);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);

        let cred_id = client.issue_credential(
            &issuer,
            &subject,
            &CredentialType::Kyc,
            &claims,
            &sig,
            &0u64,
        );

        assert!(client.verify_credential(&cred_id));
    }

    /// revoke_credential marks the credential revoked; verify_credential returns false.
    #[test]
    fn test_revoke_credential() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc, &claims, &sig, &0u64,
        );

        client.revoke_credential(&issuer, &cred_id);
        assert!(!client.verify_credential(&cred_id));
    }

    /// issue_credential must panic when expires_at is in the past.
    #[test]
    #[should_panic]
    fn test_issue_credential_already_expired() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        // expires_at is in the past (timestamp 1 is before the default ledger time)
        let past_expiry = env.ledger().timestamp().saturating_sub(1);

        client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc, &claims, &sig, &past_expiry,
        );
    }

    /// issue_credential must panic when called by an address that did not issue the credential.
    #[test]
    #[should_panic]
    fn test_issue_unauthorized_issuer() {
        let (env, _admin, client) = setup();

        let unauthorized = Address::generate(&env); // NOT registered
        let subject = Address::generate(&env);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);

        client.issue_credential(
            &unauthorized, &subject, &CredentialType::Kyc, &claims, &sig, &0u64,
        );
    }

    /// verify_credential returns false once the credential's expiry timestamp has passed.
    #[test]
    fn test_verify_expired_credential() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let expires_at = env.ledger().timestamp() + 100;

        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc, &claims, &sig, &expires_at,
        );

        // Valid before expiry
        assert!(client.verify_credential(&cred_id));

        // Advance ledger past expiry
        env.ledger().with_mut(|li| {
            li.timestamp = expires_at + 1;
        });

        // Must be invalid after expiry
        assert!(!client.verify_credential(&cred_id));
    }

    /// revoke_credential must return UnauthorizedIssuer when called by a different issuer.
    #[test]
    fn test_revoke_by_different_issuer() {
        let (env, _admin, client) = setup();

        let issuer1 = Address::generate(&env);
        let issuer2 = Address::generate(&env);
        let subject = Address::generate(&env);

        client.add_issuer(&issuer1);
        client.add_issuer(&issuer2);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let cred_id = client.issue_credential(
            &issuer1, &subject, &CredentialType::Kyc, &claims, &sig, &0u64,
        );

        // issuer2 attempts to revoke a credential they did not issue
        let result = client.try_revoke_credential(&issuer2, &cred_id);
        assert_eq!(result, Err(Ok(ContractError::UnauthorizedIssuer)));
    }

    /// initialize must return AlreadyInitialized on a second call.
    #[test]
    fn test_double_initialize_returns_error() {
        let (env, admin, client) = setup();
        let result = client.try_initialize(&admin);
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
    }

    /// get_credential returns all fields exactly as supplied at issuance.
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
        let sig = Bytes::from_array(&env, &[1u8; 64]);
        let expires_at = 9999u64;

        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Achievement, &claims, &sig, &expires_at,
        );

        let cred = client.get_credential(&cred_id).unwrap();
        assert_eq!(cred.issuer, issuer);
        assert_eq!(cred.subject, subject);
        assert_eq!(cred.credential_type, CredentialType::Achievement);
        assert_eq!(cred.expires_at, expires_at);
        assert!(!cred.revoked);
    }

    #[test]
    fn test_transfer_admin_authorized() {
        let (env, admin, client) = setup();
        let new_admin = Address::generate(&env);

        client.transfer_admin(&admin, &new_admin);

        // new_admin can now add an issuer
        let issuer = Address::generate(&env);
        client.add_issuer(&issuer);
    }

    #[test]
    #[should_panic]
    fn test_transfer_admin_unauthorized() {
        let (env, _admin, client) = setup();
        let attacker  = Address::generate(&env);
        let new_admin = Address::generate(&env);

        client.transfer_admin(&attacker, &new_admin);
    }

    /// add_issuer must panic with MaxIssuersReached once MAX_ISSUERS (100) are registered.
    #[test]
    #[should_panic]
    fn test_max_issuers_cap() {
        let (env, _admin, client) = setup();

        // Register exactly MAX_ISSUERS (100) unique issuers
        for _ in 0..100 {
            client.add_issuer(&Address::generate(&env));
        }

        // The 101st add must panic
        client.add_issuer(&Address::generate(&env));
    }

    /// get_issuers returns the list of all registered issuers.
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

    /// get_issuers reflects add and remove operations.
    #[test]
    fn test_get_issuers_after_remove() {
        let (env, _admin, client) = setup();

        let issuer1 = Address::generate(&env);
        let issuer2 = Address::generate(&env);

        client.add_issuer(&issuer1);
        client.add_issuer(&issuer2);

        let issuers_before = client.get_issuers();
        assert_eq!(issuers_before.len(), 2);

        client.remove_issuer(&issuer1);

        let issuers_after = client.get_issuers();
        assert_eq!(issuers_after.len(), 1);
        assert!(!issuers_after.contains(&issuer1));
        assert!(issuers_after.contains(&issuer2));
    }

    /// get_storage_stats returns correct credential counts.
    #[test]
    fn test_get_storage_stats() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let stats = client.get_storage_stats();
        assert_eq!(stats.total_credentials, 0);
        assert_eq!(stats.revoked_credentials, 0);
        assert_eq!(stats.active_credentials, 0);

        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let id1 = client.issue_credential(&issuer, &subject, &CredentialType::Kyc, &Map::new(&env), &sig, &0u64);
        let _id2 = client.issue_credential(&issuer, &subject, &CredentialType::Achievement, &Map::new(&env), &sig, &0u64);

        let stats = client.get_storage_stats();
        assert_eq!(stats.total_credentials, 2);
        assert_eq!(stats.revoked_credentials, 0);
        assert_eq!(stats.active_credentials, 2);

        client.revoke_credential(&issuer, &id1);

        let stats = client.get_storage_stats();
        assert_eq!(stats.total_credentials, 2);
        assert_eq!(stats.revoked_credentials, 1);
        assert_eq!(stats.active_credentials, 1);
    }
}
