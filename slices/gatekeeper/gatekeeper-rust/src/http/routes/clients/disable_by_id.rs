use axum::extract::Path;
use axum::http::StatusCode;
use chrono::Utc;

use crate::domain::capabilities::Scoped;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::errors::{ClientNotFoundBody, FirstPartyClientLockedBody};
use crate::live_bindings::LiveClientsDisabler;

/// `POST /access/clients/{clientId}/disable` — take back the Owner's trust in a client:
/// `/oauth/authorize` and `/oauth/token` refuse it until it is re-enabled.
/// Idempotent (a repeat keeps the first `disabledAt`). The first-party host
/// client is refused with `409 FirstPartyClientLocked`. Acquired through
/// [`LiveClientsDisabler`] (scope `wildflower/Client.u`).
#[utoipa::path(
    post,
    tag = "Access management",
    path = "/clients/{clientId}/disable",
    params(("clientId" = String, Path, description = "The client's `client_id`")),
    responses(
        (status = 204, description = "The client is disabled"),
        (status = 404, description = "No client with that id", body = ClientNotFoundBody),
        (status = 409, description = "The first-party host client can't be disabled", body = FirstPartyClientLockedBody),
    ),
)]
pub(super) async fn handle_disable_client(
    clients: Scoped<LiveClientsDisabler>,
    Path(client_id): Path<String>,
) -> Result<StatusCode, GatekeeperError> {
    clients.disable(&client_id, Utc::now())?;
    Ok(StatusCode::NO_CONTENT)
}
