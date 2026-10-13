//! base64 encoding/decoding for the gatekeeper, in the two RFC 4648 flavours
//! the crate needs — kept in one place so the alphabet/padding choice is never
//! made ad hoc at a call site.
//!
//! The method names spell out the exact wire format so the two variants are not
//! mistaken for one another:
//!
//!   * [`url_safe_no_pad_encode`] / [`url_safe_no_pad_decode`] — RFC 4648 §5,
//!     the URL- and filename-safe alphabet (`-`/`_`) without `=` padding. The
//!     "web style": opaque tokens, SHA-256 hashes, and JWT/JWK key material.
//!   * [`standard_encode`] / [`standard_decode`] — RFC 4648 §4, the standard
//!     alphabet (`+`/`/`) with `=` padding. Used to read (and, in tests, write)
//!     the HTTP Basic `Authorization` header (RFC 6749 §2.3.1,
//!     `client_secret_basic`).
//!
//! These are the only base64 encode/decode entry points in the crate, and the
//! sole place a `base64` engine is constructed. The decoders' error type is
//! re-exported here as [`DecodeError`] so other modules name it through this
//! module instead of reaching for the `base64` crate's path themselves.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;

pub use base64::DecodeError;

/// Encode bytes as URL-safe base64 (RFC 4648 §5) without padding.
#[must_use]
pub fn url_safe_no_pad_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decode a URL-safe base64 (RFC 4648 §5, no padding) string back to bytes.
///
/// # Errors
///
/// Returns a [`DecodeError`] if `s` is not valid unpadded base64url.
pub fn url_safe_no_pad_decode(s: &str) -> Result<Vec<u8>, DecodeError> {
    URL_SAFE_NO_PAD.decode(s)
}

/// Encode bytes as standard base64 (RFC 4648 §4) with `=` padding.
#[must_use]
pub fn standard_encode(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

/// Decode a standard base64 (RFC 4648 §4, padded) string back to bytes.
///
/// # Errors
///
/// Returns a [`DecodeError`] if `s` is not valid padded standard base64.
pub fn standard_decode(s: &str) -> Result<Vec<u8>, DecodeError> {
    STANDARD.decode(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_pads_while_url_safe_does_not() {
        // A single input byte leaves the final base64 quantum incomplete: the
        // standard form pads it with `=`, the url-safe no-pad form omits it.
        assert_eq!(standard_encode(&[0x00]), "AA==");
        assert_eq!(url_safe_no_pad_encode(&[0x00]), "AA");
    }

    #[test]
    fn alphabets_differ_on_the_62nd_and_63rd_symbols() {
        // 0xFB,0xF0 select base64 indices 62 and 63 — the only two symbols the
        // alphabets disagree on: standard emits `+`/`/`, url-safe emits `-`/`_`.
        let bytes = [0xfb, 0xf0];
        assert_eq!(standard_encode(&bytes), "+/A=");
        assert_eq!(url_safe_no_pad_encode(&bytes), "-_A");
    }

    #[test]
    fn each_variant_round_trips() {
        let bytes: &[u8] = &[0x00, 0x10, 0x83, 0xfb, 0xf0, 0xff];
        assert_eq!(standard_decode(&standard_encode(bytes)).unwrap(), bytes);
        assert_eq!(
            url_safe_no_pad_decode(&url_safe_no_pad_encode(bytes)).unwrap(),
            bytes
        );
    }
}
