//! Scope-gated service facades for the `/databases` surface — the databases
//! slice's copy of the default-safe authorization pattern (the generic machinery
//! lives in [`shared_structures_rust::scope_gating`]; the pattern originated on
//! gatekeeper's `/access` surface).
//!
//! Unlike gatekeeper's facades (a fixed scope each), the scope a database
//! requires depends on **which** database — the host declares every
//! [`DatabaseDescriptor`](crate::config::DatabaseDescriptor)'s `read_scope` /
//! `delete_scope`. So the static [`required_scopes`](GatedService::required_scopes)
//! gate is empty ("authenticated only", enforced by the claims-inserting authN
//! layer the host wraps this router with) and the real, data-dependent check
//! lives inside the facade methods, against the caller's [`Grant`].
//!
//! Handlers reach the store **only** through these facades — the source-guard
//! test below fails the build if a `/databases` handler touches
//! [`DatabasesState`] directly, so a forgotten scope check can't ship.

use std::path::PathBuf;
use std::sync::Arc;

use scopes_rust::{Grant, Scope};
use shared_structures_rust::scope_gating::{GatedService, ScopeClaims};

pub(crate) use shared_structures_rust::scope_gating::Scoped;

use crate::domain::DatabaseError;
use crate::files::{schedule_deletion, snapshot_to_temp};
use crate::http::state::DatabasesState;
use crate::metadata::DatabaseMetadata;

/// Require the caller's `granted` scopes to cover `required`, else a
/// `403`-rendering [`DatabaseError::InsufficientScope`] naming the missing scope.
fn require_scope(granted: &Grant, required: &Scope) -> Result<(), DatabaseError> {
    if granted.covers(required) {
        Ok(())
    } else {
        Err(DatabaseError::InsufficientScope {
            missing_scopes: scopes_rust::render_scopes(std::slice::from_ref(required)),
        })
    }
}

/// Read access to catalogued databases — `GET /databases[/{id}]`. `list` is
/// authenticated-only (metadata for every database, no contents); `download`
/// requires the target database's declared `read_scope`.
pub(crate) struct DatabasesReader {
    state: Arc<DatabasesState>,
    granted: Grant,
}

impl GatedService for DatabasesReader {
    type State = Arc<DatabasesState>;
    type Claims = ScopeClaims;

    // Empty: listing needs only authentication; the per-database read scope is
    // data-dependent and checked in `download`.
    fn required_scopes() -> Vec<Scope> {
        Vec::new()
    }

    fn build(state: Arc<DatabasesState>, granted: &Grant) -> Self {
        DatabasesReader {
            state,
            granted: granted.clone(),
        }
    }
}

impl DatabasesReader {
    /// Metadata for every catalogued database (existence, size, table count,
    /// last-modified). Authenticated-only — the listing exposes names/sizes, not
    /// contents, so it needs no per-database scope. The per-database reads are
    /// best-effort and blocking, so the loop runs on a blocking thread.
    pub(crate) async fn list(&self) -> Result<Vec<DatabaseMetadata>, DatabaseError> {
        let state = Arc::clone(&self.state);
        tokio::task::spawn_blocking(move || {
            state
                .databases()
                .iter()
                .map(|descriptor| DatabaseMetadata::read(descriptor, &state.path_for(descriptor)))
                .collect()
        })
        .await
        .map_err(|error| DatabaseError::infrastructure("list metadata task panicked", error))
    }

    /// Snapshot a database for download. The scope check runs against the
    /// database's declared `read_scope` **before** the existence check, so an
    /// under-scoped caller gets a `403` whether or not the file is present (no
    /// existence leak) — mirroring gatekeeper's "gate rejects before the
    /// handler". Unknown id / absent file are `404`. Returns the download
    /// filename + the temp snapshot path for the handler to stream and unlink.
    pub(crate) async fn download(&self, id: &str) -> Result<DownloadSnapshot, DatabaseError> {
        let read_scope = self
            .state
            .descriptor(id)
            .ok_or_else(|| DatabaseError::NotFound { id: id.to_owned() })?
            .read_scope
            .clone();
        require_scope(&self.granted, &read_scope)?;

        let (descriptor, path) = self
            .state
            .existing(id)
            .ok_or_else(|| DatabaseError::NotFound { id: id.to_owned() })?;
        // Own the filename before the await (the descriptor borrows `state`).
        let filename = descriptor.id.clone();
        let temp_path = tokio::task::spawn_blocking(move || snapshot_to_temp(&path))
            .await
            .map_err(|error| DatabaseError::infrastructure("snapshot task panicked", error))??;
        Ok(DownloadSnapshot {
            filename,
            temp_path,
        })
    }
}

/// The result of a successful [`DatabasesReader::download`] — the header filename
/// and the temp snapshot path the handler streams and unlinks on drop.
pub(crate) struct DownloadSnapshot {
    pub(crate) filename: String,
    pub(crate) temp_path: PathBuf,
}

/// Delete (schedule for deletion at next startup) a catalogued database —
/// `DELETE /databases/{id}`. Requires the target database's declared
/// `delete_scope`. Separate from [`DatabasesReader`] so a read handler holding
/// `Scoped<DatabasesReader>` structurally cannot delete.
pub(crate) struct DatabasesDeleter {
    state: Arc<DatabasesState>,
    granted: Grant,
}

impl GatedService for DatabasesDeleter {
    type State = Arc<DatabasesState>;
    type Claims = ScopeClaims;

    fn required_scopes() -> Vec<Scope> {
        Vec::new()
    }

    fn build(state: Arc<DatabasesState>, granted: &Grant) -> Self {
        DatabasesDeleter {
            state,
            granted: granted.clone(),
        }
    }
}

impl DatabasesDeleter {
    /// Schedule a database for deletion. The scope check (against the database's
    /// `delete_scope`) runs before the existence check, same as `download`.
    /// Unknown id / absent file are `404`. `existing` stats the file and
    /// `schedule_deletion` writes the marker, both blocking, so the
    /// check-then-write runs on a blocking thread.
    pub(crate) async fn delete(&self, id: &str) -> Result<(), DatabaseError> {
        let delete_scope = self
            .state
            .descriptor(id)
            .ok_or_else(|| DatabaseError::NotFound { id: id.to_owned() })?
            .delete_scope
            .clone();
        require_scope(&self.granted, &delete_scope)?;

        let state = Arc::clone(&self.state);
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || {
            let (_descriptor, path) = state
                .existing(&id)
                .ok_or_else(|| DatabaseError::NotFound { id: id.clone() })?;
            schedule_deletion(&path)
        })
        .await
        .map_err(|error| DatabaseError::infrastructure("delete task panicked", error))?
    }
}

#[cfg(test)]
mod tests {
    /// Default-safety guard: the `/databases` handler files must reach the store
    /// **only** through a `Scoped<…>` facade — never a raw
    /// `State<Arc<DatabasesState>>` or a direct `DatabasesState` method. Bypassing
    /// the facade would need one of these tokens, and this test fails the build if
    /// one appears, so a forgotten per-database scope check can't ship silently.
    /// (Mirrors gatekeeper's `access_handlers_reach_the_store_only_through_facades`.)
    #[test]
    fn database_handlers_reach_the_store_only_through_facades() {
        const GATED_HANDLERS: &[(&str, &str)] = &[
            (
                "databases/list_all",
                include_str!("routes/databases/list_all.rs"),
            ),
            (
                "databases/download_by_id",
                include_str!("routes/databases/download_by_id.rs"),
            ),
            (
                "databases/delete_by_id",
                include_str!("routes/databases/delete_by_id.rs"),
            ),
        ];
        // Raw router state, or any direct `DatabasesState` accessor — the only
        // ways to reach the store without a facade. (The type *name* may still
        // appear in prose/`expect` messages; these are the method call shapes.)
        const FORBIDDEN: &[&str] = &[
            "State<",
            ".databases(",
            ".descriptor(",
            ".path_for(",
            ".existing(",
        ];
        for (name, source) in GATED_HANDLERS {
            for needle in FORBIDDEN {
                assert!(
                    !source.contains(needle),
                    "scope-gated handler `{name}` reaches the store directly (`{needle}`); \
                     acquire it through a `Scoped<…>` facade instead",
                );
            }
        }
    }
}
