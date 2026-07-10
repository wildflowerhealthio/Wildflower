//! The unified `/docs` surface: merge several slice `OpenApi` documents into one
//! and serve it as an interactive [Scalar](https://scalar.com) API reference.
//!
//! Each documented slice (`gatekeeper`, `apps`, `databases`, `tunnel`, `emr`)
//! exposes an `openapi_spec()`. For most slices that's collected from the very
//! routes that serve traffic; `emr`'s is the one exception — its server is the
//! embedded third-party HFS router, so its spec is a committed snapshot
//! generated from the TS `fhir-r4` `HttpApi` instead (see
//! `emr_rust::openapi_spec`). The host — the one process that actually serves
//! HTTP — collects those, merges them here
//! into a single document, and mounts the returned router at `/docs`. The paths
//! in each slice's spec already carry that slice's host mount prefix (`/oauth`,
//! `/tunnel`, `/databases`, `/apps`, …), so a plain [`OpenApi::merge`] needs no
//! re-nesting. Nothing else consumes this: the per-slice snapshots remain the
//! drift-guard source of truth (see the [OpenAPI Spec Drift How-To]).
//!
//! ## Sectioning
//!
//! A flat merge is unreadable, so the merge builds the metadata a tag-aware
//! renderer uses for a two-level sidebar. Every operation already carries a
//! fine-grained `tag` (set on the slice's `#[utoipa::path]`, e.g. `OAuth 2.0`,
//! `Catalogue`), so tags become the **sub-sections**. Each group (a slice) is
//! then mapped to its own tags via the `x-tagGroups` root extension —
//! [Scalar]/Redoc render that as the top-level **group heading**. The mapping is
//! derived from whatever tags each slice actually exposes, so there is no central
//! tag list to keep in sync; a slice whose operations carry no tags falls back to
//! a single section named after the group.
//!
//! [`OpenApi::merge`]: utoipa::openapi::OpenApi::merge
//! [OpenAPI Spec Drift How-To]: ../../../../docs/Effect/OpenAPI%20Spec%20Drift%20How-To.md

use axum::Router;
use utoipa::openapi::extensions::Extensions;
use utoipa::openapi::path::{Operation, PathItem};
use utoipa::openapi::{Info, OpenApi, Paths, Tag};
use utoipa_scalar::{Scalar, Servable};

/// Merge `groups` — each a display name paired with that slice's [`OpenApi`] —
/// into one document titled `title` / `version`, wiring up the two-level section
/// metadata (see the [module docs](self)).
///
/// Paths and component schemas are unioned via [`OpenApi::merge`] (a shallow,
/// name-keyed union: on a duplicate path/schema name the first contributor wins;
/// the slices' one shared schema, `DeletedBody`, is byte-identical so the dedup
/// is lossless). Each input spec's own `info` is discarded in favour of the
/// unified `title` / `version`. Additionally:
///
/// - each group's operation tags are collected (in route order) into an
///   `x-tagGroups` entry named after the group, so the slice becomes a top-level
///   heading;
/// - the union of tags across all groups is emitted as ordered root `tags`, so
///   sections render in a stable, first-seen order;
/// - a group whose operations carry no tags has every operation stamped with the
///   group name, so an untagged slice still forms one clean, named section.
///
/// [`OpenApi::merge`]: utoipa::openapi::OpenApi::merge
pub fn merge_specs<'a>(
    title: &str,
    version: &str,
    groups: impl IntoIterator<Item = (&'a str, OpenApi)>,
) -> OpenApi {
    let mut merged = OpenApi::new(Info::new(title, version), Paths::new());
    let mut tag_groups: Vec<serde_json::Value> = Vec::new();
    let mut ordered_tags: Vec<String> = Vec::new();

    for (group_name, mut spec) in groups {
        let mut group_tags = collect_tags(&spec);
        if group_tags.is_empty() {
            // No per-operation tags — stamp the group name onto every operation
            // so the slice still forms a single, named section rather than
            // scattering into the renderer's "default" bucket.
            stamp_tag(&mut spec, group_name);
            group_tags.push(group_name.to_owned());
        }
        for tag in &group_tags {
            if !ordered_tags.iter().any(|existing| existing == tag) {
                ordered_tags.push(tag.clone());
            }
        }
        tag_groups.push(serde_json::json!({ "name": group_name, "tags": group_tags }));
        merged.merge(spec);
    }

    merged.tags = Some(ordered_tags.into_iter().map(Tag::new).collect());
    merged
        .extensions
        .get_or_insert_with(Extensions::default)
        .insert(
            "x-tagGroups".to_owned(),
            serde_json::Value::Array(tag_groups),
        );
    merged
}

/// Every [`Operation`] present on a [`PathItem`], in HTTP-method order.
fn operations(item: &PathItem) -> impl Iterator<Item = &Operation> {
    [
        &item.get,
        &item.put,
        &item.post,
        &item.delete,
        &item.options,
        &item.head,
        &item.patch,
        &item.trace,
    ]
    .into_iter()
    .flatten()
}

/// The distinct operation tags in `spec`, in first-seen (route) order.
fn collect_tags(spec: &OpenApi) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for item in spec.paths.paths.values() {
        for op in operations(item) {
            for tag in op.tags.iter().flatten() {
                if !tags.iter().any(|existing| existing == tag) {
                    tags.push(tag.clone());
                }
            }
        }
    }
    tags
}

/// Overwrite every operation's tags in `spec` with the single tag `tag`.
fn stamp_tag(spec: &mut OpenApi, tag: &str) {
    for item in spec.paths.paths.values_mut() {
        let ops = [
            &mut item.get,
            &mut item.put,
            &mut item.post,
            &mut item.delete,
            &mut item.options,
            &mut item.head,
            &mut item.patch,
            &mut item.trace,
        ];
        for op in ops.into_iter().flatten() {
            op.tags = Some(vec![tag.to_owned()]);
        }
    }
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

/// Convenience: [`merge_specs`] the `groups`, then serve the result with
/// [`scalar_router`] at `path`. The host's one-call entry point.
pub fn merged_scalar_router<'a>(
    path: &str,
    title: &str,
    version: &str,
    groups: impl IntoIterator<Item = (&'a str, OpenApi)>,
) -> Router {
    scalar_router(path, merge_specs(title, version, groups))
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
    fn merge_specs_builds_tag_groups_and_orders_sections() {
        let a = spec_from_json(
            r#"{
                "openapi": "3.1.0",
                "info": { "title": "A", "version": "1.0.0" },
                "paths": {
                    "/a1": { "get": { "tags": ["Alpha"], "responses": {} } },
                    "/a2": { "post": { "tags": ["Beta"], "responses": {} } }
                },
                "components": { "schemas": { "Shared": { "type": "object" } } }
            }"#,
        );
        let b = spec_from_json(
            r#"{
                "openapi": "3.1.0",
                "info": { "title": "B", "version": "2.0.0" },
                "paths": { "/b": { "get": { "tags": ["Gamma"], "responses": {} } } },
                "components": {
                    "schemas": {
                        "Shared": { "type": "object" },
                        "OnlyB": { "type": "object" }
                    }
                }
            }"#,
        );

        let merged = merge_specs("Unified", "9.9.9", [("Group A", a), ("Group B", b)]);

        // The unified info wins; neither input title/version survives.
        assert_eq!(merged.info.title, "Unified");
        assert_eq!(merged.info.version, "9.9.9");

        // Paths union, schemas union with the duplicate `Shared` collapsed.
        assert!(merged.paths.paths.contains_key("/a1"));
        assert!(merged.paths.paths.contains_key("/a2"));
        assert!(merged.paths.paths.contains_key("/b"));
        let schemas = &merged.components.as_ref().expect("components").schemas;
        assert!(schemas.contains_key("Shared"));
        assert!(schemas.contains_key("OnlyB"));

        // Root tags are ordered by first appearance across the groups.
        let tag_names: Vec<&str> = merged
            .tags
            .as_ref()
            .expect("root tags")
            .iter()
            .map(|tag| tag.name.as_str())
            .collect();
        assert_eq!(tag_names, ["Alpha", "Beta", "Gamma"]);

        // `x-tagGroups` maps each group name to exactly its tags, in order.
        let tag_groups = merged
            .extensions
            .as_ref()
            .expect("extensions")
            .get("x-tagGroups")
            .expect("x-tagGroups");
        assert_eq!(
            tag_groups,
            &serde_json::json!([
                { "name": "Group A", "tags": ["Alpha", "Beta"] },
                { "name": "Group B", "tags": ["Gamma"] }
            ])
        );
    }

    #[test]
    fn untagged_group_falls_back_to_one_named_section() {
        let a = spec_from_json(
            r#"{
                "openapi": "3.1.0",
                "info": { "title": "A", "version": "1.0.0" },
                "paths": { "/a": { "get": { "responses": {} } } }
            }"#,
        );

        let merged = merge_specs("Unified", "0.0.0", [("Solo", a)]);

        // Every operation in the untagged group is stamped with the group name.
        let op = merged
            .paths
            .paths
            .get("/a")
            .expect("path")
            .get
            .as_ref()
            .expect("get op");
        assert_eq!(op.tags.as_deref(), Some(["Solo".to_owned()].as_slice()));

        let tag_groups = merged
            .extensions
            .as_ref()
            .expect("extensions")
            .get("x-tagGroups")
            .expect("x-tagGroups");
        assert_eq!(
            tag_groups,
            &serde_json::json!([{ "name": "Solo", "tags": ["Solo"] }])
        );
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
