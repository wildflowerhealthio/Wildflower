//! The route a forwarded request's path is reduced to before it is reported,
//! so the request log never holds a record identifier.

use axum::http::Uri;
use wildflowerhealthio_fhir_r4::FHIR_R4_PATH;

/// `uri`'s path reduced to its route: the first segment, plus the resource type
/// when the first segment is the FHIR base. `/fhir-r4/Patient/123/_history/2?x=y`
/// reduces to `/fhir-r4/Patient` and `/access/clients/abc` to `/access`.
///
/// Only the path is read, so the query string never appears. A FHIR segment
/// that isn't shaped like a resource type (`metadata`, `$versions`,
/// `.well-known`) is dropped with everything after it, so an id can't stand in
/// for one.
pub(crate) fn reduced_path(uri: &Uri) -> String {
    let mut segments = uri.path().trim_start_matches('/').split('/');
    let first = segments.next().unwrap_or_default();
    let route = format!("/{first}");
    match segments.next() {
        Some(resource_type) if route == FHIR_R4_PATH && is_resource_type(resource_type) => {
            format!("{route}/{resource_type}")
        }
        _ => route,
    }
}

/// Whether `segment` is shaped like a FHIR resource type: an ASCII capital
/// followed by ASCII letters (`Patient`, `MedicationRequest`).
fn is_resource_type(segment: &str) -> bool {
    let mut chars = segment.chars();
    chars.next().is_some_and(|first| first.is_ascii_uppercase())
        && chars.all(|c| c.is_ascii_alphabetic())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn reduced(path_and_query: &str) -> String {
        reduced_path(&path_and_query.parse().expect("a valid URI"))
    }

    #[test]
    fn fhir_paths_keep_the_resource_type() {
        for (path, route) in [
            ("/fhir-r4/Patient/123/_history/2?x=y", "/fhir-r4/Patient"),
            ("/fhir-r4/Patient", "/fhir-r4/Patient"),
            ("/fhir-r4/Patient?name=smith", "/fhir-r4/Patient"),
            (
                "/fhir-r4/MedicationRequest/abc",
                "/fhir-r4/MedicationRequest",
            ),
            ("/fhir-r4/Patient/123/$everything", "/fhir-r4/Patient"),
            ("/fhir-r4/metadata", "/fhir-r4"),
            ("/fhir-r4/.well-known/smart-configuration", "/fhir-r4"),
            ("/fhir-r4/$versions", "/fhir-r4"),
            ("/fhir-r4/123", "/fhir-r4"),
            ("/fhir-r4/Patient-1", "/fhir-r4"),
            ("/fhir-r4", "/fhir-r4"),
            ("/fhir-r4/", "/fhir-r4"),
        ] {
            assert_eq!(reduced(path), route, "{path}");
        }
    }

    #[test]
    fn other_paths_keep_only_their_first_segment() {
        for (path, route) in [
            ("/access/clients/abc", "/access"),
            ("/access", "/access"),
            ("/collector/remotes?x=1", "/collector"),
            ("/apps/lifting", "/apps"),
            ("/health", "/health"),
            // A resource-type-shaped second segment only counts under FHIR.
            ("/apps/Patient", "/apps"),
            ("/fhir-r4x/Patient", "/fhir-r4x"),
            ("/", "/"),
        ] {
            assert_eq!(reduced(path), route, "{path}");
        }
    }

    /// A non-empty path segment, drawn from the characters a URI path may carry
    /// unescaped, so ids, resource-type look-alikes and operations all occur.
    fn segment() -> impl Strategy<Value = String> {
        prop_oneof![
            "[A-Za-z0-9._~$-]{1,12}",
            Just("fhir-r4".to_owned()),
            Just("Patient".to_owned()),
        ]
    }

    proptest! {
        /// The reduction is the path's first segment, or under the FHIR base
        /// its first two when the second is shaped like a resource type.
        /// Nothing further along the path, and nothing from the query, is ever
        /// emitted.
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

            let route = reduced(&path_and_query);

            prop_assert!(!route.contains('?'));
            let kept: Vec<&str> = route.trim_start_matches('/').split('/').collect();
            prop_assert!(kept.len() == 1 || kept.len() == 2);
            prop_assert_eq!(&kept[..], &segments[..kept.len()]);
            if let [base, resource_type] = kept[..] {
                prop_assert_eq!(format!("/{base}"), FHIR_R4_PATH);
                prop_assert!(resource_type.starts_with(|c: char| c.is_ascii_uppercase()));
                prop_assert!(resource_type.chars().all(|c| c.is_ascii_alphabetic()));
            }
        }
    }
}
