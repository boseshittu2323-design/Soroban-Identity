#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, Map, String, Symbol, Vec,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol = symbol_short!("ADMIN");
const ISSUER: Symbol = symbol_short!("ISSUER");
const CRED: Symbol = symbol_short!("CRED");

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum CredentialError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotFound = 3,
    Unauthorized = 4,
    NotAnIssuer = 5,
}

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

    pub fn initialize(env: Env, admin: Address) -> Result<(), CredentialError> {
        if env.storage().instance().has(&ADMIN) {
            return Err(CredentialError::AlreadyInitialized);
        }
        env.storage().instance().set(&ADMIN, &admin);
        Ok(())
    }

    /// Register a trusted issuer (admin only).
    pub fn add_issuer(env: Env, issuer: Address) -> Result<(), CredentialError> {
        Self::require_admin(&env)?;
        let mut issuers = Self::get_issuers(&env);
        if !issuers.contains(&issuer) {
            issuers.push_back(issuer.clone());
            env.storage().instance().set(&ISSUER, &issuers);
            env.events().publish((ISSUER, symbol_short!("added")), issuer);
        }
        Ok(())
    }

    /// Remove a trusted issuer (admin only).
    pub fn remove_issuer(env: Env, issuer: Address) -> Result<(), CredentialError> {
        Self::require_admin(&env)?;
        let issuers = Self::get_issuers(&env);
        let updated: Vec<Address> = issuers
            .iter()
            .filter(|i| i != issuer)
            .collect();
        env.storage().instance().set(&ISSUER, &updated);
        Ok(())
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
    ) -> Result<BytesN<32>, CredentialError> {
        issuer.require_auth();
        Self::require_issuer(&env, &issuer)?;

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

        Ok(id)
    }

    /// Revoke a credential. Only the original issuer can revoke.
    pub fn revoke_credential(env: Env, issuer: Address, credential_id: BytesN<32>) -> Result<(), CredentialError> {
        issuer.require_auth();

        let key = Self::cred_key(&env, &credential_id);
        let mut cred: Credential = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(CredentialError::NotFound)?;

        if cred.issuer != issuer {
            return Err(CredentialError::Unauthorized);
        }

        cred.revoked = true;
        env.storage().persistent().set(&key, &cred);
        env.events().publish((CRED, symbol_short!("revoked")), credential_id);
        Ok(())
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
    pub fn get_credential(env: Env, credential_id: BytesN<32>) -> Result<Credential, CredentialError> {
        let key = Self::cred_key(&env, &credential_id);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(CredentialError::NotFound)
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

    fn require_admin(env: &Env) -> Result<(), CredentialError> {
        let admin: Address = env.storage().instance().get(&ADMIN).ok_or(CredentialError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn require_issuer(env: &Env, issuer: &Address) -> Result<(), CredentialError> {
        let issuers = Self::get_issuers(env);
        if !issuers.contains(issuer) {
            return Err(CredentialError::NotAnIssuer);
        }
        Ok(())
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
    fn test_error_variants() {
        let (env, admin, client) = setup();

        assert_eq!(client.try_initialize(&admin), Err(Ok(CredentialError::AlreadyInitialized)));

        let fake_id = BytesN::from_array(&env, &[1u8; 32]);
        assert_eq!(client.try_get_credential(&fake_id), Err(Ok(CredentialError::NotFound)));

        let rando = Address::generate(&env);
        let claims: Map<String, String> = Map::new(&env);
        let sig = Bytes::from_array(&env, &[0u8; 64]);
        assert_eq!(
            client.try_issue_credential(&rando, &rando, &CredentialType::Kyc, &claims, &sig, &0u64),
            Err(Ok(CredentialError::NotAnIssuer))
        );
    }
}
