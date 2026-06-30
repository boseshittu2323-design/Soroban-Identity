#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, Map, String, Symbol, Vec,
};
use soroban_sdk::xdr::ToXdr;

pub const CONTRACT_VERSION: u32 = 1;
const EVENT_VERSION: u32 = 1;

mod keys;

// ── Storage keys ──────────────────────────────────────────────────────────────

const IDENTITY: Symbol = symbol_short!("IDENTITY");
const ADMIN: Symbol = symbol_short!("ADMIN");
const PENDING_ADMIN: Symbol = symbol_short!("PADMIN");
const DID_COUNT: Symbol = symbol_short!("DIDCNT");
const TOTAL_DIDS: Symbol = symbol_short!("TOTDIDS");

const DID_STELLAR_PREFIX: &[u8] = b"did:stellar:";
const TTL_LEDGERS: u32 = 6_312_000;

/// Maximum number of service endpoints allowed on a DID document.
/// Exceeding this limit returns [`ContractError::MetadataTooLarge`].
const MAX_SERVICES: u32 = 10;

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
    MetadataTooLarge = 9,
    NoPendingAdmin = 10,
    NotPendingAdmin = 11,
}

// ── Data types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct IdentityStorageStats {
    pub total_dids: u32,
    pub active_dids: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ServiceEndpoint {
    pub id: String,
    pub type_: String,
    pub service_endpoint: String,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DidDocument {
    pub id: String,
    pub controller: Address,
    pub metadata: Map<String, String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub active: bool,
    pub services: Vec<ServiceEndpoint>,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct IdentityRegistry;

#[contractimpl]
impl IdentityRegistry {
    pub fn ping(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        Self::require_uninitialized(&env)?;
        Self::set_admin(&env, &admin);
        env.events().publish((ADMIN, symbol_short!("init")), (EVENT_VERSION, admin));
        Ok(())
    }

    pub fn transfer_admin(env: Env, current_admin: Address, new_admin: Address) -> Result<(), ContractError> {
        current_admin.require_auth();
        let stored: Address = env.storage().instance().get(&ADMIN).expect("not initialized");
        if stored != current_admin {
            panic!("not the admin");
        }
        env.storage().instance().set(&ADMIN, &new_admin);
        env.events().publish((ADMIN, symbol_short!("transfer")), (EVENT_VERSION, current_admin, new_admin));
        Ok(())
    }

    pub fn propose_admin(env: Env, admin: Address, proposed: Address) -> Result<(), ContractError> {
        admin.require_auth();
        let stored: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        if stored != admin {
            return Err(ContractError::Unauthorized);
        }
        env.storage().instance().set(&PENDING_ADMIN, &proposed);
        env.events().publish((ADMIN, symbol_short!("proposed")), (EVENT_VERSION, admin, proposed));
        Ok(())
    }

    pub fn accept_admin(env: Env, proposed: Address) -> Result<(), ContractError> {
        proposed.require_auth();
        let pending: Address = env.storage().instance().get(&PENDING_ADMIN).ok_or(ContractError::NoPendingAdmin)?;
        if pending != proposed {
            return Err(ContractError::NotPendingAdmin);
        }
        env.storage().instance().remove(&PENDING_ADMIN);
        let old_admin: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        env.storage().instance().set(&ADMIN, &proposed);
        env.events().publish((ADMIN, symbol_short!("accepted")), (EVENT_VERSION, old_admin, proposed));
        Ok(())
    }

    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
        admin.require_auth();
        let stored: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        if stored != admin {
            return Err(ContractError::Unauthorized);
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn create_did(env: Env, controller: Address, metadata: Map<String, String>) -> Result<String, ContractError> {
        controller.require_auth();
        let storage = env.storage().persistent();
        let key = Self::did_key(&env, &controller);
        if storage.has(&key) {
            return Err(ContractError::DidAlreadyExists);
        }
        Self::validate_metadata(&metadata)?;
        let did_id = Self::build_did_string(&env, &controller);
        if !Self::validate_did_format(&env, &did_id) {
            return Err(ContractError::DidNotFound);
        }
        let now = env.ledger().timestamp();
        let doc = DidDocument {
            id: did_id.clone(),
            controller: controller.clone(),
            metadata,
            created_at: now,
            updated_at: now,
            active: true,
            services: Vec::new(&env),
        };
        storage.set(&key, &doc);
        storage.extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);
        let count: u32 = env.storage().instance().get(&DID_COUNT).unwrap_or(0);
        env.storage().instance().set(&DID_COUNT, &(count + 1));
        let total: u32 = env.storage().instance().get(&TOTAL_DIDS).unwrap_or(0);
        env.storage().instance().set(&TOTAL_DIDS, &(total + 1));
        env.events().publish((IDENTITY, symbol_short!("created")), (EVENT_VERSION, controller, now));
        Ok(did_id)
    }

    /// Appends a service endpoint to an existing DID document.
    /// Returns [`ContractError::MetadataTooLarge`] when the document already has
    /// [`MAX_SERVICES`] endpoints.
    pub fn add_service(env: Env, controller: Address, service: ServiceEndpoint) -> Result<(), ContractError> {
        controller.require_auth();
        let storage = env.storage().persistent();
        let key = Self::did_key(&env, &controller);
        let mut doc: DidDocument = storage.get(&key).ok_or(ContractError::DidNotFound)?;
        if !doc.active {
            return Err(ContractError::DidDeactivated);
        }
        if doc.services.len() >= MAX_SERVICES {
            return Err(ContractError::MetadataTooLarge);
        }
        doc.services.push_back(service);
        doc.updated_at = env.ledger().timestamp();
        storage.set(&key, &doc);
        storage.extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);
        env.events().publish((IDENTITY, symbol_short!("svc_add")), (EVENT_VERSION, controller, doc.updated_at));
        Ok(())
    }

    pub fn update_did(env: Env, controller: Address, metadata: Map<String, String>) -> Result<(), ContractError> {
        controller.require_auth();
        if metadata.is_empty() {
            return Err(ContractError::EmptyMetadata);
        }
        Self::validate_metadata(&metadata)?;
        let storage = env.storage().persistent();
        let key = Self::did_key(&env, &controller);
        let mut doc: DidDocument = storage.get(&key).ok_or(ContractError::DidNotFound)?;
        if !doc.active {
            return Err(ContractError::DidDeactivated);
        }
        doc.metadata = metadata;
        doc.updated_at = env.ledger().timestamp();
        storage.set(&key, &doc);
        storage.extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);
        let mut hash_input = Self::string_to_bytes(&env, &doc.id);
        hash_input.extend_from_array(&doc.updated_at.to_be_bytes());
        let meta_hash = env.crypto().sha256(&hash_input).to_bytes();
        env.events().publish((IDENTITY, symbol_short!("updated")), (EVENT_VERSION, controller, meta_hash));
        Ok(())
    }

    pub fn deactivate_did(env: Env, controller: Address) -> Result<(), ContractError> {
        controller.require_auth();
        let storage = env.storage().persistent();
        let key = Self::did_key(&env, &controller);
        let mut doc: DidDocument = storage.get(&key).ok_or(ContractError::DidNotFound)?;
        doc.active = false;
        doc.updated_at = env.ledger().timestamp();
        storage.set(&key, &doc);
        storage.extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);
        let count: u32 = env.storage().instance().get(&DID_COUNT).unwrap_or(0);
        if count > 0 {
            env.storage().instance().set(&DID_COUNT, &(count - 1));
        }
        env.events().publish((IDENTITY, symbol_short!("deact")), (EVENT_VERSION, controller, doc.updated_at));
        Ok(())
    }

    /// Reactivates a deactivated DID. Only the admin can call this.
    ///
    /// Sets `active=true` and updates `updated_at` on the existing document.
    /// If the DID is already active, this is a no-op and returns `Ok(())`.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment.
    /// * `admin` - The admin address (must sign the transaction).
    /// * `controller` - The address whose DID to reactivate.
    ///
    /// # Errors
    /// Returns [`ContractError::Unauthorized`] if `admin` is not the current admin.
    /// Returns [`ContractError::DidNotFound`] if no DID exists for the controller.
    pub fn reactivate_did(env: Env, admin: Address, controller: Address) -> Result<(), ContractError> {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN)
            .ok_or(ContractError::NotInitialized)?;
        if stored_admin != admin {
            return Err(ContractError::Unauthorized);
        }

        let storage = env.storage().persistent();
        let key = Self::did_key(&env, &controller);
        let mut doc: DidDocument = storage.get(&key).ok_or(ContractError::DidNotFound)?;

        // No-op if already active
        if doc.active {
            return Ok(());
        }

        doc.active = true;
        doc.updated_at = env.ledger().timestamp();

        storage.set(&key, &doc);
        storage.extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);

        // Increment active DID count
        let count: u32 = env.storage().instance().get(&DID_COUNT).unwrap_or(0);
        env.storage().instance().set(&DID_COUNT, &(count + 1));

        env.events().publish(
            (IDENTITY, symbol_short!("reactivated")),
            (EVENT_VERSION, controller, doc.updated_at),
        );
        Ok(())
    }

    /// Resolve a DID document by controller address.
    pub fn resolve_did(env: Env, controller: Address) -> Result<DidDocument, IdentityError> {
        let key = Self::did_key(&env, &controller);
    pub fn resolve_did(env: Env, controller: Address) -> DidDocument {
        let key = keys::did_key(&env, &controller);
        env.storage()
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
        if env.storage().persistent().has(&key) {
            env.storage().persistent().extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);
        }
        let doc: DidDocument = env.storage().persistent().get(&key).ok_or(ContractError::DidNotFound)?;
        if !doc.active {
            return Err(ContractError::DidDeactivated);
        }
        Ok(doc)
    }

    pub fn has_active_did(env: Env, controller: Address) -> bool {
        let key = Self::did_key(&env, &controller);
        if env.storage().persistent().has(&key) {
            env.storage().persistent().extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);
        }
        match env.storage().persistent().get::<_, DidDocument>(&key) {
            Some(doc) => doc.active,
            None => false,
        }
    }

    pub fn get_did_count(env: Env) -> u32 {
        env.storage().instance().get(&DID_COUNT).unwrap_or(0)
    }

    pub fn get_storage_stats(env: Env) -> IdentityStorageStats {
        IdentityStorageStats {
            total_dids: env.storage().instance().get(&TOTAL_DIDS).unwrap_or(0),
            active_dids: env.storage().instance().get(&DID_COUNT).unwrap_or(0),
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn require_uninitialized(env: &Env) -> Result<(), ContractError> {
        if env.storage().instance().has(&ADMIN) {
            return Err(ContractError::AlreadyInitialized);
        }
        Ok(())
    }

    fn set_admin(env: &Env, admin: &Address) {
        env.storage().instance().set(&ADMIN, admin);
    }

    fn validate_metadata(metadata: &Map<String, String>) -> Result<(), ContractError> {
        if metadata.len() > 10 {
            return Err(ContractError::MetadataTooLarge);
        }
        for (k, v) in metadata.iter() {
            if k.len() > 64 || v.len() > 256 {
                return Err(ContractError::MetadataTooLong);
            }
        }
        Ok(())
    }

    fn did_key(env: &Env, controller: &Address) -> (Symbol, BytesN<32>) {
        let key_bytes = env.crypto().sha256(&controller.clone().to_xdr(env));
        (IDENTITY, key_bytes)
    }

    fn build_did_string(env: &Env, controller: &Address) -> String {
        let addr_str = controller.to_string();
        let mut addr_bytes = [0u8; 56];
        addr_str.copy_into_slice(&mut addr_bytes);
        let prefix_len = DID_STELLAR_PREFIX.len();
        let mut result = [0u8; 68];
        result[..prefix_len].copy_from_slice(DID_STELLAR_PREFIX);
        result[prefix_len..].copy_from_slice(&addr_bytes);
        String::from_bytes(env, &result)
    }

    fn validate_did_format(env: &Env, did: &String) -> bool {
        if did.len() != 68 {
            return false;
        }
        let did_bytes = Self::string_to_bytes(env, did);
        for (i, expected) in DID_STELLAR_PREFIX.iter().enumerate() {
            if did_bytes.get(i as u32).unwrap() != *expected {
                return false;
            }
        }
        true
    }

    fn string_to_bytes(env: &Env, value: &String) -> Bytes {
        let mut result = Bytes::new(env);
        let mut buffer = [0u8; 68];
        value.copy_into_slice(&mut buffer[..value.len() as usize]);
        result.extend_from_slice(&buffer[..value.len() as usize]);
        result
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, Map};
    extern crate std;
    use std::string::ToString;

    fn setup() -> (Env, IdentityRegistryClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, client)
    }

    #[test]
    fn test_ping_returns_version() {
        let env = Env::default();
        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);
        assert_eq!(client.ping(), CONTRACT_VERSION);
    }

    #[test]
    fn test_double_initialize_returns_error() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        assert_eq!(client.try_initialize(&admin), Err(Ok(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn test_create_and_resolve_did() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        let did_id = client.create_did(&user, &Map::new(&env));
        let did_str = did_id.to_string();
        assert!(did_str.contains("did:stellar:"));
        let doc = client.resolve_did(&user);
        assert!(doc.active);
        assert_eq!(doc.controller, user);
    }

    #[test]
    fn test_deactivate_did() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.create_did(&user, &Map::new(&env));
        assert!(client.has_active_did(&user));
        client.deactivate_did(&user);
        assert!(!client.has_active_did(&user));
    }

    #[test]
    fn test_resolve_deactivated_did_returns_error() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.create_did(&user, &Map::new(&env));
        client.deactivate_did(&user);
        assert_eq!(client.try_resolve_did(&user), Err(Ok(ContractError::DidDeactivated)));
    }

    #[test]
    fn test_resolve_nonexistent_did_returns_error() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        assert_eq!(client.try_resolve_did(&user), Err(Ok(ContractError::DidNotFound)));
    }

    #[test]
    fn test_get_did_count() {
        let (env, client) = setup();
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

    #[test]
    fn test_create_did_metadata_key_too_long() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        let mut metadata: Map<String, String> = Map::new(&env);
        metadata.set(
            String::from_str(&env, "aaaaaaaaaabbbbbbbbbbccccccccccddddddddddeeeeeeeeeefffff1234567890"),
            String::from_str(&env, "value"),
        );
        assert_eq!(client.try_create_did(&user, &metadata), Err(Ok(ContractError::MetadataTooLong)));
    }

    #[test]
    fn test_upgrade_unauthorized_returns_error() {
        let (env, client) = setup();
        let attacker = Address::generate(&env);
        assert_eq!(
            client.try_upgrade(&attacker, &BytesN::from_array(&env, &[0u8; 32])),
            Err(Ok(ContractError::Unauthorized))
        );
    }

    #[test]
    fn test_get_storage_stats() {
        let (env, client) = setup();
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

    fn make_service(env: &Env, n: u32) -> ServiceEndpoint {
        let mut buf = [0u8; 3];
        buf[0] = b'a' + (n % 26) as u8;
        buf[1] = b'0' + (n / 10) as u8;
        buf[2] = b'0' + (n % 10) as u8;
        let s = String::from_bytes(env, &buf);
        ServiceEndpoint { id: s.clone(), type_: s.clone(), service_endpoint: s }
    }

    /// Exactly MAX_SERVICES endpoints must be accepted; MAX_SERVICES+1 must return MetadataTooLarge.
    #[test]
    fn test_add_service_max_services_boundary() {
        let (env, client) = setup();
        let user = Address::generate(&env);
        client.create_did(&user, &Map::new(&env));
        for i in 0..MAX_SERVICES {
            client.add_service(&user, &make_service(&env, i));
        }
        let result = client.try_add_service(&user, &make_service(&env, MAX_SERVICES));
        assert_eq!(result, Err(Ok(ContractError::MetadataTooLarge)));
    }

    /// reactivate_did called by non-admin returns Unauthorized.
    #[test]
    fn test_reactivate_did_unauthorized_non_admin() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin);
        client.create_did(&user, &Map::new(&env));
        client.deactivate_did(&user);

        let result = client.try_reactivate_did(&non_admin, &user);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    /// reactivate_did on an already-active DID is a no-op and returns Ok.
    #[test]
    fn test_reactivate_did_already_active_is_noop() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin);
        client.create_did(&user, &Map::new(&env));

        // DID is already active; reactivate should be a no-op
        let result = client.try_reactivate_did(&admin, &user);
        assert_eq!(result, Ok(Ok(())));

        // Verify DID is still active
        assert!(client.has_active_did(&user));
    }

    /// reactivate_did restores an active DID and increments count.
    #[test]
    fn test_reactivate_did_restores_active_did() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(&admin);
        client.create_did(&user, &Map::new(&env));

        assert_eq!(client.get_did_count(), 1);
        assert!(client.has_active_did(&user));

        // Deactivate
        client.deactivate_did(&user);
        assert_eq!(client.get_did_count(), 0);
        assert!(!client.has_active_did(&user));

        // Reactivate
        let result = client.try_reactivate_did(&admin, &user);
        assert_eq!(result, Ok(Ok(())));

        assert_eq!(client.get_did_count(), 1);
        assert!(client.has_active_did(&user));

        // Verify the document is now active
        let doc = client.resolve_did(&user);
        assert!(doc.active);
    }
}
