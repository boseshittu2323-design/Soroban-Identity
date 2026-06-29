#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, IntoVal, Map, String, Symbol, Val, Vec,
};
use soroban_sdk::xdr::ToXdr;

pub use shared_errors::SharedError;

pub const CONTRACT_VERSION: u32 = 1;
const EVENT_VERSION: u32 = 1;

const ADMIN: Symbol = symbol_short!("ADMIN");
const PENDING_ADMIN: Symbol = symbol_short!("PADMIN");
const ISSUER: Symbol = symbol_short!("ISSUER");
const CRED: Symbol = symbol_short!("CRED");
const SUBJECT: Symbol = symbol_short!("sub");
const CRED_CNT: Symbol = symbol_short!("CREDCNT");
const REVOKED_CNT: Symbol = symbol_short!("REVCNT");
const ISSUER_CREDS: Symbol = symbol_short!("ISSCREDS");
const IDENTITY_REGISTRY: Symbol = symbol_short!("IDREGIST");

const MAX_ISSUERS: u32 = 100;
const TTL_MAX: u32 = 6_312_000;
const TTL_MIN: u32 = 17_280;
const PAGE_CAP: u32 = 100;

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
}

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
}

#[contract]
pub struct CredentialManager;

#[contractimpl]
impl CredentialManager {
    pub fn ping(_env: Env) -> u32 { CONTRACT_VERSION }

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
        if stored != current_admin { return Err(ContractError::Unauthorized); }
        env.storage().instance().set(&ADMIN, &new_admin);
        env.events().publish((ADMIN, symbol_short!("transfer")), (EVENT_VERSION, current_admin, new_admin));
        Ok(())
    }

    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
        admin.require_auth();
        let stored: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        if stored != admin { return Err(ContractError::Unauthorized); }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn add_issuer(env: Env, issuer: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let mut issuers = Self::get_issuers_internal(&env);
        if !issuers.contains(&issuer) {
            if issuers.len() >= MAX_ISSUERS { return Err(ContractError::MaxIssuersReached); }
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
        for i in issuers.iter() { if i != issuer { updated.push_back(i); } }
        env.storage().instance().set(&ISSUER, &updated);
        Ok(())
    }
