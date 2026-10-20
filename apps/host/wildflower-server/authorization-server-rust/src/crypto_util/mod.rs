//! Pure cryptographic mechanisms with no product knowledge — PKCE, the
//! [`PublicJwk`](public_jwk::PublicJwk) wire struct, random tokens and their
//! storage hash, client secrets, and device-flow user codes. This module depends
//! on nothing else in the crate; domain policy (token claims, mint/verify
//! rules) lives in [`crate::domain::access_token`]. Constant-time comparison is
//! delegated to the `subtle` crate at call sites.

pub mod base64;
pub mod client_secret;
pub mod oauth_user_code;
pub mod pkce;
pub mod public_jwk;
pub mod random_token;
pub(crate) mod sha256;
