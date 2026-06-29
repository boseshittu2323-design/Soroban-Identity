#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short,
    Address, BytesN, Env, Symbol, Vec,
};

pub use shared_errors::SharedError;

pub const CONTRACT_VERSION: u32 = 1;
const EVENT_VERSION: u32 = 1;
const MIN_INTERVAL: u32 = 100;
const MIN_SCORE: i64 = 0;
const TTL_MAX: u32 = 6_312_000;
const MAX_HISTORY: usize = 50;
const PAGE_CAP: u32 = 100;
/// Maximum number of submissions in a single batch_submit_score call.
pub const MAX_BATCH_SIZE: u32 = 20;

const ADMIN: Symbol = symbol_short!("ADMIN");
const PENDING_ADMIN: Symbol = symbol_short!("PADMIN");
const REPORTER: Symbol = symbol_short!("REPORTER");
const DEF_THRESH: Symbol = symbol_short!("DEFTHRESH");
const SUBJECT_CNT: Symbol = symbol_short!("SUBCNT");
const SCORE_CNT: Symbol = symbol_short!("SCRCNT");
const RECORD: Symbol = symbol_short!("rec");
const HISTORY: Symbol = symbol_short!("h");
const RATE_LIMIT: Symbol = symbol_short!("rl");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ContractError {
    AlreadyInitialized = 1,
    ReporterNotFound = 2,
    RateLimitExceeded = 3,
    ReasonTooLong = 4,
    NotInitialized = 5,
    Unauthorized = 6,
    NoPendingAdmin = 7,
    NotPendingAdmin = 8,
    BatchTooLarge = 9,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ReputationStorageStats {
    pub total_subjects: u32,
    pub total_score_entries: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DefaultThreshold {
    pub min_score: i64,
    pub min_reporters: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ReputationRecord {
    pub subject: Address,
    pub score: i64,
    pub reporter_count: u32,
    pub updated_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ScoreEntry {
    pub reporter: Address,
    pub delta: i64,
    pub reason: soroban_sdk::String,
    pub submitted_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ScoreEntriesPage {
    pub items: Vec<ScoreEntry>,
    pub next_cursor: Option<u64>,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ReportersPage {
    pub items: Vec<Address>,
    pub next_cursor: Option<u64>,
}

#[contract]
pub struct Reputation;

#[contractimpl]
impl Reputation {
    pub fn ping(_env: Env) -> u32 { CONTRACT_VERSION }

    pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        Self::require_uninitialized(&env)?;
        Self::set_admin(&env, &admin);
        env.events().publish((ADMIN, symbol_short!("init")), (EVENT_VERSION, admin));
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
        let old: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        env.storage().instance().set(&ADMIN, &proposed);
        env.events().publish((ADMIN, symbol_short!("accepted")), (EVENT_VERSION, old, proposed));
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

    pub fn add_reporter(env: Env, reporter: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let mut reporters = Self::get_reporters(&env);
        if !reporters.contains(&reporter) {
            reporters.push_back(reporter.clone());
            env.storage().instance().set(&REPORTER, &reporters);
            env.events().publish((REPORTER, symbol_short!("added")), (EVENT_VERSION, reporter, env.ledger().timestamp()));
        }
        Ok(())
    }

    pub fn remove_reporter(env: Env, reporter: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let reporters = Self::get_reporters(&env);
        let mut updated = Vec::new(&env);
        for r in reporters.iter() {
            if r != reporter { updated.push_back(r); }
        }
        env.storage().instance().set(&REPORTER, &updated);
        env.events().publish((REPORTER, symbol_short!("removed")), (EVENT_VERSION, reporter, env.ledger().timestamp()));
        Ok(())
    }

    pub fn remove_subject_reporter(env: Env, subject: Address, reporter: Address) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        let history_key = Self::history_key(&subject, &reporter);
        if env.storage().persistent().has(&history_key) {
            env.storage().persistent().remove(&history_key);
            let rec_key = Self::record_key(&subject);
            if let Some(mut record) = env.storage().persistent().get::<(Symbol, Address), ReputationRecord>(&rec_key) {
                record.reporter_count = record.reporter_count.saturating_sub(1);
                env.storage().persistent().set(&rec_key, &record);
                env.storage().persistent().extend_ttl(&rec_key, TTL_MAX, TTL_MAX);
            }
            env.events().publish((REPORTER, symbol_short!("removed")), (EVENT_VERSION, subject, reporter));
        }
        Ok(())
    }

    pub fn update_thresholds(env: Env, min_score: i64, min_reporters: u32) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DEF_THRESH, &DefaultThreshold { min_score, min_reporters });
        env.events().publish((symbol_short!("THRESH"), symbol_short!("updated")), (EVENT_VERSION, min_score, min_reporters));
        Ok(())
    }

    pub fn set_default_threshold(env: Env, min_score: i64, min_reporters: u32) -> Result<(), ContractError> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DEF_THRESH, &DefaultThreshold { min_score, min_reporters });
        Ok(())
    }

    pub fn passes_sybil_check_default(env: Env, subject: Address) -> Result<bool, ContractError> {
        let threshold: DefaultThreshold = env.storage().instance().get(&DEF_THRESH).ok_or(ContractError::NotInitialized)?;
        let key = Self::record_key(&subject);
        match env.storage().persistent().get::<(Symbol, Address), ReputationRecord>(&key) {
            None => Ok(false),
            Some(rec) => Ok(rec.score >= threshold.min_score && rec.reporter_count >= threshold.min_reporters),
        }
    }

    pub fn submit_score(env: Env, reporter: Address, subject: Address, delta: i64, reason: soroban_sdk::String) -> Result<(), ContractError> {
        reporter.require_auth();
        Self::require_reporter(&env, &reporter)?;
        if reason.len() > 256 { return Err(ContractError::ReasonTooLong); }
        Self::check_and_set_rate_limit(&env, &subject, &reporter)?;
        Self::apply_score(&env, &reporter, &subject, delta, reason);
        Ok(())
    }

    /// Batch submit score deltas for multiple subjects in a single transaction.
    /// Validates ALL entries before writing any (atomic: one invalid entry fails all).
    /// Rate limit is checked per-subject. Max batch size is MAX_BATCH_SIZE (20).
    pub fn batch_submit_score(
        env: Env,
        reporter: Address,
        submissions: Vec<(Address, i64, soroban_sdk::String)>,
    ) -> Result<(), ContractError> {
        reporter.require_auth();
        Self::require_reporter(&env, &reporter)?;

        if submissions.len() > MAX_BATCH_SIZE {
            return Err(ContractError::BatchTooLarge);
        }

        // Pass 1: validate all entries (atomicity — no writes yet)
        for (subject, _delta, reason) in submissions.iter() {
            if reason.len() > 256 { return Err(ContractError::ReasonTooLong); }
            let rate_key = Self::rate_key(&subject, &reporter);
            let current_ledger = env.ledger().sequence();
            if let Some(last_ledger) = env.storage().persistent().get::<(Symbol, Address, Address), u32>(&rate_key) {
                if current_ledger <= last_ledger + MIN_INTERVAL {
                    return Err(ContractError::RateLimitExceeded);
                }
            }
        }

        // Pass 2: apply all writes
        for (subject, delta, reason) in submissions.iter() {
            let rate_key = Self::rate_key(&subject, &reporter);
            env.storage().persistent().set(&rate_key, &env.ledger().sequence());
            env.storage().persistent().extend_ttl(&rate_key, TTL_MAX, TTL_MAX);
            Self::apply_score(&env, &reporter, &subject, delta, reason);
        }

        Ok(())
    }

    pub fn get_reputation(env: Env, subject: Address) -> ReputationRecord {
        let key = Self::record_key(&subject);
        if env.storage().persistent().has(&key) {
            env.storage().persistent().extend_ttl(&key, TTL_MAX, TTL_MAX);
        }
        env.storage().persistent().get(&key).unwrap_or(ReputationRecord {
            subject: subject.clone(),
            score: 0,
            reporter_count: 0,
            updated_at: 0,
        })
    }

    pub fn get_history(env: Env, subject: Address, reporter: Address, offset: u32, limit: u32) -> Result<Vec<ScoreEntry>, ContractError> {
        if !Self::get_reporters(&env).contains(&reporter) { return Err(ContractError::ReporterNotFound); }
        let key = Self::history_key(&subject, &reporter);
        if env.storage().persistent().has(&key) { env.storage().persistent().extend_ttl(&key, TTL_MAX, TTL_MAX); }
        let all: Vec<ScoreEntry> = env.storage().persistent().get(&key).unwrap_or_else(|| Vec::new(&env));
        let cap: u32 = 100;
        let effective_limit = if limit == 0 || limit > cap { cap } else { limit };
        let len = all.len();
        let start = offset.min(len);
        let end = (start + effective_limit).min(len);
        let mut page = Vec::new(&env);
        for i in start..end { page.push_back(all.get(i).unwrap()); }
        Ok(page)
    }

    pub fn passes_sybil_check(env: Env, subject: Address, min_score: i64, min_reporters: u32) -> bool {
        let key = Self::record_key(&subject);
        if env.storage().persistent().has(&key) { env.storage().persistent().extend_ttl(&key, TTL_MAX, TTL_MAX); }
        match env.storage().persistent().get::<(Symbol, Address), ReputationRecord>(&key) {
            None => false,
            Some(rec) => {
                if rec.score < min_score { return false; }
                let active_reporters = Self::get_reporters(&env);
                let mut active_count = 0u32;
                for r in active_reporters.iter() {
                    let hk = Self::history_key(&subject, &r);
                    if env.storage().persistent().has(&hk) {
                        env.storage().persistent().extend_ttl(&hk, TTL_MAX, TTL_MAX);
                        active_count += 1;
                    }
                }
                active_count >= min_reporters
            }
        }
    }

    pub fn get_reporters_list(env: Env) -> Vec<Address> { Self::get_reporters(&env) }

    pub fn list_reporters(env: Env, cursor: Option<u64>, limit: u32) -> ReportersPage {
        let all = Self::get_reporters(&env);
        let total = all.len();
        let start: u64 = cursor.unwrap_or(0);
        let effective_limit = if limit == 0 || limit > PAGE_CAP { PAGE_CAP } else { limit };
        let mut items = Vec::new(&env);
        let mut next = start;
        let mut taken = 0u32;
        while (next as u32) < total && taken < effective_limit {
            items.push_back(all.get(next as u32).unwrap());
            next += 1; taken += 1;
        }
        let next_cursor = if (next as u32) < total { Some(next) } else { None };
        ReportersPage { items, next_cursor }
    }

    pub fn list_history(env: Env, subject: Address, reporter: Address, cursor: Option<u64>, limit: u32) -> Result<ScoreEntriesPage, ContractError> {
        if !Self::get_reporters(&env).contains(&reporter) { return Err(ContractError::ReporterNotFound); }
        let key = Self::history_key(&subject, &reporter);
        let all: Vec<ScoreEntry> = env.storage().persistent().get(&key).unwrap_or_else(|| Vec::new(&env));
        let total = all.len();
        let start: u64 = cursor.unwrap_or(0);
        let effective_limit = if limit == 0 || limit > PAGE_CAP { PAGE_CAP } else { limit };
        let mut items = Vec::new(&env);
        let mut next = start;
        let mut taken = 0u32;
        while (next as u32) < total && taken < effective_limit {
            items.push_back(all.get(next as u32).unwrap());
            next += 1; taken += 1;
        }
        let next_cursor = if (next as u32) < total { Some(next) } else { None };
        Ok(ScoreEntriesPage { items, next_cursor })
    }

    pub fn get_storage_stats(env: Env) -> ReputationStorageStats {
        ReputationStorageStats {
            total_subjects: env.storage().instance().get(&SUBJECT_CNT).unwrap_or(0),
            total_score_entries: env.storage().instance().get(&SCORE_CNT).unwrap_or(0),
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn require_uninitialized(env: &Env) -> Result<(), ContractError> {
        if env.storage().instance().has(&ADMIN) { return Err(ContractError::AlreadyInitialized); }
        Ok(())
    }

    fn set_admin(env: &Env, admin: &Address) { env.storage().instance().set(&ADMIN, admin); }

    fn require_admin(env: &Env) -> Result<(), ContractError> {
        let admin: Address = env.storage().instance().get(&ADMIN).ok_or(ContractError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn require_reporter(env: &Env, reporter: &Address) -> Result<(), ContractError> {
        if !Self::get_reporters(env).contains(reporter) { return Err(ContractError::ReporterNotFound); }
        Ok(())
    }

    fn get_reporters(env: &Env) -> Vec<Address> {
        env.storage().instance().get(&REPORTER).unwrap_or_else(|| Vec::new(env))
    }

    fn record_key(subject: &Address) -> (Symbol, Address) { (RECORD, subject.clone()) }
    fn history_key(subject: &Address, reporter: &Address) -> (Symbol, Address, Address) { (HISTORY, subject.clone(), reporter.clone()) }
    fn rate_key(subject: &Address, reporter: &Address) -> (Symbol, Address, Address) { (RATE_LIMIT, subject.clone(), reporter.clone()) }

    /// Checks rate limit for (subject, reporter) and sets it. Call only during write phase.
    fn check_and_set_rate_limit(env: &Env, subject: &Address, reporter: &Address) -> Result<(), ContractError> {
        let rate_key = Self::rate_key(subject, reporter);
        let current_ledger = env.ledger().sequence();
        if let Some(last_ledger) = env.storage().persistent().get::<(Symbol, Address, Address), u32>(&rate_key) {
            if current_ledger <= last_ledger + MIN_INTERVAL { return Err(ContractError::RateLimitExceeded); }
        }
        env.storage().persistent().set(&rate_key, &current_ledger);
        env.storage().persistent().extend_ttl(&rate_key, TTL_MAX, TTL_MAX);
        Ok(())
    }

    /// Core score application logic (no auth, no rate-limit check — callers handle those).
    fn apply_score(env: &Env, reporter: &Address, subject: &Address, delta: i64, reason: soroban_sdk::String) {
        let now = env.ledger().timestamp();
        let rec_key = Self::record_key(subject);
        let existing: Option<ReputationRecord> = env.storage().persistent().get(&rec_key);
        let is_new_subject = existing.is_none();
        let mut record = existing.unwrap_or(ReputationRecord {
            subject: subject.clone(), score: 0, reporter_count: 0, updated_at: now,
        });
        record.score = record.score.saturating_add(delta).max(MIN_SCORE);
        record.updated_at = now;

        let history_key = Self::history_key(subject, reporter);
        if !env.storage().persistent().has(&history_key) {
            record.reporter_count = record.reporter_count.saturating_add(1);
        }

        if is_new_subject {
            let cnt: u32 = env.storage().instance().get(&SUBJECT_CNT).unwrap_or(0);
            env.storage().instance().set(&SUBJECT_CNT, &(cnt + 1));
        }

        env.storage().persistent().set(&rec_key, &record);
        env.storage().persistent().extend_ttl(&rec_key, TTL_MAX, TTL_MAX);

        let mut history: Vec<ScoreEntry> = env.storage().persistent().get(&history_key).unwrap_or_else(|| Vec::new(env));
        if history.len() >= MAX_HISTORY as u32 { history.remove(0); }
        history.push_back(ScoreEntry { reporter: reporter.clone(), delta, reason, submitted_at: now });
        env.storage().persistent().set(&history_key, &history);
        env.storage().persistent().extend_ttl(&history_key, TTL_MAX, TTL_MAX);

        let score_cnt: u32 = env.storage().instance().get(&SCORE_CNT).unwrap_or(0);
        env.storage().instance().set(&SCORE_CNT, &(score_cnt + 1));

        env.events().publish((symbol_short!("SCORE"), symbol_short!("submitted")), (EVENT_VERSION, reporter.clone(), subject.clone(), delta));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Ledger as _}, Env, String, Vec};

    fn setup() -> (Env, Address, Address, Address, ReputationClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, Reputation);
        let client = ReputationClient::new(&env, &id);
        let admin = Address::generate(&env);
        let reporter = Address::generate(&env);
        let subject = Address::generate(&env);
        client.initialize(&admin);
        client.add_reporter(&reporter);
        (env, admin, reporter, subject, client)
    }

    #[test]
    fn test_ping_returns_version() {
        let env = Env::default();
        let id = env.register_contract(None, Reputation);
        assert_eq!(ReputationClient::new(&env, &id).ping(), CONTRACT_VERSION);
    }

    #[test]
    fn test_double_initialize_returns_error() {
        let (env, admin, _, _, client) = setup();
        assert_eq!(client.try_initialize(&admin), Err(Ok(ContractError::AlreadyInitialized)));
    }

    #[test]
    fn test_upgrade_unauthorized_returns_error() {
        let (env, _, _, _, client) = setup();
        let attacker = Address::generate(&env);
        assert_eq!(client.try_upgrade(&attacker, &BytesN::from_array(&env, &[0u8; 32])), Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn test_upgrade_not_initialized_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, Reputation);
        let client = ReputationClient::new(&env, &id);
        let admin = Address::generate(&env);
        assert_eq!(client.try_upgrade(&admin, &BytesN::from_array(&env, &[0u8; 32])), Err(Ok(ContractError::NotInitialized)));
    }

    #[test]
    fn test_score_accumulation() {
        let (env, _, reporter, subject, client) = setup();
        let reason = String::from_str(&env, "completed KYC");
        client.submit_score(&reporter, &subject, &50, &reason);
        env.ledger().with_mut(|li| li.sequence_number += 101);
        client.submit_score(&reporter, &subject, &25, &reason);
        let rec = client.get_reputation(&subject);
        assert_eq!(rec.score, 75);
        assert_eq!(rec.reporter_count, 1);
    }

    #[test]
    fn test_score_floor_at_zero() {
        let (env, _, reporter, subject, client) = setup();
        let reason = String::from_str(&env, "penalty");
        client.submit_score(&reporter, &subject, &-100, &reason);
        assert_eq!(client.get_reputation(&subject).score, 0);
    }

    #[test]
    fn test_submit_score_rate_limit() {
        let (env, _, reporter, subject, client) = setup();
        let reason = String::from_str(&env, "first");
        client.submit_score(&reporter, &subject, &10, &reason);
        assert_eq!(client.try_submit_score(&reporter, &subject, &10, &reason), Err(Ok(ContractError::RateLimitExceeded)));
        env.ledger().with_mut(|li| li.sequence_number += 101);
        client.submit_score(&reporter, &subject, &10, &reason);
    }

    #[test]
    fn test_sybil_check() {
        let (env, admin, reporter1, subject, client) = setup();
        let reporter2 = Address::generate(&env);
        client.add_reporter(&reporter2);
        let reason = String::from_str(&env, "activity");
        client.submit_score(&reporter1, &subject, &40, &reason);
        client.submit_score(&reporter2, &subject, &40, &reason);
        assert!(client.passes_sybil_check(&subject, &50, &2));
        assert!(!client.passes_sybil_check(&subject, &50, &3));
        // unused var warning suppressor
        let _ = admin;
    }

    #[test]
    fn test_remove_reporter_updates_sybil_check() {
        let (env, _, reporter1, subject, client) = setup();
        let reporter2 = Address::generate(&env);
        let reporter3 = Address::generate(&env);
        client.add_reporter(&reporter2);
        client.add_reporter(&reporter3);
        let reason = String::from_str(&env, "activity");
        client.submit_score(&reporter1, &subject, &40, &reason);
        client.submit_score(&reporter2, &subject, &40, &reason);
        client.submit_score(&reporter3, &subject, &40, &reason);
        assert!(client.passes_sybil_check(&subject, &50, &3));
        client.remove_reporter(&reporter2);
        assert!(!client.passes_sybil_check(&subject, &50, &3));
        assert!(client.passes_sybil_check(&subject, &50, &2));
    }

    #[test]
    #[should_panic]
    fn test_submit_score_unauthorized_reporter() {
        let (env, _, _, subject, client) = setup();
        let rando = Address::generate(&env);
        client.submit_score(&rando, &subject, &10, &String::from_str(&env, "x"));
    }

    #[test]
    fn test_get_history_unknown_reporter() {
        let (env, _, reporter, subject, client) = setup();
        let unknown = Address::generate(&env);
        let reason = String::from_str(&env, "test");
        client.submit_score(&reporter, &subject, &10, &reason);
        assert_eq!(client.try_get_history(&subject, &unknown, &0, &10), Err(Ok(ContractError::ReporterNotFound)));
    }

    #[test]
    fn test_get_storage_stats() {
        let (env, _, reporter, subject1, client) = setup();
        let subject2 = Address::generate(&env);
        let reason = String::from_str(&env, "activity");
        client.submit_score(&reporter, &subject1, &10, &reason);
        env.ledger().with_mut(|li| li.sequence_number += 101);
        client.submit_score(&reporter, &subject1, &20, &reason);
        env.ledger().with_mut(|li| li.sequence_number += 101);
        client.submit_score(&reporter, &subject2, &30, &reason);
        let stats = client.get_storage_stats();
        assert_eq!(stats.total_subjects, 2);
        assert_eq!(stats.total_score_entries, 3);
    }

    #[test]
    fn test_list_reporters_paginates() {
        let (env, admin, _, _, client) = setup();
        client.add_reporter(&Address::generate(&env));
        client.add_reporter(&Address::generate(&env));
        // Already has 1 reporter from setup, now 3 total
        let _ = admin;
        let page1 = client.list_reporters(&None, &2);
        assert_eq!(page1.items.len(), 2);
        assert_eq!(page1.next_cursor, Some(2));
        let page2 = client.list_reporters(&page1.next_cursor, &2);
        assert_eq!(page2.items.len(), 1);
        assert_eq!(page2.next_cursor, None);
    }

    // ── batch_submit_score tests (#398) ───────────────────────────────────────

    #[test]
    fn test_batch_submit_score_succeeds() {
        let (env, _, reporter, subject1, client) = setup();
        let subject2 = Address::generate(&env);
        let reason = String::from_str(&env, "batch");
        let mut submissions: Vec<(Address, i64, String)> = Vec::new(&env);
        submissions.push_back((subject1.clone(), 30, reason.clone()));
        submissions.push_back((subject2.clone(), 50, reason.clone()));
        client.batch_submit_score(&reporter, &submissions);
        assert_eq!(client.get_reputation(&subject1).score, 30);
        assert_eq!(client.get_reputation(&subject2).score, 50);
    }

    #[test]
    fn test_batch_submit_score_too_large() {
        let (env, _, reporter, _, client) = setup();
        let reason = String::from_str(&env, "x");
        let mut submissions: Vec<(Address, i64, String)> = Vec::new(&env);
        for _ in 0..21 {
            submissions.push_back((Address::generate(&env), 1, reason.clone()));
        }
        assert_eq!(client.try_batch_submit_score(&reporter, &submissions), Err(Ok(ContractError::BatchTooLarge)));
    }

    #[test]
    fn test_batch_submit_score_atomicity_rate_limit() {
        let (env, _, reporter, subject1, client) = setup();
        let subject2 = Address::generate(&env);
        let reason = String::from_str(&env, "x");
        // subject1 already submitted once
        client.submit_score(&reporter, &subject1, &10, &reason);
        // batch contains subject1 (rate limited) and subject2 — whole batch must fail
        let mut submissions: Vec<(Address, i64, String)> = Vec::new(&env);
        submissions.push_back((subject1.clone(), 10, reason.clone()));
        submissions.push_back((subject2.clone(), 10, reason.clone()));
        assert_eq!(client.try_batch_submit_score(&reporter, &submissions), Err(Ok(ContractError::RateLimitExceeded)));
        // subject2 must have no score (atomicity)
        assert_eq!(client.get_reputation(&subject2).score, 0);
    }

    #[test]
    fn test_batch_submit_score_reason_too_long() {
        let (env, _, reporter, subject1, client) = setup();
        let subject2 = Address::generate(&env);
        let long_reason = String::from_str(&env, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let mut submissions: Vec<(Address, i64, String)> = Vec::new(&env);
        submissions.push_back((subject1.clone(), 10, long_reason));
        submissions.push_back((subject2.clone(), 10, String::from_str(&env, "ok")));
        assert_eq!(client.try_batch_submit_score(&reporter, &submissions), Err(Ok(ContractError::ReasonTooLong)));
        assert_eq!(client.get_reputation(&subject2).score, 0);
    }
}
