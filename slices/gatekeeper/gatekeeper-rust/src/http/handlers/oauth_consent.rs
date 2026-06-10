use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::grant::Grant;
use crate::http::state::AppState;
use crate::json::Json as JsonWrap;

/// Body returned to the Owner UI when it loads an authorization-code consent
/// prompt — describes the client, scopes, and any pre-approved subset.
#[derive(Debug, Serialize)]
pub struct OAuthConsent {
    pub id: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub scopes: Vec<String>,
    #[serde(rename = "redirectUri")]
    pub redirect_uri: String,
    #[serde(rename = "preApprovedScopes")]
    pub pre_approved_scopes: Vec<String>,
    pub patient: Option<String>,
}

/// Body posted by the Owner UI to approve a consent prompt.
#[derive(Debug, Deserialize)]
pub struct ApproveBody {
    #[serde(rename = "approvedScopes")]
    pub approved_scopes: Vec<String>,
    pub patient: Option<String>,
}

/// Result the Owner UI sees after approving or denying a consent prompt.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ConsentResult {
    Approved,
    Denied,
}

#[derive(Debug, Serialize)]
struct NotFound {
    error: &'static str,
    id: String,
}

pub fn router() -> Router {
    Router::new()
        .route("/oauth-consents/{id}", get(get_consent))
        .route("/oauth-consents/{id}/approve", post(approve_consent))
        .route("/oauth-consents/{id}/deny", post(deny_consent))
}

async fn get_consent(Extension(state): Extension<AppState>, Path(id): Path<String>) -> Response {
    let request = match load_pending_authorization_code_request(&state, &id) {
        Ok(r) => r,
        Err(response) => return *response,
    };
    let redirect_uri = request
        .redirect_uri
        .expect("load_pending_authorization_code_request guarantees Some(redirect_uri)");
    Json(OAuthConsent {
        id: id.clone(),
        client_id: request.client_id,
        scopes: request.requested_scopes.0,
        redirect_uri,
        pre_approved_scopes: request.pre_approved_scopes.map(|j| j.0).unwrap_or_default(),
        patient: request.patient,
    })
    .into_response()
}

async fn approve_consent(
    Extension(state): Extension<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ApproveBody>,
) -> Response {
    let request = match load_pending_authorization_code_request(&state, &id) {
        Ok(r) => r,
        Err(response) => return *response,
    };
    let redirect_uri = request
        .redirect_uri
        .expect("load_pending_authorization_code_request guarantees Some(redirect_uri)");
    if let Err(e) = state.store.approve_authorization_request(
        &id,
        &body.approved_scopes,
        body.patient.as_deref(),
    ) {
        return internal_error("approve_authorization_request failed", e);
    }
    if let Err(e) = upsert_grant(
        &state,
        &request.client_id,
        &redirect_uri,
        &body.approved_scopes,
        body.patient.as_deref(),
    ) {
        return internal_error("upsert_grant failed", e);
    }
    Json(ConsentResult::Approved).into_response()
}

async fn deny_consent(Extension(state): Extension<AppState>, Path(id): Path<String>) -> Response {
    if let Err(response) = load_pending_authorization_code_request(&state, &id) {
        return *response;
    }
    if let Err(e) = state.store.deny_authorization_request(&id) {
        return internal_error("deny_authorization_request failed", e);
    }
    Json(ConsentResult::Denied).into_response()
}

/// Load the authorization request for `id` and verify it's a pending
/// authorization-code flow with a `redirect_uri`. Returns a ready-to-use
/// `Response` for both "not found" and "internal error" outcomes so each
/// handler can `match` once and move on.
fn load_pending_authorization_code_request(
    state: &AppState,
    id: &str,
) -> Result<AuthorizationRequest, Box<Response>> {
    match state.store.authorization_request_by_id(id) {
        Ok(Some(r))
            if r.status == RequestStatus::Pending
                && r.grant_type == GrantType::AuthorizationCode
                && r.redirect_uri.is_some() =>
        {
            Ok(r)
        }
        Ok(_) => Err(Box::new(not_found(id))),
        Err(e) => Err(Box::new(internal_error(
            "authorization_request_by_id lookup failed",
            e,
        ))),
    }
}

fn upsert_grant(
    state: &AppState,
    client_id: &str,
    redirect_uri: &str,
    scopes: &[String],
    patient: Option<&str>,
) -> crate::db::DbResult<()> {
    let now = Utc::now();
    if let Some(existing) = state
        .store
        .grant_by_client_and_redirect(client_id, redirect_uri)?
    {
        state.store.update_grant(&existing.id, scopes, now, patient)
    } else {
        let grant = Grant {
            id: Uuid::new_v4().to_string(),
            client_id: client_id.to_string(),
            scopes: JsonWrap(scopes.to_vec()),
            redirect_uri: redirect_uri.to_string(),
            granted_at: now,
            last_used_at: None,
            patient: patient.map(str::to_string),
        };
        state.store.create_grant(&grant)
    }
}

fn not_found(id: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(NotFound {
            error: "OAuthConsentNotFound",
            id: id.to_string(),
        }),
    )
        .into_response()
}

fn internal_error(context: &str, err: impl std::fmt::Display) -> Response {
    tracing::error!(error = %err, "{context}");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}
