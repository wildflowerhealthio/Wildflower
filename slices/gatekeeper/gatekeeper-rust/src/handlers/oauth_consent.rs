use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::require_auth::AppState;
use crate::store::authorization_request::{GrantType, RequestStatus};
use crate::store::grant::GrantRow;
use crate::time;

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

#[derive(Debug, Deserialize)]
pub struct ApproveBody {
    #[serde(rename = "approvedScopes")]
    pub approved_scopes: Vec<String>,
    pub patient: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ConsentResult {
    Approved,
    Denied,
    Error { message: String },
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
    let request = match state.store.authorization_request_by_id(&id) {
        Ok(Some(r))
            if r.status == RequestStatus::Pending
                && r.grant_type == GrantType::AuthorizationCode
                && r.redirect_uri.is_some() =>
        {
            r
        }
        Ok(_) => return not_found(&id),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    Json(OAuthConsent {
        id: id.clone(),
        client_id: request.client_id,
        scopes: request.requested_scopes,
        redirect_uri: request.redirect_uri.unwrap(),
        pre_approved_scopes: request.pre_approved_scopes.unwrap_or_default(),
        patient: request.patient,
    })
    .into_response()
}

async fn approve_consent(
    Extension(state): Extension<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ApproveBody>,
) -> Response {
    let request = match state.store.authorization_request_by_id(&id) {
        Ok(Some(r))
            if r.status == RequestStatus::Pending
                && r.grant_type == GrantType::AuthorizationCode
                && r.redirect_uri.is_some() =>
        {
            r
        }
        Ok(_) => return not_found(&id),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let redirect_uri = request.redirect_uri.clone().unwrap();
    if state
        .store
        .approve_authorization_request(&id, &body.approved_scopes, body.patient.as_deref())
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if upsert_grant(&state, &request.client_id, &redirect_uri, &body.approved_scopes, body.patient.as_deref())
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(ConsentResult::Approved).into_response()
}

async fn deny_consent(Extension(state): Extension<AppState>, Path(id): Path<String>) -> Response {
    let request = match state.store.authorization_request_by_id(&id) {
        Ok(Some(r))
            if r.status == RequestStatus::Pending
                && r.grant_type == GrantType::AuthorizationCode
                && r.redirect_uri.is_some() =>
        {
            r
        }
        Ok(_) => return not_found(&id),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let _ = request;
    if state.store.deny_authorization_request(&id).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(ConsentResult::Denied).into_response()
}

fn upsert_grant(
    state: &AppState,
    client_id: &str,
    redirect_uri: &str,
    scopes: &[String],
    patient: Option<&str>,
) -> crate::store::DbResult<()> {
    let now = time::to_iso(time::now());
    if let Some(existing) = state
        .store
        .grant_by_client_and_redirect(client_id, redirect_uri)?
    {
        state
            .store
            .update_grant(&existing.id, scopes, &now, patient)
    } else {
        let row = GrantRow {
            id: Uuid::new_v4().to_string(),
            client_id: client_id.to_string(),
            scopes: scopes.to_vec(),
            redirect_uri: redirect_uri.to_string(),
            granted_at: now,
            last_used_at: None,
            patient: patient.map(str::to_string),
        };
        state.store.create_grant(row)
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
