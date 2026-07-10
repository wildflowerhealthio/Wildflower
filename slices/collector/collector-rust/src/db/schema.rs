//! Diesel table definition for `collector_remotes`, mirroring the STRICT table
//! created by migration `0001_initial_schema`. `config` is JSON TEXT (opaque to
//! Rust — see [`crate::domain::Remote::config`]); the row struct in
//! [`super::remotes_store`] converts it to/from `serde_json::Value`.

diesel::table! {
    collector_remotes (id) {
        id -> Text,
        name -> Text,
        tag -> Text,
        config -> Text,
        added_at -> Text,
    }
}
