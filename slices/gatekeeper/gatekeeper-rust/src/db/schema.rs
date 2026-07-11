//! Diesel table definitions mirroring migration `0001_gatekeeper_schema`. JSON
//! list columns are declared `Text` (the STRICT columns store compact JSON;
//! [`super::columns`]' newtypes convert at the bind/read boundary), enums-as-
//! text likewise, and timestamps are `TimestamptzSqlite` so diesel's chrono
//! mapping reads/writes `DateTime<Utc>` directly.
//!
//! `grants` is a VIEW (`UNION ALL` over the two concrete grant tables), which
//! diesel's `table!` queries like any table — SELECT-only; writes go to the
//! concrete tables.

diesel::table! {
    clients (client_id) {
        client_id -> Text,
        name -> Text,
        kind -> Text,
        redirect_uris -> Text,
        allowed_scopes -> Text,
        allowed_grant_types -> Text,
        secret_hash -> Nullable<Text>,
        registered_at -> TimestamptzSqlite,
        disabled_at -> Nullable<TimestamptzSqlite>,
    }
}

diesel::table! {
    signing_keys (kid) {
        kid -> Text,
        kty -> Text,
        alg -> Text,
        values_json -> Text,
        is_active -> Bool,
    }
}

diesel::table! {
    authorization_requests (id) {
        id -> Text,
        grant_type -> Text,
        client_id -> Text,
        requested_scopes -> Text,
        code_challenge -> Nullable<Text>,
        code_challenge_method -> Nullable<Text>,
        redirect_uri -> Nullable<Text>,
        client_state -> Nullable<Text>,
        user_code -> Nullable<Text>,
        pre_approved_scopes -> Text,
        requested_at -> TimestamptzSqlite,
        expires_at -> TimestamptzSqlite,
        last_polled_at -> Nullable<TimestamptzSqlite>,
        status -> Text,
        granted_scopes -> Nullable<Text>,
        patient -> Nullable<Text>,
        device_name -> Nullable<Text>,
    }
}

diesel::table! {
    authorization_codes (code) {
        code -> Text,
        request_id -> Text,
        client_id -> Text,
        redirect_uri -> Text,
        code_challenge -> Text,
        granted_scopes -> Text,
        patient -> Nullable<Text>,
        issued_at -> TimestamptzSqlite,
        expires_at -> TimestamptzSqlite,
    }
}

diesel::table! {
    authorization_code_grants (id) {
        id -> Text,
        client_id -> Text,
        scopes -> Text,
        granted_at -> TimestamptzSqlite,
        last_used_at -> Nullable<TimestamptzSqlite>,
        patient -> Nullable<Text>,
        redirect_uri -> Text,
    }
}

diesel::table! {
    device_grants (id) {
        id -> Text,
        client_id -> Text,
        scopes -> Text,
        granted_at -> TimestamptzSqlite,
        last_used_at -> Nullable<TimestamptzSqlite>,
        patient -> Nullable<Text>,
        device_name -> Text,
    }
}

diesel::table! {
    /// The cross-kind `grants` VIEW: shared columns + the kind tag + each
    /// kind's payload column, NULLable for the other kind. SELECT-only.
    grants (id) {
        id -> Text,
        client_id -> Text,
        scopes -> Text,
        granted_at -> TimestamptzSqlite,
        last_used_at -> Nullable<TimestamptzSqlite>,
        patient -> Nullable<Text>,
        grant_type -> Text,
        redirect_uri -> Nullable<Text>,
        device_name -> Nullable<Text>,
    }
}

diesel::table! {
    refresh_token_families (family_id) {
        family_id -> Text,
        client_id -> Text,
        scopes -> Text,
        patient -> Nullable<Text>,
        issued_at -> TimestamptzSqlite,
        expires_at -> TimestamptzSqlite,
        authorization_code_hash -> Nullable<Text>,
        grant_id -> Nullable<Text>,
    }
}

diesel::table! {
    refresh_tokens (token_hash) {
        token_hash -> Text,
        family_id -> Text,
        issued_at -> TimestamptzSqlite,
        consumed_at -> Nullable<TimestamptzSqlite>,
    }
}

diesel::joinable!(refresh_tokens -> refresh_token_families (family_id));
diesel::allow_tables_to_appear_in_same_query!(refresh_tokens, refresh_token_families);
