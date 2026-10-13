//! The API router's fallback: a request no slice route claims reaches the FHIR
//! router when [`is_fhir_r4_route`](wildflowerhealthio_fhir_r4::is_fhir_r4_route)
//! says it is FHIR's, and the [`not_found`](super::not_found) page otherwise.
//! See "Served at the root, on FHIR paths only" in `fhir-r4-rust`'s
//! `docs/Capability Statement.md`.

use std::sync::Arc;

use axum::extract::Request;
use axum::middleware::{self, Next};
use axum::Router;
use wildflowerhealthio_fhir_r4::is_fhir_r4_route;

use super::not_found::{self, NotFoundConfig};

/// Build the fallback service: `fhir_r4` (already behind its bearer gate) for a
/// FHIR request, else the `404` over `not_found_config`. The choice is a layer
/// outside `fhir_r4`'s own, so a path that isn't FHIR's never reaches its gate
/// and is answered `404`, not `401`.
pub(crate) fn fallback(fhir_r4: Router, not_found_config: Arc<NotFoundConfig>) -> Router {
    let not_found = not_found::fallback(not_found_config);
    fhir_r4.layer(middleware::from_fn(move |request: Request, next: Next| {
        let not_found = not_found.clone();
        async move {
            if is_fhir_r4_route(request.method(), request.uri().path()) {
                next.run(request).await
            } else {
                let (parts, _body) = request.into_parts();
                not_found(parts.method, parts.headers, parts.uri).await
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::fallback;
    use crate::http::not_found::NotFoundConfig;
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::StatusCode;
    use axum::Router;
    use std::sync::Arc;
    use tower::ServiceExt;
    use url::Url;
    use wildflowerhealthio_shared_structures::launcher::LauncherBase;

    /// A host router with one slice route, over a stand-in FHIR router that
    /// answers every request it gets with `418`.
    fn router() -> Router {
        let fhir_r4 = Router::new().fallback(|| async { StatusCode::IM_A_TEAPOT });
        let not_found_config = Arc::new(NotFoundConfig {
            launcher_base: LauncherBase::parse("https://launcher.test/launcher/")
                .expect("valid base"),
            loopback_base_url: Url::parse("http://127.0.0.1:8080/").expect("valid loopback"),
        });
        Router::new()
            .route("/apps", axum::routing::get(|| async { StatusCode::OK }))
            .fallback_service(fallback(fhir_r4, not_found_config))
    }

    async fn status_of(method: &str, path: &str) -> StatusCode {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .body(Body::empty())
            .expect("request");
        router()
            .oneshot(request)
            .await
            .expect("infallible")
            .status()
    }

    #[tokio::test]
    async fn fhir_requests_reach_the_fhir_router() {
        for (method, path) in [
            ("GET", "/Patient/p1"),
            ("POST", "/"),
            ("GET", "/metadata"),
            ("GET", "/$export"),
        ] {
            assert_eq!(
                status_of(method, path).await,
                StatusCode::IM_A_TEAPOT,
                "{method} {path} is FHIR's"
            );
        }
    }

    /// A slice's own route still wins, and a path nobody serves is the host's
    /// `404`, not a FHIR error.
    #[tokio::test]
    async fn other_requests_keep_the_host_routes_and_not_found() {
        assert_eq!(status_of("GET", "/apps").await, StatusCode::OK);
        for path in ["/nowhere", "/fhir-r4/Patient", "/patient/p1"] {
            assert_eq!(
                status_of("GET", path).await,
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
    }
}
