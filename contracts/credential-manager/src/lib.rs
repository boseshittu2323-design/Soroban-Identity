#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, IntoVal, Map, String, Symbol, Val, Vec,
};
use soroban_sdk::xdr::ToXdr;

pub const CONTRACT_VERSION: u32 = 1;
const EVENT_VERSION: u32 = 1;

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol = symbol_short!("ADMIN");
const PENDING_ADMIN: Symbol = symbol_short!("PADMIN");
const ISSUER: Symbol = symbol_short!("ISSUER");
const ISSUER_KEY: Symbol = symbol_short!("ISS_KEY");
const CRED: Symbol = symbol_short!("CRED");
const SUBJECT: Symbol = symbol_short!("sub");
const CRED_CNT: Symbol = symbol_short!("CREDCNT");
const REVOKED_CNT: Symbol = symbol_short!("REVCNT");
const ISSUER_CREDS: Symbol = symbol_short!("ISSCREDS");
const SCHEMA: Symbol = symbol_short!("SCHEMA");
const IDENTITY_REGISTRY: Symbol = symbol_short!("IDREGIST");

const MAX_ISSUERS: u32 = 100;
const MAX_ISSUER_CREDS: u32 = 10_000;
const IDENTITY_REGISTRY: Symbol = symbol_short!("IDREGIST");

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
    NoPendingAdmin = 10,
    NotPendingAdmin = 11,
    SchemaNotFound = 12,
    CredentialNotExpiredYet = 13,
}

// ── Data types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct CredentialStorageStats {
    pub total_credentials: u32,
    pub revoked_credentials: u32,
    pub active_credentials: u32,
}

#[contracttype]
#[derive(Clone, PartialEq, Debug)]
pub enum CredentialType {
    Kyc,
    Reputation,
    Achievement,
    Custom,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CredentialIdsPage {
    pub items: Vec<BytesN<32>>,
    pub next_cursor: Option<u64>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct IssuersPage {
    pub items: Vec<Address>,
    pub next_cursor: Option<u64>,
}

#[contracttype]
#[derive(Clone)]
pub struct Credential {
    pub id: BytesN<32>,
    pub subject: Address,
    pub issuer: Address,
    pub credential_type: CredentialType,
    pub claims: Map<String, String>,
    pub claims_hash: BytesN<32>,
    pub signature: Bytes,
    pub issued_at: u64,
    pub expires_at: u64,
    pub revoked: bool,
    pub schema_hash: Option<BytesN<32>>,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct CredentialManager;

#[contractimpl]
impl CredentialManager {
    pub fn ping(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    pub fn initialize(env: Env, admin: Address, identity_registry_id: Address) -> Result<(), ContractError> {
        Self::require_uninitialized(&env)?;
        Self::set_admin(&env, &admin);
        env.storage().instance().set(&IDENTITY_REGISTRY, &identity_registry_id);
        env.events().publish((ADMIN, symbol_short!("init")), (EVENT_VERSION, admin));
        Ok(())
    }

    pub fn transfer_admin(env: Env, current_admin: Address, new_admin: Address) -> Result<(), ContractError> {
        current_admin.require_auth();
        let stored: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        if stored != current_admin {
            return Err(ContractError::Unauthorized);
        }
        env.storage().instance().set(&ADMIN, &new_admin);
        env.events().publish((ADMIN, symbol_short!("transfer")), (EVENT_VERSION, current_admin, new_admin));
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

    pub fn add_issuer(env: Env, issuer: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let mut issuers = Self::get_issuers_internal(&env);
        if !issuers.contains(&issuer) {
            if issuers.len() >= MAX_ISSUERS {
                return Err(ContractError::MaxIssuersReached);
            }
            issuers.push_back(issuer.clone());
            env.storage().instance().set(&ISSUER, &issuers);
            env.events().publish((ISSUER, symbol_short!("added")), (EVENT_VERSION, issuer));
        }
        Ok(())
    }

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

    pub fn register_schema(env: Env, issuer: Address, schema_hash: BytesN<32>) -> Result<(), ContractError> {
        issuer.require_auth();
        Self::require_issuer(&env, &issuer)?;
        let schema_key = (SCHEMA, issuer.clone(), schema_hash.clone());
        env.storage().persistent().set(&schema_key, &true);
        env.storage().persistent().extend_ttl(&schema_key, TTL_MAX, TTL_MAX);
        env.events().publish((CRED, symbol_short!("sch_reg")), (EVENT_VERSION, issuer, schema_hash));
        Ok(())
    }

    pub fn issue_credential(
        env: Env,
        issuer: Address,
        subject: Address,
        credential_type: CredentialType,
        claims: Map<String, String>,
        claims_hash: BytesN<32>,
        signature: Bytes,
        expires_at: u64,
        schema_hash: Option<BytesN<32>>,
    ) -> Result<BytesN<32>, ContractError> {
        issuer.require_auth();
        Self::require_issuer(&env, &issuer)?;

        if let Some(ref sh) = schema_hash {
            let schema_key = (SCHEMA, issuer.clone(), sh.clone());
            if !env.storage().persistent().has(&schema_key) {
                return Err(ContractError::SchemaNotFound);
            }
        }

        let registry_id: Address = env.storage().instance().get(&IDENTITY_REGISTRY).ok_or(ContractError::NotInitialized)?;
        let mut registry_args: Vec<Val> = Vec::new(&env);
        registry_args.push_back(subject.clone().into_val(&env));
        let has_did: bool = env.invoke_contract(&registry_id, &Symbol::new(&env, "has_active_did"), registry_args);
        if !has_did {
            panic!("subject does not have an active DID");
        }

        let now = env.ledger().timestamp();
        if expires_at != 0 && expires_at <= now {
            return Err(ContractError::CredentialExpired);
        }

        let id = Self::derive_id(&env, &issuer, &subject, &credential_type);
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
            schema_hash,
        };

        env.storage().persistent().set(&key, &credential);
        let ttl = Self::ttl_for_credential(&env, expires_at);
        env.storage().persistent().extend_ttl(&key, ttl, ttl);

        let mut subject_creds = Self::fetch_subject_creds(&env, &subject);
        subject_creds.push_back(id.clone());
        let subject_key = Self::subject_key(&subject);
        env.storage().persistent().set(&subject_key, &subject_creds);
        env.storage().persistent().extend_ttl(&subject_key, TTL_MAX, TTL_MAX);

        // Index credential under issuer for reverse lookup
        // Apply ring-buffer semantics: cap at MAX_ISSUER_CREDS
        let mut issuer_creds = Self::fetch_issuer_creds(&env, &issuer);
        if issuer_creds.len() >= MAX_ISSUER_CREDS {
            // Drop the oldest (head) entry
            issuer_creds = issuer_creds.slice(1..issuer_creds.len());
        }
        issuer_creds.push_back(id.clone());
        let issuer_creds_key = Self::issuer_creds_key(&issuer);
        env.storage().persistent().set(&issuer_creds_key, &issuer_creds);
        env.storage().persistent().extend_ttl(&issuer_creds_key, TTL_MAX, TTL_MAX);

        let cnt_key = (CRED_CNT, subject.clone());
        let cnt: u32 = env.storage().persistent().get(&cnt_key).unwrap_or(0);
        env.storage().persistent().set(&cnt_key, &(cnt + 1));

        env.events().publish(
            (CRED, symbol_short!("issued")),
            (EVENT_VERSION, id.clone(), subject, issuer, credential_type, expires_at),
        );
        Ok(id)
    }

    pub fn revoke_credential(env: Env, issuer: Address, credential_id: BytesN<32>) -> Result<(), ContractError> {
        issuer.require_auth();
        let key = Self::cred_key(&credential_id);
        let mut cred: Credential = env.storage().persistent().get(&key).ok_or(ContractError::CredentialNotFound)?;
        if cred.issuer != issuer {
            return Err(ContractError::UnauthorizedIssuer);
        }
        cred.revoked = true;
        env.storage().persistent().set(&key, &cred);
        let revoked: u32 = env.storage().instance().get(&REVOKED_CNT).unwrap_or(0);
        env.storage().instance().set(&REVOKED_CNT, &(revoked + 1));
        env.events().publish((CRED, symbol_short!("revoked")), (EVENT_VERSION, credential_id, issuer));
        Ok(())
    }

    pub fn expire_credential(env: Env, caller: Address, credential_id: BytesN<32>) -> Result<(), ContractError> {
        caller.require_auth();
        let key = Self::cred_key(&credential_id);
        let mut cred: Credential = env.storage().persistent().get(&key).ok_or(ContractError::CredentialNotFound)?;
        if cred.revoked {
            return Err(ContractError::CredentialRevoked);
        }
        if cred.expires_at == 0 || env.ledger().timestamp() <= cred.expires_at {
            return Err(ContractError::CredentialNotExpiredYet);
        }
        env.events().publish((CRED, symbol_short!("expired")), (EVENT_VERSION, credential_id, caller));
        let revoked: u32 = env.storage().instance().get(&REVOKED_CNT).unwrap_or(0);
        env.storage().instance().set(&REVOKED_CNT, &(revoked + 1));
        cred.revoked = true;
        env.storage().persistent().set(&key, &cred);
        Ok(())
    }

    pub fn verify_credential(env: Env, credential_id: BytesN<32>) -> Result<(), ContractError> {
        let key = Self::cred_key(&credential_id);
        match env.storage().persistent().get::<_, Credential>(&key) {
            None => Err(ContractError::CredentialNotFound),
            Some(cred) => {
                if cred.revoked {
                    return Err(ContractError::CredentialRevoked);
                }
                let now = env.ledger().timestamp();
                if cred.expires_at > 0 && now > cred.expires_at {
                    return Err(ContractError::CredentialExpired);
                }
                let ttl = Self::ttl_for_credential(&env, cred.expires_at);
                env.storage().persistent().extend_ttl(&key, ttl, ttl);
                Ok(())
            }
        }
    }

    pub fn get_credential(env: Env, credential_id: BytesN<32>) -> Result<Credential, ContractError> {
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

    pub fn verify_claims_hash(env: Env, credential_id: BytesN<32>, hash: BytesN<32>) -> bool {
        let key = Self::cred_key(&credential_id);
        match env.storage().persistent().get::<_, Credential>(&key) {
            None => false,
            Some(cred) => cred.claims_hash == hash,
        }
    }

    pub fn get_subject_credentials(env: Env, subject: Address) -> Vec<BytesN<32>> {
        Self::fetch_subject_creds(&env, &subject)
    }

    pub fn list_subject_credentials(
        env: Env,
        subject: Address,
        cursor: Option<u64>,
        limit: u32,
        credential_type: Option<CredentialType>,
    ) -> CredentialIdsPage {
        let all = Self::fetch_subject_creds(&env, &subject);
        let total = all.len();
        let start: u64 = cursor.unwrap_or(0);
        let effective_limit: u32 = if limit == 0 || limit > PAGE_CAP { PAGE_CAP } else { limit };
        let mut items: Vec<BytesN<32>> = Vec::new(&env);
        let mut next: u64 = start;
        let mut taken: u32 = 0;
        while (next as u32) < total && taken < effective_limit {
            let id = all.get(next as u32).unwrap();
            next += 1;
            let include = match &credential_type {
                None => true,
                Some(filter_type) => {
                    let key = (CRED, id.clone());
                    match env.storage().persistent().get::<_, Credential>(&key) {
                        Some(cred) => cred.credential_type == *filter_type,
                        None => false,
                    }
                }
            };
            if include {
                items.push_back(id);
                taken += 1;
            }
        }
        let next_cursor = if (next as u32) < total { Some(next) } else { None };
        CredentialIdsPage { items, next_cursor }
    }

    pub fn get_credential_count(env: Env, subject: Address) -> u32 {
        let cnt_key = (CRED_CNT, subject);
        if env.storage().persistent().has(&cnt_key) {
            env.storage().persistent().extend_ttl(&cnt_key, TTL_MAX, TTL_MAX);
        }
        env.storage().persistent().get(&cnt_key).unwrap_or(0)
    }

    pub fn get_issuers(env: Env) -> Vec<Address> {
        Self::get_issuers_internal(&env)
    }

    pub fn list_issuers(env: Env, cursor: Option<u64>, limit: u32) -> IssuersPage {
        let all = Self::get_issuers_internal(&env);
        let total = all.len();
        let start: u64 = cursor.unwrap_or(0);
        let effective_limit: u32 = if limit == 0 || limit > PAGE_CAP { PAGE_CAP } else { limit };
        let mut items: Vec<Address> = Vec::new(&env);
        let mut next: u64 = start;
        let mut taken: u32 = 0;
        while (next as u32) < total && taken < effective_limit {
            items.push_back(all.get(next as u32).unwrap());
            next += 1;
            taken += 1;
        }
        let next_cursor = if (next as u32) < total { Some(next) } else { None };
        IssuersPage { items, next_cursor }
    }

    pub fn get_issuer_credentials(env: Env, issuer: Address) -> Vec<BytesN<32>> {
        Self::fetch_issuer_creds(&env, &issuer)
    }

    pub fn list_issuer_credentials(env: Env, issuer: Address, cursor: Option<u64>, limit: u32) -> CredentialIdsPage {
        let all = Self::fetch_issuer_creds(&env, &issuer);
        let total = all.len();
        let start: u64 = cursor.unwrap_or(0);
        let effective_limit: u32 = if limit == 0 || limit > PAGE_CAP { PAGE_CAP } else { limit };
        let mut items: Vec<BytesN<32>> = Vec::new(&env);
        let mut next: u64 = start;
        let mut taken: u32 = 0;
        while (next as u32) < total && taken < effective_limit {
            items.push_back(all.get(next as u32).unwrap());
            next += 1;
            taken += 1;
        }
        let next_cursor = if (next as u32) < total { Some(next) } else { None };
        CredentialIdsPage { items, next_cursor }
    }

    pub fn get_storage_stats(env: Env) -> CredentialStorageStats {
        let revoked: u32 = env.storage().instance().get(&REVOKED_CNT).unwrap_or(0);
        CredentialStorageStats {
            total_credentials: revoked,
            revoked_credentials: revoked,
            active_credentials: 0,
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

    fn require_admin(env: &Env) -> Result<(), ContractError> {
        let admin: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn require_issuer(env: &Env, issuer: &Address) -> Result<(), ContractError> {
        if !Self::get_issuers_internal(env).contains(issuer) {
            return Err(ContractError::UnauthorizedIssuer);
        }
        Ok(())
    }

    fn get_issuers_internal(env: &Env) -> Vec<Address> {
        env.storage().instance().get(&ISSUER).unwrap_or_else(|| Vec::new(env))
    }

    fn derive_id(env: &Env, issuer: &Address, subject: &Address, credential_type: &CredentialType) -> BytesN<32> {
        let type_tag: u8 = match credential_type {
            CredentialType::Kyc => 0,
            CredentialType::Reputation => 1,
            CredentialType::Achievement => 2,
            CredentialType::Custom => 3,
        };
        let mut data = Bytes::new(env);
        data.append(&issuer.clone().to_xdr(env));
        data.append(&subject.clone().to_xdr(env));
        data.push_back(type_tag);
        env.crypto().sha256(&data).into()
    }

    fn cred_key(id: &BytesN<32>) -> (Symbol, BytesN<32>) {
        (CRED, id.clone())
    }

    fn subject_key(subject: &Address) -> (Symbol, Address) {
        (SUBJECT, subject.clone())
    }

    fn issuer_creds_key(issuer: &Address) -> (Symbol, Address) {
        (ISSUER_CREDS, issuer.clone())
    }

    fn fetch_subject_creds(env: &Env, subject: &Address) -> Vec<BytesN<32>> {
        let key = Self::subject_key(subject);
        if env.storage().persistent().has(&key) {
            env.storage().persistent().extend_ttl(&key, TTL_MAX, TTL_MAX);
        }
        env.storage().persistent().get(&key).unwrap_or_else(|| Vec::new(env))
    }

    fn fetch_issuer_creds(env: &Env, issuer: &Address) -> Vec<BytesN<32>> {
        let key = Self::issuer_creds_key(issuer);
        if env.storage().persistent().has(&key) {
            env.storage().persistent().extend_ttl(&key, TTL_MAX, TTL_MAX);
        }
        env.storage().persistent().get(&key).unwrap_or_else(|| Vec::new(env))
    }

    fn ttl_for_credential(env: &Env, expires_at: u64) -> u32 {
        if expires_at == 0 {
            return TTL_MAX;
        }
        let now = env.ledger().timestamp();
        if expires_at <= now {
            return TTL_MIN;
        }
        let ledgers = ((expires_at - now) / 5) as u32;
        ledgers.min(TTL_MAX).max(TTL_MIN)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Ledger as _}, Bytes, Env, Map, String};

    struct MockIdentityRegistry;
    #[contractimpl]
    impl MockIdentityRegistry {
        pub fn has_active_did(_env: Env, _controller: Address) -> bool { true }
    }

    fn setup() -> (Env, Address, CredentialManagerClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let registry_id = env.register_contract(None, MockIdentityRegistry);
        let contract_id = env.register_contract(None, CredentialManager);
        let client = CredentialManagerClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin, &registry_id);
        (env, admin, client)
    }

    fn issue_kyc(env: &Env, client: &CredentialManagerClient, issuer: &Address, subject: &Address) -> BytesN<32> {
        client.issue_credential(
            issuer, subject, &CredentialType::Kyc,
            &Map::new(env), &BytesN::from_array(env, &[1u8; 32]),
            &Bytes::from_array(env, &[0u8; 64]), &0u64, &None,
        )
    }

    #[test]
    fn test_ping_returns_version() {
        let env = Env::default();
        let contract_id = env.register_contract(None, CredentialManager);
        let client = CredentialManagerClient::new(&env, &contract_id);
        assert_eq!(client.ping(), CONTRACT_VERSION);
    }

    #[test]
    fn test_issue_and_verify() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);
        let cred_id = issue_kyc(&env, &client, &issuer, &subject);
        client.verify_credential(&cred_id);
    }

    #[test]
    fn test_revoke_credential() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);
        let cred_id = issue_kyc(&env, &client, &issuer, &subject);
        client.revoke_credential(&issuer, &cred_id);
        assert_eq!(client.try_verify_credential(&cred_id), Err(Ok(ContractError::CredentialRevoked)));
    }

    #[test]
    fn test_verify_expired_credential() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);
        let expires_at = env.ledger().timestamp() + 100;
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc,
            &Map::new(&env), &BytesN::from_array(&env, &[0u8; 32]),
            &Bytes::from_array(&env, &[0u8; 64]), &expires_at, &None,
        );
        env.ledger().with_mut(|li| li.timestamp = expires_at + 1);
        assert_eq!(client.try_verify_credential(&cred_id), Err(Ok(ContractError::CredentialExpired)));
    }

    #[test]
    fn test_duplicate_credential_rejected() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);
        issue_kyc(&env, &client, &issuer, &subject);
        let result = client.try_issue_credential(
            &issuer, &subject, &CredentialType::Kyc,
            &Map::new(&env), &BytesN::from_array(&env, &[1u8; 32]),
            &Bytes::from_array(&env, &[0u8; 64]), &0u64, &None,
        );
        assert_eq!(result, Err(Ok(ContractError::CredentialAlreadyExists)));
    }

    #[test]
    fn test_double_initialize_returns_error() {
        let (env, admin, client) = setup();
        let dummy_registry = Address::generate(&env);
        assert_eq!(client.try_initialize(&admin, &dummy_registry), Err(Ok(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn test_register_schema_and_issue() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);
        let schema_hash = BytesN::from_array(&env, &[99u8; 32]);

        // Issuing with unregistered schema returns SchemaNotFound
        let result = client.try_issue_credential(
            &issuer, &subject, &CredentialType::Kyc,
            &Map::new(&env), &BytesN::from_array(&env, &[1u8; 32]),
            &Bytes::from_array(&env, &[0u8; 64]), &0u64, &Some(schema_hash.clone()),
        );
        assert_eq!(result, Err(Ok(ContractError::SchemaNotFound)));

        // Register schema then issue succeeds
        client.register_schema(&issuer, &schema_hash);
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc,
            &Map::new(&env), &BytesN::from_array(&env, &[1u8; 32]),
            &Bytes::from_array(&env, &[0u8; 64]), &0u64, &Some(schema_hash),
        );
        client.verify_credential(&cred_id);
    }

    #[test]
    fn test_schema_optional_no_schema_works() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);
        // No schema_hash — must work as before
        let cred_id = issue_kyc(&env, &client, &issuer, &subject);
        client.verify_credential(&cred_id);
    }

    #[test]
    fn test_expire_credential() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let caller = Address::generate(&env);
        client.add_issuer(&issuer);

        let expires_at = env.ledger().timestamp() + 100;
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc,
            &Map::new(&env), &BytesN::from_array(&env, &[0u8; 32]),
            &Bytes::from_array(&env, &[0u8; 64]), &expires_at, &None,
        );

        // Before expiry returns CredentialNotExpiredYet
        assert_eq!(
            client.try_expire_credential(&caller, &cred_id),
            Err(Ok(ContractError::CredentialNotExpiredYet))
        );

        // After expiry succeeds and marks credential expired
        env.ledger().with_mut(|li| li.timestamp = expires_at + 1);
        client.expire_credential(&caller, &cred_id);
        assert_eq!(client.try_verify_credential(&cred_id), Err(Ok(ContractError::CredentialRevoked)));
    }

    #[test]
    fn test_expire_already_revoked() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        let caller = Address::generate(&env);
        client.add_issuer(&issuer);

        let expires_at = env.ledger().timestamp() + 100;
        let cred_id = client.issue_credential(
            &issuer, &subject, &CredentialType::Kyc,
            &Map::new(&env), &BytesN::from_array(&env, &[0u8; 32]),
            &Bytes::from_array(&env, &[0u8; 64]), &expires_at, &None,
        );
        client.revoke_credential(&issuer, &cred_id);
        env.ledger().with_mut(|li| li.timestamp = expires_at + 1);
        assert_eq!(
            client.try_expire_credential(&caller, &cred_id),
            Err(Ok(ContractError::CredentialRevoked))
        );
    }

    #[test]
    fn test_list_subject_credentials_paginates() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        let subject = Address::generate(&env);
        client.add_issuer(&issuer);
        for ct in [CredentialType::Kyc, CredentialType::Reputation, CredentialType::Achievement] {
            client.issue_credential(
                &issuer, &subject, &ct,
                &Map::new(&env), &BytesN::from_array(&env, &[1u8; 32]),
                &Bytes::from_array(&env, &[0u8; 64]), &0u64, &None,
            );
        }
        let page1 = client.list_subject_credentials(&subject, &None, &2, &None);
        assert_eq!(page1.items.len(), 2);
        assert_eq!(page1.next_cursor, Some(2));
        let page2 = client.list_subject_credentials(&subject, &page1.next_cursor, &2, &None);
        assert_eq!(page2.items.len(), 1);
        assert_eq!(page2.next_cursor, None);
    }

    #[test]
    fn test_storage_key_symbols_are_unique() {
        let keys = [ADMIN, ISSUER, CRED, SUBJECT, CRED_CNT, REVOKED_CNT, ISSUER_CREDS, SCHEMA];
        for (i, left) in keys.iter().enumerate() {
            for right in keys.iter().skip(i + 1) {
                assert_ne!(left, right);
            }
        }
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

    /// Ring-buffer eviction: when issuer index reaches MAX_ISSUER_CREDS,
    /// issuing the (MAX_ISSUER_CREDS + 1)th credential drops the oldest entry.
    #[test]
    fn test_issuer_credentials_ring_buffer_eviction() {
        let (env, _admin, client) = setup();
        let issuer = Address::generate(&env);
        client.add_issuer(&issuer);

        // Issue MAX_ISSUER_CREDS credentials from different subjects
        let mut first_id = None;
        for i in 0..MAX_ISSUER_CREDS {
            let subject = Address::generate(&env);
            let id = issue_kyc(&env, &client, &issuer, &subject);
            if i == 0 {
                first_id = Some(id);
            }
        }

        // Index should be at MAX_ISSUER_CREDS
        let creds_before = client.get_issuer_credentials(&issuer);
        assert_eq!(creds_before.len(), MAX_ISSUER_CREDS as u32);

        // Issue one more credential — should not panic and index stays at MAX_ISSUER_CREDS
        let new_subject = Address::generate(&env);
        let _new_id = issue_kyc(&env, &client, &issuer, &new_subject);

        let creds_after = client.get_issuer_credentials(&issuer);
        assert_eq!(creds_after.len(), MAX_ISSUER_CREDS as u32);

        // The first credential ID should have been evicted (removed from head)
        if let Some(first) = first_id {
            // Verify first_id is NOT in the list after eviction
            let mut found = false;
            for cred_id in creds_after.iter() {
                if cred_id == first {
                    found = true;
                    break;
                }
            }
            assert!(!found, "First credential ID should have been evicted from the index");
        }
    }
}
