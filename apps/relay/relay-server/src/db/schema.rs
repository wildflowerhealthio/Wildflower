//! Diesel table definitions, mirroring the STRICT tables the migrations
//! create:
//!
//! - `tunnels` (`0001_tunnels`): one row per tunnel created through the
//!   admin API, addressed by its `name`. A row is loaded into a
//!   [`super::tunnels::TunnelRow`] and folded into the domain
//!   [`crate::domain::StoredTunnel`].
//! - `claim_codes` (`0002_claim_codes`): a tunnel's outstanding claim code,
//!   at most one per tunnel, addressed by the tunnel's `tunnel_name`; the
//!   code's SHA-256 is unique across rows. Deleting the tunnel deletes its
//!   row (`ON DELETE CASCADE`).
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
    claim_codes (tunnel_name) {
        tunnel_name -> Text,
        code_hash -> Binary,
        expires_at -> BigInt,
    }
}

diesel::joinable!(claim_codes -> tunnels (tunnel_name));
diesel::allow_tables_to_appear_in_same_query!(claim_codes, tunnels);
