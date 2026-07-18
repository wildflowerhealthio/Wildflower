//! `PUT /self-hosted-apps/{id}` — replace a self-hosted app's `launchPath`; an
//! absent / empty value clears it back to root-serving. An id that isn't a
//! self-hosted app is `404`; a seeded self-hosted app is `409 AppNotEditable`; a
//! non-origin-relative path is `400`. The response is the refreshed
//! [`SelfHostedAppDetail`], hydrated via `RETURNING`.

use axum::extract::Path;
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use crate::domain::AppsError;
use crate::http::errors::{AppNotEditableBody, AppNotFoundBody, InvalidFieldBody};
use crate::http::wire_representations::SelfHostedAppDetail;
use crate::state::AppsEditorCap;

/// The `PUT /self-hosted-apps/{id}` body — the editable launch path. Absent or
/// empty clears it back to root-serving. Matches the TS
/// `SelfHostedAppBodySchema`.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelfHostedAppBody {
    #[serde(default)]
    launch_path: Option<String>,
}

/// `PUT /self-hosted-apps/{id}` — replace a self-hosted app's launch path.
/// Scope-gated on `wildflower/Apps.u` through [`Scoped<AppsEditorCap>`].
#[utoipa::path(
    put,
    tag = "Self-hosted apps",
    path = "/self-hosted-apps/{id}",
    params(("id" = String, Path, description = "App id")),
    request_body = SelfHostedAppBody,
    responses(
        (status = 200, description = "The updated self-hosted app detail", body = SelfHostedAppDetail),
        (status = 400, description = "The launch path isn't origin-relative (`InvalidUrl`)", body = InvalidFieldBody),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Apps.u`", body = InsufficientScopeBody),
        (status = 404, description = "No self-hosted app has this id", body = AppNotFoundBody),
        (status = 409, description = "A seeded self-hosted app is edit-protected", body = AppNotEditableBody),
    ),
)]
pub(crate) async fn handle_update_self_hosted_app(
    editor: Scoped<AppsEditorCap>,
    Path(id): Path<String>,
    Json(body): Json<SelfHostedAppBody>,
) -> Result<Json<SelfHostedAppDetail>, AppsError> {
    let (registration, config) = editor.self_hosted(&id, body.launch_path)?;
    Ok(Json(SelfHostedAppDetail::from((&registration, &config))))
}
