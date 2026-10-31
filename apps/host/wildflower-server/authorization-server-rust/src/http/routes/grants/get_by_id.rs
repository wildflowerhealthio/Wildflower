//! `GET /authorization/grants/{id}`: one standing grant, for the Owner's view of
//! what an app or device holds.

use axum::extract::Path;
use axum::response::IntoResponse;
use axum::Json;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::domain::grant::Grant;
use crate::http::errors::GrantNotFoundBody;
use crate::live_bindings::LiveGrantsReader;

/// `GET /authorization/grants/{id}` — one standing grant, or `404` when no
/// grant has the id. Through `Scoped<LiveGrantsReader>`
/// (`wildflower/Grant.r`).
#[utoipa::path(
    get,
    tag = "Access management",
    path = "/grants/{id}",
    params(("id" = String, Path, description = "The grant's id")),
    responses(
        (status = 200, description = "The grant", body = Grant),
        (status = 404, description = "No grant has that id", body = GrantNotFoundBody),
        (status = 500, description = "A store failed; logged, with no body"),
    ),
)]
pub(super) async fn handle_get_grant(
    grants: Scoped<LiveGrantsReader>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AuthorizationServerError> {
    Ok(Json(grants.get(&id)?))
}
