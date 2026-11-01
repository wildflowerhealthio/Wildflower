//! `GET /authorization/grants`: the Owner's list of every standing grant, so
//! they can see what each app and device keeps.

use axum::response::IntoResponse;
use axum::Json;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::domain::grant::Grant;
use crate::live_bindings::LiveGrantsReader;

/// `GET /authorization/grants` — every standing grant, of both kinds, in the
/// order they were granted: what each app or device has been allowed and
/// keeps. Acquired through [`LiveGrantsReader`] (scope `wildflower/Grant.r`):
/// the read capability *is* the extractor, so the scope check can't be
/// skipped.
#[utoipa::path(
    get,
    tag = "Access management",
    path = "/grants",
    responses(
        (status = 200, description = "Every standing grant, in the order granted", body = [Grant]),
        (status = 500, description = "A store failed; logged, with no body"),
    ),
)]
pub(super) async fn handle_list_grants(
    grants: Scoped<LiveGrantsReader>,
) -> Result<impl IntoResponse, AuthorizationServerError> {
    Ok(Json(grants.list()?))
}
