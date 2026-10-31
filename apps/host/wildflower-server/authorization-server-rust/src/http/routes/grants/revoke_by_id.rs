//! `DELETE /authorization/grants/{id}`: the Owner takes back a standing grant,
//! and with it every token the app holds under it.

use axum::extract::Path;
use axum::http::StatusCode;
use chrono::Utc;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::http::errors::GrantNotFoundBody;
use crate::live_bindings::LiveGrantsRevoker;

/// `DELETE /authorization/grants/{id}` — revoke a grant, expire the
/// refresh-token families minted under its client, and bump the client's
/// revocation epoch so any still-live *access* tokens die too — no
/// `offline_access` client (or a leaked live bearer) outlives the revocation.
/// Acquired through [`LiveGrantsRevoker`] (scope `wildflower/Grant.d`), which
/// owns the whole cascade, so it doesn't also take `wildflower/Token.d`.
/// `204 No Content`, or `404` when no grant has the id.
#[utoipa::path(
    delete,
    tag = "Access management",
    path = "/grants/{id}",
    params(("id" = String, Path, description = "The grant's id")),
    responses(
        (status = 204, description = "The grant is revoked, with every token its client holds"),
        (status = 404, description = "No grant has that id", body = GrantNotFoundBody),
        (status = 500, description = "A store failed; logged, with no body"),
    ),
)]
pub(super) async fn handle_revoke_grant(
    grants: Scoped<LiveGrantsRevoker>,
    Path(id): Path<String>,
) -> Result<StatusCode, AuthorizationServerError> {
    grants.revoke(&id, Utc::now())?;
    Ok(StatusCode::NO_CONTENT)
}
