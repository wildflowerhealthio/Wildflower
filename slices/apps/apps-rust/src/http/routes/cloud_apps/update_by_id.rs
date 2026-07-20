//! `PUT /cloud-apps/{id}` — replace a cloud app's *content* (`name` / `subtitle` /
//! `url` / `requiresTunnel`); the `url` is re-parsed through the write-side filter.
//! An id that isn't a cloud app is `404`; a bad name / url is `400`. `enabled` is
//! **not** content — `PUT /home-screen` owns it. The response is the refreshed
//! [`CloudAppDetail`], hydrated via `RETURNING`.

use axum::extract::Path;
use axum::Json;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use super::CloudAppBody;
use crate::domain::actions::CloudAppPayload;
use crate::domain::AppsError;
use crate::http::errors::{AppNotFoundBody, InvalidFieldBody};
use crate::http::wire_representations::CloudAppDetail;
use crate::state::AppsEditorCap;

/// `PUT /cloud-apps/{id}` — replace a cloud app's content. Scope-gated on
/// `wildflower/Apps.u` through [`Scoped<AppsEditorCap>`].
#[utoipa::path(
    put,
    tag = "Cloud apps",
    path = "/cloud-apps/{id}",
    params(("id" = String, Path, description = "App id")),
    request_body = CloudAppBody,
    responses(
        (status = 200, description = "The updated cloud app detail", body = CloudAppDetail),
        (status = 400, description = "Empty name (`InvalidName`) or bad url (`InvalidUrl`)", body = InvalidFieldBody),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Apps.u`", body = InsufficientScopeBody),
        (status = 404, description = "No cloud app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_update_cloud_app(
    editor: Scoped<AppsEditorCap>,
    Path(id): Path<String>,
    Json(body): Json<CloudAppBody>,
) -> Result<Json<CloudAppDetail>, AppsError> {
    // The capability resolves the kind (a non-cloud id is a 404) before validating
    // any field, then validates (400) and writes the registration + payload in-txn.
    let (registration, config) = editor.update_cloud_app(
        &id,
        CloudAppPayload {
            name: body.name,
            subtitle: body.subtitle,
            url: body.url,
            requires_tunnel: body.requires_tunnel,
        },
    )?;
    Ok(Json(CloudAppDetail::from((&registration, &config))))
}
