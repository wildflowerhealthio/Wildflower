//! Shared OpenAPI snapshot-test helper. A `-rust` crate emits its documented
//! HTTP surface as a [`utoipa::openapi::OpenApi`], then a `#[test]` hands it to
//! [`assert_up_to_date`] to keep the committed JSON snapshot — the one the
//! TypeScript spec-drift test reads — byte-exact with the live routes.
//!
//! Regenerate after a wire-type change with:
//! `UPDATE_OPENAPI=1 cargo test <test-name>`.

use utoipa::openapi::OpenApi;

/// Assert the committed snapshot at `path` matches `spec` serialized as pretty
/// JSON with a trailing newline. With `UPDATE_OPENAPI` set in the environment,
/// (re)writes the snapshot and returns instead of asserting.
///
/// The comparison is byte-exact on purpose: the snapshot is excluded from oxfmt
/// (`vite.config.ts` `fmt.ignorePatterns` → `**/openapi/*.openapi.json`) so it
/// stays in serde_json's canonical form and doesn't churn on `vp fmt`. Pass an
/// absolute `path`, e.g.
/// `concat!(env!("CARGO_MANIFEST_DIR"), "/openapi/<name>.openapi.json")`.
pub fn assert_up_to_date(spec: &OpenApi, path: &str) {
    let generated = format!(
        "{}\n",
        serde_json::to_string_pretty(spec).expect("serialize OpenAPI to JSON")
    );
    if std::env::var_os("UPDATE_OPENAPI").is_some() {
        std::fs::write(path, &generated)
            .unwrap_or_else(|e| panic!("write OpenAPI snapshot to {path}: {e}"));
        return;
    }
    let committed = std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "read committed OpenAPI snapshot at {path}: {e}; \
             regenerate with UPDATE_OPENAPI=1 cargo test"
        )
    });
    assert_eq!(
        committed, generated,
        "OpenAPI snapshot at {path} is out of date — \
         regenerate with UPDATE_OPENAPI=1 cargo test"
    );
}
