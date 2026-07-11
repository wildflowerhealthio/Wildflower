//! Diesel table definition for `tunnel_settings`, mirroring the STRICT table
//! created by migration `0001_initial_schema`. The singleton settings row
//! (`id = 'tunnel'`) is addressed by `id`; `revision` is the optimistic-
//! concurrency token, `requested_running` the on/off intent, and the nullable
//! `relay_*` / `service_name` columns the write-only relay connection.
//!
//! `revision` is `BigInt` (i64) and `requested_running` is `Bool` — both stored
//! as SQLite `INTEGER`, which those diesel SQL types map to. The row is loaded
//! into a [`super::tunnel_settings::TunnelSettingsRow`] and folded into the
//! domain [`crate::domain::TunnelSettings`] (empty relay columns collapse to
//! "unconfigured").

diesel::table! {
    tunnel_settings (id) {
        id -> Text,
        revision -> BigInt,
        public_host -> Nullable<Text>,
        requested_running -> Bool,
        relay_remote_addr -> Nullable<Text>,
        relay_token -> Nullable<Text>,
        relay_public_key -> Nullable<Text>,
        service_name -> Nullable<Text>,
    }
}
