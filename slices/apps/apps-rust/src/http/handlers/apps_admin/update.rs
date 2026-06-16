//! `PATCH /apps/{id}` — partial update.
//!
//! The id resolves to one of three states:
//!
//!   * Bundled / action row: only `enabled` can be patched. Any other field
//!     in the body returns 403 `BundledAppImmutable` (matches the TS
//!     contract).
//!   * Custom row: any subset of `enabled` / `name` / `url` /
//!     `requiresTunnel` is honoured; a non-empty `url` is re-validated.
//!   * No row at all: 404 `AppNotFound`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::{patch, MethodRouter};
use axum::Json;
use serde::Deserialize;

use super::super::build_entry::build_entry;
use crate::db::{UpdateApp, UpdateOutcome};
use crate::domain::{find_bundled, validate_custom_url, AppEntry};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppsState;

/// PATCH body — all fields optional. Matches `UpdateAppBodySchema`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAppBody {
    enabled: Option<bool>,
    name: Option<String>,
    url: Option<String>,
    requires_tunnel: Option<bool>,
}

impl UpdateAppBody {
    fn carries_bundled_immutable_fields(&self) -> bool {
        self.name.is_some() || self.url.is_some() || self.requires_tunnel.is_some()
    }
}

pub(super) fn route() -> MethodRouter<Arc<AppsState>> {
    patch(handle_update_app)
}

async fn handle_update_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateAppBody>,
) -> Result<Json<AppEntry>, HandlerError> {
    let bundled = find_bundled(&id);
    let existing = state
        .store
        .find_app(&id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?;

    // Bundled rows: only `enabled` can be patched. Reject any other field
    // before reaching the store so a `name` patch can't sneak through as a
    // no-op when the column doesn't exist on bundled rows.
    if bundled.is_some() {
        if body.carries_bundled_immutable_fields() {
            return Err(HandlerError::BundledImmutable { id });
        }
        // An `enabled` patch is the only legal change, and even that is a
        // no-op the SQL allows (the row exists from the seed).
        let patch = UpdateApp {
            enabled: body.enabled,
            ..Default::default()
        };
        let outcome = state
            .store
            .update_app(&id, &patch)
            .map_err(|e| HandlerError::internal("update_app SQL failed", e))?;
        let UpdateOutcome::Updated(row) = outcome else {
            // The bundled row was seeded by the migration and we never
            // delete bundled rows, so this is a hard bug — surface as a
            // logged 500 rather than papering over with the registry
            // metadata (which would hide the data drift).
            return Err(HandlerError::internal(
                "bundled app row missing from store",
                format!("id={id}"),
            ));
        };
        return Ok(Json(build_entry(&row).ok_or_else(|| {
            HandlerError::internal(
                "build_entry failed for bundled row",
                format!("id={id} kind={}", row.kind),
            )
        })?));
    }

    let existing = existing.ok_or_else(|| HandlerError::NotFound { id: id.clone() })?;
    if existing.kind != "custom" {
        // A row exists but it's bundled/action and the registry didn't know
        // it (shouldn't happen given the seed invariants, but cheaper to
        // surface than to assert).
        return Err(HandlerError::BundledImmutable { id });
    }

    if let Some(url) = body.url.as_deref() {
        validate_custom_url(url).map_err(|e| HandlerError::InvalidUrl {
            message: e.to_string(),
        })?;
    }
    if let Some(name) = body.name.as_deref() {
        if name.is_empty() {
            return Err(HandlerError::InvalidUrl {
                message: "name must not be empty".to_owned(),
            });
        }
    }

    let patch = UpdateApp {
        enabled: body.enabled,
        name: body.name,
        url: body.url,
        requires_tunnel: body.requires_tunnel,
    };
    let outcome = state
        .store
        .update_app(&id, &patch)
        .map_err(|e| HandlerError::internal("update_app SQL failed", e))?;
    match outcome {
        UpdateOutcome::Updated(row) => Ok(Json(build_entry(&row).ok_or_else(|| {
            HandlerError::internal(
                "build_entry failed for custom row",
                format!("id={id} kind={}", row.kind),
            )
        })?)),
        UpdateOutcome::NotFound => Err(HandlerError::NotFound { id }),
    }
}
