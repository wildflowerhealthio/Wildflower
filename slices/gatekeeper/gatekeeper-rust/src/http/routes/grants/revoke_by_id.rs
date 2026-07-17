use std::sync::Arc;

use axum::extract::Path;
use axum::http::StatusCode;
use axum::routing::{delete, MethodRouter};
use chrono::Utc;

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::capabilities::{GrantsRevoker, Scoped};
use crate::http::state::GatekeeperState;

/// `DELETE /grants/{id}` — revoke a grant, expire the refresh-token families
/// minted under its client, and bump the client's revocation epoch so any
/// still-live *access* tokens die too — no `offline_access` client (or a leaked
/// live bearer) outlives the revocation. Acquired through [`GrantsRevoker`]
/// (scope `wildflower/Grant.d`), which owns the whole cascade.
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    delete(handle_revoke_grant)
}

async fn handle_revoke_grant(
    grants: Scoped<GrantsRevoker>,
    Path(id): Path<String>,
) -> Result<StatusCode, GatekeeperError> {
    grants.revoke(&id, Utc::now())?;
    Ok(StatusCode::NO_CONTENT)
}
