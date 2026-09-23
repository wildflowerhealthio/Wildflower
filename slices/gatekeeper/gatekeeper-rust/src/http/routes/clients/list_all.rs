use axum::Json;
use chrono::{DateTime, Utc};
use serde::Serialize;
use utoipa::ToSchema;

use crate::domain::capabilities::{ClientView, Scoped};
use crate::domain::client::{AllowedGrantType, ClientKind, RegisteredRedirectUri};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::live_bindings::LiveClientsReader;

/// A registered OAuth client as the Owner's "Trusted apps" list reads it. Every
/// column of the `clients` row **except `secret_hash`**, which never leaves the
/// server, plus `firstParty` — whether this is the host client, which can't be
/// disabled.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientBody {
    client_id: String,
    name: String,
    /// `public` or `confidential`.
    #[schema(value_type = String)]
    kind: ClientKind,
    /// Absolute URLs, or app-relative paths (a leading `/`) for self-hosted apps.
    #[schema(value_type = Vec<String>)]
    redirect_uris: Vec<RegisteredRedirectUri>,
    allowed_scopes: Vec<String>,
    /// The `grant_type` values the client may use at `/oauth/token`.
    #[schema(value_type = Vec<String>)]
    allowed_grant_types: Vec<AllowedGrantType>,
    #[schema(value_type = String, format = DateTime)]
    registered_at: DateTime<Utc>,
    /// Set while the client is disabled; `null` when it is enabled.
    #[schema(value_type = Option<String>, format = DateTime, required = true)]
    disabled_at: Option<DateTime<Utc>>,
    first_party: bool,
}

impl From<ClientView> for ClientBody {
    fn from(
        ClientView {
            client,
            first_party,
        }: ClientView,
    ) -> Self {
        ClientBody {
            client_id: client.client_id,
            name: client.name,
            kind: client.kind,
            redirect_uris: client.redirect_uris,
            allowed_scopes: client.allowed_scopes,
            allowed_grant_types: client.allowed_grant_types,
            registered_at: client.registered_at,
            disabled_at: client.disabled_at,
            first_party,
        }
    }
}

/// `GET /access/clients` — every registered OAuth client (seeded or trusted on first
/// use), disabled ones included, ordered by `clientId`. Acquired through
/// [`LiveClientsReader`] (scope `wildflower/Client.r`).
#[utoipa::path(
    get,
    tag = "Access management",
    path = "/clients",
    responses(
        (status = 200, description = "Every registered client", body = [ClientBody]),
    ),
)]
pub(super) async fn handle_list_clients(
    clients: Scoped<LiveClientsReader>,
) -> Result<Json<Vec<ClientBody>>, GatekeeperError> {
    Ok(Json(
        clients.list()?.into_iter().map(ClientBody::from).collect(),
    ))
}
