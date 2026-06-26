#![no_std]

//! Reputation contract — on-chain activity scoring and anti-sybil signals.
//!
//! Trusted reporters (e.g. dApps, oracles) submit score deltas for a subject.
//! The contract accumulates a total score and tracks per-reporter contributions
//! so scores can be audited or disputed.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short,
    Address, Env, Symbol, Vec,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol    = symbol_short!("ADMIN");
const REPORTER: Symbol = symbol_short!("REPORTER");

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ReputationError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAReporter = 3,
}

// ── Data types ────────────────────────────────────────────────────────────────

/// Aggregated reputation record for a subject.
#[contracttype]
#[derive(Clone)]
pub struct ReputationRecord {
    pub subject: Address,
    /// Total accumulated score (can be negative)
    pub score: i64,
    /// Number of distinct reporters that have submitted
    pub reporter_count: u32,
    /// Last update timestamp
    pub updated_at: u64,
}

/// A single score submission from a reporter.
#[contracttype]
#[derive(Clone)]
pub struct ScoreEntry {
    pub reporter: Address,
    pub delta: i64,
    pub reason: soroban_sdk::String,
    pub submitted_at: u64,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct Reputation;

#[contractimpl]
impl Reputation {
    // ── Admin ─────────────────────────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address) -> Result<(), ReputationError> {
        if env.storage().instance().has(&ADMIN) {
            return Err(ReputationError::AlreadyInitialized);
        }
        env.storage().instance().set(&ADMIN, &admin);
        Ok(())
    }

    pub fn add_reporter(env: Env, reporter: Address) -> Result<(), ReputationError> {
        Self::require_admin(&env)?;
        let mut reporters = Self::get_reporters(&env);
        if !reporters.contains(&reporter) {
            reporters.push_back(reporter.clone());
            env.storage().instance().set(&REPORTER, &reporters);
        }
        Ok(())
    }

    pub fn remove_reporter(env: Env, reporter: Address) -> Result<(), ReputationError> {
        Self::require_admin(&env)?;
        let reporters = Self::get_reporters(&env);
        let updated: Vec<Address> = reporters.iter().filter(|r| r != reporter).collect();
        env.storage().instance().set(&REPORTER, &updated);
        Ok(())
    }

    // ── Scoring ───────────────────────────────────────────────────────────────

    /// Submit a score delta for a subject. Caller must be a registered reporter.
    pub fn submit_score(
        env: Env,
        reporter: Address,
        subject: Address,
        delta: i64,
        reason: soroban_sdk::String,
    ) -> Result<(), ReputationError> {
        reporter.require_auth();
        Self::require_reporter(&env, &reporter)?;

        let now = env.ledger().timestamp();

        let rec_key = Self::record_key(&env, &subject);
        let mut record: ReputationRecord = env
            .storage()
            .persistent()
            .get(&rec_key)
            .unwrap_or(ReputationRecord {
                subject: subject.clone(),
                score: 0,
                reporter_count: 0,
                updated_at: now,
            });

        record.score = record.score.saturating_add(delta);
        record.updated_at = now;

        let history_key = Self::history_key(&env, &subject, &reporter);
        let is_new = !env.storage().persistent().has(&history_key);
        if is_new {
            record.reporter_count = record.reporter_count.saturating_add(1);
        }

        env.storage().persistent().set(&rec_key, &record);

        let mut history: Vec<ScoreEntry> = env
            .storage()
            .persistent()
            .get(&history_key)
            .unwrap_or_else(|| Vec::new(&env));

        history.push_back(ScoreEntry {
            reporter: reporter.clone(),
            delta,
            reason,
            submitted_at: now,
        });
        env.storage().persistent().set(&history_key, &history);

        env.events()
            .publish((symbol_short!("SCORE"), symbol_short!("updated")), (reporter, subject, delta));

        Ok(())
    }

    /// Get the reputation record for a subject.
    pub fn get_reputation(env: Env, subject: Address) -> ReputationRecord {
        let key = Self::record_key(&env, &subject);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or(ReputationRecord {
                subject: subject.clone(),
                score: 0,
                reporter_count: 0,
                updated_at: 0,
            })
    }

    /// Get score history submitted by a specific reporter for a subject.
    pub fn get_history(
        env: Env,
        subject: Address,
        reporter: Address,
    ) -> Vec<ScoreEntry> {
        let key = Self::history_key(&env, &subject, &reporter);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Simple anti-sybil check: returns true if score >= threshold AND
    /// at least `min_reporters` distinct reporters have contributed.
    pub fn passes_sybil_check(
        env: Env,
        subject: Address,
        min_score: i64,
        min_reporters: u32,
    ) -> bool {
        let key = Self::record_key(&env, &subject);
        match env.storage().persistent().get::<soroban_sdk::Bytes, ReputationRecord>(&key) {
            None => false,
            Some(rec) => rec.score >= min_score && rec.reporter_count >= min_reporters,
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), ReputationError> {
        let admin: Address = env.storage().instance().get(&ADMIN).ok_or(ReputationError::NotInitialized)?;
        admin.require_auth();
        Ok(())
    }

    fn require_reporter(env: &Env, reporter: &Address) -> Result<(), ReputationError> {
        if !Self::get_reporters(env).contains(reporter) {
            return Err(ReputationError::NotAReporter);
        }
        Ok(())
    }

    fn get_reporters(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&REPORTER)
            .unwrap_or_else(|| Vec::new(env))
    }

    fn record_key(env: &Env, subject: &Address) -> soroban_sdk::Bytes {
        let mut k = soroban_sdk::Bytes::new(env);
        k.extend_from_array(&[b'r', b'e', b'c', b':']);
        k.extend_from_slice(&subject.to_string().into_bytes());
        k
    }

    fn history_key(env: &Env, subject: &Address, reporter: &Address) -> soroban_sdk::Bytes {
        let mut k = soroban_sdk::Bytes::new(env);
        k.extend_from_array(&[b'h', b':', ]);
        k.extend_from_slice(&subject.to_string().into_bytes());
        k.extend_from_array(&[b'|']);
        k.extend_from_slice(&reporter.to_string().into_bytes());
        k
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, String};

    #[test]
    fn test_score_accumulation() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, Reputation);
        let client = ReputationClient::new(&env, &contract_id);

        let admin    = Address::generate(&env);
        let reporter = Address::generate(&env);
        let subject  = Address::generate(&env);

        client.initialize(&admin);
        client.add_reporter(&reporter);

        let reason = String::from_str(&env, "completed KYC");
        client.submit_score(&reporter, &subject, &50, &reason);
        client.submit_score(&reporter, &subject, &25, &reason);

        let rec = client.get_reputation(&subject);
        assert_eq!(rec.score, 75);
        assert_eq!(rec.reporter_count, 1);
    }

    #[test]
    fn test_sybil_check() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, Reputation);
        let client = ReputationClient::new(&env, &contract_id);

        let admin     = Address::generate(&env);
        let reporter1 = Address::generate(&env);
        let reporter2 = Address::generate(&env);
        let subject   = Address::generate(&env);

        client.initialize(&admin);
        client.add_reporter(&reporter1);
        client.add_reporter(&reporter2);

        let reason = String::from_str(&env, "activity");
        client.submit_score(&reporter1, &subject, &40, &reason);
        client.submit_score(&reporter2, &subject, &40, &reason);

        assert!(client.passes_sybil_check(&subject, &50, &2));
        assert!(!client.passes_sybil_check(&subject, &50, &3));
    }

    #[test]
    fn test_error_variants() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Reputation);
        let client = ReputationClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        assert_eq!(client.try_initialize(&admin), Err(Ok(ReputationError::AlreadyInitialized)));

        let rando = Address::generate(&env);
        let reason = String::from_str(&env, "scam");
        assert_eq!(
            client.try_submit_score(&rando, &rando, &10, &reason),
            Err(Ok(ReputationError::NotAReporter))
        );
    }
}
