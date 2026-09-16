mod errors;
mod routes;

use std::sync::Arc;

use axum::Router;
use utoipa::OpenApi;
use utoipa_axum::router::OpenApiRouter;

use crate::live_bindings::state::OhifServerState;

#[derive(OpenApi)]
struct ApiDoc;

fn documented_router() -> OpenApiRouter<Arc<OhifServerState>> {
    OpenApiRouter::with_openapi(ApiDoc::openapi()).merge(routes::openapi_router())
}

pub fn router(state: Arc<OhifServerState>) -> Router {
    let (router, _spec) = documented_router().split_for_parts();
    router.with_state(state)
}

#[must_use]
pub fn openapi_spec() -> utoipa::openapi::OpenApi {
    let (_router, mut spec) = documented_router().split_for_parts();
    spec.info = utoipa::openapi::Info::new("OHIF Server API", "0.0.0");
    spec
}

#[cfg(test)]
mod openapi_tests {
    const SPEC_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/openapi/ohif-server.openapi.json"
    );

    #[test]
    fn openapi_spec_snapshot_is_up_to_date() {
        shared_structures_rust::openapi_snapshot::assert_up_to_date(
            &super::openapi_spec(),
            SPEC_PATH,
        );
    }
}
