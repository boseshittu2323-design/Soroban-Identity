use soroban_sdk::{symbol_short, Address, Env, Vec};
use crate::keys::{ADMIN, ISSUER};

pub fn initialize(env: &Env, admin: Address) {
    if env.storage().instance().has(&ADMIN) {
        panic!("already initialized");
    }
    env.storage().instance().set(&ADMIN, &admin);
}

pub fn require_admin(env: &Env) {
    let admin: Address = env.storage().instance().get(&ADMIN).expect("not initialized");
    admin.require_auth();
}

pub fn get_issuers(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&ISSUER)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn require_issuer(env: &Env, issuer: &Address) {
    if !get_issuers(env).contains(issuer) {
        panic!("not a registered issuer");
    }
}

pub fn add_issuer(env: &Env, issuer: Address) {
    require_admin(env);
    let mut issuers = get_issuers(env);
    if !issuers.contains(&issuer) {
        issuers.push_back(issuer.clone());
        env.storage().instance().set(&ISSUER, &issuers);
        env.events().publish((ISSUER, symbol_short!("added")), issuer);
    }
}

pub fn remove_issuer(env: &Env, issuer: Address) {
    require_admin(env);
    let issuers = get_issuers(env);
    let mut updated = Vec::new(env);
    for i in issuers.iter() {
        if i != issuer {
            updated.push_back(i);
        }
    }
    env.storage().instance().set(&ISSUER, &updated);
}
