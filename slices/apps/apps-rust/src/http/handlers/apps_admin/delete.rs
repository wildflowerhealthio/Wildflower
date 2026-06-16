//! `DELETE /apps/{id}` — remove a custom app row. Bundled / action rows
//! return 403; unknown ids return 404.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::{delete, MethodRouter};
use axum::Json;
use serde::Serialize;

use crate::domain::find_bundled;
use crate::http::response_templates::HandlerError;
use crate::http::state::AppsState;

#[derive(Debug, Serialize)]
struct DeletedBody {
    deleted: bool,
}

pub(super) fn route() -> MethodRouter<Arc<AppsState>> {
    delete(handle_delete_app)
}

async fn handle_delete_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
) -> Result<Json<DeletedBody>, HandlerError> {
    // Reject bundled ids up front — the seed guarantees a row for them, so
    // a bare `delete_custom_app` would 404 with the wrong error code.
    if find_bundled(&id).is_some() {
        return Err(HandlerError::BundledImmutable { id });
    }
    let existing = state
        .store
        .find_app(&id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?;
    let Some(row) = existing else {
        return Err(HandlerError::NotFound { id });
    };
    if row.kind != "custom" {
        // A row exists but isn't custom and isn't in the registry — shape
        // mismatch the seed should preclude, but the safety belt prefers
        // 403 over silently dropping a row whose semantics we don't know.
        return Err(HandlerError::BundledImmutable { id });
    }
    let deleted = state
        .store
        .delete_custom_app(&id)
        .map_err(|e| HandlerError::internal("delete_custom_app failed", e))?;
    if !deleted {
        // Lost a race with another deleter — surface as 404 (the row is
        // gone from the client's point of view either way).
        return Err(HandlerError::NotFound { id });
    }
    Ok(Json(DeletedBody { deleted: true }))
}
