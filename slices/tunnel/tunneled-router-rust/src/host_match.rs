//! Match a forwarded request's origin against the `<id>.<public_host>` shape.
//!
//! The host-shape matching itself is the shared
//! [`shared_structures_rust::subdomain_host::match_subdomain`] (so it can't
//! drift from the launch redirect that produces the same shape). This module
//! only adds the dispatch-side concern of stripping the `scheme://` off the
//! rendered `Forwarded` origin before matching.

use shared_structures_rust::subdomain_host::match_subdomain;

/// Match a forwarded request's `origin` (`scheme://host[:port]`) against
/// `public_host`, returning the route id when the host is `<id>.<public_host>`
/// for some `id` accepted by `is_known_id`.
pub(crate) fn match_forwarded_origin(
    origin: &str,
    public_host: &str,
    is_known_id: impl Fn(&str) -> bool,
) -> Option<String> {
    match_subdomain(strip_scheme(origin)?, public_host, is_known_id)
}

/// Strip a `scheme://` prefix from `origin`, returning the `host[:port]` tail.
/// `None` for an empty tail (defensive: `request_provenance` already validated
/// the host shape).
fn strip_scheme(origin: &str) -> Option<&str> {
    origin
        .split_once("://")
        .map(|(_, tail)| tail)
        .filter(|tail| !tail.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_scheme_before_matching() {
        assert_eq!(
            match_forwarded_origin(
                "https://patient-browser.demo.example.com",
                "demo.example.com",
                |id| id == "patient-browser",
            ),
            Some("patient-browser".to_owned()),
        );
    }

    #[test]
    fn rejects_an_origin_with_no_scheme_or_empty_tail() {
        let known = |_: &str| true;
        assert_eq!(
            match_forwarded_origin("patient-browser.demo.example.com", "demo.example.com", known),
            None,
        );
        assert_eq!(match_forwarded_origin("https://", "demo.example.com", known), None);
    }
}
