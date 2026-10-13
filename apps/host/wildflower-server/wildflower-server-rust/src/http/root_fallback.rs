//! The API router's fallback: a request no slice route claims reaches the FHIR
//! router when [`is_fhir_r4_route`](wildflowerhealthio_fhir_r4::is_fhir_r4_route)
//! says it is FHIR's, and the [`not_found`](super::not_found) page otherwise. A
//! browser opening the root is sent to the FHIR web UI, at `/ui`.
//! See "Served at the root, on FHIR paths only" in `fhir-r4-rust`'s
//! `docs/Capability Statement.md`.

use std::sync::Arc;

use axum::extract::Request;
use axum::http::Method;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect};
use axum::Router;
use wildflowerhealthio_fhir_r4::is_fhir_r4_route;

use super::not_found::{self, NotFoundConfig};

/// The path a browser opening the server's root is sent to: the FHIR web UI.
const ROOT_PAGE: &str = "/ui";

/// Build the fallback service: `fhir_r4` (already behind its bearer gate) for a
/// FHIR request, a redirect to [`ROOT_PAGE`] for a browser opening the root,
/// else the `404` over `not_found_config`. The choice is a layer
/// outside `fhir_r4`'s own, so a path that isn't FHIR's never reaches its gate
/// and is answered `404`, not `401`.
pub(crate) fn fallback(fhir_r4: Router, not_found_config: Arc<NotFoundConfig>) -> Router {
    let not_found = not_found::fallback(not_found_config);
    fhir_r4.layer(middleware::from_fn(move |request: Request, next: Next| {
        let not_found = not_found.clone();
        async move {
            if is_browser_opening_the_root(&request) {
                Redirect::to(ROOT_PAGE).into_response()
            } else if is_fhir_r4_route(request.method(), request.uri().path()) {
                next.run(request).await
            } else {
                let (parts, _body) = request.into_parts();
                not_found(parts.method, parts.headers, parts.uri).await
            }
        }
    }))
}

/// Whether `request` is a browser navigating to the server's root: a `GET` or
/// `HEAD` of `/` asking for HTML.
fn is_browser_opening_the_root(request: &Request) -> bool {
    matches!(*request.method(), Method::GET | Method::HEAD)
        && request.uri().path() == "/"
        && not_found::accepts_html(request.headers())
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
        response_to(method, path, None).await.status()
    }

    async fn response_to(
        method: &str,
        path: &str,
        accept: Option<&str>,
    ) -> axum::response::Response {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(accept) = accept {
            request = request.header("accept", accept);
        }
        router()
            .oneshot(request.body(Body::empty()).expect("request"))
            .await
            .expect("infallible")
    }

    /// A browser opening the server lands on the FHIR web UI; an API client
    /// asking for `/` still gets the `404`, and `POST /` is still FHIR's.
    #[tokio::test]
    async fn a_browser_opening_the_root_is_sent_to_the_ui() {
        let response = response_to("GET", "/", Some("text/html,*/*;q=0.8")).await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            response
                .headers()
                .get("location")
                .and_then(|value| value.to_str().ok()),
            Some("/ui")
        );
        assert_eq!(status_of("GET", "/").await, StatusCode::NOT_FOUND);
        assert_eq!(status_of("POST", "/").await, StatusCode::IM_A_TEAPOT);
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
