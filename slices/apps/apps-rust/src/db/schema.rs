//! Diesel table definitions for the apps slice, mirroring the STRICT tables the
//! embedded migration creates. Class-table-inheritance: one authoritative
//! `app_registry` parent (the global id space, the shared catalogue fields, and
//! the homescreen placement) with three symmetric per-kind child tables
//! (`system_apps` / `cloud_apps` / `self_hosted_apps`), each keyed `id … REFERENCES
//! app_registry(id) ON DELETE CASCADE`. The `kind` column names which child holds
//! a registration's payload.
//!
//! Column-type notes: `bool` columns are declared `Bool` (stored INTEGER),
//! `kind` is `Text` (mapped to [`AppKind`](crate::domain::AppKind) via
//! [`super::columns::AppKindColumn`]), `port` is `Integer` (mapped to `u16` via
//! [`super::columns::PortColumn`]), and the cloud / system `url` is `Text` (mapped
//! to [`AppUrl`](crate::domain::AppUrl) via [`super::columns::AppUrlColumn`]).

diesel::table! {
    app_registry (id) {
        id -> Text,
        kind -> Text,
        position -> BigInt,
        enabled -> Bool,
        name -> Text,
        subtitle -> Nullable<Text>,
        local_only -> Bool,
        client_id -> Nullable<Text>,
        requires_tunnel -> Bool,
    }
}

diesel::table! {
    system_apps (id) {
        id -> Text,
        url -> Text,
    }
}

diesel::table! {
    cloud_apps (id) {
        id -> Text,
        url -> Text,
    }
}

diesel::table! {
    self_hosted_apps (id) {
        id -> Text,
        port -> Integer,
        content_folder -> Text,
        subdomain -> Text,
        seeded -> Bool,
        launch_path -> Nullable<Text>,
    }
}

// Each child's PK is a FK into the parent registry, so a payload row can be joined
// to its registration. The joins are declared explicitly (each child `id` →
// `app_registry.id`) so `find_app_on` / the host-listener read can inner-join
// child ⋈ parent.
diesel::joinable!(system_apps -> app_registry (id));
diesel::joinable!(cloud_apps -> app_registry (id));
diesel::joinable!(self_hosted_apps -> app_registry (id));
diesel::allow_tables_to_appear_in_same_query!(
    app_registry,
    system_apps,
    cloud_apps,
    self_hosted_apps,
);
