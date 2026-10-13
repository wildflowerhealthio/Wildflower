//! Guards the FHIR web UI's session cookie, and presents the session's bearer
//! for the browser that holds it. The UI (`helios-ui`) keeps its signed-in
//! user's tokens server-side and gives the browser only the `hfs_session`
//! cookie, so the UI's own FHIR calls reach the server with a cookie and no
//! `Authorization`. In front of both the UI's routes and the FHIR router's
//! bearer gate, this:
//!
//! - refuses, `403`, a write (any method but `GET`, `HEAD`, `OPTIONS`,
//!   `TRACE`) carrying the cookie unless it comes from the served origin. The
//!   UI's routes sit outside the gate and act as the session's user on the
//!   cookie alone, so this is what keeps another page from writing through
//!   them;
//! - turns the cookie of a request from the served origin into the session's
//!   bearer, so the gate checks it like any other token (revocation included).
//!   A request that brings its own `Authorization` keeps it. A read from
//!   anywhere else passes without one: a `/ui` page a link opens still
//!   renders, and the FHIR API's gate refuses it.
//!
//! Same-origin, not same-site: every server's domain is a subdomain of the
//! relay's, under `wildflowerhealth.io`, and neither is a public suffix, so a
//! page on another server behind the same relay, or on `wildflowerhealth.io`,
//! is same-site to this one. Its form posts carry the `SameSite=Lax` cookie,
//! and would ride the owner's session if same-site were enough. CORS never
//! allows credentials, so no other origin reads a response the cookie rode on,
//! and only a request a page can send without a preflight (a form or text
//! `POST`) needs refusing here.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use helios_auth::{cookie_value, AccessOutcome, SessionStore, SESSION_COOKIE};
use url::Url;
use wildflowerhealthio_authorization_server::ensure_bearer_header;
use wildflowerhealthio_shared_structures::origin_string;
use wildflowerhealthio_shared_structures::served_origin::served_base_url_for;

/// What the middleware reads: the UI's sessions, and the loopback base URL,
/// the served origin of a request with no `Forwarded` (see
/// [`served_base_url_for`]).
pub(crate) struct UiSessionBearerConfig {
    pub(crate) ui_sessions: Arc<SessionStore>,
    pub(crate) loopback_base_url: Url,
}

/// The middleware: a write carrying the session cookie from anywhere but the
/// served origin is refused. With no `Authorization` of its own, a request
/// from the served origin carrying a live session's cookie gets
/// `Authorization: Bearer <the session's access token>`. Anything else passes
/// as it came, for the gate to judge.
pub(crate) async fn present_ui_session_bearer(
    State(config): State<Arc<UiSessionBearerConfig>>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(session_id) = cookie_value(request.headers(), SESSION_COOKIE) else {
        return next.run(request).await;
    };
    if !is_from_served_origin(
        request.method(),
        request.headers(),
        &config.loopback_base_url,
    ) {
        if request.method().is_safe() {
            return next.run(request).await;
        }
        return (
            StatusCode::FORBIDDEN,
            "a write carrying the FHIR web UI's session must come from this server's origin",
        )
            .into_response();
    }
    if request.headers().contains_key(header::AUTHORIZATION) {
        return next.run(request).await;
    }
    let AccessOutcome::Token(access_token) = config.ui_sessions.access_token(&session_id).await
    else {
        return next.run(request).await;
    };
    let Ok(bearer) = HeaderValue::from_str(&format!("Bearer {access_token}")) else {
        tracing::error!("a UI session's access token is not a valid header value");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    ensure_bearer_header(request.headers_mut(), &bearer);
    next.run(request).await
}

/// Whether the browser says the request came from a page on the served
/// origin. Each header a browser sends must agree:
///
/// - `Sec-Fetch-Site`, when sent, is `same-origin`, or `none` for the user's
///   own navigation (a typed URL or a bookmark);
/// - `Origin`, when sent, is the served origin.
///
/// A write must send `Origin`: every browser does on a `POST`, including one
/// too old to send `Sec-Fetch-Site`. A read needn't, since a browser leaves it
/// off a same-origin `GET`. A `Forwarded` the served origin can't be read from
/// matches no `Origin`.
fn is_from_served_origin(method: &Method, headers: &HeaderMap, loopback_base_url: &Url) -> bool {
    if let Some(fetch_site) = headers.get("sec-fetch-site") {
        let is_same_origin = fetch_site.to_str().is_ok_and(|fetch_site| {
            fetch_site.eq_ignore_ascii_case("same-origin")
                || fetch_site.eq_ignore_ascii_case("none")
        });
        if !is_same_origin {
            return false;
        }
    }
    match headers.get(header::ORIGIN) {
        Some(request_origin) => {
            served_base_url_for(headers, loopback_base_url).is_some_and(|served_base_url| {
                request_origin
                    .to_str()
                    .is_ok_and(|request_origin| request_origin == origin_string(&served_base_url))
            })
        }
        None => method.is_safe(),
    }
}

#[cfg(test)]
mod tests {
    use super::{present_ui_session_bearer, UiSessionBearerConfig};
    use axum::body::{to_bytes, Body};
    use axum::extract::Request;
    use axum::http::{header, HeaderMap, Method, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use chrono::Utc;
    use helios_auth::{Session, SessionPrincipal, SessionStore};
    use std::sync::Arc;
    use tower::ServiceExt;

    const SERVED_ORIGIN: &str = "https://ruth.relay.example";
    const FORWARDED: &str = "for=192.0.2.1;host=ruth.relay.example;proto=https";
    const LOOPBACK_ORIGIN: &str = "http://127.0.0.1:8080";
    const SIBLING_ORIGIN: &str = "https://evil.relay.example";
    const SESSION_COOKIE: (&str, &str) = ("cookie", "hfs_session=session-1");

    /// The middleware's config: one live session, `session-1`, whose access
    /// token is `session-token`.
    fn config_with_a_session() -> Arc<UiSessionBearerConfig> {
        let loopback_base_url = url::Url::parse(LOOPBACK_ORIGIN).expect("loopback");
        let store = SessionStore::new(wildflowerhealthio_fhir_r4::ui_login_config(
            &url::Url::parse(SERVED_ORIGIN).expect("origin"),
            &loopback_base_url,
            "fhir-ui-client",
        ));
        store.insert(Session {
            id: "session-1".to_string(),
            principal: SessionPrincipal {
                subject: "fhir-ui-client".to_string(),
                issuer: SERVED_ORIGIN.to_string(),
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
        Arc::new(UiSessionBearerConfig {
            ui_sessions: Arc::new(store),
            loopback_base_url,
        })
    }

    /// What the middleware made of a request: its status, and the
    /// `Authorization` the router behind it saw, if the request got that far
    /// and carried one.
    async fn respond(method: Method, headers: &[(&str, &str)]) -> (StatusCode, Option<String>) {
        async fn authorization(headers: HeaderMap) -> String {
            headers
                .get(header::AUTHORIZATION)
                .map(|value| value.to_str().expect("ascii").to_string())
                .unwrap_or_default()
        }
        let router = Router::new()
            .route("/Patient", get(authorization).post(authorization))
            .layer(axum::middleware::from_fn_with_state(
                config_with_a_session(),
                present_ui_session_bearer,
            ));
        let mut request = Request::builder().method(method).uri("/Patient");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = router
            .oneshot(request.body(Body::empty()).expect("request"))
            .await
            .expect("infallible");
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let seen = String::from_utf8(body.to_vec()).expect("utf-8");
        let authorization = (status == StatusCode::OK && !seen.is_empty()).then_some(seen);
        (status, authorization)
    }

    fn presented() -> (StatusCode, Option<String>) {
        (StatusCode::OK, Some("Bearer session-token".to_string()))
    }

    fn passed_without_a_bearer() -> (StatusCode, Option<String>) {
        (StatusCode::OK, None)
    }

    fn refused() -> (StatusCode, Option<String>) {
        (StatusCode::FORBIDDEN, None)
    }

    #[tokio::test]
    async fn a_read_from_the_served_origin_gets_the_sessions_bearer() {
        let cases: [&[(&str, &str)]; 4] = [
            &[
                SESSION_COOKIE,
                ("forwarded", FORWARDED),
                ("sec-fetch-site", "same-origin"),
            ],
            &[
                SESSION_COOKIE,
                ("forwarded", FORWARDED),
                ("sec-fetch-site", "none"),
            ],
            // A browser too old to send `Sec-Fetch-Site`, and no `Origin` on a
            // same-origin `GET`.
            &[SESSION_COOKIE, ("forwarded", FORWARDED)],
            &[
                SESSION_COOKIE,
                ("forwarded", FORWARDED),
                ("origin", SERVED_ORIGIN),
            ],
        ];
        for headers in cases {
            assert_eq!(
                respond(Method::GET, headers).await,
                presented(),
                "{headers:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_write_from_the_served_origin_gets_the_sessions_bearer() {
        let cases: [&[(&str, &str)]; 3] = [
            &[
                SESSION_COOKIE,
                ("forwarded", FORWARDED),
                ("sec-fetch-site", "same-origin"),
                ("origin", SERVED_ORIGIN),
            ],
            // A browser too old to send `Sec-Fetch-Site`.
            &[
                SESSION_COOKIE,
                ("forwarded", FORWARDED),
                ("origin", SERVED_ORIGIN),
            ],
            // A direct loopback caller's served origin is loopback.
            &[
                SESSION_COOKIE,
                ("sec-fetch-site", "same-origin"),
                ("origin", LOOPBACK_ORIGIN),
            ],
        ];
        for headers in cases {
            assert_eq!(
                respond(Method::POST, headers).await,
                presented(),
                "{headers:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_write_from_anywhere_else_carrying_the_cookie_is_refused() {
        let cases: [&[(&str, &str)]; 7] = [
            // Another server behind the same relay.
            &[
                SESSION_COOKIE,
                ("forwarded", FORWARDED),
                ("sec-fetch-site", "same-site"),
                ("origin", SIBLING_ORIGIN),
            ],
            &[
                SESSION_COOKIE,
                ("forwarded", FORWARDED),
                ("sec-fetch-site", "cross-site"),
                ("origin", SIBLING_ORIGIN),
            ],
            // A browser too old to send `Sec-Fetch-Site`.
            &[
                SESSION_COOKIE,
                ("forwarded", FORWARDED),
                ("origin", SIBLING_ORIGIN),
            ],
            // A sandboxed page.
            &[SESSION_COOKIE, ("forwarded", FORWARDED), ("origin", "null")],
            // `Sec-Fetch-Site` and `Origin` must both agree.
            &[
                SESSION_COOKIE,
                ("forwarded", FORWARDED),
                ("sec-fetch-site", "same-origin"),
                ("origin", SIBLING_ORIGIN),
            ],
            // Not saying where it came from.
            &[SESSION_COOKIE, ("forwarded", FORWARDED)],
            // A `Forwarded` the served origin can't be read from.
            &[
                SESSION_COOKIE,
                ("forwarded", "for=192.0.2.1;host=\"a/b\";proto=https"),
                ("origin", SERVED_ORIGIN),
            ],
        ];
        for headers in cases {
            assert_eq!(
                respond(Method::POST, headers).await,
                refused(),
                "{headers:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_read_from_anywhere_else_passes_without_the_sessions_bearer() {
        let cases: [&[(&str, &str)]; 2] = [
            &[
                SESSION_COOKIE,
                ("forwarded", FORWARDED),
                ("sec-fetch-site", "same-site"),
            ],
            &[
                SESSION_COOKIE,
                ("forwarded", FORWARDED),
                ("origin", SIBLING_ORIGIN),
            ],
        ];
        for headers in cases {
            assert_eq!(
                respond(Method::GET, headers).await,
                passed_without_a_bearer(),
                "{headers:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_write_without_the_cookie_passes_for_the_gate_to_judge() {
        assert_eq!(
            respond(
                Method::POST,
                &[("forwarded", FORWARDED), ("origin", SIBLING_ORIGIN)]
            )
            .await,
            passed_without_a_bearer()
        );
    }

    #[tokio::test]
    async fn a_request_s_own_authorization_wins_over_its_cookie() {
        assert_eq!(
            respond(
                Method::GET,
                &[
                    SESSION_COOKIE,
                    ("forwarded", FORWARDED),
                    ("sec-fetch-site", "same-origin"),
                    ("authorization", "Bearer its-own"),
                ]
            )
            .await,
            (StatusCode::OK, Some("Bearer its-own".to_string()))
        );
    }

    #[tokio::test]
    async fn an_unknown_session_presents_nothing() {
        assert_eq!(
            respond(
                Method::GET,
                &[
                    ("cookie", "hfs_session=no-such-session"),
                    ("sec-fetch-site", "same-origin"),
                ]
            )
            .await,
            passed_without_a_bearer()
        );
    }
}
