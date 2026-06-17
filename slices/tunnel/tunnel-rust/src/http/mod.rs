//! The tunnel slice's HTTP surface. The only crate-facing surface is
//! [`router`] and [`TunnelState`]; the handler files are private
//! implementation detail behind the route table.

mod handlers;
mod response_templates;
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
    OpenApiRouter::with_openapi(ApiDoc::openapi()).merge(handlers::openapi_router())
}

/// Build the tunnel's `/tunnel` router (GET + PUT) over a [`TunnelState`]. The
/// module owns its mount path so the caller just `.merge()`s.
pub fn router(state: Arc<TunnelState>) -> Router {
    let (router, _spec) = documented_router().split_for_parts();
    router.with_state(state)
}

#[cfg(test)]
mod openapi_tests {
    use utoipa::openapi::Info;

    /// The committed spec snapshot the TS spec-drift test reads.
    const SPEC_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/openapi/tunnel-admin.openapi.json"
    );

    /// The tunnel admin `OpenAPI` document. `info` is set explicitly so the
    /// committed snapshot doesn't churn with the crate version. Test-only —
    /// nothing serves the spec at runtime.
    fn openapi_spec() -> utoipa::openapi::OpenApi {
        let (_router, mut spec) = super::documented_router().split_for_parts();
        spec.info = Info::new("Tunnel Admin API", "0.0.0");
        spec
    }

    /// The generated `OpenAPI` document must match the committed snapshot. A wire
    /// type change flips this red; regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p tunnel-rust openapi_spec_snapshot_is_up_to_date`.
    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        shared_structures_rust::openapi_snapshot::assert_up_to_date(&openapi_spec(), SPEC_PATH);
    }
}
