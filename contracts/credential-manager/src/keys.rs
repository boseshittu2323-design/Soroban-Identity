use soroban_sdk::{symbol_short, Address, BytesN, Symbol};

pub const ADMIN: Symbol = symbol_short!("ADMIN");
pub const ISSUER: Symbol = symbol_short!("ISSUER");
pub const CRED: Symbol = symbol_short!("CRED");
pub const IDSEQ: Symbol = symbol_short!("IDSEQ");
pub const SUB: Symbol = symbol_short!("sub");

pub fn cred_key(id: &BytesN<32>) -> (Symbol, BytesN<32>) {
    (CRED, id.clone())
}

pub fn subject_key(subject: &Address) -> (Symbol, Address) {
    (SUB, subject.clone())
}
