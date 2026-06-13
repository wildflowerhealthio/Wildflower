use crate::crypto_util::sha256;

/// RFC 7636 §4.1 bounds on the `code_verifier`: 43–128 characters drawn from
/// the unreserved set.
const CODE_VERIFIER_MIN_LEN: usize = 43;
const CODE_VERIFIER_MAX_LEN: usize = 128;

/// True when `code_verifier` has an RFC 7636 §4.1-legal length (43–128 chars).
/// Counts Unicode scalar values, matching how the verifier arrives on the wire.
#[must_use]
pub fn is_valid_code_verifier_length(code_verifier: &str) -> bool {
    (CODE_VERIFIER_MIN_LEN..=CODE_VERIFIER_MAX_LEN).contains(&code_verifier.chars().count())
}

/// Derive the PKCE S256 `code_challenge` from a `code_verifier` (RFC 7636 §4.2).
#[must_use]
pub fn compute_code_challenge(code_verifier: &str) -> String {
    sha256::as_base64url(code_verifier.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc7636_appendix_b_example() {
        // RFC 7636 Appendix B
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(compute_code_challenge(verifier), expected);
    }
}
