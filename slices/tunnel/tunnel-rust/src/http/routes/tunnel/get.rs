//! `GET /tunnel` — the tunnel's observed liveness.

use axum::Json;

use scope_capabilities_rust::InsufficientScopeBody;

use super::wire_representations::TunnelStateResponse;
use crate::domain::capabilities::{Scoped, TunnelSettingsReader};

/// `GET /tunnel` — read the tunnel's observed liveness as a single wire
/// snapshot. Gated by [`Scoped<TunnelSettingsReader>`]: the read
/// lives behind the `wildflower/TunnelSettings.r` capability, so this handler
/// never touches the router state directly (a `403` on an under-scoped token).
/// Collected into the `OpenAPI` doc via `routes!` in the parent module, which
/// reads this `#[utoipa::path]`.
#[utoipa::path(
    get,
    tag = "Configuration",
    path = "/tunnel",
    responses(
        (status = 200, description = "The tunnel's observed liveness", body = TunnelStateResponse),
        (status = 403, description = "The caller's token doesn't cover `wildflower/TunnelSettings.r`", body = InsufficientScopeBody)
    )
)]
pub(super) async fn handle_get_tunnel(
    tunnel: Scoped<TunnelSettingsReader>,
) -> Json<TunnelStateResponse> {
    Json(TunnelStateResponse::from(tunnel.liveness()))
}
