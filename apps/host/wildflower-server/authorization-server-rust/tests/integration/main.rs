//! The authorization server's end-to-end tests: each file drives the real
//! router over a fresh in-memory database and holds the server to one area of
//! its behaviour on the wire. `common` holds the fixtures they share.

mod approval_scopes;
mod authorization_start_limit;
mod bearer_only;
mod browser_pairing;
mod browser_sessions;
mod cache_suppression;
mod client_auth;
mod client_management;
mod common;
mod consent_card;
mod device_code;
mod device_page;
mod grant_flows;
mod oauth_endpoints;
mod request_caller;
mod revocation;
mod same_device_sign_in;
mod scope_gating;
mod session_required;
mod session_shortfall;
mod smoke;
mod token_revocation;
mod wait_page;
