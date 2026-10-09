//! Diesel table definition for `tunnels`, mirroring the STRICT table created
//! by migration `0001_tunnels`: one row per tunnel created through the admin
//! API, addressed by its `name`. `created_at` is `BigInt` (i64, Unix epoch
//! seconds), stored as SQLite `INTEGER`. A row is loaded into a
//! [`super::tunnels::TunnelRow`] and folded into the domain
//! [`crate::domain::StoredTunnel`].

diesel::table! {
    tunnels (name) {
        name -> Text,
        email -> Text,
        token -> Text,
        created_at -> BigInt,
    }
}
