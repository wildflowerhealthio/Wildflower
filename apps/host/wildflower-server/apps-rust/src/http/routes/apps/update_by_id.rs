//! `PUT /apps/{id}` — replace an app's *content* (`name` / `subtitle` / `url` /
//! `requiresTunnel`); the `url` is re-parsed through the write-side filter. An
//! unknown id is `404`; a bad name / url is `400`. `onHomescreen` is **not**
//! content — `PUT /home-screen` owns it. The response is the refreshed
//! [`AppRegistration`], hydrated via `RETURNING`.

use axum::extract::Path;
use axum::Json;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use super::AppBody;
use crate::domain::actions::AppPayload;
use crate::domain::{AppRegistration, AppsError};
use crate::http::errors::{AppNotFoundBody, InvalidFieldBody};
use crate::live_bindings::LiveAppsEditor;

/// `PUT /apps/{id}` — replace an app's content. Scope-gated on
/// `wildflower/Apps.u` through [`Scoped<LiveAppsEditor>`].
#[utoipa::path(
    put,
    tag = "Catalogue",
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    request_body = AppBody,
    responses(
        (status = 200, description = "The updated app", body = AppRegistration),
        (status = 400, description = "Empty name (`InvalidName`) or bad url (`InvalidUrl`)", body = InvalidFieldBody),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Apps.u`", body = InsufficientScopeBody),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_update_app(
    editor: Scoped<LiveAppsEditor>,
    Path(id): Path<String>,
    Json(body): Json<AppBody>,
) -> Result<Json<AppRegistration>, AppsError> {
    // The capability resolves the app (an unknown id is a 404) before validating
    // any field, then validates (400) and writes the editable subset.
    Ok(Json(editor.update_app(
        &id,
        AppPayload {
            name: body.name,
            subtitle: body.subtitle,
            url: body.url,
            requires_tunnel: body.requires_tunnel,
        },
    )?))
}
