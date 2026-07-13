//! Diesel table definitions for the apps slice, mirroring the STRICT tables the
//! embedded migration creates. One shared `app_registrations` table (the global
//! id space, the shared catalogue fields, and the homescreen placement) plus one
//! per-kind configuration table (`system_app_configurations` /
//! `cloud_app_configurations` / `self_hosted_app_configurations`), each keyed
//! `id … REFERENCES app_registrations(id) ON DELETE CASCADE`. The `kind` column
//! names which configuration table holds a registration's payload.
//!
//! Column-type notes: `bool` columns are declared `Bool` (stored INTEGER),
//! `kind` is `Text` (mapped to [`AppKind`](crate::domain::AppKind) via
//! [`super::columns::AppKindColumn`]), `port` is `Integer` (mapped to `u16` via
//! [`super::columns::PortColumn`]), and the cloud / system `url` is `Text` (mapped
//! to [`AppUrl`](crate::domain::AppUrl) via [`super::columns::AppUrlColumn`]).

diesel::table! {
    app_registrations (id) {
        id -> Text,
        kind -> Text,
        position -> BigInt,
        on_homescreen -> Bool,
        name -> Text,
        subtitle -> Nullable<Text>,
        local_only -> Bool,
        client_id -> Nullable<Text>,
        requires_tunnel -> Bool,
    }
}

diesel::table! {
    system_app_configurations (id) {
        id -> Text,
        url -> Text,
    }
}

diesel::table! {
    cloud_app_configurations (id) {
        id -> Text,
        url -> Text,
    }
}

diesel::table! {
    self_hosted_app_configurations (id) {
        id -> Text,
        port -> Integer,
        content_folder -> Text,
        subdomain -> Text,
        seeded -> Bool,
        launch_path -> Nullable<Text>,
    }
}

// Each configuration's PK is a FK into the registrations table, so a payload row
// can be joined to its registration. The joins are declared explicitly (each
// configuration `id` → `app_registrations.id`) so `find_app_on` / the
// host-listener read can inner-join configuration ⋈ registration.
diesel::joinable!(system_app_configurations -> app_registrations (id));
diesel::joinable!(cloud_app_configurations -> app_registrations (id));
diesel::joinable!(self_hosted_app_configurations -> app_registrations (id));
diesel::allow_tables_to_appear_in_same_query!(
    app_registrations,
    system_app_configurations,
    cloud_app_configurations,
    self_hosted_app_configurations,
);
