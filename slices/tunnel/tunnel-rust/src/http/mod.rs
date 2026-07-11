//! The tunnel slice's HTTP surface. The only crate-facing surface is
//! [`router`] and [`TunnelState`]; the route files are private implementation
//! detail behind the route table.

mod errors;
mod routes;
mod state;

pub use state::TunnelState;

use std::sync::Arc;

use axum::Router;
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;

/// Base `OpenAPI` document; the collected routes fill in paths + components.
#[derive(OpenApi)]
struct ApiDoc;

/// The `/tunnel` surface as an `OpenApiRouter`, so the spec is collected from
/// the same routes that serve traffic (mirrors `gatekeeper-rust`).
fn documented_router() -> OpenApiRouter<Arc<TunnelState>> {
    OpenApiRouter::with_openapi(ApiDoc::openapi()).merge(routes::openapi_router())
}

/// Build the tunnel's `/tunnel` router (GET + PUT) over a [`TunnelState`]. The
/// module owns its mount path so the caller just `.merge()`s.
pub fn router(state: Arc<TunnelState>) -> Router {
    let (router, _spec) = documented_router().split_for_parts();
    router.with_state(state)
}

/// The tunnel admin `OpenAPI` document, collected from the same routes that
/// serve traffic. `info` is set explicitly so the committed snapshot doesn't
/// churn with the crate version. Two consumers read it: the committed snapshot
/// the TS spec-drift test guards, and the host's unified `/docs` Scalar surface,
/// which merges this with the other slices' documents.
#[must_use]
pub fn openapi_spec() -> utoipa::openapi::OpenApi {
    let (_router, mut spec) = documented_router().split_for_parts();
    spec.info = utoipa::openapi::Info::new("Tunnel Admin API", "0.0.0");
    spec
}

#[cfg(test)]
mod openapi_tests {
    /// The committed spec snapshot the TS spec-drift test reads.
    const SPEC_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/openapi/tunnel-admin.openapi.json"
    );

    /// The generated `OpenAPI` document must match the committed snapshot. A wire
    /// type change flips this red; regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p tunnel-rust openapi_spec_snapshot_is_up_to_date`.
    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        shared_structures_rust::openapi_snapshot::assert_up_to_date(
            &super::openapi_spec(),
            SPEC_PATH,
        );
    }
}
