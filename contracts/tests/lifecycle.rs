use credential_manager::{CredentialManager, CredentialManagerClient, CredentialType};
use identity_registry::{IdentityRegistry, IdentityRegistryClient};
use reputation::{Reputation, ReputationClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Bytes, BytesN, Env, Map, String,
};

fn register_clients(
    env: &Env,
) -> (
    IdentityRegistryClient<'_>,
    CredentialManagerClient<'_>,
    ReputationClient<'_>,
) {
    let identity_id = env.register_contract(None, IdentityRegistry);
    let credential_id = env.register_contract(None, CredentialManager);
    let reputation_id = env.register_contract(None, Reputation);

    (
        IdentityRegistryClient::new(env, &identity_id),
        CredentialManagerClient::new(env, &credential_id),
        ReputationClient::new(env, &reputation_id),
    )
}

#[test]
fn did_and_credential_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    let (identity, credentials, reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);

    identity.initialize(&admin);
    credentials.initialize(&admin);
    reputation.initialize(&admin);

    // Create a DID before issuing credentials so the subject has an on-chain identity.
    let metadata = Map::new(&env);
    let did = identity.create_did(&subject, &metadata);
    let mut did_bytes = [0u8; 68];
    did.copy_into_slice(&mut did_bytes);
    assert_eq!(&did_bytes[..12], b"did:stellar:");

    let document = identity.resolve_did(&subject);
    assert!(document.active);
    assert_eq!(document.controller, subject);

    // Issue a KYC credential to the DID controller and verify it is usable.
    credentials.add_issuer(&issuer);
    let claims = Map::new(&env);
    let claims_hash = BytesN::from_array(&env, &[7u8; 32]);
    let signature = Bytes::from_array(&env, &[1u8; 64]);
    let credential_id = credentials.issue_credential(
        &issuer,
        &subject,
        &CredentialType::Kyc,
        &claims,
        &claims_hash,
        &signature,
        &0u64,
    );

    assert!(credentials.verify_credential(&credential_id));
    let credential = credentials.get_credential(&credential_id);
    assert_eq!(credential.subject, subject);
    assert_eq!(credential.issuer, issuer);

    // Revocation must immediately make the same credential fail verification.
    credentials.revoke_credential(&issuer, &credential_id);
    assert!(!credentials.verify_credential(&credential_id));
}

#[test]
fn reputation_lifecycle_and_sybil_gate() {
    let env = Env::default();
    env.mock_all_auths();

    let (_identity, _credentials, reputation) = register_clients(&env);
    let admin = Address::generate(&env);
    let reporter = Address::generate(&env);
    let subject = Address::generate(&env);

    reputation.initialize(&admin);
    reputation.add_reporter(&reporter);

    // A positive score from a trusted reporter should satisfy the sybil gate.
    let reason = String::from_str(&env, "completed onboarding");
    reputation.submit_score(&reporter, &subject, &75, &reason);
    let record = reputation.get_reputation(&subject);
    assert_eq!(record.score, 75);
    assert_eq!(record.reporter_count, 1);
    assert!(reputation.passes_sybil_check(&subject, &50, &1));

    // Advance beyond the per-reporter rate limit, then submit a penalty.
    env.ledger().with_mut(|li| li.sequence_number += 101);
    let penalty = String::from_str(&env, "fraud report");
    reputation.submit_score(&reporter, &subject, &-75, &penalty);

    let record = reputation.get_reputation(&subject);
    assert_eq!(record.score, 0);
    assert!(!reputation.passes_sybil_check(&subject, &50, &1));
}
#[test]
fn contracts_expose_ping_version() {
    let env = Env::default();
    let (identity, credentials, reputation) = register_clients(&env);

    assert_eq!(identity.ping(), 1);
    assert_eq!(credentials.ping(), 1);
    assert_eq!(reputation.ping(), 1);
}
