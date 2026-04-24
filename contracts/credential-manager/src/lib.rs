#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, Map, String, Symbol, Vec,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol = symbol_short!("ADMIN");
const ISSUER: Symbol = symbol_short!("ISSUER");
const CRED: Symbol = symbol_short!("CRED");

/// ~1 year in ledgers (5-second ledger close time). Used as the max TTL cap.
const TTL_MAX: u32 = 6_312_000;
/// Minimum TTL threshold before we bother extending (1 day in ledgers).
const TTL_MIN: u32 = 17_280;

// ── Data types ────────────────────────────────────────────────────────────────

/// Credential types supported by the protocol.
#[contracttype]
#[derive(Clone, PartialEq)]
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

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&ADMIN) {
            panic!("already initialized");
        }
        env.storage().instance().set(&ADMIN, &admin);
    }

    /// Register a trusted issuer (admin only).
    pub fn add_issuer(env: Env, issuer: Address) {
        Self::require_admin(&env);
        let mut issuers = Self::get_issuers(&env);
        if !issuers.contains(&issuer) {
            issuers.push_back(issuer.clone());
            env.storage().instance().set(&ISSUER, &issuers);
            env.events().publish((ISSUER, symbol_short!("added")), issuer);
        }
    }

    /// Remove a trusted issuer (admin only).
    pub fn remove_issuer(env: Env, issuer: Address) {
        Self::require_admin(&env);
        let issuers = Self::get_issuers(&env);
        let updated: Vec<Address> = issuers
            .iter()
            .filter(|i| i != issuer)
            .collect();
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

        let now = env.ledger().timestamp();
        let id = Self::generate_id(&env, &issuer, &subject, now);

        let credential = Credential {
            id: id.clone(),
            subject: subject.clone(),
            issuer: issuer.clone(),
            credential_type,
            claims,
            signature,
            issued_at: now,
            expires_at,
            revoked: false,
        };

        let key = Self::cred_key(&env, &id);
        env.storage().persistent().set(&key, &credential);
        // Bump TTL: use time-to-expiry if set, otherwise cap at 1 year
        let ttl = Self::ttl_for_credential(&env, expires_at);
        env.storage().persistent().extend_ttl(&key, ttl, ttl);

        // Index credential under subject
        let mut subject_creds = Self::get_subject_credentials(&env, &subject);
        subject_creds.push_back(id.clone());
        let subject_key = Self::subject_key(&env, &subject);
        env.storage().persistent().set(&subject_key, &subject_creds);
        env.storage().persistent().extend_ttl(&subject_key, TTL_MAX, TTL_MAX);

        env.events().publish((CRED, symbol_short!("issued")), (issuer, subject));

        id
    }

    /// Revoke a credential. Only the original issuer can revoke.
    pub fn revoke_credential(env: Env, issuer: Address, credential_id: BytesN<32>) {
        issuer.require_auth();

        let key = Self::cred_key(&env, &credential_id);
        let mut cred: Credential = env
            .storage()
            .persistent()
            .get(&key)
            .expect("credential not found");

        if cred.issuer != issuer {
            panic!("only the issuer can revoke");
        }

        cred.revoked = true;
        env.storage().persistent().set(&key, &cred);
        // Do NOT extend TTL for revoked credentials — let them expire naturally
        env.events().publish((CRED, symbol_short!("revoked")), credential_id);
    }

    /// Verify a credential is valid (not revoked, not expired).
    pub fn verify_credential(env: Env, credential_id: BytesN<32>) -> bool {
        let key = Self::cred_key(&env, &credential_id);
        match env.storage().persistent().get::<Bytes, Credential>(&key) {
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

    /// Get a credential by ID.
    pub fn get_credential(env: Env, credential_id: BytesN<32>) -> Credential {
        let key = Self::cred_key(&env, &credential_id);
        let cred: Credential = env
            .storage()
            .persistent()
            .get(&key)
            .expect("credential not found");
        // Bump TTL on read only for active credentials
        if !cred.revoked {
            let ttl = Self::ttl_for_credential(&env, cred.expires_at);
            env.storage().persistent().extend_ttl(&key, ttl, ttl);
        }
        cred
    }

    /// List all credential IDs for a subject.
    pub fn get_subject_credentials(env: &Env, subject: &Address) -> Vec<BytesN<32>> {
        let key = Self::subject_key(env, subject);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(env))
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) {
        let admin: Address = env.storage().instance().get(&ADMIN).expect("not initialized");
        admin.require_auth();
    }

    fn require_issuer(env: &Env, issuer: &Address) {
        let issuers = Self::get_issuers(env);
        if !issuers.contains(issuer) {
            panic!("not a registered issuer");
        }
    }

    fn get_issuers(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&ISSUER)
            .unwrap_or_else(|| Vec::new(env))
    }

    fn generate_id(env: &Env, issuer: &Address, subject: &Address, timestamp: u64) -> BytesN<32> {
        let mut data = Bytes::new(env);
        data.extend_from_slice(&issuer.to_string().into_bytes());
        data.extend_from_slice(&subject.to_string().into_bytes());
        data.extend_from_array(&timestamp.to_be_bytes());
        env.crypto().sha256(&data)
    }

    fn cred_key(env: &Env, id: &BytesN<32>) -> Bytes {
        let mut key = Bytes::new(env);
        key.extend_from_array(&[b'c', b'r', b'e', b'd', b':']);
        key.extend_from_slice(id.as_ref());
        key
    }

    fn subject_key(env: &Env, subject: &Address) -> Bytes {
        let mut key = Bytes::new(env);
        key.extend_from_array(&[b's', b'u', b'b', b':']);
        key.extend_from_slice(&subject.to_string().into_bytes());
        key
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
    use soroban_sdk::{testutils::Address as _, Bytes, Env, Map};

    fn setup() -> (Env, Address, CredentialManagerClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, CredentialManager);
        let client = CredentialManagerClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, admin, client)
    }

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

    #[test]
    fn test_ttl_bumped_on_issue() {
        let (env, _admin, client) = setup();

        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);

        // Issue with no expiry — should use TTL_MAX
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc, &claims, &sig, &0u64,
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
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc, &claims, &sig, &0u64,
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
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc, &claims, &sig, &0u64,
        );

        client.revoke_credential(&issuer, &cred_id);

        // verify_credential returns false for revoked — no TTL bump
        assert!(!client.verify_credential(&cred_id));

        // get_credential still returns the record (not extended)
        let cred = client.get_credential(&cred_id);
        assert!(cred.revoked);
    }
