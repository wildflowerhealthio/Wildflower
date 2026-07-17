//! Scope-gated capabilities for the `/databases` surface — the databases slice's
//! copy of the default-safe authorization pattern (the generic machinery lives
//! in [`scope_capabilities_rust`]; the pattern originated on gatekeeper's
//! `/access` surface).
//!
//! Unlike gatekeeper's capabilities (a fixed scope each), the scope a database
//! requires depends on **which** database — the host declares every
//! [`DatabaseDescriptor`]'s `read_scope` / `delete_scope`. So both capabilities
//! here are the **data-dependent** flavour (`impl Capability` directly): the
//! static [`required_scopes`](Capability::required_scopes) gate is empty
//! ("authenticated only", enforced by the claims-inserting authN layer the host
//! wraps this router with), the builder stores the caller's [`Grant`], and the
//! real check lives in [`authorized_descriptor`] — the **only** descriptor
//! accessor the capability methods use, so resolving an id to a database is
//! inseparable from proving the scope (the check is the price of admission one
//! level down, not a step each method remembers).
//!
//! Handlers reach the store **only** through these capabilities — the
//! source-guard test below fails if a `/databases` handler touches
//! [`DatabasesState`] directly, so a forgotten scope check can't ship.

use std::path::PathBuf;
use std::sync::Arc;

use scopes_rust::{Grant, Scope};

pub(crate) use scope_capabilities_rust::{Capability, ScopeClaims, Scoped};

use crate::config::DatabaseDescriptor;
use crate::domain::DatabaseError;
use crate::files::{schedule_deletion, snapshot_to_temp};
use crate::http::state::DatabasesState;
use crate::metadata::DatabaseMetadata;

/// Resolve `id` to its catalogued descriptor **and** prove the caller's grant
/// covers the descriptor scope `scope_of` selects — the one door from an id to a
/// database for the capability methods, so a method cannot look a database up
/// without the scope check riding along.
///
/// Ordering: unknown id → `404` (the catalogue is host policy, and its ids are
/// already public to any authenticated caller via `GET /databases`); catalogued
/// but not covered → `403` naming the missing scope, checked **before** any
/// on-disk existence probe, so an under-scoped caller learns nothing about
/// whether data exists (`403` whether or not the file is present).
fn authorized_descriptor<'s>(
    state: &'s DatabasesState,
    granted: &Grant,
    id: &str,
    scope_of: impl FnOnce(&DatabaseDescriptor) -> &Scope,
) -> Result<&'s DatabaseDescriptor, DatabaseError> {
    let descriptor = state
        .descriptor(id)
        .ok_or_else(|| DatabaseError::NotFound { id: id.to_owned() })?;
    let required = scope_of(descriptor);
    if granted.covers(required) {
        Ok(descriptor)
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

impl Capability for DatabasesReader {
    type State = Arc<DatabasesState>;
    type Claims = ScopeClaims;

    // Empty — the data-dependent flavour: listing needs only authentication, and
    // the per-database read scope is checked in `download` via
    // `authorized_descriptor`.
    fn required_scopes() -> Vec<Scope> {
        Vec::new()
    }

    fn build(state: Arc<DatabasesState>, granted: Grant) -> Self {
        DatabasesReader { state, granted }
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

    /// Snapshot a database for download. [`authorized_descriptor`] proves the
    /// caller covers the database's declared `read_scope` **before** the on-disk
    /// existence check, so an under-scoped caller gets a `403` whether or not
    /// the file is present — what does (deliberately) remain distinguishable is
    /// catalogue membership, which `GET /databases` already exposes to any
    /// authenticated caller. Unknown id / absent file are `404`. Returns the
    /// download filename + the temp snapshot path for the handler to stream and
    /// unlink.
    pub(crate) async fn download(&self, id: &str) -> Result<DownloadSnapshot, DatabaseError> {
        let descriptor = authorized_descriptor(&self.state, &self.granted, id, |d| &d.read_scope)?;
        // Own the filename before the await (the descriptor borrows `state`).
        let filename = descriptor.id.clone();
        let path = self
            .state
            .existing_path(descriptor)
            .ok_or_else(|| DatabaseError::NotFound { id: id.to_owned() })?;
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

impl Capability for DatabasesDeleter {
    type State = Arc<DatabasesState>;
    type Claims = ScopeClaims;

    // Empty — the data-dependent flavour; see `DatabasesReader`.
    fn required_scopes() -> Vec<Scope> {
        Vec::new()
    }

    fn build(state: Arc<DatabasesState>, granted: Grant) -> Self {
        DatabasesDeleter { state, granted }
    }
}

impl DatabasesDeleter {
    /// Schedule a database for deletion. [`authorized_descriptor`] proves the
    /// caller covers the database's `delete_scope` before the on-disk existence
    /// check, same boundary as `download`. Unknown id / absent file are `404`.
    /// The existence stat and the marker write are blocking, so the
    /// check-then-write runs on a blocking thread.
    pub(crate) async fn delete(&self, id: &str) -> Result<(), DatabaseError> {
        let descriptor =
            authorized_descriptor(&self.state, &self.granted, id, |d| &d.delete_scope)?;
        let path = self.state.path_for(descriptor);
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || {
            if !path.exists() {
                return Err(DatabaseError::NotFound { id });
            }
            schedule_deletion(&path)
        })
        .await
        .map_err(|error| DatabaseError::infrastructure("delete task panicked", error))?
    }
}

#[cfg(test)]
mod tests {
    /// Default-safety guard: the `/databases` handler files must reach the store
    /// **only** through a `Scoped<…>` capability — never a raw
    /// `State<Arc<DatabasesState>>` or a direct `DatabasesState` method.
    /// Bypassing the capability would need one of these tokens, and this test
    /// fails if one appears, so a forgotten per-database scope check can't ship
    /// silently. (Mirrors gatekeeper's
    /// `access_handlers_reach_the_store_only_through_capabilities`.)
    ///
    /// The routes tree is enumerated at test time, so a NEW handler file is
    /// guarded by default. (Advisory-strength, deliberately: the needles are
    /// textual, so a comment containing `.descriptor(` false-positives and
    /// creative formatting could evade them. It back-stops the real seal — the
    /// capability being the only door — rather than replacing it.)
    #[test]
    fn database_handlers_reach_the_store_only_through_capabilities() {
        // Raw router state, or any direct `DatabasesState` accessor — the only
        // ways to reach the store without a capability. (The type *name* may
        // still appear in prose/`expect` messages; these are the method call
        // shapes.)
        const FORBIDDEN: &[&str] = &[
            "State<",
            ".databases(",
            ".descriptor(",
            ".path_for(",
            ".existing_path(",
        ];
        let routes_dir =
            std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/http/routes"));
        let mut checked = 0;
        for path in rs_files_under(routes_dir) {
            let relative = path
                .strip_prefix(routes_dir)
                .expect("enumerated under routes_dir")
                .to_string_lossy()
                .replace('\\', "/");
            // Module glue only — every operation handler is gated.
            if relative.ends_with("mod.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read handler source {relative}: {e}"));
            for needle in FORBIDDEN {
                assert!(
                    !source.contains(needle),
                    "scope-gated handler `{relative}` reaches the store directly \
                     (`{needle}`); acquire it through a `Scoped<…>` capability instead",
                );
            }
            checked += 1;
        }
        assert!(
            checked >= 3,
            "only {checked} handler files enumerated — did src/http/routes move?",
        );
    }

    fn rs_files_under(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut files = Vec::new();
        let entries =
            std::fs::read_dir(dir).unwrap_or_else(|e| panic!("enumerate {}: {e}", dir.display()));
        for entry in entries {
            let path = entry.expect("readable dir entry").path();
            if path.is_dir() {
                files.extend(rs_files_under(&path));
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                files.push(path);
            }
        }
        files.sort();
        files
    }
}
