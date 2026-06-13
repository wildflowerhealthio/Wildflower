//! URL-safe base64 (RFC 4648 §5) without padding — the single encoding used
//! across the gatekeeper for opaque tokens, hashes, and JWK key material.
//! `base64url::encode` / `base64url::decode` are the only base64 entry points;
//! no other module should reach for the `base64` crate directly.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

/// Encode bytes as URL-safe base64 without padding.
#[must_use]
pub(crate) fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decode a URL-safe base64 (no padding) string back to bytes.
///
/// # Errors
///
/// Returns a [`base64::DecodeError`] if `s` is not valid unpadded base64url.
pub(crate) fn decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    URL_SAFE_NO_PAD.decode(s)
}
