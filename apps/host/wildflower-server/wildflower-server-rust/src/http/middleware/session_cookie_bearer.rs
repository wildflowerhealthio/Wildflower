//! The cookie→bearer layer: the server's two session cookies, guarded, and
//! turned into the bearer the gates check. A browser on the server's own pages
//! sends a cookie and no `Authorization`, and the cookie stands for an access
//! token:
//!
//! - **`__Host-owner_browser_session`**, an Owner browser's session, which
//!   `/oauth/sign-in` sets. Its value is the Owner browser's access token
//!   itself.
//! - **`hfs_session`**, the FHIR web UI's (`helios-ui`) session. The UI keeps
//!   its signed-in user's tokens server-side, so its value names a session in
//!   the UI's store, which holds the bearer.
//!
//! [`present_session_cookie_bearers`] layers one instance per cookie around
//! the whole API, the FHIR web UI's outermost: a request carrying both cookies
//! gets `hfs_session`'s bearer, the more specific session, and the UI runs as
//! its own signed-in user. A page that acts as the Owner (the consent card)
//! says so with `Wildflower-Session: owner-browser`
//! ([`SESSION_HEADER`], [`OWNER_BROWSER_SESSION_HEADER_VALUE`]): the UI's
//! instance then presents nothing, so the request gets the Owner browser
//! session's bearer, or none if that cookie is missing or its session has
//! ended; it never falls back to `hfs_session`'s. Any other value is read as
//! no header. For its cookie, an instance:
//!
//! - refuses, `403`, a write (any method but `GET`, `HEAD`, `OPTIONS`,
//!   `TRACE`) carrying the cookie unless it comes from the server's origin. The
//!   FHIR UI's routes sit outside the gate and act as the session's user on the
//!   cookie alone, and an Owner browser's cookie reaches every route, so this
//!   is what keeps another page from writing through either;
//! - turns the cookie of a request from the server's origin into its bearer, so
//!   the gates check it like any other token (revocation included). A request
//!   that brings its own `Authorization` keeps it. A read from anywhere else
//!   passes without one: a `/ui` page a link opens still renders, and the gates
//!   refuse whatever else it asks for;
//! - passes a request whose cookie stands for no live session as if the cookie
//!   weren't sent. An Owner browser's session has ended once the gates would
//!   refuse its token (expired, or revoked by `jti` or subject); the response
//!   then clears the cookie, which is `HttpOnly`, so no script on the page can.
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
//!
//! The header needs no guard of its own. It is not CORS-safelisted, so another
//! origin's page can only send it after a preflight, and since CORS never
//! allows credentials, the browser sends that request without either cookie.
//! Nor does it widen what a request may do: it only picks which of the
//! browser's own sessions the request presents, and only from the server's
//! origin, which already reaches either.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Router;
use helios_auth::{cookie_value, AccessOutcome, SessionStore, SESSION_COOKIE};
use url::Url;
use wildflowerhealthio_authorization_server::domain::token::VerifyError;
use wildflowerhealthio_authorization_server::{
    ensure_bearer_header, owner_browser_session_clearing_set_cookie,
    owner_browser_session_has_ended, AuthorizationServerState, OWNER_BROWSER_SESSION_COOKIE,
    OWNER_BROWSER_SESSION_HEADER_VALUE, SESSION_HEADER,
};
use wildflowerhealthio_shared_structures::origin_string;

/// A session cookie the layer guards, and where its bearer comes from.
pub(crate) enum SessionCookie {
    /// `__Host-owner_browser_session`: its value is an Owner browser's access
    /// token, checked against the authorization server's state before it is
    /// presented.
    OwnerBrowser(Arc<AuthorizationServerState>),
    /// The FHIR web UI's `hfs_session`: its value names a session in the UI's
    /// store, which holds the session's access token.
    FhirUi(Arc<SessionStore>),
}

/// What a session cookie's value stands for.
enum CookieSession {
    /// A live session: its access token is the request's bearer.
    Live(String),
    /// No session: the request passes as if the cookie weren't sent.
    Absent,
    /// An Owner browser session that has ended: the request passes as if the
    /// cookie weren't sent, and the response clears it.
    Ended,
}

impl SessionCookie {
    /// The cookie's name.
    fn name(&self) -> &'static str {
        match self {
            SessionCookie::OwnerBrowser(_) => OWNER_BROWSER_SESSION_COOKIE,
            SessionCookie::FhirUi(_) => SESSION_COOKIE,
        }
    }

    /// Whether the page sending `headers` chose another session than this
    /// cookie's: `hfs_session` when it asks for the Owner browser's.
    fn is_set_aside_by(&self, headers: &HeaderMap) -> bool {
        matches!(self, SessionCookie::FhirUi(_))
            && headers
                .get(SESSION_HEADER)
                .is_some_and(|session| session == OWNER_BROWSER_SESSION_HEADER_VALUE)
    }

    /// The session the cookie's `value` stands for: an Owner browser
    /// cookie's own token, unless its session has ended, or the bearer of the
    /// UI session it names, while that session lives.
    ///
    /// # Errors
    ///
    /// The authorization server's server-side [`VerifyError`]s, when it can't
    /// check whether an Owner browser session has ended.
    async fn session(&self, value: String) -> Result<CookieSession, VerifyError> {
        Ok(match self {
            SessionCookie::OwnerBrowser(authorization_server) => {
                if owner_browser_session_has_ended(authorization_server, &value)? {
                    CookieSession::Ended
                } else {
                    CookieSession::Live(value)
                }
            }
            SessionCookie::FhirUi(ui_sessions) => match ui_sessions.access_token(&value).await {
                AccessOutcome::Token(access_token) => CookieSession::Live(access_token),
                AccessOutcome::NoSession => CookieSession::Absent,
            },
        })
    }
}

/// What an instance of the layer reads: the cookie it guards, and the
/// server's origin, the only origin a request carrying it may come from.
pub(crate) struct SessionCookieBearerConfig {
    pub(crate) session_cookie: SessionCookie,
    /// The server's bare origin, `https://<domain>`, spelled as a browser's
    /// `Origin` header spells it ([`origin_string`]).
    pub(crate) server_origin: String,
}

/// Wrap `router` in the layer once per session cookie: an Owner browser's,
/// checked against `authorization_server`, and the FHIR web UI's, read from
/// `ui_sessions`. The UI's is outermost, so it runs first: a request carrying
/// both cookies gets `hfs_session`'s bearer, and the Owner browser instance
/// then finds `Authorization` set and leaves it, unless the request asks for
/// the Owner browser session, when the UI's instance leaves it to the inner
/// one.
pub(crate) fn present_session_cookie_bearers(
    router: Router,
    authorization_server: Arc<AuthorizationServerState>,
    ui_sessions: Arc<SessionStore>,
    server_origin: &Url,
) -> Router {
    let server_origin = origin_string(server_origin);
    let session_cookie_bearer = |session_cookie| {
        axum::middleware::from_fn_with_state(
            Arc::new(SessionCookieBearerConfig {
                session_cookie,
                server_origin: server_origin.clone(),
            }),
            present_session_cookie_bearer,
        )
    };
    router
        .layer(session_cookie_bearer(SessionCookie::OwnerBrowser(
            authorization_server,
        )))
        .layer(session_cookie_bearer(SessionCookie::FhirUi(ui_sessions)))
}

/// The middleware: a write carrying the session cookie from anywhere but the
/// server's origin is refused. With no `Authorization` of its own, a request
/// from the server's origin carrying a cookie that stands for a live session
/// gets `Authorization: Bearer <its token>`, and one whose Owner browser
/// session has ended passes without it and has the cookie cleared. One whose
/// Owner browser session can't be judged, because the authorization server's
/// stores can't be read, is a 500. One that asks for another session than the
/// cookie's passes without it. Anything else passes as it came, for the gates
/// to judge.
pub(crate) async fn present_session_cookie_bearer(
    State(config): State<Arc<SessionCookieBearerConfig>>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(cookie) = cookie_value(request.headers(), config.session_cookie.name()) else {
        return next.run(request).await;
    };
    if !is_from_server_origin(request.method(), request.headers(), &config.server_origin) {
        if request.method().is_safe() {
            return next.run(request).await;
        }
        return (
            StatusCode::FORBIDDEN,
            "a write carrying this server's session cookie must come from this server's origin",
        )
            .into_response();
    }
    if request.headers().contains_key(header::AUTHORIZATION)
        || config.session_cookie.is_set_aside_by(request.headers())
    {
        return next.run(request).await;
    }
    let session = match config.session_cookie.session(cookie).await {
        Ok(session) => session,
        Err(error) => {
            tracing::error!(
                cookie = config.session_cookie.name(),
                error = %error,
                "couldn't check whether a session cookie's session has ended"
            );
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    match session {
        CookieSession::Live(access_token) => {
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
        CookieSession::Absent => next.run(request).await,
        CookieSession::Ended => {
            let mut response = next.run(request).await;
            let clearing = HeaderValue::from_str(&owner_browser_session_clearing_set_cookie())
                .expect("the clearing Set-Cookie is a fixed, valid header value");
            response.headers_mut().append(header::SET_COOKIE, clearing);
            response
        }
    }
}

/// Whether the browser says the request came from a page on the server's
/// origin. Each header a browser sends must agree:
///
/// - `Sec-Fetch-Site`, when sent, is `same-origin`, or `none` for the user's
///   own navigation (a typed URL or a bookmark);
/// - `Origin`, when sent, is the server's origin.
///
/// A write must send `Origin`: every browser does on a `POST`, including one
/// too old to send `Sec-Fetch-Site`. A read needn't, since a browser leaves it
/// off a same-origin `GET`.
fn is_from_server_origin(method: &Method, headers: &HeaderMap, server_origin: &str) -> bool {
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
        Some(request_origin) => request_origin
            .to_str()
            .is_ok_and(|request_origin| request_origin == server_origin),
        None => method.is_safe(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        present_session_cookie_bearer, present_session_cookie_bearers, SessionCookie,
        SessionCookieBearerConfig,
    };
    use axum::body::{to_bytes, Body};
    use axum::extract::Request;
    use axum::http::{header, HeaderMap, Method, StatusCode};
    use axum::response::Response;
    use axum::routing::get;
    use axum::Router;
    use chrono::{Duration, Utc};
    use helios_auth::{Session, SessionPrincipal, SessionStore};
    use std::sync::Arc;
    use tokio::sync::watch;
    use tower::ServiceExt;
    use wildflowerhealthio_authorization_server::domain::token::{mint_access_token, NewJwtArgs};
    use wildflowerhealthio_authorization_server::{
        setup_authorization_server, AdmitEveryAuthorizationStart, AuthorizationServerConfig,
        AuthorizationServerState, GrantStore, SqliteGrantStore, OWNER_BROWSER_CLIENT_ID,
    };
    use wildflowerhealthio_persistence::{Connection, DieselPool};
    use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
    use wildflowerhealthio_shared_structures::launcher::LauncherBase;
    use wildflowerhealthio_token_revocation::RevocationStore;

    const SERVER_ORIGIN: &str = "https://ruth.relay.example";
    const SIBLING_ORIGIN: &str = "https://evil.relay.example";

    /// A cookie the layer guards, as the tests send it: the layer's config,
    /// the `Cookie` header, and the bearer the layer presents for it.
    struct GuardedCookie {
        config: Arc<SessionCookieBearerConfig>,
        cookie: String,
        bearer: String,
    }

    fn server_origin() -> url::Url {
        url::Url::parse(SERVER_ORIGIN).expect("origin")
    }

    /// A real authorization server over an in-memory database, whose state
    /// judges an Owner browser's token, and the revocation store it reads.
    struct AuthorizationServerFixture {
        state: Arc<AuthorizationServerState>,
        pool: DieselPool,
        revocation_store: RevocationStore,
    }

    impl AuthorizationServerFixture {
        fn new() -> Self {
            let pool = wildflowerhealthio_persistence::open_in_memory_pool().expect("pool");
            let revocation_store =
                RevocationStore::new(Connection::open_in_memory().expect("revocation db"))
                    .expect("revocation store");
            let config = AuthorizationServerConfig {
                server_origin: server_origin(),
                host_app_client_scopes:
                    wildflowerhealthio_authorization_server::default_host_app_client_scopes(),
                wildflower_host_app_client_id:
                    wildflowerhealthio_authorization_server::default_wildflower_host_app_client_id(),
                fhir_ui_client_id: "fhir-ui-client".to_string(),
                launcher_base: LauncherBase::parse("https://launcher.test/launcher/")
                    .expect("launcher base"),
                authorization_app_base: AuthorizationAppBase::parse(
                    "https://authorization.test/authorization/",
                )
                .expect("authorization app base"),
                launcher_url: url::Url::parse("https://launcher.test/launcher/")
                    .expect("launcher URL"),
                authorization_url: url::Url::parse("https://authorization.test/authorization/")
                    .expect("authorization URL"),
            };
            let authorization_server = setup_authorization_server(
                pool.clone(),
                revocation_store.clone(),
                &config,
                watch::channel(None).0,
                Arc::new(AdmitEveryAuthorizationStart),
            )
            .expect("set up the authorization server");
            AuthorizationServerFixture {
                state: authorization_server.state,
                pool,
                revocation_store,
            }
        }

        /// An Owner browser's token, signed by the server's key, living `ttl`.
        fn owner_browser_token(&self, ttl: Duration) -> String {
            let key = SqliteGrantStore::new(self.pool.clone())
                .expect("store")
                .active_signing_key()
                .expect("key query")
                .expect("a seeded key");
            mint_access_token(
                &key,
                &NewJwtArgs {
                    client_id: OWNER_BROWSER_CLIENT_ID,
                    scopes: &wildflowerhealthio_authorization_server::owner_scopes(),
                    ttl,
                    issuer: SERVER_ORIGIN,
                    audience: Some(SERVER_ORIGIN),
                    patient: None,
                    sid: None,
                },
            )
            .expect("mint")
        }

        /// The layer's config for an Owner browser's cookie, judged here.
        fn owner_browser_config(&self) -> Arc<SessionCookieBearerConfig> {
            Arc::new(SessionCookieBearerConfig {
                session_cookie: SessionCookie::OwnerBrowser(self.state.clone()),
                server_origin: SERVER_ORIGIN.to_owned(),
            })
        }
    }

    /// The `jti` of `token`, read from its payload.
    fn jti_of(token: &str) -> String {
        let payload = token.split('.').nth(1).expect("a JWT payload");
        let claims: serde_json::Value = serde_json::from_slice(
            &wildflowerhealthio_authorization_server::crypto_util::base64::url_safe_no_pad_decode(
                payload,
            )
            .expect("base64url"),
        )
        .expect("JSON claims");
        claims["jti"].as_str().expect("a jti").to_owned()
    }

    /// An Owner browser's cookie, whose value is a live Owner browser token.
    fn owner_browser_cookie() -> GuardedCookie {
        let authorization_server = AuthorizationServerFixture::new();
        let token = authorization_server.owner_browser_token(Duration::hours(8));
        GuardedCookie {
            config: authorization_server.owner_browser_config(),
            cookie: format!("__Host-owner_browser_session={token}"),
            bearer: format!("Bearer {token}"),
        }
    }

    /// The FHIR web UI's cookie, naming its one live session, `session-1`,
    /// whose access token is `session-token`.
    fn fhir_ui_cookie() -> GuardedCookie {
        GuardedCookie {
            config: Arc::new(SessionCookieBearerConfig {
                session_cookie: SessionCookie::FhirUi(Arc::new(store_with_a_session())),
                server_origin: SERVER_ORIGIN.to_owned(),
            }),
            cookie: "hfs_session=session-1".to_owned(),
            bearer: "Bearer session-token".to_owned(),
        }
    }

    fn store_with_a_session() -> SessionStore {
        let store = SessionStore::new(wildflowerhealthio_fhir_r4::ui_login_config(
            &server_origin(),
            "fhir-ui-client",
        ));
        store.insert(Session {
            id: "session-1".to_string(),
            principal: SessionPrincipal {
                subject: "fhir-ui-client".to_string(),
                issuer: SERVER_ORIGIN.to_string(),
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
        [owner_browser_cookie(), fhir_ui_cookie()]
    }

    /// What `config`'s layer made of a request: its status, and the
    /// `Authorization` the router behind it saw, if the request got that far
    /// and carried one.
    async fn respond(
        config: Arc<SessionCookieBearerConfig>,
        method: Method,
        headers: &[(&str, &str)],
    ) -> (StatusCode, Option<String>) {
        let router = echo_router().layer(axum::middleware::from_fn_with_state(
            config,
            present_session_cookie_bearer,
        ));
        status_and_authorization(send(router, method, headers).await).await
    }

    /// A `/Patient` route that answers with the `Authorization` it saw.
    fn echo_router() -> Router {
        async fn authorization(headers: HeaderMap) -> String {
            headers
                .get(header::AUTHORIZATION)
                .map(|value| value.to_str().expect("ascii").to_string())
                .unwrap_or_default()
        }
        Router::new().route("/Patient", get(authorization).post(authorization))
    }

    /// `router`'s response to `method /Patient` with `headers`.
    async fn send(router: Router, method: Method, headers: &[(&str, &str)]) -> Response {
        let mut request = Request::builder().method(method).uri("/Patient");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        router
            .oneshot(request.body(Body::empty()).expect("request"))
            .await
            .expect("infallible")
    }

    /// A response's status, and the `Authorization` [`echo_router`] saw, if
    /// the request got that far and carried one.
    async fn status_and_authorization(response: Response) -> (StatusCode, Option<String>) {
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let seen = String::from_utf8(body.to_vec()).expect("utf-8");
        let authorization = (status == StatusCode::OK && !seen.is_empty()).then_some(seen);
        (status, authorization)
    }

    /// The `Set-Cookie` values on `response`.
    fn set_cookies(response: &Response) -> Vec<String> {
        response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().expect("ascii").to_owned())
            .collect()
    }

    /// [`respond`] to a request carrying `guarded`'s cookie and `headers`.
    async fn respond_with_cookie(
        guarded: &GuardedCookie,
        method: Method,
        headers: &[(&str, &str)],
    ) -> (StatusCode, Option<String>) {
        let mut with_cookie = vec![("cookie", guarded.cookie.as_str())];
        with_cookie.extend_from_slice(headers);
        respond(guarded.config.clone(), method, &with_cookie).await
    }

    fn presented(guarded: &GuardedCookie) -> (StatusCode, Option<String>) {
        (StatusCode::OK, Some(guarded.bearer.clone()))
    }

    fn passed_without_a_bearer() -> (StatusCode, Option<String>) {
        (StatusCode::OK, None)
    }

    fn refused() -> (StatusCode, Option<String>) {
        (StatusCode::FORBIDDEN, None)
    }

    #[tokio::test]
    async fn a_read_from_the_server_origin_gets_the_cookie_s_bearer() {
        let cases: [&[(&str, &str)]; 4] = [
            &[("sec-fetch-site", "same-origin")],
            &[("sec-fetch-site", "none")],
            // A browser too old to send `Sec-Fetch-Site`, and no `Origin` on a
            // same-origin `GET`.
            &[],
            &[("origin", SERVER_ORIGIN)],
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
    async fn a_write_from_the_server_origin_gets_the_cookie_s_bearer() {
        let cases: [&[(&str, &str)]; 2] = [
            &[("sec-fetch-site", "same-origin"), ("origin", SERVER_ORIGIN)],
            // A browser too old to send `Sec-Fetch-Site`.
            &[("origin", SERVER_ORIGIN)],
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
        let cases: [&[(&str, &str)]; 6] = [
            // Another server behind the same relay.
            &[("sec-fetch-site", "same-site"), ("origin", SIBLING_ORIGIN)],
            &[("sec-fetch-site", "cross-site"), ("origin", SIBLING_ORIGIN)],
            // A browser too old to send `Sec-Fetch-Site`.
            &[("origin", SIBLING_ORIGIN)],
            // A sandboxed page.
            &[("origin", "null")],
            // `Sec-Fetch-Site` and `Origin` must both agree.
            &[
                ("sec-fetch-site", "same-origin"),
                ("origin", SIBLING_ORIGIN),
            ],
            // Not saying where it came from.
            &[],
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
            &[("sec-fetch-site", "same-site")],
            &[("origin", SIBLING_ORIGIN)],
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
                    &[("origin", SIBLING_ORIGIN)]
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
                        ("cookie", other.cookie.as_str()),
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

    /// The value a clearing `Set-Cookie` carries for the Owner browser cookie.
    const CLEARED_OWNER_BROWSER_COOKIE: &str =
        "__Host-owner_browser_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";

    /// An Owner browser cookie whose session has ended passes as if it weren't
    /// sent, and the response clears it: a token revoked by its `jti`, one
    /// revoked with its subject, an expired one, and one that isn't a token.
    #[tokio::test]
    async fn an_ended_owner_browser_session_passes_without_a_bearer_and_is_cleared() {
        let authorization_server = AuthorizationServerFixture::new();
        let revoked_by_jti = authorization_server.owner_browser_token(Duration::hours(8));
        authorization_server
            .revocation_store
            .revoke_jti(
                &jti_of(&revoked_by_jti),
                Utc::now() + Duration::hours(8),
                "test",
            )
            .expect("revoke the jti");
        let expired = authorization_server.owner_browser_token(Duration::hours(-1));
        for (what, token) in [
            ("revoked by jti", revoked_by_jti),
            ("expired", expired),
            ("not a token", "not-a-token".to_owned()),
            ("empty", String::new()),
        ] {
            let cookie = format!("__Host-owner_browser_session={token}");
            let response = send(
                echo_router().layer(axum::middleware::from_fn_with_state(
                    authorization_server.owner_browser_config(),
                    present_session_cookie_bearer,
                )),
                Method::GET,
                &[("cookie", &cookie), ("sec-fetch-site", "same-origin")],
            )
            .await;
            assert_eq!(
                set_cookies(&response),
                [CLEARED_OWNER_BROWSER_COOKIE],
                "{what}"
            );
            assert_eq!(
                status_and_authorization(response).await,
                passed_without_a_bearer(),
                "{what}"
            );
        }

        let revoked_with_subject = authorization_server.owner_browser_token(Duration::hours(8));
        authorization_server
            .revocation_store
            .revoke_subject_as_of_now(OWNER_BROWSER_CLIENT_ID)
            .expect("revoke the subject");
        let cookie = format!("__Host-owner_browser_session={revoked_with_subject}");
        let response = send(
            echo_router().layer(axum::middleware::from_fn_with_state(
                authorization_server.owner_browser_config(),
                present_session_cookie_bearer,
            )),
            Method::GET,
            &[("cookie", &cookie), ("sec-fetch-site", "same-origin")],
        )
        .await;
        assert_eq!(
            set_cookies(&response),
            [CLEARED_OWNER_BROWSER_COOKIE],
            "revoked with its subject"
        );
    }

    /// An Owner browser cookie whose session can't be judged, because the
    /// authorization server's key store can't be read, fails closed: a 500,
    /// with no bearer presented and the cookie left alone.
    #[tokio::test]
    async fn an_owner_browser_session_that_cannot_be_judged_is_a_server_error() {
        use diesel::RunQueryDsl as _;

        let authorization_server = AuthorizationServerFixture::new();
        let token = authorization_server.owner_browser_token(Duration::hours(8));
        diesel::sql_query("DROP TABLE signing_keys")
            .execute(&mut authorization_server.pool.get().expect("connection"))
            .expect("drop the key store");
        let cookie = format!("__Host-owner_browser_session={token}");
        let response = send(
            echo_router().layer(axum::middleware::from_fn_with_state(
                authorization_server.owner_browser_config(),
                present_session_cookie_bearer,
            )),
            Method::GET,
            &[("cookie", &cookie), ("sec-fetch-site", "same-origin")],
        )
        .await;
        assert!(set_cookies(&response).is_empty());
        assert_eq!(
            status_and_authorization(response).await,
            (StatusCode::INTERNAL_SERVER_ERROR, None)
        );
    }

    /// A live Owner browser session is presented and its cookie left alone.
    #[tokio::test]
    async fn a_live_owner_browser_session_keeps_its_cookie() {
        let guarded = owner_browser_cookie();
        let response = send(
            echo_router().layer(axum::middleware::from_fn_with_state(
                guarded.config.clone(),
                present_session_cookie_bearer,
            )),
            Method::GET,
            &[
                ("cookie", &guarded.cookie),
                ("sec-fetch-site", "same-origin"),
            ],
        )
        .await;
        assert!(set_cookies(&response).is_empty());
        assert_eq!(
            status_and_authorization(response).await,
            presented(&guarded)
        );
    }

    /// With both cookies live, the layers the server composes present the
    /// FHIR web UI's bearer: the more specific session wins.
    #[tokio::test]
    async fn with_both_cookies_the_fhir_ui_session_wins() {
        let authorization_server = AuthorizationServerFixture::new();
        let owner_browser_token = authorization_server.owner_browser_token(Duration::hours(8));
        let router = composed_layers(&authorization_server);
        let cookies =
            format!("__Host-owner_browser_session={owner_browser_token}; hfs_session=session-1");
        for method in [Method::GET, Method::POST] {
            let response = send(
                router.clone(),
                method.clone(),
                &[
                    ("cookie", &cookies),
                    ("sec-fetch-site", "same-origin"),
                    ("origin", SERVER_ORIGIN),
                ],
            )
            .await;
            assert_eq!(
                status_and_authorization(response).await,
                (StatusCode::OK, Some("Bearer session-token".to_owned())),
                "{method}"
            );
        }
    }

    /// The layers the server composes, over [`echo_router`], judging an Owner
    /// browser's cookie by `authorization_server` and the UI's against its one
    /// live session.
    fn composed_layers(authorization_server: &AuthorizationServerFixture) -> Router {
        present_session_cookie_bearers(
            echo_router(),
            authorization_server.state.clone(),
            Arc::new(store_with_a_session()),
            &server_origin(),
        )
    }

    /// A request from the server's origin asking for the Owner browser session
    /// gets its bearer even with the FHIR web UI's cookie beside it.
    #[tokio::test]
    async fn asking_for_the_owner_browser_session_presents_it_over_the_fhir_ui_s() {
        let authorization_server = AuthorizationServerFixture::new();
        let owner_browser_token = authorization_server.owner_browser_token(Duration::hours(8));
        let cookies =
            format!("__Host-owner_browser_session={owner_browser_token}; hfs_session=session-1");
        for method in [Method::GET, Method::POST] {
            let response = send(
                composed_layers(&authorization_server),
                method.clone(),
                &[
                    ("cookie", &cookies),
                    ("sec-fetch-site", "same-origin"),
                    ("origin", SERVER_ORIGIN),
                    ("wildflower-session", "owner-browser"),
                ],
            )
            .await;
            assert_eq!(
                status_and_authorization(response).await,
                (
                    StatusCode::OK,
                    Some(format!("Bearer {owner_browser_token}"))
                ),
                "{method}"
            );
        }
    }

    /// Asking for the Owner browser session without a live one presents no
    /// session at all, never the FHIR web UI's: whether the Owner cookie is
    /// missing or its session has ended, which is still cleared.
    #[tokio::test]
    async fn asking_for_a_missing_owner_browser_session_presents_none() {
        let authorization_server = AuthorizationServerFixture::new();
        let expired = authorization_server.owner_browser_token(Duration::hours(-1));
        for (what, cookies, cleared) in [
            ("no Owner cookie", "hfs_session=session-1".to_owned(), false),
            (
                "an ended Owner session",
                format!("__Host-owner_browser_session={expired}; hfs_session=session-1"),
                true,
            ),
        ] {
            let response = send(
                composed_layers(&authorization_server),
                Method::GET,
                &[
                    ("cookie", &cookies),
                    ("sec-fetch-site", "same-origin"),
                    ("wildflower-session", "owner-browser"),
                ],
            )
            .await;
            assert_eq!(
                set_cookies(&response) == [CLEARED_OWNER_BROWSER_COOKIE],
                cleared,
                "{what}"
            );
            assert_eq!(
                status_and_authorization(response).await,
                passed_without_a_bearer(),
                "{what}"
            );
        }
    }

    /// The header still names a session only from the server's origin: a write
    /// from another server's page carrying either cookie is refused with it.
    #[tokio::test]
    async fn asking_for_the_owner_browser_session_keeps_the_write_guard() {
        for guarded in guarded_cookies() {
            assert_eq!(
                respond_with_cookie(
                    &guarded,
                    Method::POST,
                    &[
                        ("origin", SIBLING_ORIGIN),
                        ("wildflower-session", "owner-browser"),
                    ]
                )
                .await,
                refused(),
                "{}",
                guarded.cookie
            );
        }
    }

    /// Any other value of the header is read as no header: the FHIR web UI's
    /// session wins as usual.
    #[tokio::test]
    async fn an_unknown_session_choice_is_ignored() {
        let authorization_server = AuthorizationServerFixture::new();
        let owner_browser_token = authorization_server.owner_browser_token(Duration::hours(8));
        let cookies =
            format!("__Host-owner_browser_session={owner_browser_token}; hfs_session=session-1");
        for value in ["fhir-ui", "Owner-Browser", ""] {
            let response = send(
                composed_layers(&authorization_server),
                Method::GET,
                &[
                    ("cookie", &cookies),
                    ("sec-fetch-site", "same-origin"),
                    ("wildflower-session", value),
                ],
            )
            .await;
            assert_eq!(
                status_and_authorization(response).await,
                (StatusCode::OK, Some("Bearer session-token".to_owned())),
                "{value:?}"
            );
        }
    }

    /// The composed layers still present an Owner browser's bearer when it is
    /// the only cookie.
    #[tokio::test]
    async fn the_composed_layers_present_a_lone_owner_browser_cookie() {
        let authorization_server = AuthorizationServerFixture::new();
        let owner_browser_token = authorization_server.owner_browser_token(Duration::hours(8));
        let router = composed_layers(&authorization_server);
        let cookie = format!("__Host-owner_browser_session={owner_browser_token}");
        let response = send(
            router,
            Method::GET,
            &[("cookie", &cookie), ("sec-fetch-site", "same-origin")],
        )
        .await;
        assert_eq!(
            status_and_authorization(response).await,
            (
                StatusCode::OK,
                Some(format!("Bearer {owner_browser_token}"))
            )
        );
    }
}
