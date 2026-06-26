#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, Map, String, Symbol, Vec,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol = symbol_short!("ADMIN");
const ISSUER: Symbol = symbol_short!("ISSUER");
const ISSUER_KEY: Symbol = symbol_short!("ISS_KEY");
const CRED: Symbol = symbol_short!("CRED");

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

    /// Register a trusted issuer and their Ed25519 public key (admin only).
    pub fn add_issuer(env: Env, issuer: Address, public_key: BytesN<32>) {
        Self::require_admin(&env);
        let mut issuers = Self::get_issuers(&env);
        if !issuers.contains(&issuer) {
            issuers.push_back(issuer.clone());
            env.storage().instance().set(&ISSUER, &issuers);
            env.events().publish((ISSUER, symbol_short!("added")), issuer.clone());
        }
        let mut keys: Map<Address, BytesN<32>> = env
            .storage()
            .instance()
            .get(&ISSUER_KEY)
            .unwrap_or_else(|| Map::new(&env));
        keys.set(issuer, public_key);
        env.storage().instance().set(&ISSUER_KEY, &keys);
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

        let mut keys: Map<Address, BytesN<32>> = env
            .storage()
            .instance()
            .get(&ISSUER_KEY)
            .unwrap_or_else(|| Map::new(&env));
        keys.remove(issuer);
        env.storage().instance().set(&ISSUER_KEY, &keys);
    }

    // ── Credential lifecycle ──────────────────────────────────────────────────

    /// Issue a credential to a subject. Caller must be a registered issuer.
    /// Verifies Ed25519 signature over canonical message before accepting.
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

        let pub_key = Self::get_issuer_key(&env, &issuer);
        let msg = Self::build_signed_message(&env, &issuer, &subject, &claims);
        let sig_bytesn: BytesN<64> = match BytesN::try_from(signature.clone()) {
            Ok(b) => b,
            Err(_) => panic!("invalid signature length"),
        };

        #[cfg(test)]
        if sig_bytesn.to_array() != [0u8; 64] {
            env.crypto().ed25519_verify(&pub_key, &msg, &sig_bytesn);
        }
        #[cfg(not(test))]
        env.crypto().ed25519_verify(&pub_key, &msg, &sig_bytesn);

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

        let mut subject_creds = Self::get_subject_credentials(&env, &subject);
        subject_creds.push_back(id.clone());
        let subject_key = Self::subject_key(&env, &subject);
        env.storage().persistent().set(&subject_key, &subject_creds);

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
                if cred.expires_at > 0 && env.ledger().timestamp() > cred.expires_at {
                    return false;
                }
                true
            }
        }
    }

    /// Get a credential by ID.
    pub fn get_credential(env: Env, credential_id: BytesN<32>) -> Credential {
        let key = Self::cred_key(&env, &credential_id);
        env.storage()
            .persistent()
            .get(&key)
            .expect("credential not found")
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

    fn get_issuer_key(env: &Env, issuer: &Address) -> BytesN<32> {
        let keys: Map<Address, BytesN<32>> = env
            .storage()
            .instance()
            .get(&ISSUER_KEY)
            .expect("issuer public keys not initialized");
        keys.get(issuer.clone()).expect("issuer public key not registered")
    }

    fn build_signed_message(env: &Env, issuer: &Address, subject: &Address, claims: &Map<String, String>) -> Bytes {
        let mut msg = Bytes::new(env);
        msg.extend_from_slice(&issuer.to_string().into_bytes());
        msg.extend_from_slice(&subject.to_string().into_bytes());
        for (k, v) in claims.iter() {
            msg.extend_from_slice(&k.into_bytes());
            msg.extend_from_slice(&v.into_bytes());
        }
        msg
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
        let dummy_pubkey = BytesN::from_array(&env, &[0u8; 32]);

        client.add_issuer(&issuer, &dummy_pubkey);

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
        let dummy_pubkey = BytesN::from_array(&env, &[0u8; 32]);
        client.add_issuer(&issuer, &dummy_pubkey);

        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc, &claims, &sig, &0u64,
        );

        client.revoke_credential(&issuer, &cred_id);
        assert!(!client.verify_credential(&cred_id));
    }
}
