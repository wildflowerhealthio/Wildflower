//! The route a forwarded request's path is reduced to before it is reported,
//! so the request log never holds a record identifier.

use axum::http::Uri;

/// `uri`'s path reduced to its route, its first segment:
/// `/Patient/123/_history/2?x=y` reduces to `/Patient` and
/// `/access/clients/abc` to `/access`. FHIR is served at the root, so a FHIR
/// request's first segment is its resource type (or a `$operation`,
/// `metadata`, …), and an id never comes first.
///
/// Only the path is read, so the query string never appears.
pub(crate) fn reduced_path(uri: &Uri) -> String {
    let first = uri
        .path()
        .trim_start_matches('/')
        .split('/')
        .next()
        .unwrap_or_default();
    format!("/{first}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn reduced(path_and_query: &str) -> String {
        reduced_path(&path_and_query.parse().expect("a valid URI"))
    }

    #[test]
    fn paths_keep_only_their_first_segment() {
        for (path, route) in [
            ("/Patient/123/_history/2?x=y", "/Patient"),
            ("/Patient?name=smith", "/Patient"),
            ("/MedicationRequest/abc", "/MedicationRequest"),
            ("/Patient/123/$everything", "/Patient"),
            ("/.well-known/smart-configuration", "/.well-known"),
            ("/$versions", "/$versions"),
            ("/access/clients/abc", "/access"),
            ("/access", "/access"),
            ("/requests/abc?x=1", "/requests"),
            ("/apps/lifting", "/apps"),
            ("/health", "/health"),
            ("/", "/"),
        ] {
            assert_eq!(reduced(path), route, "{path}");
        }
    }

    /// A non-empty path segment, drawn from the characters a URI path may carry
    /// unescaped, so ids, resource-type look-alikes and operations all occur.
    fn segment() -> impl Strategy<Value = String> {
        prop_oneof!["[A-Za-z0-9._~$-]{1,12}", Just("Patient".to_owned()),]
    }

    proptest! {
        /// The reduction is the path's first segment. Nothing further along the
        /// path, and nothing from the query, is ever emitted.
        #[test]
        fn never_emits_an_id_segment_or_a_query(
            segments in proptest::collection::vec(segment(), 1..6),
            query in proptest::option::of("[A-Za-z0-9=&]{0,12}"),
        ) {
            let path = format!("/{}", segments.join("/"));
            let path_and_query = match &query {
                Some(query) => format!("{path}?{query}"),
                None => path,
            };

            prop_assert_eq!(reduced(&path_and_query), format!("/{}", segments[0]));
        }
    }
}
