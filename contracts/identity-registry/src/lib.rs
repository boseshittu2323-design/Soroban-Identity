#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, Map, String, Symbol, Vec,
};
use soroban_sdk::xdr::ToXdr;

pub use shared_errors::SharedError;

pub const CONTRACT_VERSION: u32 = 1;
const EVENT_VERSION: u32 = 1;

const IDENTITY: Symbol = symbol_short!("IDENTITY");
const ADMIN: Symbol = symbol_short!("ADMIN");
const PENDING_ADMIN: Symbol = symbol_short!("PADMIN");
const DID_COUNT: Symbol = symbol_short!("DIDCNT");
const TOTAL_DIDS: Symbol = symbol_short!("TOTDIDS");
const DID_STELLAR_PREFIX: &[u8] = b"did:stellar:";
const TTL_LEDGERS: u32 = 6_312_000;

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
    ServiceAlreadyExists = 12,
}

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
        let stored: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        if stored != current_admin { return Err(ContractError::Unauthorized); }
        env.storage().instance().set(&ADMIN, &new_admin);
        env.events().publish((ADMIN, symbol_short!("transfer")), (EVENT_VERSION, current_admin, new_admin));
        Ok(())
    }

    pub fn propose_admin(env: Env, admin: Address, proposed: Address) -> Result<(), ContractError> {
        admin.require_auth();
        let stored: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        if stored != admin { return Err(ContractError::Unauthorized); }
        env.storage().instance().set(&PENDING_ADMIN, &proposed);
        env.events().publish((ADMIN, symbol_short!("proposed")), (EVENT_VERSION, admin, proposed));
        Ok(())
    }

    pub fn accept_admin(env: Env, proposed: Address) -> Result<(), ContractError> {
        proposed.require_auth();
        let pending: Address = env.storage().instance().get(&PENDING_ADMIN).ok_or(ContractError::NoPendingAdmin)?;
        if pending != proposed { return Err(ContractError::NotPendingAdmin); }
        env.storage().instance().remove(&PENDING_ADMIN);
        let old_admin: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        env.storage().instance().set(&ADMIN, &proposed);
        env.events().publish((ADMIN, symbol_short!("accepted")), (EVENT_VERSION, old_admin, proposed));
        Ok(())
    }

    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
        admin.require_auth();
        let stored: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        if stored != admin { return Err(ContractError::Unauthorized); }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn create_did(env: Env, controller: Address, metadata: Map<String, String>) -> Result<String, ContractError> {
        controller.require_auth();
        let key = Self::did_key(&env, &controller);
        if env.storage().persistent().has(&key) { return Err(ContractError::DidAlreadyExists); }
        Self::validate_metadata(&metadata)?;
        let did_id = Self::build_did_string(&env, &controller);
        if !Self::validate_did_format(&env, &did_id) { return Err(ContractError::DidNotFound); }
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
        env.storage().persistent().set(&key, &doc);
        env.storage().persistent().extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);
        let count: u32 = env.storage().instance().get(&DID_COUNT).unwrap_or(0);
        env.storage().instance().set(&DID_COUNT, &(count + 1));
        let total: u32 = env.storage().instance().get(&TOTAL_DIDS).unwrap_or(0);
        env.storage().instance().set(&TOTAL_DIDS, &(total + 1));
        env.events().publish((IDENTITY, symbol_short!("created")), (EVENT_VERSION, controller, now));
        Ok(did_id)
    }

    pub fn update_did(env: Env, controller: Address, metadata: Map<String, String>) -> Result<(), ContractError> {
        controller.require_auth();
        if metadata.is_empty() { return Err(ContractError::EmptyMetadata); }
        Self::validate_metadata(&metadata)?;
        let key = Self::did_key(&env, &controller);
        let mut doc: DidDocument = env.storage().persistent().get(&key).ok_or(ContractError::DidNotFound)?;
        if !doc.active { return Err(ContractError::DidDeactivated); }
        doc.metadata = metadata;
        doc.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &doc);
        env.storage().persistent().extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);
        let mut hash_input = Self::string_to_bytes(&env, &doc.id);
        hash_input.extend_from_array(&doc.updated_at.to_be_bytes());
        let meta_hash = env.crypto().sha256(&hash_input).to_bytes();
        env.events().publish((IDENTITY, symbol_short!("updated")), (EVENT_VERSION, controller, meta_hash));
        Ok(())
    }

    pub fn deactivate_did(env: Env, controller: Address) -> Result<(), ContractError> {
        controller.require_auth();
        let key = Self::did_key(&env, &controller);
        let mut doc: DidDocument = env.storage().persistent().get(&key).ok_or(ContractError::DidNotFound)?;
        doc.active = false;
        doc.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &doc);
        env.storage().persistent().extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);
        let count: u32 = env.storage().instance().get(&DID_COUNT).unwrap_or(0);
        if count > 0 { env.storage().instance().set(&DID_COUNT, &(count - 1)); }
        env.events().publish((IDENTITY, symbol_short!("deact")), (EVENT_VERSION, controller, doc.updated_at));
        Ok(())
    }

    pub fn resolve_did(env: Env, controller: Address) -> Result<DidDocument, ContractError> {
        let key = Self::did_key(&env, &controller);
        if env.storage().persistent().has(&key) {
            env.storage().persistent().extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);
        }
        let doc: DidDocument = env.storage().persistent().get(&key).ok_or(ContractError::DidNotFound)?;
        if !doc.active { return Err(ContractError::DidDeactivated); }
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

    // ── Service endpoints (#393) ───────────────────────────────────────────────

    /// Appends a service endpoint to the DID document. Returns ServiceAlreadyExists
    /// if an endpoint with the same id is already present.
    pub fn add_service(env: Env, controller: Address, endpoint: ServiceEndpoint) -> Result<(), ContractError> {
        controller.require_auth();
        let key = Self::did_key(&env, &controller);
        let mut doc: DidDocument = env.storage().persistent().get(&key).ok_or(ContractError::DidNotFound)?;
        if !doc.active { return Err(ContractError::DidDeactivated); }
        for svc in doc.services.iter() {
            if svc.id == endpoint.id { return Err(ContractError::ServiceAlreadyExists); }
        }
        doc.services.push_back(endpoint.clone());
        doc.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &doc);
        env.storage().persistent().extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);
        env.events().publish((IDENTITY, symbol_short!("svc_added")), (EVENT_VERSION, controller, endpoint.id));
        Ok(())
    }

    /// Removes a service endpoint by id. Returns DidNotFound if the id is absent.
    pub fn remove_service(env: Env, controller: Address, service_id: String) -> Result<(), ContractError> {
        controller.require_auth();
        let key = Self::did_key(&env, &controller);
        let mut doc: DidDocument = env.storage().persistent().get(&key).ok_or(ContractError::DidNotFound)?;
        if !doc.active { return Err(ContractError::DidDeactivated); }
        let mut found = false;
        let mut updated = Vec::new(&env);
        for svc in doc.services.iter() {
            if svc.id == service_id {
                found = true;
            } else {
                updated.push_back(svc);
            }
        }
        if !found { return Err(ContractError::DidNotFound); }
        doc.services = updated;
        doc.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &doc);
        env.storage().persistent().extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);
        env.events().publish((IDENTITY, symbol_short!("svc_rmvd")), (EVENT_VERSION, controller, service_id));
        Ok(())
    }

    /// Returns all service endpoints for a DID.
    pub fn get_services(env: Env, controller: Address) -> Result<Vec<ServiceEndpoint>, ContractError> {
        let key = Self::did_key(&env, &controller);
        let doc: DidDocument = env.storage().persistent().get(&key).ok_or(ContractError::DidNotFound)?;
        if !doc.active { return Err(ContractError::DidDeactivated); }
        Ok(doc.services)
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn require_uninitialized(env: &Env) -> Result<(), ContractError> {
        if env.storage().instance().has(&ADMIN) { return Err(ContractError::AlreadyInitialized); }
        Ok(())
    }

    fn set_admin(env: &Env, admin: &Address) {
        env.storage().instance().set(&ADMIN, admin);
    }

    fn validate_metadata(metadata: &Map<String, String>) -> Result<(), ContractError> {
        if metadata.len() > 10 { return Err(ContractError::MetadataTooLarge); }
        for (k, v) in metadata.iter() {
            if k.len() > 64 || v.len() > 256 { return Err(ContractError::MetadataTooLong); }
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

    pub fn validate_did_format(env: &Env, did: &String) -> bool {
        if did.len() != 68 { return false; }
        let did_bytes = Self::string_to_bytes(env, did);
        for (i, expected) in DID_STELLAR_PREFIX.iter().enumerate() {
            if did_bytes.get(i as u32).unwrap() != *expected { return false; }
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

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, Map};
    extern crate std;
    use std::string::ToString;

    #[test]
    fn test_ping_returns_version() {
        let env = Env::default();
        let id = env.register_contract(None, IdentityRegistry);
        assert_eq!(IdentityRegistryClient::new(&env, &id).ping(), CONTRACT_VERSION);
    }

    #[test]
    fn test_double_initialize_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        assert_eq!(client.try_initialize(&admin), Err(Ok(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn test_upgrade_unauthorized_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &id);
        let admin = Address::generate(&env);
        let attacker = Address::generate(&env);
        client.initialize(&admin);
        assert_eq!(client.try_upgrade(&attacker, &BytesN::from_array(&env, &[0u8; 32])), Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn test_upgrade_not_initialized_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &id);
        let admin = Address::generate(&env);
        assert_eq!(client.try_upgrade(&admin, &BytesN::from_array(&env, &[0u8; 32])), Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn test_create_and_resolve_did() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let user = Address::generate(&env);
        let did_id = client.create_did(&user, &Map::new(&env));
        assert!(did_id.to_string().contains("did:stellar:"));
        let doc = client.resolve_did(&user);
        assert!(doc.active);
        assert_eq!(doc.controller, user);
    }

    #[test]
    fn test_deactivate_did() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let user = Address::generate(&env);
        client.create_did(&user, &Map::new(&env));
        assert!(client.has_active_did(&user));
        client.deactivate_did(&user);
        assert!(!client.has_active_did(&user));
    }

    #[test]
    fn test_resolve_deactivated_did_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let user = Address::generate(&env);
        client.create_did(&user, &Map::new(&env));
        client.deactivate_did(&user);
        assert_eq!(client.try_resolve_did(&user), Err(Ok(ContractError::DidDeactivated)));
    }

    #[test]
    fn test_resolve_nonexistent_did_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let user = Address::generate(&env);
        assert_eq!(client.try_resolve_did(&user), Err(Ok(ContractError::DidNotFound)));
    }

    #[test]
    fn test_get_did_count() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        assert_eq!(client.get_did_count(), 0);
        let u1 = Address::generate(&env);
        let u2 = Address::generate(&env);
        client.create_did(&u1, &Map::new(&env));
        client.create_did(&u2, &Map::new(&env));
        assert_eq!(client.get_did_count(), 2);
        client.deactivate_did(&u1);
        assert_eq!(client.get_did_count(), 1);
    }

    #[test]
    fn test_create_did_metadata_key_too_long() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let user = Address::generate(&env);
        let mut metadata = Map::new(&env);
        metadata.set(
            String::from_str(&env, "aaaaaaaaaabbbbbbbbbbccccccccccddddddddddeeeeeeeeeefffff1234567890"),
            String::from_str(&env, "v"),
        );
        assert_eq!(client.try_create_did(&user, &metadata), Err(Ok(ContractError::MetadataTooLong)));
    }

    #[test]
    fn test_update_deactivated_did_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let user = Address::generate(&env);
        client.create_did(&user, &Map::new(&env));
        client.deactivate_did(&user);
        let mut m = Map::new(&env);
        m.set(String::from_str(&env, "k"), String::from_str(&env, "v"));
        assert_eq!(client.try_update_did(&user, &m), Err(Ok(ContractError::DidDeactivated)));
    }

    #[test]
    fn test_update_did_empty_metadata_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let user = Address::generate(&env);
        let mut m = Map::new(&env);
        m.set(String::from_str(&env, "k"), String::from_str(&env, "v"));
        client.create_did(&user, &m);
        assert_eq!(client.try_update_did(&user, &Map::new(&env)), Err(Ok(ContractError::EmptyMetadata)));
    }

    #[test]
    fn test_get_storage_stats() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let u1 = Address::generate(&env);
        let u2 = Address::generate(&env);
        client.create_did(&u1, &Map::new(&env));
        client.create_did(&u2, &Map::new(&env));
        let stats = client.get_storage_stats();
        assert_eq!(stats.total_dids, 2);
        assert_eq!(stats.active_dids, 2);
        client.deactivate_did(&u1);
        let stats = client.get_storage_stats();
        assert_eq!(stats.total_dids, 2);
        assert_eq!(stats.active_dids, 1);
    }

    // ── Service endpoint tests (#393) ─────────────────────────────────────────

    fn make_endpoint(env: &Env, id: &str) -> ServiceEndpoint {
        ServiceEndpoint {
            id: String::from_str(env, id),
            type_: String::from_str(env, "DIDCommMessaging"),
            service_endpoint: String::from_str(env, "https://example.com"),
        }
    }

    #[test]
    fn test_add_service() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let user = Address::generate(&env);
        client.create_did(&user, &Map::new(&env));
        client.add_service(&user, &make_endpoint(&env, "svc1"));
        let svcs = client.get_services(&user);
        assert_eq!(svcs.len(), 1);
        assert_eq!(svcs.get(0).unwrap().id, String::from_str(&env, "svc1"));
    }

    #[test]
    fn test_remove_service() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let user = Address::generate(&env);
        client.create_did(&user, &Map::new(&env));
        client.add_service(&user, &make_endpoint(&env, "svc1"));
        client.remove_service(&user, &String::from_str(&env, "svc1"));
        let svcs = client.get_services(&user);
        assert_eq!(svcs.len(), 0);
    }

    #[test]
    fn test_add_service_duplicate_id_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let user = Address::generate(&env);
        client.create_did(&user, &Map::new(&env));
        client.add_service(&user, &make_endpoint(&env, "svc1"));
        assert_eq!(
            client.try_add_service(&user, &make_endpoint(&env, "svc1")),
            Err(Ok(ContractError::ServiceAlreadyExists))
        );
    }

    #[test]
    fn test_remove_service_not_found() {
        let env = Env::default();
        env.mock_all_auths();
        let cid = env.register_contract(None, IdentityRegistry);
        let client = IdentityRegistryClient::new(&env, &cid);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let user = Address::generate(&env);
        client.create_did(&user, &Map::new(&env));
        assert_eq!(
            client.try_remove_service(&user, &String::from_str(&env, "nonexistent")),
            Err(Ok(ContractError::DidNotFound))
        );
    }
}
