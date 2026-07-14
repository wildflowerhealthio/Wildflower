//! `PUT /cloud-apps/{id}` — replace a cloud app's *content* (`name` / `subtitle` /
//! `url` / `requiresTunnel`); the `url` is re-parsed through the write-side filter.
//! An id that isn't a cloud app is `404`; a bad name / url is `400`. `enabled` is
//! **not** content — `PUT /home-screen` owns it. The response is the refreshed
//! [`CloudAppDetail`], hydrated via `RETURNING`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;

use super::CloudAppBody;
use crate::domain::{actions, AppsError};
use crate::http::errors::{AppNotFoundBody, InvalidFieldBody};
use crate::http::state::AppsState;
use crate::http::wire_representations::CloudAppDetail;

/// `PUT /cloud-apps/{id}` — replace a cloud app's content. Owner-gated by the host.
#[utoipa::path(
    put,
    tag = "Cloud apps",
    path = "/cloud-apps/{id}",
    params(("id" = String, Path, description = "App id")),
    request_body = CloudAppBody,
    responses(
        (status = 200, description = "The updated cloud app detail", body = CloudAppDetail),
        (status = 400, description = "Empty name (`InvalidName`) or bad url (`InvalidUrl`)", body = InvalidFieldBody),
        (status = 404, description = "No cloud app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_replace_cloud_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
    Json(body): Json<CloudAppBody>,
) -> Result<Json<CloudAppDetail>, AppsError> {
    // The action resolves the kind (a non-cloud id is a 404) before validating any
    // field, then validates (400) and writes the registration + payload in-txn.
    let (registration, config) = actions::replace_cloud_app(
        &state.store,
        &id,
        actions::CloudAppPayload {
            name: body.name,
            subtitle: body.subtitle,
            url: body.url,
            requires_tunnel: body.requires_tunnel,
        },
    )?;
    Ok(Json(CloudAppDetail::from((&registration, &config))))
}
