//! Pure cryptographic mechanisms with no product knowledge — PKCE,
//! RSA/JWK key material, and device-flow user codes. This module depends
//! on nothing else in the crate; domain policy (token claims, mint/verify
//! rules) lives in [`crate::domain::token`]. Constant-time comparison is
//! delegated to the `subtle` crate at call sites.

pub mod base64;
pub mod client_secret;
pub mod oauth_user_code;
pub mod pkce;
pub mod public_jwk;
pub mod random_token;
pub(crate) mod sha256;
