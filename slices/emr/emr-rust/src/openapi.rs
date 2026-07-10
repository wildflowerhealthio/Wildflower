//! The FHIR R4 group's `OpenApi` document for the host's unified `/docs`
//! Scalar page.
//!
//! Unlike the other documented slices, this spec is **not** collected from
//! utoipa-annotated routes — the server here is the embedded third-party HFS
//! router (see [`crate`]'s module docs), so there is nothing on the Rust side
//! to annotate. Instead the committed snapshot at
//! `openapi/fhir-r4.openapi.json` is generated from the TypeScript `fhir-r4`
//! `HttpApi` (the Effect description of the FHIR surface the Wildflower
//! client actually uses — not the whole of HFS) and embedded here at compile
//! time via `include_str!`. Its paths already carry the `/fhir-r4` mount
//! prefix, so it merges into the host's document with no re-nesting.
//!
//! The snapshot's freshness against the TS `HttpApi` is guarded on the TS
//! side, not here — see
//! `slices/emr/fhir-r4/src/http-api-definition/openapi-drift.test.ts`.
//! There remains no drift guard between this spec and HFS's actual surface
//! (see `slices/emr/CLAUDE.md`).

/// Parse the committed FHIR R4 OpenAPI snapshot embedded at compile time.
///
/// # Panics
///
/// Panics if the embedded snapshot fails to parse as `OpenApi` JSON — this
/// can only happen if the committed file is corrupted, since it is generated
/// and validated by a TS-side test before being committed.
pub fn openapi_spec() -> utoipa::openapi::OpenApi {
    let raw = include_str!("../openapi/fhir-r4.openapi.json");
    serde_json::from_str(raw).expect("embedded fhir-r4 OpenAPI snapshot must parse as valid JSON")
}

#[cfg(test)]
mod tests {
    use super::openapi_spec;

    #[test]
    fn parses_and_contains_expected_paths() {
        let spec = openapi_spec();
        assert!(
            spec.paths.paths.contains_key("/fhir-r4/Patient/{id}"),
            "expected /fhir-r4/Patient/{{id}} in the FHIR R4 spec"
        );

        let everything_paths: Vec<&String> = spec
            .paths
            .paths
            .keys()
            .filter(|path| path.ends_with("/$everything"))
            .collect();
        assert_eq!(
            everything_paths,
            vec!["/fhir-r4/Patient/{id}/$everything"],
            "the only $everything path should be Patient's"
        );
    }

    /// The `/docs` merge's two-level Scalar sidebar groups operations by tag
    /// (see `shared-structures-rust`'s `openapi_docs` module); an untagged
    /// operation would silently fall out of the sidebar.
    #[test]
    fn every_operation_carries_at_least_one_tag() {
        let spec = openapi_spec();
        for (path, item) in &spec.paths.paths {
            let operations = [
                ("GET", &item.get),
                ("PUT", &item.put),
                ("POST", &item.post),
                ("DELETE", &item.delete),
                ("OPTIONS", &item.options),
                ("HEAD", &item.head),
                ("PATCH", &item.patch),
                ("TRACE", &item.trace),
            ];
            for (method, operation) in operations {
                let Some(operation) = operation else {
                    continue;
                };
                let tags = operation.tags.as_deref().unwrap_or_default();
                assert!(!tags.is_empty(), "{method} {path} has no tags");
            }
        }
    }
}
