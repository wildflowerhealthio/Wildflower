//! Cross-language contract tests over `slices/scopes/scope-test-vectors.json`,
//! the fixture shared with `scopes-core`'s `scope-test-vectors.test.ts`. Both
//! suites consume the same file, so a semantic change on one side of the
//! TS/Rust scope-grammar mirror fails the other side's build instead of
//! drifting silently.

use scopes_rust::{allowed_scope_covers, Scope};

const VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../scope-test-vectors.json"
));

fn vectors() -> serde_json::Value {
    serde_json::from_str(VECTORS).expect("scope-test-vectors.json parses")
}

#[test]
fn parse_vectors_agree_on_kind_and_rendering() {
    for case in vectors()["parse"].as_array().expect("parse cases") {
        let raw = case["scope"].as_str().expect("scope");
        let rendered = case["rendered"].as_str().expect("rendered");
        let kind = case["kind"].as_str().expect("kind");

        let scope = Scope::from(raw);
        let actual_kind = match &scope {
            // The fixture splits FHIR by grammar for the TS partitions; Rust
            // holds both grammars in the one FhirResource variant.
            Scope::FhirResource(_) => "fhir",
            Scope::WildflowerResource(_) => "wildflower",
            Scope::Known(_) => "known",
            Scope::Unknown(_) => "unknown",
        };
        let expected_kind = match kind {
            "fhirV1" | "fhirV2" => "fhir",
            other => other,
        };
        assert_eq!(actual_kind, expected_kind, "kind of {raw}");
        assert_eq!(scope.to_string(), rendered, "rendering of {raw}");
    }
}

#[test]
fn coverage_vectors_agree_with_allowed_scope_covers() {
    for case in vectors()["coverage"].as_array().expect("coverage cases") {
        let allowed = case["allowed"].as_str().expect("allowed");
        let requested = case["requested"].as_str().expect("requested");
        let covers = case["covers"].as_bool().expect("covers");
        assert_eq!(
            allowed_scope_covers(allowed, requested),
            covers,
            "{allowed} covers {requested}"
        );
    }
}
