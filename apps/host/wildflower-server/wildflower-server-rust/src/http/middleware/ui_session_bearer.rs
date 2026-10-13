//! Presents a FHIR web UI session's bearer for the browser that holds it. The
//! UI (`helios-ui`) keeps its signed-in user's tokens server-side and gives
//! the browser only the `hfs_session` cookie, so the UI's own FHIR calls reach
//! the server with a cookie and no `Authorization`. In front of the FHIR
//! router's bearer gate, this turns a same-site request's cookie into the
//! session's bearer, so the gate checks it like any other token (revocation
//! included). A request that brings its own `Authorization` keeps it.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use helios_auth::{cookie_value, is_cross_site, AccessOutcome, SessionStore, SESSION_COOKIE};
use wildflowerhealthio_gatekeeper::ensure_bearer_header;

/// The middleware: with no `Authorization` of its own, a same-site request
/// carrying a live session's cookie gets `Authorization: Bearer <the session's
/// access token>`. A cross-site request never rides the cookie. Anything else
/// passes as it came, for the gate to judge.
pub(crate) async fn present_ui_session_bearer(
    State(ui_sessions): State<Arc<SessionStore>>,
    mut request: Request,
    next: Next,
) -> Response {
    if is_cross_site(request.headers()) {
        return next.run(request).await;
    }
    let Some(session_id) = cookie_value(request.headers(), SESSION_COOKIE) else {
        return next.run(request).await;
    };
    if request
        .headers()
        .contains_key(axum::http::header::AUTHORIZATION)
    {
        return next.run(request).await;
    }
    let AccessOutcome::Token(access_token) = ui_sessions.access_token(&session_id).await else {
        return next.run(request).await;
    };
    let Ok(bearer) = HeaderValue::from_str(&format!("Bearer {access_token}")) else {
        tracing::error!("a UI session's access token is not a valid header value");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    ensure_bearer_header(request.headers_mut(), &bearer);
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::present_ui_session_bearer;
    use axum::body::{to_bytes, Body};
    use axum::extract::Request;
    use axum::http::{header, HeaderMap};
    use axum::routing::get;
    use axum::Router;
    use chrono::Utc;
    use helios_auth::{Session, SessionPrincipal, SessionStore};
    use std::sync::Arc;
    use tower::ServiceExt;

    /// A store holding one live session, `session-1`, whose access token is
    /// `session-token`.
    fn store_with_a_session() -> Arc<SessionStore> {
        let store = SessionStore::new(wildflowerhealthio_fhir_r4::ui_login_config(
            &url::Url::parse("https://ruth.relay.example").expect("origin"),
            &url::Url::parse("http://127.0.0.1:8080").expect("loopback"),
            "fhir-ui-client",
        ));
        store.insert(Session {
            id: "session-1".to_string(),
            principal: SessionPrincipal {
                subject: "fhir-ui-client".to_string(),
                issuer: "https://ruth.relay.example".to_string(),
                name: None,
                preferred_username: None,
                email: None,
                picture: None,
            },
            access_token: "session-token".to_string(),
            access_expires_at: std::time::Instant::now() + std::time::Duration::from_secs(3600),
            refresh_token: None,
            id_token: None,
            last_seen: std::time::Instant::now(),
            created_at: Utc::now(),
        });
        Arc::new(store)
    }

    /// The `Authorization` header the router behind the middleware saw, if any.
    async fn authorization_seen(headers: &[(&str, &str)]) -> Option<String> {
        let router = Router::new()
            .route(
                "/Patient",
                get(|headers: HeaderMap| async move {
                    headers
                        .get(header::AUTHORIZATION)
                        .map(|value| value.to_str().expect("ascii").to_string())
                        .unwrap_or_default()
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                store_with_a_session(),
                present_ui_session_bearer,
            ));
        let mut request = Request::get("/Patient");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = router
            .oneshot(request.body(Body::empty()).expect("request"))
            .await
            .expect("infallible");
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let seen = String::from_utf8(body.to_vec()).expect("utf-8");
        (!seen.is_empty()).then_some(seen)
    }

    #[tokio::test]
    async fn a_live_sessions_cookie_becomes_its_bearer() {
        assert_eq!(
            authorization_seen(&[("cookie", "hfs_session=session-1")]).await,
            Some("Bearer session-token".to_string())
        );
    }

    #[tokio::test]
    async fn a_request_s_own_authorization_wins_over_its_cookie() {
        assert_eq!(
            authorization_seen(&[
                ("cookie", "hfs_session=session-1"),
                ("authorization", "Bearer its-own"),
            ])
            .await,
            Some("Bearer its-own".to_string())
        );
    }

    #[tokio::test]
    async fn a_cross_site_request_never_rides_the_cookie() {
        assert_eq!(
            authorization_seen(&[
                ("cookie", "hfs_session=session-1"),
                ("sec-fetch-site", "cross-site"),
            ])
            .await,
            None
        );
    }

    #[tokio::test]
    async fn an_unknown_session_presents_nothing() {
        assert_eq!(
            authorization_seen(&[("cookie", "hfs_session=no-such-session")]).await,
            None
        );
        assert_eq!(authorization_seen(&[]).await, None);
    }
}
