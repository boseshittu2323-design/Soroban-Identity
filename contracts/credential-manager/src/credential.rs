use soroban_sdk::{symbol_short, Address, Bytes, BytesN, Env, Map, String, Vec};
use crate::types::{Credential, CredentialType};
use crate::keys::{CRED, IDSEQ, cred_key, subject_key};
use crate::issuer::require_issuer;

pub fn issue_credential(
    env: &Env,
    issuer: Address,
    subject: Address,
    credential_type: CredentialType,
    claims: Map<String, String>,
    signature: Bytes,
    expires_at: u64,
) -> BytesN<32> {
    issuer.require_auth();
    require_issuer(env, &issuer);

    let now = env.ledger().timestamp();
    let id = generate_id(env, now);

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

    env.storage().persistent().set(&cred_key(&id), &credential);

    let mut subject_creds = fetch_subject_creds(env, &subject);
    subject_creds.push_back(id.clone());
    env.storage().persistent().set(&subject_key(&subject), &subject_creds);

    env.events().publish((CRED, symbol_short!("issued")), (issuer, subject));

    id
}

pub fn get_credential(env: &Env, credential_id: BytesN<32>) -> Credential {
    env.storage()
        .persistent()
        .get(&cred_key(&credential_id))
        .expect("credential not found")
}

pub fn get_subject_credentials(env: &Env, subject: Address) -> Vec<BytesN<32>> {
    fetch_subject_creds(env, &subject)
}

pub fn fetch_subject_creds(env: &Env, subject: &Address) -> Vec<BytesN<32>> {
    env.storage()
        .persistent()
        .get(&subject_key(subject))
        .unwrap_or_else(|| Vec::new(env))
}

fn generate_id(env: &Env, timestamp: u64) -> BytesN<32> {
    let seq: u64 = env.storage().instance().get(&IDSEQ).unwrap_or(0);
    env.storage().instance().set(&IDSEQ, &(seq + 1));

    let mut data = Bytes::new(env);
    data.extend_from_array(&timestamp.to_be_bytes());
    data.extend_from_array(&seq.to_be_bytes());
    env.crypto().sha256(&data).into()
}
