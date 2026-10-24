//! Diesel table definitions, mirroring the STRICT tables the migrations
//! create:
//!
//! - `tunnels` (`0001_tunnels`): one row per tunnel created through the
//!   admin API, addressed by its `name`. A row is loaded into a
//!   [`super::tunnels::TunnelRow`] and folded into the domain
//!   [`crate::domain::StoredTunnel`].
//! - `claim_codes` (`0002_claim_codes`, rebuilt by `0004_open_claim_codes`):
//!   the outstanding claim codes, addressed by the code's SHA-256. A row's
//!   `tunnel_name` is the tunnel it redeems for, unique across rows so a
//!   tunnel has at most one code, or `NULL` for a code that names no tunnel.
//!   Deleting the tunnel deletes its row (`ON DELETE CASCADE`).
//! - `connection_totals` (`0003_connection_totals`): how many connections
//!   had an outcome in a UTC hour, addressed by the `hour` and the
//!   `outcome`'s name. No identifiers.
//!
//! `created_at`, `expires_at` and `hour` are `BigInt` (i64, Unix epoch
//! seconds), stored as SQLite `INTEGER`, as is `count`.

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
        tunnel_name -> Nullable<Text>,
        expires_at -> BigInt,
    }
}

diesel::table! {
    connection_totals (hour, outcome) {
        hour -> BigInt,
        outcome -> Text,
        count -> BigInt,
    }
}

diesel::joinable!(claim_codes -> tunnels (tunnel_name));
diesel::allow_tables_to_appear_in_same_query!(claim_codes, tunnels);
