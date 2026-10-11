//! Diesel table definitions, mirroring the STRICT tables the migrations
//! create:
//!
//! - `tunnels` (`0001_tunnels`): one row per tunnel created through the
//!   admin API, addressed by its `name`. A row is loaded into a
//!   [`super::tunnels::TunnelRow`] and folded into the domain
//!   [`crate::domain::StoredTunnel`].
//! - `claim_codes` (`0002_claim_codes`): one row per unredeemed claim code,
//!   addressed by the code's SHA-256, for the tunnel it names. Deleting the
//!   tunnel deletes its rows (`ON DELETE CASCADE`).
//!
//! `created_at` and `expires_at` are `BigInt` (i64, Unix epoch seconds),
//! stored as SQLite `INTEGER`.

diesel::table! {
    tunnels (name) {
        name -> Text,
        email -> Text,
        token -> Text,
        created_at -> BigInt,
    }
}

diesel::table! {
    claim_codes (code_hash) {
        code_hash -> Binary,
        tunnel_name -> Text,
        expires_at -> BigInt,
    }
}

diesel::joinable!(claim_codes -> tunnels (tunnel_name));
diesel::allow_tables_to_appear_in_same_query!(claim_codes, tunnels);
