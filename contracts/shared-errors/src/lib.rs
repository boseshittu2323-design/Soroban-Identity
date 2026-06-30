#![no_std]

use soroban_sdk::contracterror;

/// Shared error variants common across all Soroban Identity contracts.
/// Each contract re-exports this type so cross-contract error handling is consistent.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum SharedError {
    AlreadyInitialized = 100,
    NotInitialized = 101,
    Unauthorized = 102,
}
