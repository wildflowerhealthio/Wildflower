//! `GET /tunnel` — the current persisted settings + observed runtime snapshot.

use axum::Json;

use scope_capabilities_rust::InsufficientScopeBody;

use super::wire_representations::TunnelStateResponse;
use crate::domain::capabilities::Scoped;
use crate::domain::TunnelError;
use crate::state::TunnelSettingsReaderCap;

/// `GET /tunnel` — read the current persisted settings + observed runtime as a
/// single wire snapshot. Gated by [`Scoped<TunnelSettingsReaderCap>`]: the
/// settings read lives behind the `wildflower/TunnelSettings.r` capability, so
/// this handler never touches the store directly (a `403` on an under-scoped
/// token). Collected into the `OpenAPI` doc via `routes!` in the parent module,
/// which reads this `#[utoipa::path]`.
#[utoipa::path(
    get,
    tag = "Configuration",
    path = "/tunnel",
    responses(
        (status = 200, description = "Current tunnel settings + observed runtime", body = TunnelStateResponse),
        (status = 403, description = "The caller's token doesn't cover `wildflower/TunnelSettings.r`", body = InsufficientScopeBody)
    )
)]
pub(super) async fn handle_get_tunnel(
    tunnel: Scoped<TunnelSettingsReaderCap>,
) -> Result<Json<TunnelStateResponse>, TunnelError> {
    let settings = tunnel.settings()?;
    Ok(Json(TunnelStateResponse::from_current_state(
        tunnel.daemon(),
        &settings,
    )))
}
