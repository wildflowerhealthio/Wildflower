//! `DELETE /apps/{id}` — remove an app row of any kind. Unknown ids return
//! 404; bundled rows are deletable like any other.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::{delete, MethodRouter};
use axum::Json;
use serde::Serialize;

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
    let deleted = state
        .store
        .delete_app(&id)
        .map_err(|e| HandlerError::internal("delete_app failed", e))?;
    if !deleted {
        return Err(HandlerError::NotFound { id });
    }
    Ok(Json(DeletedBody { deleted: true }))
}
