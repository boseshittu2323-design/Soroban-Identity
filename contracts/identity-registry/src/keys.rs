use soroban_sdk::{Address, Bytes, Env};

pub const DID_PREFIX: &[u8; 4] = b"did:";

pub fn did_key(env: &Env, controller: &Address) -> Bytes {
    let mut key = Bytes::new(env);
    key.extend_from_array(DID_PREFIX);
    let addr_bytes = controller.to_string().into_bytes();
    key.extend_from_slice(&addr_bytes);
    key
}
