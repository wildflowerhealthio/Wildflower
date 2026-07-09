//! Match a forwarded request's base URL against the `<id>.<public_host>` shape.
//!
//! The host-shape split is the shared
//! [`shared_structures_rust::subdomain_host::try_split_subdomain`] (so it can't
//! drift from the launch redirect that produces the same shape). This module
//! only adds the dispatch-side concern of reading the host off the forwarded
//! [`Url`] first. Whether the resulting id is actually registered is the
//! caller's concern — the proxy-table lookup is the authority.

use shared_structures_rust::subdomain_host::try_split_subdomain;
use url::Url;

/// Split a forwarded request's `base_url` into its leftmost subdomain label when
/// the host is `<id>.<public_host>`. Reads the bare host off the [`Url`]
/// (`try_split_subdomain` is port-insensitive, so a `:port` is irrelevant).
/// Returns `None` when the URL has no host or the host doesn't match the shape.
pub(crate) fn match_forwarded_base_url(base_url: &Url, public_host: &str) -> Option<String> {
    try_split_subdomain(base_url.host_str()?, public_host)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn reads_the_host_off_the_base_url_before_matching() {
        assert_eq!(
            match_forwarded_base_url(
                &url("https://patient-browser.demo.example.com"),
                "demo.example.com"
            ),
            Some("patient-browser".to_owned()),
        );
    }

    #[test]
    fn rejects_a_base_url_whose_host_does_not_match_the_shape() {
        // A bare apex host (no subdomain label) doesn't split.
        assert_eq!(
            match_forwarded_base_url(&url("https://demo.example.com"), "demo.example.com"),
            None,
        );
    }

    #[test]
    fn returns_the_label_without_a_catalogue_check() {
        // The matcher only checks the shape; "admin" is returned even though no
        // such host may be registered. The proxy-table lookup is the authority.
        assert_eq!(
            match_forwarded_base_url(&url("https://admin.demo.example.com"), "demo.example.com"),
            Some("admin".to_owned()),
        );
    }
}
