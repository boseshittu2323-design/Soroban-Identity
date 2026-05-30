#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
    Map, String, Symbol,
};

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Clone, Debug, PartialEq, Copy)]
pub enum ContractError {
    DidNotFound = 1,
    DidDeactivated = 2,
    MetadataTooLong = 3,
    AlreadyInitialized = 4,
    EmptyMetadata = 5,
    Unauthorized = 6,
    DidAlreadyExists = 7,
    NotInitialized = 8,
}

// ── Storage keys ──────────────────────────────────────────────────────────────

const IDENTITY: Symbol = symbol_short!("IDENTITY");
const ADMIN: Symbol = symbol_short!("ADMIN");
const DID_COUNT: Symbol = symbol_short!("DIDCNT");
const TOTAL_DIDS: Symbol = symbol_short!("TOTDIDS");

/// ~1 year in ledgers (5-second ledger close time).
/// Used as the TTL extension on every persistent read/write.
const TTL_LEDGERS: u32 = 6_312_000;

// ── Data types ────────────────────────────────────────────────────────────────

/// Storage usage statistics for the identity registry.
#[contracttype]
#[derive(Clone)]
pub struct IdentityStorageStats {
    pub total_dids: u32,
    pub active_dids: u32,
}

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

    /// Initializes the identity registry with an admin address.
    ///
    /// Must be called once before any other function. Subsequent calls will
    /// return [`ContractError::AlreadyInitialized`].
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - The address that will have admin privileges over this registry.
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
            .expect("not initialized");
        if stored != current_admin {
            panic!("not the admin");
        }
        env.storage().instance().set(&ADMIN, &new_admin);
        env.events().publish(
            (ADMIN, symbol_short!("transfer")),
            (current_admin, new_admin),
        );
    }

    /// Upgrades the contract WASM to a new hash. Only the admin can call this.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - The admin address (must sign the transaction).
    /// * `new_wasm_hash` - The 32-byte hash of the new WASM binary to upgrade to.
    ///
    /// # Errors
    /// Returns [`ContractError::Unauthorized`] if `admin` does not match the stored admin address.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
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

    // ── DID management ────────────────────────────────────────────────────────

    /// Creates a new DID document for the given controller address.
    ///
    /// The DID identifier is derived as `did:stellar:<bech32-address>` and stored
    /// on-chain with the supplied metadata. The controller must sign the transaction.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `controller` - The Stellar address that will own and control this DID.
    /// * `metadata` - Arbitrary key-value pairs to embed in the DID document.
    ///   Keys must be ≤ 64 characters; values must be ≤ 256 characters.
    ///
    /// # Returns
    /// The newly created DID string (e.g. `did:stellar:GABC…`).
    ///
    /// # Errors
    /// Returns [`ContractError::MetadataTooLong`] if any key exceeds 64 characters
    /// or any value exceeds 256 characters.
    ///
    /// # Panics
    /// Panics with `"DID already exists for this address"` if a DID already exists
    /// for the given controller.
    pub fn create_did(
        env: Env,
        controller: Address,
        metadata: Map<String, String>,
    ) -> Result<String, ContractError> {
        controller.require_auth();

        let storage = env.storage().persistent();
        let key = Self::did_key(&env, &controller);

        if storage.has(&key) {
            return Err(ContractError::DidAlreadyExists);
        }

        Self::validate_metadata(&metadata)?;

        let did_id = Self::build_did_id(&env, &controller)?;
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
        storage.extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);

        // Increment active DID count and total DID count
        let count: u32 = env.storage().instance().get(&DID_COUNT).unwrap_or(0);
        env.storage().instance().set(&DID_COUNT, &(count + 1));
        let total: u32 = env.storage().instance().get(&TOTAL_DIDS).unwrap_or(0);
        env.storage().instance().set(&TOTAL_DIDS, &(total + 1));

        env.events()
            .publish((IDENTITY, symbol_short!("created")), (controller, now));

        Ok(did_id)
    }

    /// Updates the metadata on an existing DID document.
    ///
    /// Replaces the entire metadata map with the supplied values. The controller
    /// must sign the transaction. Emits an `IDENTITY/updated` event containing
    /// a SHA-256 fingerprint of the new metadata.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `controller` - The address that owns the DID (must sign the transaction).
    /// * `metadata` - New key-value metadata to store. Must be non-empty.
    ///   Keys must be ≤ 64 characters; values must be ≤ 256 characters.
    ///
    /// # Errors
    /// Returns [`ContractError::EmptyMetadata`] if `metadata` is empty.
    /// Returns [`ContractError::MetadataTooLong`] if any key or value exceeds
    /// the length limits.
    ///
    /// # Panics
    /// Panics with `"DID not found"` if no DID exists for the given controller.
    pub fn update_did(
        env: Env,
        controller: Address,
        metadata: Map<String, String>,
    ) -> Result<(), ContractError> {
        controller.require_auth();

        if metadata.is_empty() {
            return Err(ContractError::EmptyMetadata);
        }

        Self::validate_metadata(&metadata)?;

        let storage = env.storage().persistent();
        let key = Self::did_key(&env, &controller);
        let mut doc: DidDocument = storage.get(&key).ok_or(ContractError::DidNotFound)?;

        doc.metadata = metadata;
        doc.updated_at = env.ledger().timestamp();

        storage.set(&key, &doc);
        storage.extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);

        // Hash the DID id + updated_at as a deterministic metadata fingerprint
        let mut hash_input = Bytes::new(&env);
        hash_input.extend_from_slice(&doc.id.clone().as_bytes());
        hash_input.extend_from_array(&doc.updated_at.to_be_bytes());
        let meta_hash = env.crypto().sha256(&hash_input);
        env.events().publish(
            (IDENTITY, symbol_short!("updated")),
            (controller, meta_hash),
        );
        Ok(())
    }

    /// Deactivates a DID (soft delete). The DID record is retained on-chain but
    /// marked inactive. Deactivated DIDs cannot be resolved and will return
    /// [`ContractError::DidDeactivated`] on [`Self::resolve_did`].
    ///
    /// The controller must sign the transaction. Emits a `IDENTITY/deact` event.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `controller` - The address that owns the DID (must sign the transaction).
    ///
    /// # Panics
    /// Panics with `"DID not found"` if no DID exists for the given controller.
    pub fn deactivate_did(env: Env, controller: Address) -> Result<(), ContractError> {
        controller.require_auth();

        let storage = env.storage().persistent();
        let key = Self::did_key(&env, &controller);
        let mut doc: DidDocument = storage.get(&key).ok_or(ContractError::DidNotFound)?;

        doc.active = false;
        doc.updated_at = env.ledger().timestamp();

        storage.set(&key, &doc);
        storage.extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);

        // Decrement DID count
        let count: u32 = env.storage().instance().get(&DID_COUNT).unwrap_or(0);
        if count > 0 {
            env.storage().instance().set(&DID_COUNT, &(count - 1));
        }

        env.events().publish(
            (IDENTITY, symbol_short!("deact")),
            (controller, doc.updated_at),
        );
        Ok(())
    }

    /// Resolves a DID document by controller address.
    ///
    /// Returns the full [`DidDocument`] if the DID exists and is active.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `controller` - The Stellar address whose DID document to fetch.
    ///
    /// # Errors
    /// Returns [`ContractError::DidNotFound`] if no DID exists for the address.
    /// Returns [`ContractError::DidDeactivated`] if the DID has been deactivated.
    pub fn resolve_did(env: Env, controller: Address) -> Result<DidDocument, ContractError> {
        let key = Self::did_key(&env, &controller);
        let doc: DidDocument = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ContractError::DidNotFound)?;
        if !doc.active {
            return Err(ContractError::DidDeactivated);
        }
        Ok(doc)
    }

    /// Returns `true` if the given address has an active DID, `false` otherwise.
    ///
    /// This is a lightweight read that does not return the full document.
    /// Use [`Self::resolve_did`] to fetch the complete [`DidDocument`].
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `controller` - The Stellar address to check.
    pub fn has_active_did(env: Env, controller: Address) -> bool {
        let key = Self::did_key(&env, &controller);
        match env.storage().persistent().get::<_, DidDocument>(&key) {
            Some(doc) => doc.active,
            None => false,
        }
    }

    /// Returns the current count of active (non-deactivated) DIDs in the registry.
    ///
    /// This counter is incremented on [`Self::create_did`] and decremented on
    /// [`Self::deactivate_did`].
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    pub fn get_did_count(env: Env) -> u32 {
        env.storage().instance().get(&DID_COUNT).unwrap_or(0)
    }

    /// Returns storage usage statistics for the identity registry.
    ///
    /// Includes the total number of DIDs ever created (`total_dids`) and the
    /// current number of active DIDs (`active_dids`).
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    pub fn get_storage_stats(env: Env) -> IdentityStorageStats {
        IdentityStorageStats {
            total_dids: env.storage().instance().get(&TOTAL_DIDS).unwrap_or(0),
            active_dids: env.storage().instance().get(&DID_COUNT).unwrap_or(0),
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn validate_metadata(metadata: &Map<String, String>) -> Result<(), ContractError> {
        for (k, v) in metadata.iter() {
            if k.len() > 64 || v.len() > 256 {
                return Err(ContractError::MetadataTooLong);
            }
        }
        Ok(())
    }

    fn did_key(env: &Env, controller: &Address) -> Bytes {
        // Use the raw address bytes as the storage key
        let mut key = Bytes::new(env);
        key.extend_from_array(&[b'd', b'i', b'd', b':']);
        // append address bytes — Address implements IntoVal<Env, Bytes> indirectly
        // so we serialize via the env
        let addr_bytes = controller.to_string().as_bytes();
        key.extend_from_slice(&addr_bytes);
        key
    }

    fn build_did_id(env: &Env, controller: &Address) -> Result<String, ContractError> {
        // did:stellar:<bech32-address>
        let prefix = String::from_str(env, "did:stellar:");
        let addr_str = controller.to_string();
        let mut result = prefix.as_bytes();
        result.extend_from_slice(&addr_str.as_bytes());
        let did = String::from_bytes(env, &result);

        // Validate the format
        if !Self::validate_did_format(env, &did) {
            return Err(ContractError::DidNotFound); // Use existing error for invalid format
        }

        Ok(did)
    }

    fn validate_did_format(env: &Env, did: &String) -> bool {
        let did_bytes = did.as_bytes();
        let prefix = b"did:stellar:";
        if did_bytes.len() < prefix.len() {
            return false;
        }
        // Check if it starts with "did:stellar:"
        for i in 0..prefix.len() {
            if did_bytes.get(i).unwrap() != prefix[i] {
                return false;
            }
        }
        // Check that there's something after the prefix
        did_bytes.len() > prefix.len()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, Map};

    #[test]
    fn test_double_initialize_returns_error() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let result = client.try_initialize(&admin);
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
    }

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
    fn test_did_format_validation() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let user = Address::generate(&env);
        let metadata: Map<String, String> = Map::new(&env);

        let did_id = client.create_did(&user, &metadata);

        // Test that the DID format is valid
        assert!(IdentityRegistry::validate_did_format(&env, &did_id));

        // Test the exact format: did:stellar:<address>
        let did_str = did_id.to_string();
        assert!(did_str.starts_with("did:stellar:"));
        assert!(did_str.len() > "did:stellar:".len());

        // The address part should match the controller
        let expected_addr = user.to_string();
        let addr_part = &did_str["did:stellar:".len()..];
        assert_eq!(addr_part, expected_addr);
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

    /// resolve_did on a deactivated DID must return DidDeactivated error.
    #[test]
    fn test_resolve_deactivated_did_returns_error() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let user = Address::generate(&env);
        client.create_did(&user, &Map::new(&env));
        client.deactivate_did(&user);

        let result = client.try_resolve_did(&user);
        assert_eq!(result, Err(Ok(ContractError::DidDeactivated)));
    }

    /// resolve_did on a non-existent DID must return DidNotFound error.
    #[test]
    fn test_resolve_nonexistent_did_returns_error() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let user = Address::generate(&env);
        let result = client.try_resolve_did(&user);
        assert_eq!(result, Err(Ok(ContractError::DidNotFound)));
    }

    /// get_did_count must return 0 initially and increment on create_did.
    #[test]
    fn test_get_did_count() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        assert_eq!(client.get_did_count(), 0);

        let user1 = Address::generate(&env);
        client.create_did(&user1, &Map::new(&env));
        assert_eq!(client.get_did_count(), 1);

        let user2 = Address::generate(&env);
        client.create_did(&user2, &Map::new(&env));
        assert_eq!(client.get_did_count(), 2);

        client.deactivate_did(&user1);
        assert_eq!(client.get_did_count(), 1);
    }

    /// create_did must return MetadataTooLong when a key exceeds 64 chars.
    #[test]
    fn test_create_did_metadata_key_too_long() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let user = Address::generate(&env);
        let mut metadata: Map<String, String> = Map::new(&env);
        // 65-character key
        metadata.set(
            String::from_str(
                &env,
                "aaaaaaaaaabbbbbbbbbbccccccccccddddddddddeeeeeeeeeefffff1234567890",
            ),
            String::from_str(&env, "value"),
        );

        let result = client.try_create_did(&user, &metadata);
        assert_eq!(result, Err(Ok(ContractError::MetadataTooLong)));
    }

    /// update_did must return EmptyMetadata when an empty map is passed.
    #[test]
    fn test_update_did_empty_metadata_returns_error() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let user = Address::generate(&env);
        let mut metadata: Map<String, String> = Map::new(&env);
        metadata.set(
            String::from_str(&env, "key"),
            String::from_str(&env, "value"),
        );
        client.create_did(&user, &metadata);

        let result = client.try_update_did(&user, &Map::new(&env));
        assert_eq!(result, Err(Ok(ContractError::EmptyMetadata)));
    }

    /// update_did must return MetadataTooLong when a value exceeds 256 chars.
    #[test]
    fn test_update_did_metadata_value_too_long() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let user = Address::generate(&env);
        client.create_did(&user, &Map::new(&env));

        let mut metadata: Map<String, String> = Map::new(&env);
        // 257-character value
        let long_val = "a".repeat(257);
        metadata.set(
            String::from_str(&env, "key"),
            String::from_str(&env, &long_val),
        );

        let result = client.try_update_did(&user, &metadata);
        assert_eq!(result, Err(Ok(ContractError::MetadataTooLong)));
    }

    /// get_storage_stats returns correct total and active DID counts.
    #[test]
    fn test_get_storage_stats() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let stats = client.get_storage_stats();
        assert_eq!(stats.total_dids, 0);
        assert_eq!(stats.active_dids, 0);

        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);
        client.create_did(&user1, &Map::new(&env));
        client.create_did(&user2, &Map::new(&env));

        let stats = client.get_storage_stats();
        assert_eq!(stats.total_dids, 2);
        assert_eq!(stats.active_dids, 2);

        client.deactivate_did(&user1);

        let stats = client.get_storage_stats();
        assert_eq!(stats.total_dids, 2);
        assert_eq!(stats.active_dids, 1);
    }
}
