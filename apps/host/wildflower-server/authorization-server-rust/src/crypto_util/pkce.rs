//! PKCE (RFC 7636): the `code_verifier` length rule, the S256
//! `code_challenge` shape, and deriving a challenge from a verifier. S256 is
//! the only method the server accepts.

use crate::crypto_util::sha256;

/// The shortest `code_verifier` RFC 7636 §4.1 allows: 43 characters drawn
/// from the unreserved set.
const CODE_VERIFIER_MIN_LEN: usize = 43;
/// The longest `code_verifier` RFC 7636 §4.1 allows: 128 characters.
const CODE_VERIFIER_MAX_LEN: usize = 128;

/// True when `code_verifier` has an RFC 7636 §4.1-legal length (43–128 chars).
/// Counts Unicode scalar values, matching how the verifier arrives on the wire.
#[must_use]
pub fn is_valid_code_verifier_length(code_verifier: &str) -> bool {
    (CODE_VERIFIER_MIN_LEN..=CODE_VERIFIER_MAX_LEN).contains(&code_verifier.chars().count())
}

/// A `code_challenge` for the S256 method is the base64url SHA-256 digest:
/// exactly 43 unpadded base64url characters (RFC 7636 §4.2).
const S256_CODE_CHALLENGE_LEN: usize = 43;

/// True when `s` is a syntactically valid S256 `code_challenge`: exactly 43
/// base64url characters (`[A-Za-z0-9-_]`, no padding) per RFC 7636 §4.2/§4.3.
/// RFC 7636's ABNF also lists `.` and `~`, but the SHA-256/base64url form the
/// only supported method (S256) produces never contains them.
#[must_use]
pub fn is_valid_s256_code_challenge(s: &str) -> bool {
    s.len() == S256_CODE_CHALLENGE_LEN
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Derive the PKCE S256 `code_challenge` from a `code_verifier` (RFC 7636 §4.2).
#[must_use]
pub fn compute_code_challenge(code_verifier: &str) -> String {
    sha256::as_base64_no_pad(code_verifier.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The verifier from RFC 7636 Appendix B derives the challenge the RFC
    /// gives, and that challenge passes the shape check.
    #[test]
    fn rfc7636_appendix_b_example() {
        // RFC 7636 Appendix B
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(compute_code_challenge(verifier), expected);
        assert!(is_valid_s256_code_challenge(expected));
    }

    /// A challenge one character short or long, padded with `=`, or ending in
    /// a `.` is refused.
    #[test]
    fn s256_challenge_shape_is_43_base64url_chars() {
        assert!(!is_valid_s256_code_challenge(&"a".repeat(42)));
        assert!(!is_valid_s256_code_challenge(&"a".repeat(44)));
        assert!(!is_valid_s256_code_challenge(&format!(
            "{}=",
            "a".repeat(42)
        )));
        assert!(!is_valid_s256_code_challenge(&format!(
            "{}.",
            "a".repeat(42)
        )));
    }
}
