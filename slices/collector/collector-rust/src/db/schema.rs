//! Diesel table definition for `collector_remotes`, mirroring the STRICT table
//! created by migration `0001_initial_schema`. `config` is declared `Text`
//! because that is what the STRICT column stores: JSON TEXT, opaque to Rust
//! (see [`crate::domain::Remote::config`]). The
//! [`super::json_text::JsonText`] newtype converts it to/from
//! `serde_json::Value` at the diesel bind/read boundary.

diesel::table! {
    collector_remotes (id) {
        id -> Text,
        name -> Text,
        tag -> Text,
        config -> Text,
        added_at -> Text,
    }
}
