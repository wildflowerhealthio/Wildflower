//! `GET /oauth/sign-in?code=…&next=…` — the same-device sign-in of an Owner browser. The base mints a
//! one-time code in-process and opens this URL in a browser it can't script;
//! redeeming the code signs that browser in as the Owner. Wildflower has no
//! accounts or passwords, and OAuth leaves how a person signs in to the
//! authorization server (RFC 6749 §3.1): here, holding the device the server
//! runs on is what makes someone the Owner.
//!
//! A browser page, not API surface, so it is kept out of the `OpenAPI` spec,
//! like the wait page.

use std::sync::Arc;

use axum::extract::Query;
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use chrono::Utc;
use serde::Deserialize;

use crate::domain::capabilities::oauth::{
    OwnerBrowserSession, SameDeviceSignInError, SignInRefusal,
};
use crate::http::errors::{sign_in_error_html, InternalError};
use crate::http::extractors::Live;
use crate::http::owner_browser_session_set_cookie;
use crate::http::state::AuthorizationServerState;
use crate::http::wire_representations::CacheSuppressed;
use crate::live_bindings::LiveSameDeviceSignIn;

/// The sign-in's route, relative to the `/oauth` mount.
pub(crate) fn router() -> Router<Arc<AuthorizationServerState>> {
    Router::new().route("/sign-in", get(handle_sign_in))
}

/// The query the base puts on the sign-in URL. A missing parameter reads as
/// empty, which no code and no allowed `next` is, so it gets the error page
/// like any other bad value.
#[derive(Deserialize)]
struct SignInParams {
    /// The one-time same-device sign-in code.
    #[serde(default)]
    code: String,
    /// Where the browser goes once signed in.
    #[serde(default)]
    next: String,
}

/// Redeem the code for an Owner browser's session token, hand the browser the token as
/// its `__Host-owner_browser_session` cookie, and `303` it on to `next`. A `next` that
/// isn't allowed, a disabled Owner-browser client, or a code that is unknown,
/// spent or expired, gets the error page, with no cookie and no redirect.
///
/// Every answer is uncached and sends no `Referer` on, since the request's own
/// URL carries the code.
async fn handle_sign_in(
    same_device_sign_in: Live<LiveSameDeviceSignIn>,
    Query(params): Query<SignInParams>,
) -> Response {
    let response = match same_device_sign_in.sign_in(&params.code, &params.next, Utc::now()) {
        Ok(OwnerBrowserSession {
            access_token,
            redirect,
        }) => (
            StatusCode::SEE_OTHER,
            [
                (header::LOCATION, redirect.location().to_owned()),
                (
                    header::SET_COOKIE,
                    owner_browser_session_set_cookie(&access_token),
                ),
            ],
        )
            .into_response(),
        Err(SameDeviceSignInError::Refused(refusal)) => refusal_page(refusal),
        Err(SameDeviceSignInError::Store(error)) => {
            InternalError::new("read the Owner-browser client", error).into_response()
        }
        Err(SameDeviceSignInError::Issuance(error)) => {
            InternalError::new("mint the Owner browser's session token", error).into_response()
        }
    };
    (
        [(header::REFERRER_POLICY, "no-referrer")],
        CacheSuppressed(response),
    )
        .into_response()
}

fn refusal_page(refusal: SignInRefusal) -> Response {
    (StatusCode::BAD_REQUEST, Html(sign_in_error_html(refusal))).into_response()
}
