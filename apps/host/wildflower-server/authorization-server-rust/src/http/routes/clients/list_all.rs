//! `GET /authorization/clients`: the Owner's list of every registered app, and
//! the body each app is shown with.

use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use url::Url;
use utoipa::ToSchema;

use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::{ClientView, Scoped};
use crate::domain::client::{AllowedGrantType, ClientKind, RefreshPolicy};
use crate::live_bindings::LiveClientsReader;

/// A registered OAuth client as the Owner's "Trusted apps" list reads it. Every
/// column of the `clients` row **except `secret_hash`**, which never leaves the
/// server, and `registration_source`, with the three refresh columns as one
/// `refreshPolicy`, plus `essential` — whether this is the
/// host app's client or the browser-session client, which can't be disabled,
/// so the list offers no switch for them.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientBody {
    /// The public identifier the app sends on every OAuth request.
    client_id: String,
    /// The app's display name, shown on the consent card and in this list.
    name: String,
    /// `public` or `confidential`.
    #[schema(value_type = String)]
    kind: ClientKind,
    /// Absolute redirect URLs, matched exactly at `/oauth/authorize`.
    #[schema(value_type = Vec<String>)]
    redirect_uris: Vec<Url>,
    /// The scopes the app may request; a request outside them is refused or,
    /// for an app trusted on first use, shown to the Owner as a change.
    allowed_scopes: Vec<String>,
    /// The `grant_type` values the client may use at `/oauth/token`.
    #[schema(value_type = Vec<String>)]
    allowed_grant_types: Vec<AllowedGrantType>,
    /// When the app was registered: seeded, or first approved by the Owner.
    #[schema(value_type = String, format = DateTime)]
    registered_at: DateTime<Utc>,
    /// Set while the client is disabled; `null` when it is enabled.
    #[schema(value_type = Option<String>, format = DateTime, required = true)]
    disabled_at: Option<DateTime<Utc>>,
    /// Whether the Owner needs this app to get in (the host app's client or
    /// the browser-session client); disabling it is refused.
    essential: bool,
    /// How long the app's refresh-token families last once it has signed in.
    refresh_policy: RefreshPolicyBody,
}

/// A client's refresh policy on the wire, each limit in whole seconds. Every
/// field is required, `null` included.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RefreshPolicyBody {
    /// How long a family may go unrefreshed, from its last rotation, in
    /// seconds; `null` for no idle limit.
    #[serde(deserialize_with = "Option::deserialize")]
    #[schema(required = true)]
    pub(super) idle_ttl_seconds: Option<i64>,
    /// How long a family may last from when it was issued, in seconds;
    /// `null` for only the 365-day ceiling.
    #[serde(deserialize_with = "Option::deserialize")]
    #[schema(required = true)]
    pub(super) max_ttl_seconds: Option<i64>,
    /// Whether a family ends when the browser session it was minted under
    /// expires.
    pub(super) ends_with_browser_session: bool,
}

impl From<RefreshPolicy> for RefreshPolicyBody {
    fn from(refresh_policy: RefreshPolicy) -> Self {
        RefreshPolicyBody {
            idle_ttl_seconds: refresh_policy.idle_ttl.map(|limit| limit.num_seconds()),
            max_ttl_seconds: refresh_policy.max_ttl.map(|limit| limit.num_seconds()),
            ends_with_browser_session: refresh_policy.ends_with_browser_session,
        }
    }
}

impl From<ClientView> for ClientBody {
    fn from(ClientView { client, essential }: ClientView) -> Self {
        ClientBody {
            client_id: client.client_id,
            name: client.name,
            kind: client.kind,
            redirect_uris: client.redirect_uris,
            allowed_scopes: client.allowed_scopes,
            allowed_grant_types: client.allowed_grant_types,
            registered_at: client.registered_at,
            disabled_at: client.disabled_at,
            essential,
            refresh_policy: client.refresh_policy.into(),
        }
    }
}

/// `GET /authorization/clients` — every registered OAuth client (seeded or trusted on first
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
) -> Result<Json<Vec<ClientBody>>, AuthorizationServerError> {
    Ok(Json(
        clients.list()?.into_iter().map(ClientBody::from).collect(),
    ))
}
