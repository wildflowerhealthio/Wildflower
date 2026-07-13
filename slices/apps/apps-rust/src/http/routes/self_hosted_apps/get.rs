//! `GET /self-hosted-apps/{id}` — the editor detail for a self-hosted app: the
//! registration fields plus `launchPath` / `seeded` / `removable`. `404` if no
//! *self-hosted* app has the id.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;

use crate::domain::{actions, AppError, SelfHostedAppDetail};
use crate::http::errors::AppNotFoundBody;
use crate::http::state::AppsState;

/// `GET /self-hosted-apps/{id}` — the self-hosted editor detail. Owner-gated by
/// the host.
#[utoipa::path(
    get,
    tag = "Self-hosted apps",
    path = "/self-hosted-apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 200, description = "The self-hosted app detail", body = SelfHostedAppDetail),
        (status = 404, description = "No self-hosted app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_get_self_hosted_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
) -> Result<Json<SelfHostedAppDetail>, AppError> {
    let app = actions::get_self_hosted_app(&state.store, &id)?;
    Ok(Json(SelfHostedAppDetail::from(&app)))
}
