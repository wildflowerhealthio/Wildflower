//! Diesel table definition for `logged_requests`, the request log created by
//! migration `0001_logged_requests`. A row is loaded into a
//! [`super::logged_requests`] row type and folded into the domain
//! [`LoggedRequest`](crate::domain::request_log::LoggedRequest).

diesel::table! {
    logged_requests (id) {
        id -> BigInt,
        received_at -> TimestamptzSqlite,
        client_id -> Nullable<Text>,
        address -> Nullable<Text>,
        served_host -> Nullable<Text>,
        method -> Text,
        path -> Text,
        status -> Integer,
        response_bytes -> Nullable<BigInt>,
        duration_ms -> BigInt,
        refusal -> Nullable<Text>,
    }
}
