use axum::extract::{Path, State};
use axum::routing::{post, MethodRouter};
use axum::Json;
use chrono::Utc;

use crate::crypto_util::random_token::generate_authorization_code;
use crate::domain::actions;
use crate::http::errors::HandlerError;
use crate::http::state::AppState;
use crate::http::wire_representations::{ApproveBody, ConsentResult};

/// `POST /oauth-consents/{id}/approve` — the Owner approves a consent prompt,
/// granting a (narrowed) scope set and minting the authorization code the
/// polling endpoint hands back to the client. All of that lives in
/// [`actions::approve_oauth_consent`]; the handler just adapts HTTP ⇄ domain.
pub(super) fn route() -> MethodRouter<AppState> {
    post(handle_approve_oauth_consent)
}

async fn handle_approve_oauth_consent(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ApproveBody>,
) -> Result<Json<ConsentResult>, HandlerError> {
    let outcome = actions::approve_oauth_consent(
        &state.store,
        &state,
        &id,
        actions::ApproveOAuthConsentInput {
            approved_scopes: body.approved_scopes,
            patient: body.patient,
        },
        generate_authorization_code,
        Utc::now(),
    )?;
    Ok(Json(outcome.into()))
}
