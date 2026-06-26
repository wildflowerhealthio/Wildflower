//! The apps slice's HTTP surface. Two routers — the public one (list +
//! launch) the webview consumes unauthenticated and the admin one (create /
//! update / delete) the consumer wraps with the gatekeeper. `setup_apps`
//! returns both so the host can `.merge()` the public one and
//! `layer_router_with_gatekeeper_auth_gating` the admin one. Mirrors the way
//! gatekeeper-rust separates `/oauth` from `/access`.
//!
//! Both tables are built as `utoipa_axum::OpenApiRouter`s, so the same
//! `#[utoipa::path]`-annotated handlers that serve traffic also produce the
//! committed OpenAPI snapshot (`openapi/apps.openapi.json`) that the TS
//! spec-drift test reads. See [`openapi_tests`].

mod handlers;
mod response_templates;
mod state;

pub use state::AppsState;

use std::sync::Arc;

use axum::Router;

/// Build the public `/apps` router (`GET /apps`, `POST /apps/{id}`). Owner
/// auth is NOT applied — both endpoints are reachable by embedded webviews
/// and iframes that can't easily carry a bearer token.
pub fn public_router(state: Arc<AppsState>) -> Router {
    let (router, _spec) = handlers::public_openapi_router().split_for_parts();
    router.with_state(state)
}

/// Build the admin `/apps` router (`POST /apps`, `PATCH /apps/{id}`,
/// `DELETE /apps/{id}`). The router itself carries no middleware — the host
/// wraps it with `layer_router_with_gatekeeper_auth_gating` so a future
/// composing app applies its own auth gate.
pub fn admin_router(state: Arc<AppsState>) -> Router {
    let (router, _spec) = handlers::admin_openapi_router().split_for_parts();
    router.with_state(state)
}

#[cfg(test)]
mod openapi_tests {
    use utoipa::openapi::Info;
    use utoipa::OpenApi;
    use utoipa_axum::router::OpenApiRouter;

    /// The committed spec snapshot the TS spec-drift test reads.
    const SPEC_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/openapi/apps.openapi.json");

    /// Base `OpenAPI` document; the collected routes fill in paths + components.
    #[derive(OpenApi)]
    struct ApiDoc;

    /// The full apps surface — public (list + launch) and admin (create /
    /// update / delete) merged into one document, so the snapshot covers every
    /// endpoint the TS `AppsApi` / `AppsAdminApi` clients speak. `info` is set
    /// explicitly so the committed snapshot doesn't churn with the crate
    /// version. Test-only — nothing serves the spec at runtime.
    fn openapi_spec() -> utoipa::openapi::OpenApi {
        let combined = OpenApiRouter::with_openapi(ApiDoc::openapi())
            .merge(super::handlers::public_openapi_router())
            .merge(super::handlers::admin_openapi_router());
        let (_router, mut spec) = combined.split_for_parts();
        spec.info = Info::new("Apps Catalogue API", "0.0.0");
        spec
    }

    /// The generated `OpenAPI` document must match the committed snapshot. A
    /// wire-type change flips this red; regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p apps-rust openapi_spec_snapshot_is_up_to_date`.
    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        shared_structures_rust::openapi_snapshot::assert_up_to_date(&openapi_spec(), SPEC_PATH);
    }
}
