//! Every Owner `/access/*` response is cache-suppressed by one blanket layer —
//! handler output, the session gate's 401, and 404s alike — so a shared or
//! browser cache never retains a consent prompt, a device prompt, or the
//! grants list.

use crate::common::*;

/// An Owner-authenticated `GET` against `path`.
fn owner_get(host_owner_token: &str, path: &str) -> Request<Body> {
    loopback_request(
        Request::get(path)
            .header("host", "127.0.0.1")
            .header("authorization", format!("Bearer {host_owner_token}")),
        Body::empty(),
    )
}

#[tokio::test]
async fn device_prompt_is_cache_suppressed() {
    let (g, host_owner_token, _db) = spin_up();
    let start = loopback_request(
        Request::post("/oauth/device_authorization")
            .header("content-type", "application/x-www-form-urlencoded"),
        Body::from("client_id=wildflower-host&scope=system%2F*.cruds"),
    );
    let res = g.router.clone().oneshot(start).await.expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let user_code = body_json(res.into_body()).await["user_code"]
        .as_str()
        .expect("user_code")
        .to_string();

    let res = g
        .router
        .clone()
        .oneshot(owner_get(
            &host_owner_token,
            &format!("/access/devices/{user_code}"),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_cache_suppressed(&res, "the device prompt");
}

#[tokio::test]
async fn oauth_consent_prompt_is_cache_suppressed() {
    let (g, host_owner_token, db) = spin_up();
    seed_client_with_redirect(&db, "test-app", "https://app.example/cb", &["read"]);
    let res = get_authorize(&g.router, &authorize_query("test-app", "read")).await;
    let request_id = parked_request_id(&res);

    let res = g
        .router
        .clone()
        .oneshot(owner_get(
            &host_owner_token,
            &format!("/access/oauth-consents/{request_id}"),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_cache_suppressed(&res, "the oauth-consent prompt");
}

#[tokio::test]
async fn grants_list_is_cache_suppressed() {
    let (g, host_owner_token, _db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(owner_grants_probe(&host_owner_token))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_cache_suppressed(&res, "the grants list");
}

/// The session gate's rejection sits inside the cache-suppression layer, so an
/// unauthenticated request's 401 carries the headers too.
#[tokio::test]
async fn unauthenticated_401_is_cache_suppressed() {
    let (g, _host_owner_token, _db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get("/access/grants").header("host", "127.0.0.1"),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_cache_suppressed(&res, "the unauthenticated 401");
}

/// A handler's own 404 — an unknown `user_code` — is suppressed like its 200.
#[tokio::test]
async fn unknown_device_404_is_cache_suppressed() {
    let (g, host_owner_token, _db) = spin_up();
    let res = g
        .router
        .clone()
        .oneshot(owner_get(&host_owner_token, "/access/devices/NOPE-NOPE"))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_cache_suppressed(&res, "the unknown-device 404");
}

/// The code-flow status poll renders every variant through `CacheSuppressed`;
/// `Pending` is pinned here, `Approved` in the auth-code happy path.
#[tokio::test]
async fn pending_authorization_status_is_cache_suppressed() {
    let (g, _host_owner_token, _db) = spin_up();
    let res = get_authorize(&g.router, &authorize_query("ghost", "read")).await;
    let request_id = parked_request_id(&res);

    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize/{request_id}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    assert_cache_suppressed(&res, "the pending status poll");
}
