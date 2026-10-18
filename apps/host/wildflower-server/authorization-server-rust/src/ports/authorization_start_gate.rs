//! [`AuthorizationStartGate`] — the host's say over how fast authorization
//! requests are started, asked by the limit on the two routes that start one
//! (`http::middleware::authorization_start_limit`).

use axum::http::Extensions;

/// Whether a request may start an authorization request
/// (`GET /oauth/authorize`, `POST /oauth/device_authorization`), handed to
/// [`crate::setup_authorization_server`].
///
/// The authorization server knows nothing of who is asking beyond the
/// request; the host, whose listener put what it knows of the connection in
/// the request's extensions (its connect info), decides. Asked at most once
/// per request: before the request is parsed, or, for a request carrying a
/// browser session that can decide consents, only once the request is to be
/// raised for the Owner. `POST /authorization/oauth-consents/{id}/ask-owner`,
/// which raises a parked request for the Owner, asks it too, only when it
/// raises one. A request it admits has spent from whatever
/// allowance it keeps, and one it refuses is answered
/// `429 Too Many Requests`.
pub trait AuthorizationStartGate: Send + Sync + 'static {
    /// Whether to admit the request `request_extensions` belong to, spending
    /// from its allowance when it does.
    fn admit(&self, request_extensions: &Extensions) -> bool;
}

/// The [`AuthorizationStartGate`] that admits every request: for an
/// authorization server no visitor reaches, as in tests.
pub struct AdmitEveryAuthorizationStart;

impl AuthorizationStartGate for AdmitEveryAuthorizationStart {
    fn admit(&self, _request_extensions: &Extensions) -> bool {
        true
    }
}
