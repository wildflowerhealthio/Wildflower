//! `GET /cloud-apps/{id}` — the editor detail for a cloud app: the registration
//! fields plus the stored `url` template and `removable`. `404` if no *cloud* app
//! has the id (an unknown id, or one of another kind — the kind mismatch can't be
//! expressed as a `409` any more).

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;

use crate::domain::{actions, AppsError};
use crate::http::errors::AppNotFoundBody;
use crate::http::state::AppsState;
use crate::http::wire_representations::CloudAppDetail;

/// `GET /cloud-apps/{id}` — the cloud editor detail. Owner-gated by the host.
#[utoipa::path(
    get,
    tag = "Cloud apps",
    path = "/cloud-apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 200, description = "The cloud app detail", body = CloudAppDetail),
        (status = 404, description = "No cloud app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_get_cloud_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
) -> Result<Json<CloudAppDetail>, AppsError> {
    let (registration, config) = actions::get_cloud_app(&state.store, &id)?;
    Ok(Json(CloudAppDetail::from((&registration, &config))))
}
