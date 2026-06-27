//! The apps slice's HTTP surface — list, launch, placement, and the cloud-admin
//! write surface — built as `utoipa_axum::OpenApiRouter`s, so the same
//! `#[utoipa::path]`-annotated handlers that serve traffic also produce the
//! committed OpenAPI snapshot (`openapi/apps.openapi.json`) that the TS
//! spec-drift test reads.
//!
//! The surface is exposed as two routers so the host can gate them differently:
//! [`gated_router`] (list + cloud-admin + placement) is wrapped by the host's
//! bearer gate; [`launch_router`] (`POST /apps/{id}`) is mounted ungated at the
//! router level — the launch handler owner-gates the loopback popup through
//! [`owner_auth::OwnerAuth`] while a forwarded launch rides the front trust
//! boundary. The bearer gate can't exempt the parameterized launch path from the
//! gated `PATCH`/`DELETE /apps/{id}`, hence the split. See [`openapi_tests`].

mod handlers;
pub mod owner_auth;
mod response_templates;
mod state;

pub use owner_auth::{AllowOwner, OwnerAuth};
pub use state::AppsState;

use std::sync::Arc;

use axum::Router;

/// Build the owner-gated `/apps` routes (`GET /apps`, `POST /apps`,
/// `PATCH`/`DELETE /apps/{id}`, `PATCH /apps/{id}/placement`). Carries no
/// middleware — the host wraps it with its bearer gate.
pub fn gated_router(state: Arc<AppsState>) -> Router {
    let (router, _spec) = handlers::gated_openapi_router().split_for_parts();
    router.with_state(state)
}

/// Build the launch route (`POST /apps/{id}`), mounted **ungated** at the router
/// level: the host puts it behind only its network (loopback-peer) gate, and the
/// launch handler owner-gates the loopback popup internally via [`OwnerAuth`]
/// while a forwarded launch rides the front trust boundary.
pub fn launch_router(state: Arc<AppsState>) -> Router {
    let (router, _spec) = handlers::launch_openapi_router().split_for_parts();
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

    /// The full apps surface as one document — every endpoint the TS `AppsApi`
    /// client speaks. `info` is set explicitly so the committed snapshot doesn't
    /// churn with the crate version. Test-only — nothing serves the spec at
    /// runtime.
    fn openapi_spec() -> utoipa::openapi::OpenApi {
        let combined =
            OpenApiRouter::with_openapi(ApiDoc::openapi()).merge(super::handlers::openapi_router());
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
