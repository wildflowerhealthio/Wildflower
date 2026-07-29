//! The gatekeeper's HTTP routes, one module per URL segment. The folder tree
//! mirrors the URL tree: single-route paths are a flat file named by their
//! operation (`well_known_jwks`, `logout`, `revocations`), multi-route segments
//! are a folder carrying its own `mod.rs` route table (`oauth`,
//! `oauth_consents`, `devices`, `grants`).

pub mod devices;
pub mod grants;
pub mod logout;
pub mod oauth;
pub mod oauth_consents;
pub mod revocations;
pub mod session;
pub mod well_known_jwks;
