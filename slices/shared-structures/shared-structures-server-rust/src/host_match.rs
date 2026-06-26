//! Match a forwarded request's origin against the `<id>.<public_host>` shape.
//!
//! The host-shape split is the shared
//! [`shared_structures_rust::subdomain_host::try_split_subdomain`] (so it can't
//! drift from the launch redirect that produces the same shape). This module
//! only adds the dispatch-side concern of stripping the `scheme://` off the
//! rendered `Forwarded` origin first. Whether the resulting id is actually
//! registered is the caller's concern — the proxy-table lookup is the authority.

use shared_structures_rust::subdomain_host::try_split_subdomain;

/// Split a forwarded request's `origin` (`scheme://host[:port]`) into its
/// leftmost subdomain label when the host is `<id>.<public_host>`. Returns
/// `None` when there is no scheme, an empty tail, or the host doesn't match the
/// shape.
pub(crate) fn match_forwarded_origin(origin: &str, public_host: &str) -> Option<String> {
    try_split_subdomain(strip_scheme(origin)?, public_host)
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
                "demo.example.com"
            ),
            Some("patient-browser".to_owned()),
        );
    }

    #[test]
    fn rejects_an_origin_with_no_scheme_or_empty_tail() {
        assert_eq!(
            match_forwarded_origin("patient-browser.demo.example.com", "demo.example.com"),
            None,
        );
        assert_eq!(match_forwarded_origin("https://", "demo.example.com"), None);
    }

    #[test]
    fn returns_the_label_without_a_catalogue_check() {
        // The matcher only checks the shape; "admin" is returned even though no
        // such host may be registered. The proxy-table lookup is the authority.
        assert_eq!(
            match_forwarded_origin("https://admin.demo.example.com", "demo.example.com"),
            Some("admin".to_owned()),
        );
    }
}
