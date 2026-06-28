use soroban_sdk::{symbol_short, Address, Symbol};

pub const REC: Symbol = symbol_short!("rec");
pub const HIST: Symbol = symbol_short!("h");

pub fn record_key(subject: &Address) -> (Symbol, Address) {
    (REC, subject.clone())
}

pub fn history_key(subject: &Address, reporter: &Address) -> (Symbol, Address, Address) {
    (HIST, subject.clone(), reporter.clone())
}
