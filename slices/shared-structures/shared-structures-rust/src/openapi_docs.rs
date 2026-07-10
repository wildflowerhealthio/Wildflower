//! The unified `/docs` surface: merge several slice `OpenApi` documents into one
//! and serve it as an interactive [Scalar](https://scalar.com) API reference.
//!
//! Each documented slice (`gatekeeper`, `apps`, `databases`, `tunnel`) exposes an
//! `openapi_spec()` collected from the very routes that serve traffic. The host —
//! the one process that actually serves HTTP — collects those, merges them here
//! into a single document, and mounts the returned router at `/docs`. The paths
//! in each slice's spec already carry that slice's host mount prefix (`/oauth`,
//! `/tunnel`, `/databases`, `/apps`, …), so a plain [`OpenApi::merge`] needs no
//! re-nesting. Nothing else consumes this: the per-slice snapshots remain the
//! drift-guard source of truth (see the [OpenAPI Spec Drift How-To]).
//!
//! [`OpenApi::merge`]: utoipa::openapi::OpenApi::merge
//! [OpenAPI Spec Drift How-To]: ../../../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md

use axum::Router;
use utoipa::openapi::{Info, OpenApi, Paths};
use utoipa_scalar::{Scalar, Servable};

/// Merge `specs` into one [`OpenApi`] document titled `title` / `version`.
///
/// Paths and component schemas from every spec are combined. utoipa's
/// [`OpenApi::merge`] is a shallow, name-keyed union: on a duplicate path or
/// schema name the first spec to contribute it wins and later duplicates are
/// dropped. (The slices' one shared schema, `DeletedBody`, is byte-identical
/// across `apps` and `databases`, so the dedup is lossless.) Each input spec's
/// own `info` is discarded in favour of the unified `title` / `version` — merge
/// deliberately never touches `info`.
///
/// [`OpenApi::merge`]: utoipa::openapi::OpenApi::merge
#[must_use]
pub fn merge_specs(
    title: &str,
    version: &str,
    specs: impl IntoIterator<Item = OpenApi>,
) -> OpenApi {
    let mut merged = OpenApi::new(Info::new(title, version), Paths::new());
    for spec in specs {
        merged.merge(spec);
    }
    merged
}

/// Build an axum [`Router`] that serves an interactive Scalar API reference for
/// `spec` at `path` (e.g. `/docs`). The Scalar page embeds the spec inline, so
/// this is a single `GET` route with no separate spec endpoint.
///
/// The router carries no state and no auth of its own — the host wraps it with
/// the same gate as the rest of its API surface (loopback callers pass on
/// connection provenance, forwarded callers on a valid bearer).
pub fn scalar_router(path: &str, spec: OpenApi) -> Router {
    Router::new().merge(Scalar::with_url(path.to_owned(), spec))
}

/// Convenience: [`merge_specs`] the `specs`, then serve the result with
/// [`scalar_router`] at `path`. The host's one-call entry point.
pub fn merged_scalar_router(
    path: &str,
    title: &str,
    version: &str,
    specs: impl IntoIterator<Item = OpenApi>,
) -> Router {
    scalar_router(path, merge_specs(title, version, specs))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use super::{merge_specs, scalar_router};

    fn spec_from_json(json: &str) -> utoipa::openapi::OpenApi {
        serde_json::from_str(json).expect("valid OpenAPI json")
    }

    #[test]
    fn merge_specs_unions_paths_dedups_schemas_and_overrides_info() {
        let a = spec_from_json(
            r#"{
                "openapi": "3.1.0",
                "info": { "title": "A", "version": "1.0.0" },
                "paths": { "/a": {} },
                "components": { "schemas": { "Shared": { "type": "object" } } }
            }"#,
        );
        let b = spec_from_json(
            r#"{
                "openapi": "3.1.0",
                "info": { "title": "B", "version": "2.0.0" },
                "paths": { "/b": {} },
                "components": {
                    "schemas": {
                        "Shared": { "type": "object" },
                        "OnlyB": { "type": "object" }
                    }
                }
            }"#,
        );

        let merged = merge_specs("Unified", "9.9.9", [a, b]);

        // The unified info wins; neither input title/version survives.
        assert_eq!(merged.info.title, "Unified");
        assert_eq!(merged.info.version, "9.9.9");

        // Paths from both specs are present.
        assert!(merged.paths.paths.contains_key("/a"));
        assert!(merged.paths.paths.contains_key("/b"));

        // Schemas union, with the duplicate `Shared` collapsed to one entry.
        let schemas = merged.components.expect("merged components").schemas;
        assert!(schemas.contains_key("Shared"));
        assert!(schemas.contains_key("OnlyB"));
    }

    #[tokio::test]
    async fn scalar_router_serves_reference_at_path() {
        let spec = spec_from_json(
            r#"{
                "openapi": "3.1.0",
                "info": { "title": "A", "version": "0.0.0" },
                "paths": {}
            }"#,
        );

        let response = scalar_router("/docs", spec)
            .oneshot(
                Request::builder()
                    .uri("/docs")
                    .body(Body::empty())
                    .expect("request builds"),
            )
            .await
            .expect("router responds");

        assert_eq!(response.status(), StatusCode::OK);
    }
}
