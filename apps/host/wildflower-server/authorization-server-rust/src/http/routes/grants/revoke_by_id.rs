use std::sync::Arc;

use axum::extract::Path;
use axum::http::StatusCode;
use axum::routing::{delete, MethodRouter};
use chrono::Utc;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::state::AuthorizationServerState;
use crate::live_bindings::LiveGrantsRevoker;

/// The `DELETE` method on `/grants/{id}`.
pub(super) fn route() -> MethodRouter<Arc<AuthorizationServerState>> {
    delete(handle_revoke_grant)
}

/// `DELETE /authorization/grants/{id}` — revoke a grant, expire the
/// refresh-token families minted under its client, and bump the client's
/// revocation epoch so any still-live *access* tokens die too — no
/// `offline_access` client (or a leaked live bearer) outlives the revocation.
/// Acquired through [`LiveGrantsRevoker`] (scope `wildflower/Grant.d`), which
/// owns the whole cascade, so it doesn't also take `wildflower/Token.d`.
/// `204 No Content`, or `404` when no grant has the id.
async fn handle_revoke_grant(
    grants: Scoped<LiveGrantsRevoker>,
    Path(id): Path<String>,
) -> Result<StatusCode, AuthorizationServerError> {
    grants.revoke(&id, Utc::now())?;
    Ok(StatusCode::NO_CONTENT)
}
