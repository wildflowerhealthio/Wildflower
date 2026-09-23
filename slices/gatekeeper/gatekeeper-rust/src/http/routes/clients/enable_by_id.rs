use axum::extract::Path;
use axum::http::StatusCode;

use crate::domain::capabilities::Scoped;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::errors::ClientNotFoundBody;
use crate::live_bindings::LiveClientsDisabler;

/// `POST /access/clients/{clientId}/enable` — restore a disabled client with its
/// registration intact. Idempotent. Acquired through [`LiveClientsDisabler`]
/// (scope `wildflower/Client.u`).
#[utoipa::path(
    post,
    tag = "Access management",
    path = "/clients/{clientId}/enable",
    params(("clientId" = String, Path, description = "The client's `client_id`")),
    responses(
        (status = 204, description = "The client is enabled"),
        (status = 404, description = "No client with that id", body = ClientNotFoundBody),
    ),
)]
pub(super) async fn handle_enable_client(
    clients: Scoped<LiveClientsDisabler>,
    Path(client_id): Path<String>,
) -> Result<StatusCode, GatekeeperError> {
    clients.enable(&client_id)?;
    Ok(StatusCode::NO_CONTENT)
}
