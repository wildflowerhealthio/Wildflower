//! The admin API, served only on `admin.<domain>` and only to requests
//! signed with `keyid="admin"`.
//!
//! - `POST /api/tunnels` `{"email": "…", "name": "…"}` (`name` optional):
//!   `201 {"name", "token", "public_host"}`. The token is shown only here.
//! - `GET /api/tunnels`: `200 [{"name", "email", "public_host",
//!   "created_at", "last_outcome"}]`. No tokens. `last_outcome` is what
//!   became of the last connection to the tunnel since the relay started
//!   (`"ok"`, `"tunnel_down"`, `"tunnel_busy"`, `"tunnel_closed"` or
//!   `"proxy_header_failed"`, see [`TunnelOutcome`]), or `null` before the
//!   first.
//! - `DELETE /api/tunnels/{name}`: `204` once the tunnel is gone, with its
//!   claim code.
//! - `POST /api/tunnels/{name}/claim-codes` (no body): `201 {"code",
//!   "expires_at"}`, a claim code for the tunnel, shown only here, as
//!   `ABCD-EFGH`, and the Unix epoch second it stops redeeming at (see
//!   `super::claim`). It replaces the tunnel's earlier code, which stops
//!   redeeming.
//! - `POST /api/tunnels/{name}/token` (no body): `200 {"name", "token",
//!   "public_host"}`, a new token for the tunnel, shown only here. The old
//!   token stops signing and connecting at once, and a device connected
//!   with it drops. The tunnel's claim code, if any, redeems for the new
//!   token.
//! - `GET /api/connection-totals`: `200 [{"hour", "ok",
//!   "over_connection_limit", "hello_timeout", "not_a_hello",
//!   "no_server_name", "unknown_tunnel", "tunnel_down", "tunnel_busy",
//!   "tunnel_closed", "proxy_header_failed"}]`, one object per UTC hour of
//!   the last 30 days with any connection, oldest first: the hour's start in
//!   Unix epoch seconds and how many connections had each outcome (see
//!   [`Outcome`]), zeros included. Stored and not yet stored counts alike.
//!
//! On any other `Host` these paths are `404`, before the signature is
//! looked at, so `@target-uri` always names the admin hostname. A request
//! that fails verification, or is signed by a tunnel, is a bare `401`: each
//! handler acquires its capability through the [`Admin`] extractor, which
//! builds it only for the admin signer, before the body is read. Refused
//! changes answer with a short plain-text reason: `422` for a name that is
//! not a lowercase DNS label or an unusable email, `409` for a name that is
//! reserved or taken, `404` for deleting, issuing a claim code for or
//! reissuing the token of a tunnel that does not exist, and `503` when no name, or no unused claim
//! code, is left.

use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::Json;
use serde::{Deserialize, Serialize, Serializer};

use super::signature::{authority, require_signature, Verifier};
use crate::domain::{
    HourlyTotals, IssuedClaimCode, Outcome, StoredTunnel, TunnelError, TunnelOutcome,
};
use crate::live_bindings::state::TunnelRegistry;
use crate::live_bindings::{
    Admin, LiveClaimCodesIssuer, LiveConnectionTotalsReader, LiveTunnelTokensReissuer,
    LiveTunnelsCreator, LiveTunnelsDeleter, LiveTunnelsReader,
};
use crate::settings::Secret;

/// The routes above, changing tunnels through capabilities built from
/// `registry` and checking signatures with `verifier`.
pub(super) fn router(registry: Arc<TunnelRegistry>, verifier: Arc<Verifier>) -> axum::Router {
    let admin_hostname: Arc<str> = registry.admin_hostname().into();
    axum::Router::new()
        .route("/api/tunnels", get(list).post(create))
        .route("/api/tunnels/{name}", delete(remove))
        .route("/api/tunnels/{name}/claim-codes", post(issue_claim_code))
        .route("/api/tunnels/{name}/token", post(reissue_token))
        .route("/api/connection-totals", get(list_connection_totals))
        .route_layer(middleware::from_fn_with_state(verifier, require_signature))
        // The outer layer: the host is checked before the signature.
        .route_layer(middleware::from_fn_with_state(
            admin_hostname,
            require_admin_host,
        ))
        .with_state(registry)
}

/// `404` unless the request's authority is the admin hostname.
pub(super) async fn require_admin_host(
    State(admin_hostname): State<Arc<str>>,
    request: Request,
    next: Next,
) -> Response {
    let (parts, body) = request.into_parts();
    if authority(&parts).as_deref() != Some(&*admin_hostname) {
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(Request::from_parts(parts, body)).await
}

/// The body of `POST /api/tunnels`.
#[derive(Debug, Deserialize)]
struct CreateTunnel {
    email: String,
    name: Option<String>,
}

/// A tunnel as `GET /api/tunnels` lists it: no token.
#[derive(Debug, Serialize)]
struct TunnelInfo {
    name: String,
    email: String,
    /// `<tunnel name>.<domain>`.
    public_host: String,
    /// Unix epoch seconds.
    created_at: i64,
    /// What became of the last connection to the tunnel since the relay
    /// started; `null` before the first.
    last_outcome: Option<TunnelOutcome>,
}

impl TunnelInfo {
    fn new(stored: StoredTunnel, public_host: String, last_outcome: Option<TunnelOutcome>) -> Self {
        Self {
            name: stored.tunnel.name,
            email: stored.email,
            public_host,
            created_at: stored.created_at,
            last_outcome,
        }
    }
}

/// One hour as `GET /api/connection-totals` lists it: every outcome's
/// count, zeros included, by its [`Outcome::as_str`] name.
#[derive(Debug, Serialize)]
struct ConnectionTotalsBody {
    /// The UTC hour's start, Unix epoch seconds.
    hour: i64,
    ok: u64,
    over_connection_limit: u64,
    hello_timeout: u64,
    not_a_hello: u64,
    no_server_name: u64,
    unknown_tunnel: u64,
    tunnel_down: u64,
    tunnel_busy: u64,
    tunnel_closed: u64,
    proxy_header_failed: u64,
}

impl From<&HourlyTotals> for ConnectionTotalsBody {
    fn from(totals: &HourlyTotals) -> Self {
        Self {
            hour: totals.hour,
            ok: totals.count(Outcome::Ok),
            over_connection_limit: totals.count(Outcome::OverConnectionLimit),
            hello_timeout: totals.count(Outcome::HelloTimeout),
            not_a_hello: totals.count(Outcome::NotAHello),
            no_server_name: totals.count(Outcome::NoServerName),
            unknown_tunnel: totals.count(Outcome::UnknownTunnel),
            tunnel_down: totals.count(Outcome::TunnelDown),
            tunnel_busy: totals.count(Outcome::TunnelBusy),
            tunnel_closed: totals.count(Outcome::TunnelClosed),
            proxy_header_failed: totals.count(Outcome::ProxyHeaderFailed),
        }
    }
}

/// A tunnel with its token, as `POST /api/tunnels` (just created) and
/// `POST /api/tunnels/{name}/token` (just reissued) answer. The only places
/// a token is ever shown.
#[derive(Debug, Serialize)]
struct TunnelWithToken {
    name: String,
    #[serde(serialize_with = "expose")]
    token: Secret,
    /// `<tunnel name>.<domain>`.
    public_host: String,
}

impl TunnelWithToken {
    fn new(stored: StoredTunnel, public_host: String) -> Self {
        Self {
            name: stored.tunnel.name,
            token: stored.tunnel.token,
            public_host,
        }
    }
}

/// A claim code just issued, as `POST /api/tunnels/{name}/claim-codes`
/// answers. The only place the code is ever shown.
#[derive(Debug, Serialize)]
struct IssuedClaimCodeBody {
    /// `ABCD-EFGH`.
    code: String,
    /// Unix epoch seconds: the code redeems while the relay's clock reads
    /// earlier.
    expires_at: i64,
}

impl From<IssuedClaimCode> for IssuedClaimCodeBody {
    fn from(issued: IssuedClaimCode) -> Self {
        Self {
            code: issued.code.to_string(),
            expires_at: issued.expires_at,
        }
    }
}

fn expose<S: Serializer>(secret: &Secret, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(secret.expose())
}

/// The body is checked only after the signer: [`Admin`] runs first, so a
/// tunnel-signed request is `401` whatever it carries.
async fn create(
    Admin(creator): Admin<LiveTunnelsCreator>,
    body: Result<Json<CreateTunnel>, JsonRejection>,
) -> Response {
    let body = match body {
        Ok(Json(body)) => body,
        Err(rejection) => return rejection.into_response(),
    };
    match creator.create(body.email, body.name).await {
        Ok(stored) => {
            let public_host = creator.public_host(&stored.tunnel.name);
            let created = TunnelWithToken::new(stored, public_host);
            (StatusCode::CREATED, Json(created)).into_response()
        }
        Err(error) => error.into_response(),
    }
}

async fn list(Admin(reader): Admin<LiveTunnelsReader>) -> Response {
    match reader.list().await {
        Ok(stored) => {
            let listed: Vec<_> = stored
                .into_iter()
                .map(|stored| {
                    let public_host = reader.public_host(&stored.tunnel.name);
                    let last_outcome = reader.last_outcome(&stored.tunnel.name);
                    TunnelInfo::new(stored, public_host, last_outcome)
                })
                .collect();
            Json(listed).into_response()
        }
        Err(error) => error.into_response(),
    }
}

async fn list_connection_totals(Admin(reader): Admin<LiveConnectionTotalsReader>) -> Response {
    match reader.list().await {
        Ok(totals) => {
            let listed: Vec<_> = totals.iter().map(ConnectionTotalsBody::from).collect();
            Json(listed).into_response()
        }
        Err(error) => error.into_response(),
    }
}

async fn remove(Admin(deleter): Admin<LiveTunnelsDeleter>, Path(name): Path<String>) -> Response {
    match deleter.delete(name).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => error.into_response(),
    }
}

async fn issue_claim_code(
    Admin(issuer): Admin<LiveClaimCodesIssuer>,
    Path(name): Path<String>,
) -> Response {
    match issuer.issue(name).await {
        Ok(issued) => {
            (StatusCode::CREATED, Json(IssuedClaimCodeBody::from(issued))).into_response()
        }
        Err(error) => error.into_response(),
    }
}

async fn reissue_token(
    Admin(reissuer): Admin<LiveTunnelTokensReissuer>,
    Path(name): Path<String>,
) -> Response {
    match reissuer.reissue(name).await {
        Ok(stored) => {
            let public_host = reissuer.public_host(&stored.tunnel.name);
            Json(TunnelWithToken::new(stored, public_host)).into_response()
        }
        Err(error) => error.into_response(),
    }
}

impl IntoResponse for TunnelError {
    fn into_response(self) -> Response {
        let (status, reason) = match self {
            Self::InvalidName => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "the name is not a lowercase DNS label",
            ),
            Self::InvalidEmail => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "the email is not an email address",
            ),
            Self::Reserved => (StatusCode::CONFLICT, "the name is reserved"),
            Self::Taken => (StatusCode::CONFLICT, "a tunnel already has the name"),
            Self::NotFound => (StatusCode::NOT_FOUND, "no tunnel has the name"),
            Self::Exhausted(reason) => (StatusCode::SERVICE_UNAVAILABLE, reason),
            Self::ClaimCodeRejected => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "the claim code is unknown, used or expired",
            ),
            Self::Infrastructure { context, source } => {
                tracing::error!("tunnel change failed: {context}: {source}");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        };
        (status, reason).into_response()
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{header, Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;
    use crate::domain::{ClaimCode, TunnelStore};
    use crate::live_bindings::{LiveClaimCodesRedeemer, LiveTunnelsCreator};
    use crate::site::signature::tests::signed_request;
    use crate::site::signature::unix_now;
    use crate::test_support::{admin, registry, Fixture};

    const ADMIN_KEY: &str = "an-admin-key-of-thirty-two-bytes";
    const ADMIN: &str = "https://admin.relay.example.com";

    /// A request to `uri` signed with the admin key, a fresh nonce each time.
    fn admin_request(method: &str, uri: &str, body: &serde_json::Value) -> Request<Body> {
        let body = if body.is_null() {
            Vec::new()
        } else {
            serde_json::to_vec(body).unwrap()
        };
        let nonce = format!("{:x}", rand::random::<u64>());
        let mut request = signed_request(
            method,
            uri,
            &body,
            "admin",
            ADMIN_KEY,
            unix_now().unwrap(),
            &nonce,
        );
        if !body.is_empty() {
            request
                .headers_mut()
                .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        }
        request
    }

    async fn send(router: &axum::Router, request: Request<Body>) -> (StatusCode, Vec<u8>) {
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, body.to_vec())
    }

    fn json(body: &[u8]) -> serde_json::Value {
        serde_json::from_slice(body).unwrap()
    }

    /// The admin router over a fresh registry holding the tunnel `alice`,
    /// whose token is returned.
    async fn router_with_alice() -> (axum::Router, Arc<TunnelRegistry>, String, Fixture) {
        let (registry, fixture) = registry(Some(ADMIN_KEY)).await;
        let creator: LiveTunnelsCreator = admin(&registry);
        let alice = creator
            .create("alice@example.com".to_owned(), Some("alice".to_owned()))
            .await
            .unwrap();
        let router = router(Arc::clone(&registry), registry.verifier());
        let token = alice.tunnel.token.expose().to_owned();
        (router, registry, token, fixture)
    }

    #[tokio::test]
    async fn creates_lists_and_deletes_tunnels() {
        let (router, tunnels, _, _fixture) = router_with_alice().await;

        let (status, body) = send(
            &router,
            admin_request(
                "POST",
                &format!("{ADMIN}/api/tunnels"),
                &serde_json::json!({"email": "bob@example.com", "name": "bob"}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let created = json(&body);
        assert_eq!(created["name"], "bob");
        assert_eq!(created["public_host"], "bob.relay.example.com");
        assert_eq!(created["token"].as_str().unwrap().len(), 43);

        let (status, body) = send(
            &router,
            admin_request(
                "POST",
                &format!("{ADMIN}/api/tunnels"),
                &serde_json::json!({"email": "carol@example.com"}),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let generated = json(&body)["name"].as_str().unwrap().to_owned();
        assert_eq!(generated.split('-').count(), 2, "{generated}");

        let (status, body) = send(
            &router,
            admin_request(
                "GET",
                &format!("{ADMIN}/api/tunnels"),
                &serde_json::Value::Null,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let listed = json(&body);
        let listed = listed.as_array().unwrap();
        let names: Vec<&str> = listed.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names.len(), 3);
        assert!(names.is_sorted(), "{names:?}");
        assert!(names.contains(&"alice"), "{names:?}");
        let bob = listed.iter().find(|t| t["name"] == "bob").unwrap();
        let created_at = bob["created_at"].as_i64().unwrap();
        assert_eq!(
            *bob,
            serde_json::json!({
                "name": "bob",
                "email": "bob@example.com",
                "public_host": "bob.relay.example.com",
                "created_at": created_at,
                "last_outcome": null,
            })
        );
        assert!(listed.iter().all(|t| t.get("token").is_none()));

        let (status, _) = send(
            &router,
            admin_request(
                "DELETE",
                &format!("{ADMIN}/api/tunnels/bob"),
                &serde_json::Value::Null,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(tunnels.store.list_tunnels().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn refuses_bad_names_reserved_names_conflicts_and_unknown_deletes() {
        let (router, tunnels, _, _fixture) = router_with_alice().await;
        let post =
            |body: serde_json::Value| admin_request("POST", &format!("{ADMIN}/api/tunnels"), &body);
        for (body, expected) in [
            (
                serde_json::json!({"email": "x@example.com", "name": "Not_A_Label"}),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                serde_json::json!({"email": "not an email", "name": "bob"}),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                serde_json::json!({"name": "bob"}),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                serde_json::json!({"email": "x@example.com", "name": "admin"}),
                StatusCode::CONFLICT,
            ),
            (
                serde_json::json!({"email": "x@example.com", "name": "alice"}),
                StatusCode::CONFLICT,
            ),
        ] {
            let (status, _) = send(&router, post(body.clone())).await;
            assert_eq!(status, expected, "{body}");
        }
        let uri = format!("{ADMIN}/api/tunnels/nobody");
        let (status, _) = send(
            &router,
            admin_request("DELETE", &uri, &serde_json::Value::Null),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(tunnels.store.list_tunnels().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn refuses_unsigned_wrongly_signed_and_tunnel_signed_requests() {
        let (router, tunnels, alice, _fixture) = router_with_alice().await;
        let uri = format!("{ADMIN}/api/tunnels");
        let now = unix_now().unwrap();
        let unsigned = Request::builder()
            .uri("/api/tunnels")
            .header(header::HOST, "admin.relay.example.com")
            .body(Body::empty())
            .unwrap();
        for request in [
            unsigned,
            signed_request("GET", &uri, b"", "admin", "not-the-admin-key", now, "a"),
            signed_request("GET", &uri, b"", "alice", &alice, now, "b"),
            signed_request("POST", &uri, b"not json", "alice", &alice, now, "d"),
            signed_request(
                "DELETE",
                &format!("{uri}/alice"),
                b"",
                "alice",
                &alice,
                now,
                "c",
            ),
        ] {
            let (status, body) = send(&router, request).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert!(body.is_empty(), "a 401 carries no detail");
        }
        assert_eq!(
            tunnels.store.list_tunnels().unwrap().len(),
            1,
            "alice is still there"
        );
    }

    /// An admin-signed issue answers a grouped code and its expiry; the code
    /// redeems at `POST /claim` for that tunnel's token, not another's.
    #[tokio::test]
    async fn an_issued_claim_code_redeems_for_its_tunnel() {
        let (router, tunnels, _, _fixture) = router_with_alice().await;
        let creator: LiveTunnelsCreator = admin(&tunnels);
        let bob = creator
            .create("bob@example.com".to_owned(), Some("bob".to_owned()))
            .await
            .unwrap();
        let before = unix_now().unwrap();
        let (status, body) = send(
            &router,
            admin_request(
                "POST",
                &format!("{ADMIN}/api/tunnels/bob/claim-codes"),
                &serde_json::Value::Null,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        let issued = json(&body);
        let code = issued["code"].as_str().unwrap();
        assert!(ClaimCode::parse(code).is_some(), "{code}");
        assert_eq!(code.find('-'), Some(4), "{code}");
        let expires_at = issued["expires_at"].as_i64().unwrap();
        let ttl = i64::try_from(tunnels.claim_code_ttl.as_secs()).unwrap();
        assert!((before + ttl..=unix_now().unwrap() + ttl).contains(&expires_at));
        assert_eq!(issued.as_object().unwrap().len(), 2, "{issued}");

        let redeemer = LiveClaimCodesRedeemer::new(&tunnels);
        let redeemed = redeemer.redeem(code.to_owned()).await.unwrap();
        assert_eq!(redeemed, bob.tunnel);
    }

    #[tokio::test]
    async fn issuing_a_claim_code_needs_the_admin_signature_and_a_known_tunnel() {
        let (router, tunnels, alice, _fixture) = router_with_alice().await;
        let uri = format!("{ADMIN}/api/tunnels/alice/claim-codes");
        let now = unix_now().unwrap();
        let unsigned = Request::builder()
            .method("POST")
            .uri("/api/tunnels/alice/claim-codes")
            .header(header::HOST, "admin.relay.example.com")
            .body(Body::empty())
            .unwrap();
        for request in [
            unsigned,
            signed_request("POST", &uri, b"", "admin", "not-the-admin-key", now, "a"),
            signed_request("POST", &uri, b"", "alice", &alice, now, "b"),
        ] {
            let (status, body) = send(&router, request).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert!(body.is_empty(), "a 401 carries no detail");
        }
        let unknown = admin_request(
            "POST",
            &format!("{ADMIN}/api/tunnels/nobody/claim-codes"),
            &serde_json::Value::Null,
        );
        let (status, body) = send(&router, unknown).await;
        assert_eq!(
            (status, body),
            (StatusCode::NOT_FOUND, b"no tunnel has the name".to_vec())
        );
        assert_eq!(
            tunnels.store.list_tunnels().unwrap().len(),
            1,
            "nothing changed"
        );
    }

    /// An admin-signed reissue answers the tunnel with a new token, which is
    /// what is stored, and an outstanding claim code redeems for it.
    #[tokio::test]
    async fn a_reissued_token_is_shown_once_and_claim_codes_redeem_for_it() {
        let (router, tunnels, alice, _fixture) = router_with_alice().await;
        let issuer: LiveClaimCodesIssuer = admin(&tunnels);
        let code = issuer.issue("alice".to_owned()).await.unwrap().code;

        let (status, body) = send(
            &router,
            admin_request(
                "POST",
                &format!("{ADMIN}/api/tunnels/alice/token"),
                &serde_json::Value::Null,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let reissued = json(&body);
        let token = reissued["token"].as_str().unwrap();
        assert_eq!(token.len(), 43);
        assert_ne!(token, alice);
        assert_eq!(
            reissued,
            serde_json::json!({
                "name": "alice",
                "token": token,
                "public_host": "alice.relay.example.com",
            })
        );
        let stored = tunnels.store.list_tunnels().unwrap();
        assert_eq!(stored[0].tunnel.token.expose(), token);

        let redeemer = LiveClaimCodesRedeemer::new(&tunnels);
        let redeemed = redeemer.redeem(code.to_string()).await.unwrap();
        assert_eq!(redeemed.token.expose(), token);
    }

    #[tokio::test]
    async fn reissuing_a_token_needs_the_admin_signature_and_a_known_tunnel() {
        let (router, tunnels, alice, _fixture) = router_with_alice().await;
        let uri = format!("{ADMIN}/api/tunnels/alice/token");
        let now = unix_now().unwrap();
        let unsigned = Request::builder()
            .method("POST")
            .uri("/api/tunnels/alice/token")
            .header(header::HOST, "admin.relay.example.com")
            .body(Body::empty())
            .unwrap();
        for request in [
            unsigned,
            signed_request("POST", &uri, b"", "admin", "not-the-admin-key", now, "a"),
            signed_request("POST", &uri, b"", "alice", &alice, now, "b"),
        ] {
            let (status, body) = send(&router, request).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert!(body.is_empty(), "a 401 carries no detail");
        }
        let unknown = admin_request(
            "POST",
            &format!("{ADMIN}/api/tunnels/nobody/token"),
            &serde_json::Value::Null,
        );
        let (status, body) = send(&router, unknown).await;
        assert_eq!(
            (status, body),
            (StatusCode::NOT_FOUND, b"no tunnel has the name".to_vec())
        );
        assert_eq!(
            tunnels.store.list_tunnels().unwrap()[0]
                .tunnel
                .token
                .expose(),
            alice,
            "alice's token is unchanged"
        );
    }

    /// On the apex (or any other host) the admin paths do not exist, even
    /// for a request properly signed for that host.
    #[tokio::test]
    async fn the_admin_api_is_only_on_the_admin_hostname() {
        let (tunnels, _fixture) = registry(Some(ADMIN_KEY)).await;
        let router = router(Arc::clone(&tunnels), tunnels.verifier());
        for host in ["https://relay.example.com", "https://other.example.com"] {
            let request = admin_request(
                "GET",
                &format!("{host}/api/tunnels"),
                &serde_json::Value::Null,
            );
            let (status, _) = send(&router, request).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{host}");
        }
        // The host is checked before the signature: an unsigned request, or
        // one with a method the API lacks, is `404` too, not `401` or `405`.
        for method in ["GET", "PUT"] {
            let request = Request::builder()
                .method(method)
                .uri("/api/tunnels")
                .header(header::HOST, "relay.example.com")
                .body(Body::empty())
                .unwrap();
            let (status, _) = send(&router, request).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method}");
        }
    }

    /// A tunnel's last outcome is `null` until a connection to it is
    /// recorded, then that outcome's name.
    #[tokio::test]
    async fn lists_each_tunnels_last_outcome() {
        let (router, tunnels, _, _fixture) = router_with_alice().await;
        let list = || {
            admin_request(
                "GET",
                &format!("{ADMIN}/api/tunnels"),
                &serde_json::Value::Null,
            )
        };
        let (status, body) = send(&router, list()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body)[0]["last_outcome"], serde_json::Value::Null);

        tunnels
            .outcomes()
            .record_for_tunnel("alice", TunnelOutcome::TunnelDown);

        let (_, body) = send(&router, list()).await;
        assert_eq!(json(&body)[0]["last_outcome"], "tunnel_down");
    }

    #[tokio::test]
    async fn connection_totals_need_the_admin_signature_and_the_admin_host() {
        let (router, _tunnels, alice, _fixture) = router_with_alice().await;
        let uri = format!("{ADMIN}/api/connection-totals");
        let unsigned = Request::builder()
            .uri("/api/connection-totals")
            .header(header::HOST, "admin.relay.example.com")
            .body(Body::empty())
            .unwrap();
        let now = unix_now().unwrap();
        for request in [
            unsigned,
            signed_request("GET", &uri, b"", "alice", &alice, now, "a"),
        ] {
            let (status, body) = send(&router, request).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert!(body.is_empty(), "a 401 carries no detail");
        }
        let off_host = admin_request(
            "GET",
            "https://relay.example.com/api/connection-totals",
            &serde_json::Value::Null,
        );
        let (status, _) = send(&router, off_host).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// Counts already flushed and counts still pending are listed together,
    /// every outcome present.
    #[tokio::test]
    async fn connection_totals_merge_flushed_and_pending_counts() {
        let (router, tunnels, _, _fixture) = router_with_alice().await;
        let outcomes = tunnels.outcomes();
        outcomes.record_for_tunnel("alice", TunnelOutcome::Ok);
        outcomes.record(Outcome::UnknownTunnel);
        tunnels.flush_connection_totals_once().await;
        outcomes.record_for_tunnel("alice", TunnelOutcome::Ok);
        let before = crate::domain::hour_start(unix_now().unwrap());

        let (status, body) = send(
            &router,
            admin_request(
                "GET",
                &format!("{ADMIN}/api/connection-totals"),
                &serde_json::Value::Null,
            ),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        let listed = json(&body);
        let listed = listed.as_array().unwrap();
        // One hour, unless the hour turned while the test ran.
        assert!((1..=2).contains(&listed.len()), "{listed:?}");
        assert!(listed[0]["hour"].as_i64().unwrap() <= before);
        let sum = |field: &str| -> u64 {
            listed
                .iter()
                .map(|hour| hour[field].as_u64().unwrap())
                .sum()
        };
        assert_eq!(sum("ok"), 2);
        assert_eq!(sum("unknown_tunnel"), 1);
        assert_eq!(sum("tunnel_down"), 0);
        for hour in listed {
            assert_eq!(hour.as_object().unwrap().len(), 11, "{hour}");
        }
    }

    /// `apps/relay/relay-core-js/src/http-api-definition/fixtures/admin-wire.json`
    /// holds the admin API's list bodies as relay-core-js decodes them
    /// (`tunnels.test.ts`). These are the same values, serialized as the
    /// relay does.
    #[test]
    fn the_admin_wire_fixture_matches_what_the_relay_serializes() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../relay-core-js/src/http-api-definition/fixtures/admin-wire.json"
        )))
        .unwrap();
        let tunnel = |name: &str, last_outcome| {
            let mut stored = crate::domain::test_fake::stored_tunnel(name);
            stored.created_at = 1_700_000_000;
            TunnelInfo::new(stored, format!("{name}.relay.example.com"), last_outcome)
        };
        let list_tunnels = [
            tunnel("alice", Some(TunnelOutcome::TunnelDown)),
            tunnel("bob", None),
        ];
        let mut first = HourlyTotals::new(crate::domain::hour_start(1_700_000_000));
        first.add(Outcome::Ok, 12);
        first.add(Outcome::UnknownTunnel, 3);
        first.add(Outcome::TunnelDown, 1);
        let mut second = HourlyTotals::new(first.hour + 3600);
        for (index, outcome) in Outcome::ALL.into_iter().enumerate() {
            second.add(outcome, u64::try_from(index).unwrap() + 1);
        }
        let list_connection_totals: Vec<_> = [first, second]
            .iter()
            .map(ConnectionTotalsBody::from)
            .collect();
        assert_eq!(
            serde_json::json!({
                "ListTunnels": list_tunnels,
                "ListConnectionTotals": list_connection_totals,
            }),
            fixture
        );
    }
}
