use soroban_sdk::{symbol_short, Address, BytesN, Env, Symbol};
use crate::types::Credential;
use crate::keys::{CRED, cred_key};

pub fn revoke_credential(env: &Env, issuer: Address, credential_id: BytesN<32>) {
    issuer.require_auth();

    let key = cred_key(&credential_id);
    let mut cred: Credential = env
        .storage()
        .persistent()
        .get(&key)
        .expect("credential not found");

    if cred.issuer != issuer {
        panic!("only the issuer can revoke");
    }

    cred.revoked = true;
    env.storage().persistent().set(&key, &cred);
    env.events().publish((CRED, symbol_short!("revoked")), credential_id);
}

pub fn verify_credential(env: &Env, credential_id: BytesN<32>) -> bool {
    let key = cred_key(&credential_id);
    match env
        .storage()
        .persistent()
        .get::<(Symbol, BytesN<32>), Credential>(&key)
    {
        None => false,
        Some(cred) => {
            if cred.revoked {
                return false;
            }
            if cred.expires_at > 0 && env.ledger().timestamp() > cred.expires_at {
                return false;
            }
            true
        }
    }
}
