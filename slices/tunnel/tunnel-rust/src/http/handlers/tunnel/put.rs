use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{put, MethodRouter};
use axum::Json;
use serde::Deserialize;

use super::tunnel_state_response::TunnelStateResponse;
use crate::db::{SettingsUpdate, SettingsUpdateOutcome};
use crate::domain::RelaySettings;
use crate::http::response_templates::HandlerError;
use crate::http::state::TunnelState;

/// `PUT /tunnel` — full-replace of the visible settings under the caller's
/// `revision` token. A stale revision returns 409 with the current snapshot so
/// the client can rebase; a winning write bumps the revision, reconciles the
/// live supervisor, and returns the new snapshot.
pub(super) fn route() -> MethodRouter<Arc<TunnelState>> {
    put(handle_put_tunnel)
}

async fn handle_put_tunnel(
    State(state): State<Arc<TunnelState>>,
    Json(body): Json<ReplaceTunnelRequestBody>,
) -> Result<(StatusCode, Json<TunnelStateResponse>), HandlerError> {
    let update = SettingsUpdate {
        public_host: body.public_host,
        requested_running: body.requested_running,
        relay_settings: body.relay.map(RelaySettings::from),
    };
    let settings_update_outcome = state
        .store
        .replace_settings(body.revision, update)
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
            Json(TunnelStateResponse::from_current_state(&state.daemon, &current)),
        )),
    }
}

/// PUT body — a full replace of the visible settings guarded by `revision`,
/// plus an optional write-only `relay` block (absent = keep the stored relay
/// connection, present = replace all four fields).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTunnelRequestBody {
    pub(super) revision: i64,
    #[serde(default)]
    pub(super) public_host: Option<String>,
    pub(super) requested_running: bool,
    #[serde(default)]
    pub(super) relay: Option<RelayInput>,
}

#[derive(Debug, Deserialize)]
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
