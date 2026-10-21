//! `PATCH /authorization/clients/{clientId}`: the Owner disables an app, turns
//! it back on, or changes how long its sign-ins last.

use axum::extract::Path;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer};
use utoipa::ToSchema;

use super::list_all::{ClientBody, RefreshPolicyBody};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::Scoped;
use crate::domain::client::{refresh_limit_from_seconds, RefreshPolicy};
use crate::http::errors::{ClientNotFoundBody, EssentialClientBody};
use crate::live_bindings::LiveClientsUpdater;

/// Body of `PATCH /authorization/clients/{clientId}` — one of the two things
/// the Owner can change about a client, each its own shape: whether it is
/// disabled, or its refresh policy.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(untagged)]
pub(crate) enum UpdateClientBody {
    /// Disable or re-enable the client.
    DisabledAt(DisabledAtChange),
    /// Replace the client's refresh policy.
    RefreshPolicy(RefreshPolicyChange),
}

/// Disable or re-enable a client.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DisabledAtChange {
    /// Any time to disable the client now, or `null` to re-enable it. The
    /// server stamps its own now whatever time is sent, so a disable can't be
    /// scheduled or backdated. Required, `null` included.
    // `Option::deserialize` stops serde reading a missing field as `null`, so an
    // empty body can't re-enable a client by omission.
    #[serde(deserialize_with = "Option::deserialize")]
    #[schema(value_type = Option<String>, format = DateTime, required = true)]
    disabled_at: Option<DateTime<Utc>>,
}

/// Replace a client's refresh policy.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RefreshPolicyChange {
    /// The whole new policy. Each limit is at least a second and at most the
    /// 365-day ceiling; a body outside that is refused.
    #[serde(deserialize_with = "refresh_policy_from_body")]
    #[schema(value_type = RefreshPolicyBody)]
    refresh_policy: RefreshPolicy,
}

/// Read a [`RefreshPolicyBody`] as a [`RefreshPolicy`], refusing a limit a
/// client may not hold (see [`refresh_limit_from_seconds`]).
fn refresh_policy_from_body<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<RefreshPolicy, D::Error> {
    let body = RefreshPolicyBody::deserialize(deserializer)?;
    let limit = |seconds: Option<i64>| {
        seconds
            .map(|seconds| {
                refresh_limit_from_seconds(seconds).ok_or_else(|| {
                    serde::de::Error::custom(format!(
                        "a refresh limit of {seconds} seconds is not between a second and 365 days"
                    ))
                })
            })
            .transpose()
    };
    Ok(RefreshPolicy {
        idle_ttl: limit(body.idle_ttl_seconds)?,
        max_ttl: limit(body.max_ttl_seconds)?,
        ends_with_browser_session: body.ends_with_browser_session,
    })
}

/// `PATCH /authorization/clients/{clientId}` — disable or re-enable a client,
/// or replace its refresh policy; answers with the client as stored.
///
/// - A disable is stamped with the server's now, whatever time is sent. A
///   disabled client is refused at `/oauth/authorize` and `/oauth/token`.
///   Idempotent (a client that already has a `disabledAt` keeps it).
///   Disabling an essential client — the host app's or the browser-session
///   client — is refused with `409 EssentialClient`.
/// - A new `refreshPolicy` applies to the client's refresh-token families on
///   their next refresh.
///
/// Acquired through [`LiveClientsUpdater`] (scope `wildflower/Client.u`).
#[utoipa::path(
    patch,
    tag = "Access management",
    path = "/clients/{clientId}",
    params(("clientId" = String, Path, description = "The client's `client_id`")),
    request_body = UpdateClientBody,
    responses(
        (status = 200, description = "The client as stored", body = ClientBody),
        (status = 404, description = "No client with that id", body = ClientNotFoundBody),
        (status = 409, description = "The client is essential: disabling it would leave the Owner no way in", body = EssentialClientBody),
    ),
)]
pub(super) async fn handle_update_client(
    clients: Scoped<LiveClientsUpdater>,
    Path(client_id): Path<String>,
    Json(body): Json<UpdateClientBody>,
) -> Result<Json<ClientBody>, AuthorizationServerError> {
    let updated = match body {
        UpdateClientBody::DisabledAt(DisabledAtChange { disabled_at }) => {
            let stamp = disabled_at.map(|_sent| Utc::now());
            clients.set_disabled_at(&client_id, stamp)?
        }
        UpdateClientBody::RefreshPolicy(RefreshPolicyChange { refresh_policy }) => {
            clients.set_refresh_policy(&client_id, refresh_policy)?
        }
    };
    Ok(Json(updated.into()))
}
