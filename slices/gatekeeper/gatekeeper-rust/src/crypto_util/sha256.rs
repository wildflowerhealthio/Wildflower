//! SHA-256 helpers. `as_base64url` is the at-rest hash form for high-entropy
//! secrets (refresh tokens) and the PKCE S256 challenge — the digest is never
//! reversible, so a leaked database yields no presentable credential.

use sha2::{Digest, Sha256};

use crate::crypto_util::base64url;

/// SHA-256 of `input`, base64url-encoded without padding.
#[must_use]
pub(crate) fn as_base64url(input: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    base64url::encode(&hasher.finalize())
}
