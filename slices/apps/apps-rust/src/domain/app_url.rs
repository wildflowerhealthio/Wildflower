//! `AppUrl` — a validated app-launch URL, parsed once from the stored/wire
//! string and rendered back to a concrete redirect target at launch.
//!
//! Two shapes are accepted; everything else is rejected at [`parse_app_url`],
//! so a bad URL never lands in a row and the open-redirect / XSS surface a
//! launch-time check alone can't cover stays closed:
//!
//!   * [`AppUrl::External`] — an absolute `https://` URL (an off-device
//!     target). It may embed `{origin}` / `{launch}` placeholders (e.g. a
//!     SMART-on-FHIR `iss=` query value) that [`AppUrl::to_url_with_params`]
//!     substitutes at launch.
//!   * [`AppUrl::OriginRelative`] — an on-device target resolved against the
//!     served origin. It carries everything that follows the origin: a leading
//!     `/path`, `?query`, `#fragment`, or nothing (the bare origin). Both a
//!     plain `/path` and the explicit `{origin}…` placeholder form parse to
//!     this; its canonical string re-emits the `{origin}` prefix so a
//!     query/fragment-only or bare-origin target round-trips back through
//!     [`parse_app_url`].
//!
//! Rejected on parse: `http://` (no TLS), `javascript:`, `data:`, `file:`, a
//! protocol-relative `//authority` (open redirect), and an `{origin}` followed
//! by anything other than a path/query/fragment boundary — so
//! `{origin}@evil.com` / `{origin}.evil.com` can't widen the authority
//! off-device.

use std::fmt;

use serde::{Deserialize, Serialize};

/// A validated app-launch URL. See the module docs for the accepted shapes and
/// the `{origin}` / `{launch}` placeholders. Serialized (wire + SQLite) as its
/// canonical string via [`fmt::Display`]; parsed back via [`parse_app_url`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "String", try_from = "String")]
pub enum AppUrl {
    /// An absolute `https://` URL (off-device). May embed `{origin}`/`{launch}`.
    External(String),
    /// An on-device target — the part that follows the served origin (a leading
    /// `/path`, `?query`, `#fragment`, or empty for the bare origin).
    OriginRelative(String),
}

/// Substitution inputs for [`AppUrl::to_url_with_params`].
pub struct LaunchParams<'a> {
    /// The served origin, e.g. `http://127.0.0.1:8080`.
    pub origin: &'a str,
    /// Per-launch nonce substituted for `{launch}`.
    pub launch: &'a str,
    /// When true, append `?tunnel=unavailable` so the SPA can surface a banner.
    pub tunnel_unavailable: bool,
}

/// The error returned by [`parse_app_url`] when a string isn't a valid
/// [`AppUrl`]. Reused as the `message` of the wire-level 400.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppUrlError {
    /// Empty string.
    Empty,
    /// Shape doesn't match `https://`, an origin-relative `/path`, or an
    /// `{origin}…` template.
    Invalid,
}

impl fmt::Display for AppUrlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppUrlError::Empty => f.write_str("url must not be empty"),
            AppUrlError::Invalid => f.write_str(
                "url must be https://, an origin-relative /path, or start with the {origin} placeholder",
            ),
        }
    }
}

impl std::error::Error for AppUrlError {}

/// Parse a stored/wire URL string into an [`AppUrl`], rejecting empty and
/// unsafe shapes. This is the single write-side gate: a value that doesn't
/// parse never lands in a row, and a row that fails to parse on read surfaces
/// as a typed error rather than redirecting somewhere unsafe.
///
/// # Errors
///
/// Returns [`AppUrlError::Empty`] for an empty string and [`AppUrlError::Invalid`]
/// for anything outside the two accepted shapes (see the module docs).
pub fn parse_app_url(value: &str) -> Result<AppUrl, AppUrlError> {
    if value.is_empty() {
        return Err(AppUrlError::Empty);
    }
    if let Some(rest) = value.strip_prefix("{origin}") {
        // `{origin}` must be followed by a path/query/fragment boundary (or
        // nothing), never an authority-extending char. Otherwise
        // `{origin}@evil.com` would persist and resolve to
        // `http://<loopback>@evil.com`, an off-device redirect target.
        if rest.is_empty() || starts_at_url_boundary(rest) {
            return Ok(AppUrl::OriginRelative(rest.to_owned()));
        }
        return Err(AppUrlError::Invalid);
    }
    // A single-slash `/path` is origin-relative; a protocol-relative
    // `//authority` is an open redirect.
    if value.starts_with('/') && !value.starts_with("//") {
        return Ok(AppUrl::OriginRelative(value.to_owned()));
    }
    if value.starts_with("https://") {
        return Ok(AppUrl::External(value.to_owned()));
    }
    Err(AppUrlError::Invalid)
}

impl AppUrl {
    /// Render the concrete redirect target: substitute `{origin}` / `{launch}`,
    /// resolve an origin-relative target against `params.origin`, and append
    /// `?tunnel=unavailable` when the launch wanted a tunnel that isn't there.
    ///
    /// The result is safe by construction: an [`AppUrl::OriginRelative`] always
    /// renders same-origin and an [`AppUrl::External`] always stays on its
    /// `https://` authority (the placeholders only ever land in the path/query),
    /// so no launch-time re-validation is needed.
    #[must_use]
    pub fn to_url_with_params(&self, params: &LaunchParams<'_>) -> String {
        let base = match self {
            AppUrl::External(url) => url
                .replace("{origin}", params.origin)
                .replace("{launch}", params.launch),
            // The `{origin}` prefix was stripped at parse, so the suffix carries
            // only a `{launch}` placeholder (if any); the origin is prepended.
            AppUrl::OriginRelative(suffix) => {
                format!("{}{}", params.origin, suffix).replace("{launch}", params.launch)
            }
        };
        if params.tunnel_unavailable {
            append_query_flag(&base, "tunnel=unavailable")
        } else {
            base
        }
    }
}

impl fmt::Display for AppUrl {
    /// The canonical stored/wire string. [`AppUrl::OriginRelative`] re-emits the
    /// `{origin}` prefix so a `?query`/`#fragment`-only or bare-origin target
    /// round-trips back through [`parse_app_url`].
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppUrl::External(url) => f.write_str(url),
            AppUrl::OriginRelative(suffix) => write!(f, "{{origin}}{suffix}"),
        }
    }
}

impl From<AppUrl> for String {
    fn from(url: AppUrl) -> Self {
        url.to_string()
    }
}

impl TryFrom<String> for AppUrl {
    type Error = AppUrlError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        parse_app_url(&value)
    }
}

/// True when `rest` (whatever follows a matched `{origin}` prefix) begins a
/// path, query, or fragment — i.e. the prefix ended at a real URL boundary
/// rather than extending the authority (`@`, `.`, `:`, extra host chars). This
/// is what stops an `{origin}` match from being widened into an off-device
/// authority. `rest` is assumed non-empty (the empty case is handled at the
/// call site).
fn starts_at_url_boundary(rest: &str) -> bool {
    rest.starts_with(['/', '?', '#'])
}

/// Append `flag` as a query parameter to `target`, before any `#fragment`.
///
/// Uses string manipulation rather than `url::Url`: bundled launch URLs (e.g.
/// growth-chart, medication-viewer) carry raw colons / slashes in their `iss=`
/// query values that round-tripping through `Url` would percent-encode —
/// downstream consumers expect the un-encoded form.
fn append_query_flag(target: &str, flag: &str) -> String {
    let (base, hash) = match target.find('#') {
        Some(idx) => (&target[..idx], &target[idx..]),
        None => (target, ""),
    };
    let sep = if base.contains('?') { '&' } else { '?' };
    format!("{base}{sep}{flag}{hash}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params<'a>(origin: &'a str, launch: &'a str, tunnel_unavailable: bool) -> LaunchParams<'a> {
        LaunchParams {
            origin,
            launch,
            tunnel_unavailable,
        }
    }

    #[test]
    fn parses_https_origin_relative_and_origin_placeholder() {
        assert_eq!(
            parse_app_url("https://example.com/x"),
            Ok(AppUrl::External("https://example.com/x".to_owned())),
        );
        // A plain `/path` and the `{origin}/path` placeholder form both parse
        // to the same origin-relative suffix.
        assert_eq!(
            parse_app_url("/relative/path"),
            Ok(AppUrl::OriginRelative("/relative/path".to_owned())),
        );
        assert_eq!(
            parse_app_url("{origin}/launch?foo=1"),
            Ok(AppUrl::OriginRelative("/launch?foo=1".to_owned())),
        );
        // `{origin}` may be the whole URL or carry a query/fragment directly.
        assert_eq!(
            parse_app_url("{origin}"),
            Ok(AppUrl::OriginRelative(String::new())),
        );
        assert_eq!(
            parse_app_url("{origin}?x=1"),
            Ok(AppUrl::OriginRelative("?x=1".to_owned())),
        );
        assert_eq!(
            parse_app_url("{origin}#frag"),
            Ok(AppUrl::OriginRelative("#frag".to_owned())),
        );
    }

    #[test]
    fn rejects_origin_placeholder_that_extends_the_authority() {
        // `{origin}@evil.com` → resolves to `http://<loopback>@evil.com`, an
        // off-device redirect; the boundary check rejects it on parse.
        for bad in ["{origin}@evil.com/x", "{origin}.evil.com", "{origin}evil"] {
            assert_eq!(
                parse_app_url(bad),
                Err(AppUrlError::Invalid),
                "rejects {bad}"
            );
        }
    }

    #[test]
    fn rejects_empty_and_unsafe_shapes() {
        assert_eq!(parse_app_url(""), Err(AppUrlError::Empty));
        // protocol-relative authority is an open redirect
        assert_eq!(
            parse_app_url("//evil.example.com/x"),
            Err(AppUrlError::Invalid)
        );
        // plaintext http (no TLS)
        assert_eq!(
            parse_app_url("http://example.com/"),
            Err(AppUrlError::Invalid)
        );
        for scheme in [
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
        ] {
            assert_eq!(
                parse_app_url(scheme),
                Err(AppUrlError::Invalid),
                "rejects {scheme}"
            );
        }
    }

    /// The canonical string round-trips back through [`parse_app_url`] for every
    /// shape — including query/fragment-only origin-relative targets, which is
    /// why `OriginRelative` re-emits the `{origin}` prefix.
    #[test]
    fn display_round_trips_through_parse() {
        for raw in [
            "https://example.com/x?iss={origin}/fhir-r4&launch={launch}",
            "/relative/path",
            "{origin}/launch?foo=1",
            "{origin}",
            "{origin}?x=1",
            "{origin}#frag",
        ] {
            let parsed = parse_app_url(raw).expect("parses");
            let reparsed = parse_app_url(&parsed.to_string()).expect("re-parses");
            assert_eq!(parsed, reparsed, "round-trip failed for {raw}");
        }
    }

    #[test]
    fn origin_relative_renders_same_origin_with_launch_substituted() {
        let url = parse_app_url("{origin}/x?launch={launch}").unwrap();
        assert_eq!(
            url.to_url_with_params(&params("http://127.0.0.1:8080", "NONCE", false)),
            "http://127.0.0.1:8080/x?launch=NONCE",
        );
        // A plain `/path` resolves against the origin too.
        let url = parse_app_url("/installed-apps/x").unwrap();
        assert_eq!(
            url.to_url_with_params(&params("http://127.0.0.1:8080", "n", false)),
            "http://127.0.0.1:8080/installed-apps/x",
        );
    }

    #[test]
    fn external_substitutes_origin_and_launch_in_place() {
        let url =
            parse_app_url("https://host/launch.html?iss={origin}/fhir-r4&launch={launch}").unwrap();
        assert_eq!(
            url.to_url_with_params(&params("http://127.0.0.1:8080", "NONCE", false)),
            "https://host/launch.html?iss=http://127.0.0.1:8080/fhir-r4&launch=NONCE",
        );
    }

    #[test]
    fn tunnel_unavailable_flag_lands_before_any_fragment() {
        let bare = parse_app_url("https://x/y").unwrap();
        assert_eq!(
            bare.to_url_with_params(&params("o", "n", true)),
            "https://x/y?tunnel=unavailable",
        );
        let with_query = parse_app_url("https://x/y?z=1").unwrap();
        assert_eq!(
            with_query.to_url_with_params(&params("o", "n", true)),
            "https://x/y?z=1&tunnel=unavailable",
        );
        let with_hash = parse_app_url("https://x/y#hash").unwrap();
        assert_eq!(
            with_hash.to_url_with_params(&params("o", "n", true)),
            "https://x/y?tunnel=unavailable#hash",
        );
        let with_query_hash = parse_app_url("https://x/y?z=1#hash").unwrap();
        assert_eq!(
            with_query_hash.to_url_with_params(&params("o", "n", true)),
            "https://x/y?z=1&tunnel=unavailable#hash",
        );
    }
}
