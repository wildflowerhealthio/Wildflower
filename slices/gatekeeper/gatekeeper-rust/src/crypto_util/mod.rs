//! Pure cryptographic mechanisms with no product knowledge — PKCE,
//! RSA/JWK key material, and device-flow user codes. This module depends
//! on nothing else in the crate; domain policy (token claims, mint/verify
//! rules) lives in [`crate::domain::token`]. Constant-time comparison is
//! delegated to the `subtle` crate at call sites.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};

pub mod client_secret;
pub mod oauth_user_code;
pub mod pkce;
pub mod public_jwk;
pub mod random_token;

/// URL-safe base64 (RFC 4648 §5) without padding — the single encoding used
/// across the gatekeeper for opaque tokens and JWK key material.
#[must_use]
pub(crate) fn base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// SHA-256 of `input`, base64url-encoded without padding — the at-rest hash
/// form for high-entropy secrets (refresh tokens) and the PKCE S256 challenge.
#[must_use]
pub(crate) fn sha256_base64url(input: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    base64url(&hasher.finalize())
}
