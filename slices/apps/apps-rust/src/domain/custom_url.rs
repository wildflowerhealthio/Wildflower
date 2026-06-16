//! Custom-app URL validation. Mirrors the TS `CustomAppUrlSchema` filter:
//! the URL must be `https://`, an origin-relative `/path` (NOT `//`, which
//! would be a protocol-relative authority), or a template starting with the
//! literal `{origin}` placeholder. Anything else — `http://`, `javascript:`,
//! `data:`, `file:`, etc. — is rejected, closing the open-redirect / XSS
//! surface a launch-time validator alone can't cover (a bad URL would never
//! reach the row).

/// The error returned by [`validate_custom_url`] when a write-side check
/// rejects a URL. Reused as the `error` field of the wire-level 400.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CustomUrlError {
    /// Empty string.
    Empty,
    /// Shape doesn't match any of the three acceptable forms.
    Invalid,
}

impl std::fmt::Display for CustomUrlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CustomUrlError::Empty => f.write_str("url must not be empty"),
            CustomUrlError::Invalid => f.write_str(
                "url must be https://, an origin-relative /path, or start with the {origin} placeholder",
            ),
        }
    }
}

impl std::error::Error for CustomUrlError {}

/// Reject a custom URL that's empty or doesn't match one of the three shapes.
pub fn validate_custom_url(value: &str) -> Result<(), CustomUrlError> {
    if value.is_empty() {
        return Err(CustomUrlError::Empty);
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
    Err(CustomUrlError::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_origin_relative_and_origin_placeholder() {
        assert!(validate_custom_url("https://example.com/x").is_ok());
        assert!(validate_custom_url("/relative/path").is_ok());
        assert!(validate_custom_url("{origin}/launch?foo=1").is_ok());
    }

    #[test]
    fn rejects_empty_and_unsafe_shapes() {
        assert_eq!(validate_custom_url(""), Err(CustomUrlError::Empty));
        // protocol-relative authority is an open redirect
        assert_eq!(
            validate_custom_url("//evil.example.com/x"),
            Err(CustomUrlError::Invalid)
        );
        // plaintext http (no TLS)
        assert_eq!(
            validate_custom_url("http://example.com/"),
            Err(CustomUrlError::Invalid)
        );
        for scheme in [
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
        ] {
            assert_eq!(
                validate_custom_url(scheme),
                Err(CustomUrlError::Invalid),
                "rejects {scheme}",
            );
        }
    }
}
