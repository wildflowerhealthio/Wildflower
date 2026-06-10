//! The gatekeeper's domain vocabulary — pure types and business rules
//! shared by every other layer. Nothing in here knows about axum or SQL;
//! persistence mappings live in [`crate::db`], transport in
//! [`crate::http`].

pub mod authorization_code;
pub mod authorization_request;
pub mod client;
pub mod grant;
pub mod signing_key;
pub mod token;
