//! `AppUrl` — a validated app-launch URL template, parsed once from the
//! stored/wire string and rendered back to a concrete redirect target at launch.
//!
//! The one accepted shape is an absolute `http://` or `https://` URL: an app is
//! served from its own origin, never the host's. It may embed `{origin}` /
//! `{launch}` placeholders (e.g. a SMART-on-FHIR `iss=` query value) that
//! [`AppUrl::to_url_with_params`] substitutes at launch. Everything else is
//! rejected when parsing (via the standard [`FromStr`] trait), so a bad URL never
//! lands in a row and the open-redirect / XSS surface a launch-time check alone
//! can't cover stays closed: `javascript:`, `data:`, `file:`, a protocol-relative
//! `//authority` (open redirect), and a `/path` or leading `{origin}` that would
//! resolve against the host's own origin.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// A validated app-launch URL template: an absolute `http://` or `https://` URL
/// the launch flow passes through verbatim after any `{origin}` / `{launch}`
/// substitution. See the module docs for what is rejected. Serialized (wire +
/// SQLite) as its string via [`fmt::Display`]; parsed back via [`str::parse`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "String", try_from = "String")]
pub struct AppUrl(String);

/// Substitution inputs for [`AppUrl::to_url_with_params`].
pub struct LaunchParams<'a> {
    /// The origin substituted for `{origin}` — the server's public origin, e.g.
    /// `https://ruth.relay.wildflowerhealth.io`.
    pub origin: &'a str,
    /// The SMART `launch` value substituted for `{launch}` — a fresh launch
    /// context for a SMART app, empty for a non-SMART one.
    pub launch: &'a str,
}

/// The error returned when a string isn't a valid [`AppUrl`] (see
/// [`AppUrl`]'s [`FromStr`] impl). Reused as the `message` of the wire-level 400.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppUrlError {
    /// Empty string.
    Empty,
    /// Not an absolute `http://` / `https://` URL.
    Invalid,
}

impl fmt::Display for AppUrlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppUrlError::Empty => f.write_str("url must not be empty"),
            AppUrlError::Invalid => f.write_str("url must be an absolute http:// or https:// URL"),
        }
    }
}

impl std::error::Error for AppUrlError {}

impl FromStr for AppUrl {
    type Err = AppUrlError;

    /// Parse a stored/wire URL string into an [`AppUrl`], rejecting empty and
    /// unsafe shapes. This is the single write-side gate: a value that doesn't
    /// parse never lands in a row, and a row that fails to parse on read
    /// surfaces as a typed error rather than redirecting somewhere unsafe.
    ///
    /// # Errors
    ///
    /// Returns [`AppUrlError::Empty`] for an empty string and
    /// [`AppUrlError::Invalid`] for anything but an absolute `http://` /
    /// `https://` URL (see the module docs).
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.is_empty() {
            return Err(AppUrlError::Empty);
        }
        if value.starts_with("https://") || value.starts_with("http://") {
            return Ok(AppUrl(value.to_owned()));
        }
        Err(AppUrlError::Invalid)
    }
}

impl AppUrl {
    /// Render the concrete redirect target: substitute `{origin}` / `{launch}`.
    ///
    /// The result is safe by construction: it keeps the `http(s)://` scheme the
    /// template was validated with, so substitution can't produce a
    /// `javascript:` / `data:` target and no launch-time re-validation is needed.
    #[must_use]
    pub fn to_url_with_params(&self, params: &LaunchParams<'_>) -> String {
        self.0
            .replace("{origin}", params.origin)
            .replace("{launch}", params.launch)
    }
}

impl fmt::Display for AppUrl {
    /// The stored/wire string — the template exactly as parsed.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<AppUrl> for String {
    fn from(url: AppUrl) -> Self {
        url.0
    }
}

impl TryFrom<String> for AppUrl {
    type Error = AppUrlError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params<'a>(origin: &'a str, launch: &'a str) -> LaunchParams<'a> {
        LaunchParams { origin, launch }
    }

    #[test]
    fn parses_absolute_http_and_https_urls() {
        for raw in [
            "https://example.com/x",
            // `http://` is an accepted absolute target too (TLS is not required).
            "http://example.com/x",
            "https://example.com/x?iss={origin}/fhir-r4&launch={launch}",
        ] {
            let url: AppUrl = raw.parse().expect("parses");
            assert_eq!(url.to_string(), raw, "{raw} round-trips");
        }
    }

    /// A target resolved against the host's own origin — a `/path` or a leading
    /// `{origin}` — is rejected, as is any `{origin}` prefix that would widen the
    /// authority off-device (`{origin}@evil.com` → `http://<loopback>@evil.com`).
    #[test]
    fn rejects_origin_relative_targets() {
        for bad in [
            "/relative/path",
            "{origin}",
            "{origin}/launch?foo=1",
            "{origin}?x=1",
            "{origin}@evil.com/x",
            "{origin}.evil.com",
        ] {
            assert_eq!(
                bad.parse::<AppUrl>(),
                Err(AppUrlError::Invalid),
                "rejects {bad}"
            );
        }
    }

    #[test]
    fn rejects_empty_and_unsafe_shapes() {
        assert_eq!("".parse::<AppUrl>(), Err(AppUrlError::Empty));
        // protocol-relative authority is an open redirect
        assert_eq!(
            "//evil.example.com/x".parse::<AppUrl>(),
            Err(AppUrlError::Invalid)
        );
        for scheme in [
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
            "ftp://example.com/x",
        ] {
            assert_eq!(
                scheme.parse::<AppUrl>(),
                Err(AppUrlError::Invalid),
                "rejects {scheme}"
            );
        }
    }

    #[test]
    fn substitutes_origin_and_launch_in_place() {
        let url: AppUrl = "https://host/?iss={origin}/fhir-r4&launch={launch}"
            .parse()
            .unwrap();
        assert_eq!(
            url.to_url_with_params(&params("http://127.0.0.1:8080", "NONCE")),
            "https://host/?iss=http://127.0.0.1:8080/fhir-r4&launch=NONCE",
        );
    }
}
