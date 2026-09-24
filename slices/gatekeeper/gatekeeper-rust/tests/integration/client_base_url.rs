//! `wildflower_client_base_url`: a first-party client names the owner UI copy
//! it runs from, and the pages `/oauth/authorize`, `/oauth/device_authorization`
//! and `/access/logout` hand back resolve there instead of on the configured
//! [`OWNER_UI_BASE`]. On the two sign-in endpoints the copy must be vouched for
//! by a redirect the client registered; otherwise the page stays on
//! [`OWNER_UI_BASE`] and carries the copy for the Owner to confirm. Another
//! client's value is ignored; a malformed value is rejected before the endpoint
//! has any effect (logout still revokes).

use gatekeeper_rust::domain::client_base_url::CLIENT_BASE_URL_PARAM;
use url::form_urlencoded;

use crate::common::*;

/// A PR preview's copy of the owner UI — somewhere other than [`OWNER_UI_BASE`].
const PREVIEW_BASE: &str = "https://wildflowerhealthio.github.io/staging/pr-736/app/";

/// The owner scope set the hosted owner UI requests, URL-encoded.
const OWNER_SCOPES_QUERY: &str = "system%2F*.cruds%20wildflower%2F*.cruds%20wildflower%2Flaunch";

/// `key=value`, form-encoded.
fn param(key: &str, value: &str) -> String {
    form_urlencoded::Serializer::new(String::new())
        .append_pair(key, value)
        .finish()
}

fn client_base_param(value: &str) -> String {
    param(CLIENT_BASE_URL_PARAM, value)
}

/// The URL with its query dropped — the page a `Location` names.
fn page_of(location: &str) -> String {
    let mut url = Url::parse(location).expect("absolute URL");
    url.set_query(None);
    url.into()
}

/// The hosted owner UI's sign-in: `/authorize` for `wildflower-react`,
/// redirecting to `redirect_uri` and naming `client_base` as its copy.
fn owner_ui_sign_in_query(redirect_uri: &str, client_base: &str) -> String {
    form_urlencoded::Serializer::new(String::new())
        .append_pair("response_type", "code")
        .append_pair("code_challenge_method", "S256")
        .append_pair("client_id", "wildflower-react")
        .append_pair(
            "scope",
            "system/*.cruds wildflower/*.cruds wildflower/launch",
        )
        .append_pair("code_challenge", &compute_code_challenge(CODE_VERIFIER))
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("state", "xyz")
        .append_pair(CLIENT_BASE_URL_PARAM, client_base)
        .finish()
}

/// The polling page for the request `res` parked, on `owner_ui`, carrying
/// `extra_query` after `?server=`.
fn expected_polling_url(
    res: &axum::response::Response,
    owner_ui: &str,
    extra_query: &str,
) -> String {
    let request_id = polling_request_id(&location_of(res));
    format!(
        "{owner_ui}gatekeeper/oauth-polling/{request_id}?server=http%3A%2F%2F127.0.0.1{extra_query}"
    )
}

#[tokio::test]
async fn authorize_parks_the_owner_ui_on_a_copy_its_registered_redirect_lies_under() {
    let (g, _host_owner_token, db) = spin_up();
    let redirect_uri = format!("{PREVIEW_BASE}signed-in");
    seed_client_with_redirect(&db, "wildflower-react", &redirect_uri, &["system/*.cruds"]);
    let res = get_authorize(
        &g.router,
        &owner_ui_sign_in_query(&redirect_uri, PREVIEW_BASE),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FOUND);
    assert_eq!(
        location_of(&res),
        expected_polling_url(&res, PREVIEW_BASE, "")
    );
}

#[tokio::test]
async fn authorize_asks_before_continuing_on_a_copy_no_redirect_vouches_for() {
    // A copy's first sign-in: its redirect isn't registered yet.
    let (g, _host_owner_token, _db) = spin_up();
    let res = get_authorize(
        &g.router,
        &owner_ui_sign_in_query(&format!("{PREVIEW_BASE}signed-in"), PREVIEW_BASE),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FOUND);
    assert_eq!(
        location_of(&res),
        expected_polling_url(
            &res,
            OWNER_UI_BASE,
            &format!("&{}", client_base_param(PREVIEW_BASE))
        )
    );
}

#[tokio::test]
async fn a_crafted_sign_in_link_cannot_move_the_polling_page_to_an_unapproved_copy() {
    // The Owner has approved the preview; a link naming the first-party
    // `client_id` with an attacker's copy and redirect still lands on the
    // configured owner UI.
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "wildflower-react",
        &format!("{PREVIEW_BASE}signed-in"),
        &["system/*.cruds"],
    );
    let evil_base = "https://evil.example/app/";
    let res = get_authorize(
        &g.router,
        &owner_ui_sign_in_query("https://evil.example/app/signed-in", evil_base),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FOUND);
    assert_eq!(
        location_of(&res),
        expected_polling_url(
            &res,
            OWNER_UI_BASE,
            &format!("&{}", client_base_param(evil_base))
        )
    );
}

#[tokio::test]
async fn authorize_ignores_a_third_party_clients_base() {
    let (g, _host_owner_token, _db) = spin_up();
    let query = format!(
        "{}&{}",
        authorize_query("some-smart-app", "patient%2FObservation.rs"),
        client_base_param(PREVIEW_BASE)
    );
    let res = get_authorize(&g.router, &query).await;
    // `parked_request_id` pins the polling page to the configured base.
    parked_request_id(&res);
}

#[tokio::test]
async fn authorize_rejects_a_malformed_base_without_parking_a_request() {
    let (g, _host_owner_token, db) = spin_up();
    for bad in ["/staging/app/", "javascript:alert(1)"] {
        let query = format!(
            "{}&{}",
            authorize_query("wildflower-react", OWNER_SCOPES_QUERY),
            client_base_param(bad)
        );
        let res = get_authorize(&g.router, &query).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST, "{bad}");
        assert!(
            body_string(res.into_body())
                .await
                .contains("Invalid client base URL"),
            "{bad}"
        );
    }
    assert_eq!(
        pending_consent_head(&db),
        None,
        "a rejected /authorize must not park anything"
    );
}

async fn post_device_authorization(g: &Gatekeeper, body: String) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(loopback_request(
            Request::post("/oauth/device_authorization")
                .header("content-type", "application/x-www-form-urlencoded"),
            Body::from(body),
        ))
        .await
        .expect("oneshot")
}

#[tokio::test]
async fn device_authorization_points_a_first_party_client_at_a_copy_its_redirect_vouches_for() {
    let (g, _host_owner_token, db) = spin_up();
    seed_client_with_redirect(
        &db,
        "wildflower-host",
        &format!("{PREVIEW_BASE}signed-in"),
        &["system/*.cruds"],
    );
    let res = post_device_authorization(
        &g,
        format!(
            "client_id=wildflower-host&scope=system%2F*.cruds&{}",
            client_base_param(PREVIEW_BASE)
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    let user_code = body["user_code"].as_str().expect("user_code");
    assert_eq!(
        body["verification_uri"],
        format!("{PREVIEW_BASE}gatekeeper/devices?server=http%3A%2F%2F127.0.0.1")
    );
    assert_eq!(
        body["verification_uri_complete"],
        format!(
            "{PREVIEW_BASE}gatekeeper/devices?server=http%3A%2F%2F127.0.0.1&user_code={user_code}"
        )
    );
}

#[tokio::test]
async fn device_authorization_asks_before_continuing_on_a_copy_no_redirect_vouches_for() {
    // The seeded first-party client registers no redirect.
    let (g, _host_owner_token, _db) = spin_up();
    let res = post_device_authorization(
        &g,
        format!(
            "client_id=wildflower-host&scope=system%2F*.cruds&{}",
            client_base_param(PREVIEW_BASE)
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let body = body_json(res.into_body()).await;
    let user_code = body["user_code"].as_str().expect("user_code");
    let confirm = client_base_param(PREVIEW_BASE);
    assert_eq!(
        body["verification_uri"],
        format!("{OWNER_UI_BASE}gatekeeper/devices?server=http%3A%2F%2F127.0.0.1&{confirm}")
    );
    assert_eq!(
        body["verification_uri_complete"],
        format!(
            "{OWNER_UI_BASE}gatekeeper/devices?server=http%3A%2F%2F127.0.0.1\
             &user_code={user_code}&{confirm}"
        )
    );
}

#[tokio::test]
async fn device_authorization_rejects_a_malformed_base() {
    let (g, _host_owner_token, db) = spin_up();
    let res = post_device_authorization(
        &g,
        format!(
            "client_id=wildflower-host&{}",
            client_base_param("data:text/html,hi")
        ),
    )
    .await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(res.into_body()).await["error"], "invalid_request");
    assert_eq!(
        pending_consent_head(&db),
        None,
        "a rejected device authorization must not issue a pairing"
    );
}

async fn post_logout(g: &Gatekeeper, token: &str, query: &str) -> axum::response::Response {
    g.router
        .clone()
        .oneshot(loopback_request(
            Request::post(format!("/access/logout?{query}"))
                .header("host", "127.0.0.1")
                .header("authorization", format!("Bearer {token}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot")
}

#[tokio::test]
async fn logout_lands_a_first_party_session_on_the_base_it_names() {
    // The host owner token is bound to the first-party `wildflower-host`.
    let (g, host_owner_token, _db) = spin_up();
    let res = post_logout(&g, &host_owner_token, &client_base_param(PREVIEW_BASE)).await;
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    assert_eq!(page_of(&location_of(&res)), PREVIEW_BASE);
}

#[tokio::test]
async fn logout_ignores_a_third_party_sessions_base() {
    let (g, _host_owner_token, db) = spin_up();
    let token = mint_scoped_token(&db, &["patient/Observation.rs"]);
    let res = post_logout(&g, &token, &client_base_param(PREVIEW_BASE)).await;
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    assert_eq!(page_of(&location_of(&res)), OWNER_UI_BASE);
}

#[tokio::test]
async fn logout_rejects_a_malformed_base_but_still_ends_the_session() {
    let (g, host_owner_token, db) = spin_up();
    let res = post_logout(&g, &host_owner_token, &client_base_param("not a url")).await;
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    assert!(
        revocation_store_handle(&db)
            .is_revoked_by_jti(&jti_of(&host_owner_token))
            .expect("query"),
        "the client has already forgotten its bearer, so logout must revoke it regardless"
    );
}
