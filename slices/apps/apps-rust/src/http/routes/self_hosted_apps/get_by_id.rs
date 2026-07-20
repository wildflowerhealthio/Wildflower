//! `GET /self-hosted-apps/{id}` — the editor detail for a self-hosted app: the
//! registration fields plus `launchPath` / `seeded` / `removable`. `404` if no
//! *self-hosted* app has the id.

use axum::extract::Path;
use axum::Json;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::AppsError;
use crate::http::errors::AppNotFoundBody;
use crate::http::wire_representations::SelfHostedAppDetail;
use crate::live_bindings::LiveAppsReader;

/// `GET /self-hosted-apps/{id}` — the self-hosted editor detail. Scope-gated on
/// `wildflower/Apps.r` through [`Scoped<LiveAppsReader>`].
#[utoipa::path(
    get,
    tag = "Self-hosted apps",
    path = "/self-hosted-apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 200, description = "The self-hosted app detail", body = SelfHostedAppDetail),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Apps.r`", body = InsufficientScopeBody),
        (status = 404, description = "No self-hosted app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_get_self_hosted_app(
    reader: Scoped<LiveAppsReader>,
    Path(id): Path<String>,
) -> Result<Json<SelfHostedAppDetail>, AppsError> {
    let (registration, config) = reader.self_hosted(&id)?;
    Ok(Json(SelfHostedAppDetail::from((&registration, &config))))
}
