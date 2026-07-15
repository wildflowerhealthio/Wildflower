//! `POST /access/revocations` — the token-revocation control surface. Acquired
//! through the [`TokenRevoker`](crate::http::scoped::facades::TokenRevoker)
//! facade (scope `wildflower/Token.d`): a caller must cover the `Token` delete
//! scope — which an owner's `wildflower/*.cruds` does — to revoke, else a `403`.
//!
//! Two modes, exactly one per request:
//!
//! - **Per-token** — `{ "jti": "…", "expiresAt": "<RFC3339>" }` denylists a
//!   single token until its own expiry (the `expiresAt` lets the background
//!   sweep drop the row once the token would have expired anyway).
//! - **Bulk, per subject** — `{ "subject": "<client_id>" }` bumps the subject's
//!   revocation epoch to just past now (see
//!   [`revoke_subject_as_of_now`](token_revocation_rust::RevocationStore::revoke_subject_as_of_now)),
//!   invalidating every token that subject holds issued at or before the call —
//!   including one minted in the current (second-granular) second. `subject` is
//!   the `sub` claim (today the `client_id`); per-device granularity is future
//!   work (see #269).
//!
//! The revoke-device endpoint the ticket mentions is deferred — it would be a
//! thin wrapper over the same `subject` mode once a device/session handle is
//! minted into tokens.

use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::scoped::facades::TokenRevoker;
use crate::http::scoped::Scoped;
use crate::http::state::GatekeeperState;

pub fn router() -> Router<Arc<GatekeeperState>> {
    Router::new().route("/revocations", post(handle_create_revocation))
}

/// Error half of the revocations handler. The request-body validation failures
/// ([`BadRequest`](RevocationError::BadRequest)) are HTTP-layer-only — they
/// describe a malformed `POST /access/revocations` body, not a domain outcome —
/// so they can't live on [`GatekeeperError`]; the backing-store failures delegate
/// to `GatekeeperError`'s opaque, logged-500 rendering. This is the one residual
/// error mechanism left after the `/access` surface converged on
/// `impl IntoResponse for GatekeeperError` (the rest of the surface returns
/// `Result<_, GatekeeperError>` directly).
enum RevocationError {
    /// A client-fixable malformed request: JSON 400 of the shape
    /// `{ "error": <error>, "detail": <detail> }`.
    BadRequest { error: &'static str, detail: String },
    /// A backing-store failure — rendered through `GatekeeperError` as the shared
    /// opaque, logged 500.
    Store(GatekeeperError),
}

impl RevocationError {
    /// A client-fixable malformed request: JSON 400 with an explanatory detail.
    fn bad_request(error: &'static str, detail: impl Into<String>) -> Self {
        RevocationError::BadRequest {
            error,
            detail: detail.into(),
        }
    }
}

impl From<GatekeeperError> for RevocationError {
    fn from(error: GatekeeperError) -> Self {
        RevocationError::Store(error)
    }
}

impl IntoResponse for RevocationError {
    fn into_response(self) -> Response {
        match self {
            RevocationError::BadRequest { error, detail } => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": error, "detail": detail })),
            )
                .into_response(),
            RevocationError::Store(error) => error.into_response(),
        }
    }
}

/// Wire body of `POST /access/revocations`. Purely the deserialization shape:
/// the fields are optional so [`into_revocation`](RevocationRequest::into_revocation)
/// can return a precise 400 for an ambiguous or empty body rather than a generic
/// deserialization error. The *validated* request is the [`Revocation`] enum —
/// the handler branches on that, never on these raw optionals.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevocationRequest {
    /// The `jti` of a single token to denylist. Requires `expires_at`.
    jti: Option<String>,
    /// The token's own expiry (RFC 3339), recorded so the sweep can later drop
    /// the denylist row. Only meaningful alongside `jti`.
    expires_at: Option<DateTime<Utc>>,
    /// A subject (`sub` / `client_id`) whose whole token cohort to bulk-revoke
    /// via an epoch bump to now.
    subject: Option<String>,
}

/// A validated revocation request: exactly one of the two mutually-exclusive
/// modes. Constructed by [`RevocationRequest::into_revocation`], which rejects
/// the ambiguous/empty/incomplete bodies with a 400 before this exists.
enum Revocation {
    /// Denylist a single token until its own `exp`.
    Token {
        jti: String,
        expires_at: DateTime<Utc>,
    },
    /// Bulk-revoke a subject's whole token cohort via an epoch bump.
    Subject { subject: String },
}

impl RevocationRequest {
    /// Collapse the optional wire fields into exactly one [`Revocation`] mode,
    /// or a 400 for a body that names neither, both, or an incomplete mode.
    fn into_revocation(self) -> Result<Revocation, RevocationError> {
        match (self.jti, self.subject) {
            (Some(jti), None) => {
                let expires_at = self.expires_at.ok_or_else(|| {
                    RevocationError::bad_request(
                        "MissingExpiresAt",
                        "revoking by `jti` requires `expiresAt` (the token's own expiry)",
                    )
                })?;
                Ok(Revocation::Token { jti, expires_at })
            }
            (None, Some(subject)) => Ok(Revocation::Subject { subject }),
            (Some(_), Some(_)) => Err(RevocationError::bad_request(
                "AmbiguousRevocation",
                "provide exactly one of `jti` or `subject`, not both",
            )),
            (None, None) => Err(RevocationError::bad_request(
                "EmptyRevocation",
                "provide either `jti` (with `expiresAt`) or `subject`",
            )),
        }
    }
}

async fn handle_create_revocation(
    tokens: Scoped<TokenRevoker>,
    Json(request): Json<RevocationRequest>,
) -> Result<StatusCode, RevocationError> {
    match request.into_revocation()? {
        Revocation::Token { jti, expires_at } => {
            // Reject an `expiresAt` already in the past: the token is expired
            // (so verification rejects it anyway) and denylisting it just leaves
            // a dead row. A clear 400 surfaces the stale/mistyped value rather
            // than silently no-op'ing. (A too-early-but-future `expiresAt` can't
            // prematurely un-revoke a live token — the store's `purge_expired`
            // retention floor guards that.)
            if expires_at <= Utc::now() {
                return Err(RevocationError::bad_request(
                    "ExpiresAtInPast",
                    "`expiresAt` is in the past; the token has already expired",
                ));
            }
            tokens.revoke_jti(&jti, expires_at)?;
        }
        Revocation::Subject { subject } => tokens.revoke_subject(&subject)?,
    }
    Ok(StatusCode::NO_CONTENT)
}
