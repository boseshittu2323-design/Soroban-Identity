#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short,
    Address, Bytes, Env, Map, String, Symbol,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const IDENTITY: Symbol = symbol_short!("IDENTITY");
const ADMIN: Symbol = symbol_short!("ADMIN");

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum IdentityError {
    AlreadyInitialized = 1,
    AlreadyExists = 2,
    NotFound = 3,
    Unauthorized = 4,
}

// ── Data types ────────────────────────────────────────────────────────────────

/// W3C-aligned DID document stored on-chain.
#[contracttype]
#[derive(Clone)]
pub struct DidDocument {
    /// did:stellar:<address>
    pub id: String,
    /// Wallet that owns this DID
    pub controller: Address,
    /// Arbitrary metadata (e.g. service endpoints, public keys)
    pub metadata: Map<String, String>,
    /// Unix timestamp of creation
    pub created_at: u64,
    /// Unix timestamp of last update
    pub updated_at: u64,
    /// Whether this DID is active
    pub active: bool,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct IdentityRegistry;

#[contractimpl]
impl IdentityRegistry {
    // ── Admin ─────────────────────────────────────────────────────────────────

    /// Initialize the registry with an admin address.
    pub fn initialize(env: Env, admin: Address) -> Result<(), IdentityError> {
        if env.storage().instance().has(&ADMIN) {
            return Err(IdentityError::AlreadyInitialized);
        }
        env.storage().instance().set(&ADMIN, &admin);
        Ok(())
    }

    // ── DID management ────────────────────────────────────────────────────────

    /// Create a new DID for the caller.
    pub fn create_did(env: Env, controller: Address, metadata: Map<String, String>) -> Result<String, IdentityError> {
        controller.require_auth();

        let storage = env.storage().persistent();
        let key = Self::did_key(&env, &controller);

        if storage.has(&key) {
            return Err(IdentityError::AlreadyExists);
        }

        let did_id = Self::build_did_id(&env, &controller);
        let now = env.ledger().timestamp();

        let doc = DidDocument {
            id: did_id.clone(),
            controller: controller.clone(),
            metadata,
            created_at: now,
            updated_at: now,
            active: true,
        };

        storage.set(&key, &doc);
        env.events().publish((IDENTITY, symbol_short!("created")), controller);

        Ok(did_id)
    }

    /// Update metadata on an existing DID.
    pub fn update_did(env: Env, controller: Address, metadata: Map<String, String>) -> Result<(), IdentityError> {
        controller.require_auth();

        let storage = env.storage().persistent();
        let key = Self::did_key(&env, &controller);
        let mut doc: DidDocument = storage.get(&key).ok_or(IdentityError::NotFound)?;

        doc.metadata = metadata;
        doc.updated_at = env.ledger().timestamp();

        storage.set(&key, &doc);
        env.events().publish((IDENTITY, symbol_short!("updated")), controller);
        Ok(())
    }

    /// Deactivate a DID (soft delete).
    pub fn deactivate_did(env: Env, controller: Address) -> Result<(), IdentityError> {
        controller.require_auth();

        let storage = env.storage().persistent();
        let key = Self::did_key(&env, &controller);
        let mut doc: DidDocument = storage.get(&key).ok_or(IdentityError::NotFound)?;

        doc.active = false;
        doc.updated_at = env.ledger().timestamp();

        storage.set(&key, &doc);
        env.events().publish((IDENTITY, symbol_short!("deactivated")), controller);
        Ok(())
    }

    /// Resolve a DID document by controller address.
    pub fn resolve_did(env: Env, controller: Address) -> Result<DidDocument, IdentityError> {
        let key = Self::did_key(&env, &controller);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(IdentityError::NotFound)
    }

    /// Check whether an address has an active DID.
    pub fn has_active_did(env: Env, controller: Address) -> bool {
        let key = Self::did_key(&env, &controller);
        match env.storage().persistent().get::<Bytes, DidDocument>(&key) {
            Some(doc) => doc.active,
            None => false,
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn did_key(env: &Env, controller: &Address) -> Bytes {
        let mut key = Bytes::new(env);
        key.extend_from_array(&[b'd', b'i', b'd', b':']);
        let addr_bytes = controller.to_string().into_bytes();
        key.extend_from_slice(&addr_bytes);
        key
    }

    fn build_did_id(env: &Env, controller: &Address) -> String {
        let prefix = String::from_str(env, "did:stellar:");
        let addr_str = controller.to_string();
        let mut result = prefix.into_bytes();
        result.extend_from_slice(&addr_str.into_bytes());
        String::from_bytes(env, &result)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, Map};

    #[test]
    fn test_create_and_resolve_did() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let user = Address::generate(&env);
        let metadata: Map<String, String> = Map::new(&env);

        let did_id = client.create_did(&user, &metadata);
        assert!(did_id.to_string().contains("did:stellar:"));

        let doc = client.resolve_did(&user);
        assert!(doc.active);
        assert_eq!(doc.controller, user);
    }

    #[test]
    fn test_deactivate_did() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let user = Address::generate(&env);
        let metadata: Map<String, String> = Map::new(&env);
        client.create_did(&user, &metadata);

        assert!(client.has_active_did(&user));
        client.deactivate_did(&user);
        assert!(!client.has_active_did(&user));
    }

    #[test]
    fn test_error_variants() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        assert_eq!(client.try_initialize(&admin), Err(Ok(IdentityError::AlreadyInitialized)));

        let user = Address::generate(&env);
        assert_eq!(client.try_resolve_did(&user), Err(Ok(IdentityError::NotFound)));

        let metadata: Map<String, String> = Map::new(&env);
        client.create_did(&user, &metadata);
        assert_eq!(client.try_create_did(&user, &metadata), Err(Ok(IdentityError::AlreadyExists)));
    }
}
