//! `POST /access/revocations` — the owner-gated token-revocation control
//! surface. Owner-gated by the `/access` mount (`require_owner_auth`), so only
//! an authenticated owner can revoke.
//!
//! Two modes, exactly one per request:
//!
//! - **Per-token** — `{ "jti": "…", "expiresAt": "<RFC3339>" }` denylists a
//!   single token until its own expiry (the `expiresAt` lets the background
//!   sweep drop the row once the token would have expired anyway).
//! - **Bulk, per subject** — `{ "subject": "<client_id>" }` bumps the subject's
//!   revocation epoch to *now*, invalidating every token that subject holds
//!   whose `iat` predates the call. `subject` is the `sub` claim (today the
//!   `client_id`); per-device granularity is future work (see #269).
//!
//! The revoke-device endpoint the ticket mentions is deferred — it would be a
//! thin wrapper over the same `subject` mode once a device/session handle is
//! minted into tokens.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/revocations", post(handle_create_revocation))
}

/// Body of `POST /access/revocations`. Fields are optional at the type level so
/// the handler can return a precise 400 for an ambiguous or empty body rather
/// than a generic deserialization error.
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

async fn handle_create_revocation(
    State(state): State<AppState>,
    Json(request): Json<RevocationRequest>,
) -> Result<StatusCode, HandlerError> {
    match (request.jti, request.subject) {
        (Some(jti), None) => {
            let expires_at = request.expires_at.ok_or_else(|| {
                HandlerError::bad_request(
                    "MissingExpiresAt",
                    "revoking by `jti` requires `expiresAt` (the token's own expiry)",
                )
            })?;
            state
                .revocation_store
                .revoke_jti(&jti, expires_at, "admin")
                .map_err(|e| HandlerError::internal("revoke_jti failed", e))?;
        }
        (None, Some(subject)) => {
            // Bulk revoke: everything this subject holds issued before now.
            state
                .revocation_store
                .bump_subject_epoch(&subject, Utc::now())
                .map_err(|e| HandlerError::internal("bump_subject_epoch failed", e))?;
        }
        (Some(_), Some(_)) => {
            return Err(HandlerError::bad_request(
                "AmbiguousRevocation",
                "provide exactly one of `jti` or `subject`, not both",
            ));
        }
        (None, None) => {
            return Err(HandlerError::bad_request(
                "EmptyRevocation",
                "provide either `jti` (with `expiresAt`) or `subject`",
            ));
        }
    }
    Ok(StatusCode::NO_CONTENT)
}
