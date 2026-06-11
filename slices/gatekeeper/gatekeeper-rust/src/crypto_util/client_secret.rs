//! Confidential-client secret hashing.
//!
//! Client secrets are stored as argon2id PHC strings (`$argon2id$v=19$...`),
//! which bundle the algorithm, parameters, and a per-secret random salt into a
//! single self-describing field. Hashing uses [`Argon2::default`] (argon2id,
//! OWASP-recommended defaults). Verification re-derives the hash with the
//! parameters encoded in the stored string and compares in constant time, so
//! callers do not perform their own comparison.

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;

/// Failure modes for client-secret hashing and verification.
#[derive(Debug, thiserror::Error)]
pub enum ClientSecretError {
    /// Hashing the plaintext secret failed (e.g. a parameter/encoding error).
    #[error("failed to hash client secret: {0}")]
    Hash(argon2::password_hash::Error),
    /// The stored value was not a parseable PHC hash string.
    #[error("stored client-secret hash is malformed: {0}")]
    MalformedHash(argon2::password_hash::Error),
}

/// Hash a plaintext client secret into an argon2id PHC string suitable for
/// storage in `clients.secret_hash`. Each call uses a fresh random salt, so the
/// same secret hashes to a different string every time.
pub fn hash_client_secret(secret: &str) -> Result<String, ClientSecretError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(secret.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(ClientSecretError::Hash)
}

/// Verify a presented plaintext secret against a stored argon2id PHC string.
///
/// Returns `Ok(true)` on a match, `Ok(false)` on a mismatch, and `Err` only if
/// the stored value cannot be parsed as a PHC hash. The comparison is
/// constant-time internally.
pub fn verify_client_secret(
    presented: &str,
    stored_phc: &str,
) -> Result<bool, ClientSecretError> {
    let parsed = PasswordHash::new(stored_phc).map_err(ClientSecretError::MalformedHash)?;
    match Argon2::default().verify_password(presented.as_bytes(), &parsed) {
        Ok(()) => Ok(true),
        Err(argon2::password_hash::Error::Password) => Ok(false),
        Err(e) => Err(ClientSecretError::MalformedHash(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_then_verify_roundtrips() {
        let phc = hash_client_secret("correct horse battery staple").unwrap();
        // A PHC string self-describes as argon2id.
        assert!(phc.starts_with("$argon2id$"), "unexpected PHC prefix: {phc}");
        assert!(verify_client_secret("correct horse battery staple", &phc).unwrap());
    }

    #[test]
    fn verify_rejects_wrong_secret() {
        let phc = hash_client_secret("the-real-secret").unwrap();
        assert!(!verify_client_secret("not-the-secret", &phc).unwrap());
    }

    #[test]
    fn same_secret_hashes_differently_each_time() {
        let a = hash_client_secret("repeated-secret").unwrap();
        let b = hash_client_secret("repeated-secret").unwrap();
        assert_ne!(a, b, "random salt should make each hash unique");
        // ...but both still verify.
        assert!(verify_client_secret("repeated-secret", &a).unwrap());
        assert!(verify_client_secret("repeated-secret", &b).unwrap());
    }

    #[test]
    fn malformed_stored_hash_is_an_error() {
        assert!(verify_client_secret("anything", "not-a-phc-string").is_err());
    }
}
