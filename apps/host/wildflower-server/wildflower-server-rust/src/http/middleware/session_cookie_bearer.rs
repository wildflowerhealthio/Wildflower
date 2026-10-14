//! The cookie→bearer layer: the server's two session cookies, guarded, and
//! turned into the bearer the gates check. A browser on the server's own pages
//! sends a cookie and no `Authorization`, and the cookie stands for an access
//! token:
//!
//! - **`__Host-owner_session`**, the Owner's session, which `/oauth/sign-in`
//!   sets. Its value is the Owner's access token itself.
//! - **`hfs_session`**, the FHIR web UI's (`helios-ui`) session. The UI keeps
//!   its signed-in user's tokens server-side, so its value names a session in
//!   the UI's store, which holds the bearer.
//!
//! The host layers one instance per cookie around the whole API. For its
//! cookie, an instance:
//!
//! - refuses, `403`, a write (any method but `GET`, `HEAD`, `OPTIONS`,
//!   `TRACE`) carrying the cookie unless it comes from the served origin. The
//!   FHIR UI's routes sit outside the gate and act as the session's user on the
//!   cookie alone, and the Owner's cookie reaches every route, so this is what
//!   keeps another page from writing through either;
//! - turns the cookie of a request from the served origin into its bearer, so
//!   the gates check it like any other token (revocation included). A request
//!   that brings its own `Authorization` keeps it. A read from anywhere else
//!   passes without one: a `/ui` page a link opens still renders, and the gates
//!   refuse whatever else it asks for.
//!
//! No route is singled out: the token's scopes decide what it reaches.
//!
//! Same-origin, not same-site: every server's domain is a subdomain of the
//! relay's, under `wildflowerhealth.io`, and neither is a public suffix, so a
//! page on another server behind the same relay, or on `wildflowerhealth.io`,
//! is same-site to this one. Its form posts carry a `SameSite=Lax` cookie,
//! and would ride the session if same-site were enough. CORS never allows
//! credentials, so no other origin reads a response a cookie rode on, and only
//! a request a page can send without a preflight (a form or text `POST`) needs
//! refusing here.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use helios_auth::{cookie_value, AccessOutcome, SessionStore, SESSION_COOKIE};
use url::Url;
use wildflowerhealthio_authorization_server::{ensure_bearer_header, OWNER_SESSION_COOKIE};
use wildflowerhealthio_shared_structures::origin_string;
use wildflowerhealthio_shared_structures::served_origin::served_base_url_for;

/// A session cookie the layer guards, and where its bearer comes from.
pub(crate) enum SessionCookie {
    /// `__Host-owner_session`: its value is the Owner's access token.
    Owner,
    /// The FHIR web UI's `hfs_session`: its value names a session in the UI's
    /// store, which holds the session's access token.
    FhirUi(Arc<SessionStore>),
}

impl SessionCookie {
    /// The cookie's name.
    fn name(&self) -> &'static str {
        match self {
            SessionCookie::Owner => OWNER_SESSION_COOKIE,
            SessionCookie::FhirUi(_) => SESSION_COOKIE,
        }
    }

    /// The access token the cookie's `value` stands for, if any: an Owner
    /// cookie's own value, or the bearer of the UI session it names, while
    /// that session lives.
    async fn access_token(&self, value: String) -> Option<String> {
        match self {
            SessionCookie::Owner => (!value.is_empty()).then_some(value),
            SessionCookie::FhirUi(ui_sessions) => match ui_sessions.access_token(&value).await {
                AccessOutcome::Token(access_token) => Some(access_token),
                AccessOutcome::NoSession => None,
            },
        }
    }
}

/// What an instance of the layer reads: the cookie it guards, and the
/// loopback base URL, the served origin of a request with no `Forwarded` (see
/// [`served_base_url_for`]).
pub(crate) struct SessionCookieBearerConfig {
    pub(crate) session_cookie: SessionCookie,
    pub(crate) loopback_base_url: Url,
}

/// The middleware: a write carrying the session cookie from anywhere but the
/// served origin is refused. With no `Authorization` of its own, a request
/// from the served origin carrying a cookie that stands for an access token
/// gets `Authorization: Bearer <that token>`. Anything else passes as it came,
/// for the gates to judge.
pub(crate) async fn present_session_cookie_bearer(
    State(config): State<Arc<SessionCookieBearerConfig>>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(cookie) = cookie_value(request.headers(), config.session_cookie.name()) else {
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
            "a write carrying this server's session cookie must come from this server's origin",
        )
            .into_response();
    }
    if request.headers().contains_key(header::AUTHORIZATION) {
        return next.run(request).await;
    }
    let Some(access_token) = config.session_cookie.access_token(cookie).await else {
        return next.run(request).await;
    };
    let Ok(bearer) = HeaderValue::from_str(&format!("Bearer {access_token}")) else {
        tracing::error!(
            cookie = config.session_cookie.name(),
            "a session cookie's access token is not a valid header value"
        );
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
    use super::{present_session_cookie_bearer, SessionCookie, SessionCookieBearerConfig};
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

    /// A cookie the layer guards, as the tests send it: the layer's config,
    /// the `Cookie` header, and the bearer the layer presents for it.
    struct GuardedCookie {
        config: Arc<SessionCookieBearerConfig>,
        cookie: &'static str,
        bearer: &'static str,
    }

    fn loopback_base_url() -> url::Url {
        url::Url::parse(LOOPBACK_ORIGIN).expect("loopback")
    }

    /// The Owner's cookie, whose value is its token.
    fn owner_cookie() -> GuardedCookie {
        GuardedCookie {
            config: Arc::new(SessionCookieBearerConfig {
                session_cookie: SessionCookie::Owner,
                loopback_base_url: loopback_base_url(),
            }),
            cookie: "__Host-owner_session=owner-token",
            bearer: "Bearer owner-token",
        }
    }

    /// The FHIR web UI's cookie, naming its one live session, `session-1`,
    /// whose access token is `session-token`.
    fn fhir_ui_cookie() -> GuardedCookie {
        GuardedCookie {
            config: Arc::new(SessionCookieBearerConfig {
                session_cookie: SessionCookie::FhirUi(Arc::new(store_with_a_session())),
                loopback_base_url: loopback_base_url(),
            }),
            cookie: "hfs_session=session-1",
            bearer: "Bearer session-token",
        }
    }

    fn store_with_a_session() -> SessionStore {
        let store = SessionStore::new(wildflowerhealthio_fhir_r4::ui_login_config(
            &url::Url::parse(SERVED_ORIGIN).expect("origin"),
            &loopback_base_url(),
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
        store
    }

    /// Both cookies: every case in the table below runs against each.
    fn guarded_cookies() -> [GuardedCookie; 2] {
        [owner_cookie(), fhir_ui_cookie()]
    }

    /// What `config`'s layer made of a request: its status, and the
    /// `Authorization` the router behind it saw, if the request got that far
    /// and carried one.
    async fn respond(
        config: Arc<SessionCookieBearerConfig>,
        method: Method,
        headers: &[(&str, &str)],
    ) -> (StatusCode, Option<String>) {
        async fn authorization(headers: HeaderMap) -> String {
            headers
                .get(header::AUTHORIZATION)
                .map(|value| value.to_str().expect("ascii").to_string())
                .unwrap_or_default()
        }
        let router = Router::new()
            .route("/Patient", get(authorization).post(authorization))
            .layer(axum::middleware::from_fn_with_state(
                config,
                present_session_cookie_bearer,
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

    /// [`respond`] to a request carrying `guarded`'s cookie and `headers`.
    async fn respond_with_cookie(
        guarded: &GuardedCookie,
        method: Method,
        headers: &[(&str, &str)],
    ) -> (StatusCode, Option<String>) {
        let mut with_cookie = vec![("cookie", guarded.cookie)];
        with_cookie.extend_from_slice(headers);
        respond(guarded.config.clone(), method, &with_cookie).await
    }

    fn presented(guarded: &GuardedCookie) -> (StatusCode, Option<String>) {
        (StatusCode::OK, Some(guarded.bearer.to_string()))
    }

    fn passed_without_a_bearer() -> (StatusCode, Option<String>) {
        (StatusCode::OK, None)
    }

    fn refused() -> (StatusCode, Option<String>) {
        (StatusCode::FORBIDDEN, None)
    }

    #[tokio::test]
    async fn a_read_from_the_served_origin_gets_the_cookie_s_bearer() {
        let cases: [&[(&str, &str)]; 4] = [
            &[("forwarded", FORWARDED), ("sec-fetch-site", "same-origin")],
            &[("forwarded", FORWARDED), ("sec-fetch-site", "none")],
            // A browser too old to send `Sec-Fetch-Site`, and no `Origin` on a
            // same-origin `GET`.
            &[("forwarded", FORWARDED)],
            &[("forwarded", FORWARDED), ("origin", SERVED_ORIGIN)],
        ];
        for guarded in guarded_cookies() {
            for headers in cases {
                assert_eq!(
                    respond_with_cookie(&guarded, Method::GET, headers).await,
                    presented(&guarded),
                    "{} {headers:?}",
                    guarded.cookie
                );
            }
        }
    }

    #[tokio::test]
    async fn a_write_from_the_served_origin_gets_the_cookie_s_bearer() {
        let cases: [&[(&str, &str)]; 3] = [
            &[
                ("forwarded", FORWARDED),
                ("sec-fetch-site", "same-origin"),
                ("origin", SERVED_ORIGIN),
            ],
            // A browser too old to send `Sec-Fetch-Site`.
            &[("forwarded", FORWARDED), ("origin", SERVED_ORIGIN)],
            // A direct loopback caller's served origin is loopback.
            &[
                ("sec-fetch-site", "same-origin"),
                ("origin", LOOPBACK_ORIGIN),
            ],
        ];
        for guarded in guarded_cookies() {
            for headers in cases {
                assert_eq!(
                    respond_with_cookie(&guarded, Method::POST, headers).await,
                    presented(&guarded),
                    "{} {headers:?}",
                    guarded.cookie
                );
            }
        }
    }

    #[tokio::test]
    async fn a_write_from_anywhere_else_carrying_the_cookie_is_refused() {
        let cases: [&[(&str, &str)]; 7] = [
            // Another server behind the same relay.
            &[
                ("forwarded", FORWARDED),
                ("sec-fetch-site", "same-site"),
                ("origin", SIBLING_ORIGIN),
            ],
            &[
                ("forwarded", FORWARDED),
                ("sec-fetch-site", "cross-site"),
                ("origin", SIBLING_ORIGIN),
            ],
            // A browser too old to send `Sec-Fetch-Site`.
            &[("forwarded", FORWARDED), ("origin", SIBLING_ORIGIN)],
            // A sandboxed page.
            &[("forwarded", FORWARDED), ("origin", "null")],
            // `Sec-Fetch-Site` and `Origin` must both agree.
            &[
                ("forwarded", FORWARDED),
                ("sec-fetch-site", "same-origin"),
                ("origin", SIBLING_ORIGIN),
            ],
            // Not saying where it came from.
            &[("forwarded", FORWARDED)],
            // A `Forwarded` the served origin can't be read from.
            &[
                ("forwarded", "for=192.0.2.1;host=\"a/b\";proto=https"),
                ("origin", SERVED_ORIGIN),
            ],
        ];
        for guarded in guarded_cookies() {
            for headers in cases {
                assert_eq!(
                    respond_with_cookie(&guarded, Method::POST, headers).await,
                    refused(),
                    "{} {headers:?}",
                    guarded.cookie
                );
            }
        }
    }

    #[tokio::test]
    async fn a_read_from_anywhere_else_passes_without_the_cookie_s_bearer() {
        let cases: [&[(&str, &str)]; 2] = [
            &[("forwarded", FORWARDED), ("sec-fetch-site", "same-site")],
            &[("forwarded", FORWARDED), ("origin", SIBLING_ORIGIN)],
        ];
        for guarded in guarded_cookies() {
            for headers in cases {
                assert_eq!(
                    respond_with_cookie(&guarded, Method::GET, headers).await,
                    passed_without_a_bearer(),
                    "{} {headers:?}",
                    guarded.cookie
                );
            }
        }
    }

    #[tokio::test]
    async fn a_write_without_the_cookie_passes_for_the_gate_to_judge() {
        for guarded in guarded_cookies() {
            assert_eq!(
                respond(
                    guarded.config.clone(),
                    Method::POST,
                    &[("forwarded", FORWARDED), ("origin", SIBLING_ORIGIN)]
                )
                .await,
                passed_without_a_bearer(),
                "{}",
                guarded.cookie
            );
        }
    }

    #[tokio::test]
    async fn a_request_s_own_authorization_wins_over_its_cookie() {
        for guarded in guarded_cookies() {
            assert_eq!(
                respond_with_cookie(
                    &guarded,
                    Method::GET,
                    &[
                        ("forwarded", FORWARDED),
                        ("sec-fetch-site", "same-origin"),
                        ("authorization", "Bearer its-own"),
                    ]
                )
                .await,
                (StatusCode::OK, Some("Bearer its-own".to_string())),
                "{}",
                guarded.cookie
            );
        }
    }

    /// Each instance reads its own cookie only: the other cookie, alone, is
    /// neither presented nor guarded.
    #[tokio::test]
    async fn an_instance_ignores_the_other_cookie() {
        let [owner, fhir_ui] = guarded_cookies();
        for (instance, other) in [(&owner, &fhir_ui), (&fhir_ui, &owner)] {
            assert_eq!(
                respond(
                    instance.config.clone(),
                    Method::POST,
                    &[
                        ("cookie", other.cookie),
                        ("forwarded", FORWARDED),
                        ("origin", SIBLING_ORIGIN),
                    ]
                )
                .await,
                passed_without_a_bearer(),
                "{} under the {} layer",
                other.cookie,
                instance.cookie
            );
        }
    }

    #[tokio::test]
    async fn an_unknown_ui_session_presents_nothing() {
        assert_eq!(
            respond(
                fhir_ui_cookie().config,
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

    #[tokio::test]
    async fn an_empty_owner_cookie_presents_nothing() {
        assert_eq!(
            respond(
                owner_cookie().config,
                Method::GET,
                &[
                    ("cookie", "__Host-owner_session="),
                    ("sec-fetch-site", "same-origin"),
                ]
            )
            .await,
            passed_without_a_bearer()
        );
    }
}
