//! `GET /cloud-apps/{id}` — the editor detail for a cloud app: the registration
//! fields plus the stored `url` template and `removable`. `404` if no *cloud* app
//! has the id (an unknown id, or one of another kind — the kind mismatch can't be
//! expressed as a `409` any more).

use axum::extract::Path;
use axum::Json;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::AppsError;
use crate::http::errors::AppNotFoundBody;
use crate::http::wire_representations::CloudAppDetail;
use crate::live_bindings::LiveAppsReader;

/// `GET /cloud-apps/{id}` — the cloud editor detail. Scope-gated on
/// `wildflower/Apps.r` through [`Scoped<LiveAppsReader>`].
#[utoipa::path(
    get,
    tag = "Cloud apps",
    path = "/cloud-apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 200, description = "The cloud app detail", body = CloudAppDetail),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Apps.r`", body = InsufficientScopeBody),
        (status = 404, description = "No cloud app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_get_cloud_app(
    reader: Scoped<LiveAppsReader>,
    Path(id): Path<String>,
) -> Result<Json<CloudAppDetail>, AppsError> {
    let (registration, config) = reader.cloud(&id)?;
    Ok(Json(CloudAppDetail::from((&registration, &config))))
}
