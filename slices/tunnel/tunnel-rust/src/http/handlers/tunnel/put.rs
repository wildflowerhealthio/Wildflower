use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Deserializer};
use utoipa::ToSchema;

use super::tunnel_state_response::TunnelStateResponse;
use crate::db::{SettingsUpdate, SettingsUpdateOutcome};
use crate::domain::RelaySettings;
use crate::http::response_templates::HandlerError;
use crate::http::state::TunnelState;

/// `PUT /tunnel` — full-replace of the visible settings under the caller's
/// `revision` token. A stale revision returns 409 with the current snapshot so
/// the client can rebase; a winning write bumps the revision, reconciles the
/// live supervisor, and returns the new snapshot. Collected into the `OpenAPI`
/// doc via `routes!` in the parent module, which reads this `#[utoipa::path]`.
#[utoipa::path(
    put,
    path = "/tunnel",
    request_body = ReplaceTunnelRequestBody,
    responses(
        (status = 200, description = "Write applied; the new snapshot after the daemon reconciled", body = TunnelStateResponse),
        (status = 409, description = "Stale revision; no write happened — the current snapshot is returned", body = TunnelStateResponse)
    )
)]
pub(super) async fn handle_put_tunnel(
    State(state): State<Arc<TunnelState>>,
    Json(body): Json<ReplaceTunnelRequestBody>,
) -> Result<(StatusCode, Json<TunnelStateResponse>), HandlerError> {
    let update = SettingsUpdate {
        public_host: body.public_host.0,
        requested_running: body.requested_running,
        relay_settings: body.relay.map(RelaySettings::from),
    };
    let settings_update_outcome = state
        .store
        .replace_settings(body.settings_revision, update)
        .map_err(|e| HandlerError::internal("replace_settings failed", e))?;

    match settings_update_outcome {
        SettingsUpdateOutcome::Applied(settings) => {
            state.daemon.reconcile(&settings);
            Ok((
                StatusCode::OK,
                Json(TunnelStateResponse::from_current_state(
                    &state.daemon,
                    &settings,
                )),
            ))
        }
        SettingsUpdateOutcome::Conflict(current) => Ok((
            StatusCode::CONFLICT,
            Json(TunnelStateResponse::from_current_state(
                &state.daemon,
                &current,
            )),
        )),
    }
}

/// PUT body — a full replace of the visible settings guarded by
/// `settingsRevision`, plus an optional write-only `relay` block (absent = keep
/// the stored relay connection, present = replace all four fields).
///
/// `publicHost` is required and full-replace: send the desired host as a
/// string, or `null` to clear it. An omitted field is rejected — full-replace
/// PUT semantics, and the relay block is the only intentionally-omittable
/// member (because it's write-only and the client can't echo back what it
/// hasn't seen).
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTunnelRequestBody {
    /// The optimistic-concurrency token echoed from the last-seen snapshot.
    pub(super) settings_revision: i64,
    // `RequiredNullable` has no `ToSchema`, so describe it to utoipa as a
    // nullable string; `required` overrides utoipa's nullable-implies-optional
    // default to match the always-present TS `NullOr` (full-replace PUT).
    #[schema(value_type = Option<String>, required)]
    pub(super) public_host: RequiredNullable<String>,
    pub(super) requested_running: bool,
    #[serde(default)]
    pub(super) relay: Option<RelayInput>,
}

/// A nullable field that must still be *present* in the request body.
///
/// `serde_derive` injects an implicit `#[serde(default)]` for any
/// `Option<T>`-typed field, so a missing key silently deserializes to `None`.
/// That's the wrong default for a full-replace PUT: omitting `publicHost`
/// would wipe a configured host without the client noticing.
///
/// The wrapper sidesteps the implicit default. The implementation routes
/// through [`serde_json::Value::deserialize`], which dispatches via
/// `deserialize_any` — and serde's synthetic missing-field deserializer only
/// short-circuits `deserialize_option`, so `deserialize_any` raises
/// `missing field` for an absent key. An explicit `null` lands as `None`; a
/// value lands as `Some(_)`.
#[derive(Debug)]
pub(super) struct RequiredNullable<T>(pub(super) Option<T>);

impl<'de, T> Deserialize<'de> for RequiredNullable<T>
where
    T: serde::de::DeserializeOwned,
{
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        if value.is_null() {
            return Ok(Self(None));
        }
        serde_json::from_value::<T>(value)
            .map(|t| Self(Some(t)))
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct RelayInput {
    remote_addr: String,
    token: String,
    public_key: String,
    service_name: String,
}

impl From<RelayInput> for RelaySettings {
    fn from(input: RelayInput) -> Self {
        RelaySettings {
            remote_addr: input.remote_addr,
            token: input.token,
            public_key: input.public_key,
            service_name: input.service_name,
        }
    }
}
