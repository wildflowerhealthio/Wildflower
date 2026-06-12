//! High-entropy opaque token generation for OAuth artifacts that must be
//! computationally infeasible to guess — authorization codes (RFC 6749
//! §10.10) and device codes (RFC 8628 §5.1). 32 CSPRNG bytes give 256 bits
//! of entropy, comfortably exceeding the §10.10 ≤ 2^-128 guess-probability
//! target, and base64url (no padding) keeps the result URL-safe.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Number of CSPRNG bytes backing each generated token. 32 bytes = 256 bits
/// of entropy.
const TOKEN_BYTES: usize = 32;

/// Generate an opaque, URL-safe authorization/device code from 32 CSPRNG
/// bytes, base64url-encoded without padding. Suitable for OAuth
/// `authorization_code` and `device_code` values where unguessability is the
/// only requirement (the value carries no structure).
pub(crate) fn generate_authorization_code() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Generate an opaque refresh token — same construction as
/// [`generate_authorization_code`]; the two differ only in where they're
/// stored and how long they live (RFC 6749 §10.4 wants the same
/// unguessability bar).
pub(crate) fn generate_refresh_token() -> String {
    generate_authorization_code()
}

/// SHA-256 digest of an opaque token, base64url-encoded without padding —
/// the at-rest form for refresh tokens, so a stolen database never yields a
/// presentable credential. Public so integration tests can plant rows with
/// known plaintexts.
pub fn token_storage_hash(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_32_bytes_as_unpadded_base64url() {
        let code = generate_authorization_code();
        // 32 bytes -> 43 base64url chars, no padding.
        assert_eq!(code.len(), 43);
        assert!(!code.contains('='));
        assert!(code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        // Round-trips back to exactly 32 bytes.
        let decoded = URL_SAFE_NO_PAD.decode(&code).expect("valid base64url");
        assert_eq!(decoded.len(), TOKEN_BYTES);
    }

    #[test]
    fn successive_codes_differ() {
        let a = generate_authorization_code();
        let b = generate_authorization_code();
        assert_ne!(a, b);
    }
}
