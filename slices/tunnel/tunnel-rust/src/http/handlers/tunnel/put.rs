use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{put, MethodRouter};
use axum::Json;

use super::internal::{snapshot, ReplaceTunnelRequestBody, TunnelStateWire};
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
) -> Result<(StatusCode, Json<TunnelStateWire>), HandlerError> {
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
            state.reconcile(&settings);
            Ok((StatusCode::OK, Json(snapshot(&state, &settings))))
        }
        SettingsUpdateOutcome::Conflict(current) => {
            Ok((StatusCode::CONFLICT, Json(snapshot(&state, &current))))
        }
    }
}
