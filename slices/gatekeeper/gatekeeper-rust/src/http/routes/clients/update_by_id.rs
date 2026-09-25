use axum::extract::Path;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use utoipa::ToSchema;

use super::list_all::ClientBody;
use crate::domain::capabilities::Scoped;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::errors::{ClientNotFoundBody, FirstPartyClientLockedBody};
use crate::live_bindings::LiveClientsDisabler;

/// Body of `PATCH /access/clients/{clientId}` — the one client field the Owner
/// can edit.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateClientBody {
    /// When the client stops working: the caller's current time to disable it
    /// now (a time already past is replaced by the server's), a later time to
    /// schedule it, or `null` to re-enable it. Required, `null` included.
    // `Option::deserialize` stops serde reading a missing field as `null`, so an
    // empty body can't re-enable a client by omission.
    #[serde(deserialize_with = "Option::deserialize")]
    #[schema(value_type = Option<String>, format = DateTime, required = true)]
    disabled_at: Option<DateTime<Utc>>,
}

/// `PATCH /access/clients/{clientId}` — disable, schedule the disabling of, or
/// re-enable a client by writing its `disabledAt`; answers with the client as
/// stored. A disabled client is refused at `/oauth/authorize` and
/// `/oauth/token` from its `disabledAt` on. Idempotent (a client that already
/// has a `disabledAt` keeps it). Disabling the first-party host client is
/// refused with `409 FirstPartyClientLocked`. Acquired through
/// [`LiveClientsDisabler`] (scope `wildflower/Client.u`).
#[utoipa::path(
    patch,
    tag = "Access management",
    path = "/clients/{clientId}",
    params(("clientId" = String, Path, description = "The client's `client_id`")),
    request_body = UpdateClientBody,
    responses(
        (status = 200, description = "The client as stored", body = ClientBody),
        (status = 404, description = "No client with that id", body = ClientNotFoundBody),
        (status = 409, description = "The first-party host client can't be disabled", body = FirstPartyClientLockedBody),
    ),
)]
pub(super) async fn handle_update_client(
    clients: Scoped<LiveClientsDisabler>,
    Path(client_id): Path<String>,
    Json(body): Json<UpdateClientBody>,
) -> Result<Json<ClientBody>, GatekeeperError> {
    let updated = clients.set_disabled_at(&client_id, body.disabled_at, Utc::now())?;
    Ok(Json(updated.into()))
}
