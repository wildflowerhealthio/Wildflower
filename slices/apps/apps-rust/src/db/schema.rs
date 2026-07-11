//! Diesel table definitions for the apps slice, mirroring the STRICT tables the
//! embedded migration creates. Table-per-struct: `cloud_apps` and
//! `self_hosted_apps` are standalone (each carrying every one of its own
//! columns), and `home_screen` owns the cross-kind ordering + enabled flag. The
//! cross-kind `apps_view` is queried via `diesel::sql_query` (a UNION view with
//! NULLable payload columns — see [`super::reads`]), so it has no `table!` here.
//!
//! Column-type notes: `bool` columns are declared `Bool` (stored INTEGER),
//! `port` is `Integer` (mapped to `u16` via [`super::columns::PortColumn`]), and
//! the cloud `url` is `Text` (mapped to [`AppUrl`](crate::domain::AppUrl) via
//! [`super::columns::AppUrlColumn`]).

diesel::table! {
    cloud_apps (id) {
        id -> Text,
        name -> Text,
        subtitle -> Nullable<Text>,
        local_only -> Bool,
        client_id -> Nullable<Text>,
        url -> Text,
        requires_tunnel -> Bool,
    }
}

diesel::table! {
    self_hosted_apps (id) {
        id -> Text,
        name -> Text,
        subtitle -> Nullable<Text>,
        local_only -> Bool,
        client_id -> Nullable<Text>,
        port -> Integer,
        content_folder -> Text,
        subdomain -> Text,
        seeded -> Bool,
        launch_path -> Nullable<Text>,
    }
}

diesel::table! {
    home_screen (app_id) {
        app_id -> Text,
        position -> BigInt,
        enabled -> Bool,
    }
}
