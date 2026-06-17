//! App URL validation. Applied on every write — bundled rows are now
//! editable, so the same filter that rejects a hand-rolled
//! `javascript:alert(1)` URL also catches an admin who tried to point a
//! bundled row at one. The accepted shapes:
//!
//!   * `https://...` — any absolute https URL (off-device targets).
//!   * `/path` (NOT `//`, which would be a protocol-relative authority and
//!     an open redirect) — origin-relative.
//!   * Anything starting with the literal `{origin}` placeholder — the
//!     launch handler substitutes the served origin at request time.
//!
//! Anything else — `http://`, `javascript:`, `data:`, `file:`, etc. — is
//! rejected, closing the open-redirect / XSS surface that a launch-time
//! validator alone can't cover (a bad URL would never land in the row).

/// The error returned by [`validate_app_url`] when a write-side check
/// rejects a URL. Reused as the `error` field of the wire-level 400.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppUrlError {
    /// Empty string.
    Empty,
    /// Shape doesn't match any of the three acceptable forms.
    Invalid,
}

impl std::fmt::Display for AppUrlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppUrlError::Empty => f.write_str("url must not be empty"),
            AppUrlError::Invalid => f.write_str(
                "url must be https://, an origin-relative /path, or start with the {origin} placeholder",
            ),
        }
    }
}

impl std::error::Error for AppUrlError {}

/// Reject an app URL that's empty or doesn't match one of the three shapes.
pub fn validate_app_url(value: &str) -> Result<(), AppUrlError> {
    if value.is_empty() {
        return Err(AppUrlError::Empty);
    }
    if value.starts_with("{origin}") {
        return Ok(());
    }
    if value.starts_with('/') && !value.starts_with("//") {
        return Ok(());
    }
    if value.starts_with("https://") {
        return Ok(());
    }
    Err(AppUrlError::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_origin_relative_and_origin_placeholder() {
        assert!(validate_app_url("https://example.com/x").is_ok());
        assert!(validate_app_url("/relative/path").is_ok());
        assert!(validate_app_url("{origin}/launch?foo=1").is_ok());
    }

    #[test]
    fn rejects_empty_and_unsafe_shapes() {
        assert_eq!(validate_app_url(""), Err(AppUrlError::Empty));
        // protocol-relative authority is an open redirect
        assert_eq!(
            validate_app_url("//evil.example.com/x"),
            Err(AppUrlError::Invalid)
        );
        // plaintext http (no TLS)
        assert_eq!(
            validate_app_url("http://example.com/"),
            Err(AppUrlError::Invalid)
        );
        for scheme in [
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
        ] {
            assert_eq!(
                validate_app_url(scheme),
                Err(AppUrlError::Invalid),
                "rejects {scheme}",
            );
        }
    }
}
