//! Pure cryptographic mechanisms with no product knowledge — PKCE,
//! constant-time comparison, RSA/JWK key material, and device-flow user
//! codes. This module depends on nothing else in the crate; domain
//! policy (token claims, mint/verify rules) lives in
//! [`crate::domain::token`].

pub mod pkce;
pub mod signing_key;
pub mod timing_safe;
pub mod user_code;
