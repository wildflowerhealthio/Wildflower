//! Scope-gated capabilities for the `/databases` surface — the databases slice's
//! copy of the default-safe authorization pattern (the generic machinery lives in
//! [`scope_capabilities_rust`]; the pattern originated on gatekeeper's `/access`
//! surface). They live in `domain/` and depend only on the
//! [`DatabaseFiles`](crate::ports::DatabaseFiles) port + a catalogue and [`Grant`]
//! handed to their constructors — never on `crate::http`, `std::fs`, `rusqlite`,
//! or the router state, so the whole surface is unit-testable against an in-memory
//! fake (see the tests below). The `Capability` bindings that build these from the
//! `DatabasesState` (and construct the concrete adapter) live one layer out in
//! [`crate::live_bindings`].
//!
//! Unlike gatekeeper's fixed-scope capabilities, the scope a database requires
//! depends on **which** database — the host declares every
//! [`DatabaseDescriptor`]'s `read_scope` / `delete_scope`. So both capabilities
//! here are the **data-dependent** flavour: their static required-scope gate is
//! empty ("authenticated only", enforced by the claims-inserting authN layer the
//! host wraps this router with), the constructor stores the caller's [`Grant`],
//! and the real check lives in [`authorized_descriptor`] — the only descriptor
//! accessor the methods use, so resolving an id to a database is inseparable from
//! proving the scope.

use std::path::PathBuf;
use std::sync::Arc;

use scopes_rust::{Grant, Scope};

pub(crate) use scope_capabilities_rust::Scoped;

use crate::config::DatabaseDescriptor;
use crate::domain::{DatabaseError, DatabaseMetadata};
use crate::ports::DatabaseFiles;

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
fn authorized_descriptor<'c>(
    catalogue: &'c [DatabaseDescriptor],
    granted: &Grant,
    id: &str,
    scope_of: impl FnOnce(&DatabaseDescriptor) -> &Scope,
) -> Result<&'c DatabaseDescriptor, DatabaseError> {
    let descriptor = catalogue
        .iter()
        .find(|descriptor| descriptor.id == id)
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
/// requires the target database's declared `read_scope`. Generic over the
/// [`DatabaseFiles`] port `F` (held by value, not `Arc<dyn …>`), so the concrete
/// adapter binds once in [`crate::live_bindings`] and tests monomorphize it to an
/// in-memory fake. Also holds the catalogue and the caller's [`Grant`].
pub(crate) struct DatabasesReader<F> {
    files: F,
    catalogue: Arc<[DatabaseDescriptor]>,
    granted: Grant,
}

impl<F: DatabaseFiles> DatabasesReader<F> {
    /// Assemble the reader from a [`DatabaseFiles`] port `F`, the catalogue, and
    /// the caller's [`Grant`] — called by the `Capability` binding in
    /// [`crate::live_bindings`], or directly in tests with an in-memory fake.
    pub(crate) fn new(files: F, catalogue: Arc<[DatabaseDescriptor]>, granted: Grant) -> Self {
        Self {
            files,
            catalogue,
            granted,
        }
    }

    /// Metadata for every catalogued database (existence, size, table count,
    /// last-modified). Authenticated-only — the listing exposes names/sizes, not
    /// contents, so it needs no per-database scope. The port owns dispatching the
    /// best-effort, blocking per-file reads off the async runtime.
    pub(crate) async fn list(&self) -> Result<Vec<DatabaseMetadata>, DatabaseError> {
        self.files
            .read_catalogue_metadata(Arc::clone(&self.catalogue))
            .await
    }

    /// Snapshot a database for download. [`authorized_descriptor`] proves the
    /// caller covers the database's declared `read_scope` **before** the on-disk
    /// existence check (inside the port's `temp_download_for_descriptor`), so an
    /// under-scoped caller gets a `403` whether or not the file is present — what
    /// does (deliberately) remain distinguishable is catalogue membership, which
    /// `GET /databases` already exposes to any authenticated caller. Unknown id /
    /// absent file are `404`. Returns the download filename + the temp snapshot
    /// path for the handler to stream and unlink.
    pub(crate) async fn download(&self, id: &str) -> Result<DownloadSnapshot, DatabaseError> {
        let descriptor =
            authorized_descriptor(&self.catalogue, &self.granted, id, |d| &d.read_scope)?;
        let filename = descriptor.id.clone();
        let temp_path = self
            .files
            .temp_download_for_descriptor(descriptor.clone())
            .await?;
        Ok(DownloadSnapshot {
            filename,
            temp_path,
        })
    }
}

/// The result of a successful [`DatabasesReader::download`] — the header filename
/// and the temp snapshot path the handler streams and unlinks on drop.
#[derive(Debug)]
pub(crate) struct DownloadSnapshot {
    pub(crate) filename: String,
    pub(crate) temp_path: PathBuf,
}

/// Delete (schedule for deletion at next startup) a catalogued database —
/// `DELETE /databases/{id}`. Requires the target database's declared
/// `delete_scope`. Separate from [`DatabasesReader`] so a read handler holding the
/// reader capability structurally cannot delete. Generic over the
/// [`DatabaseFiles`] port `F`, same as [`DatabasesReader`].
pub(crate) struct DatabasesDeleter<F> {
    files: F,
    catalogue: Arc<[DatabaseDescriptor]>,
    granted: Grant,
}

impl<F: DatabaseFiles> DatabasesDeleter<F> {
    /// Assemble the deleter from a [`DatabaseFiles`] port `F`, the catalogue, and
    /// the caller's [`Grant`] — called by the `Capability` binding in
    /// [`crate::live_bindings`], or directly in tests with an in-memory fake.
    pub(crate) fn new(files: F, catalogue: Arc<[DatabaseDescriptor]>, granted: Grant) -> Self {
        Self {
            files,
            catalogue,
            granted,
        }
    }

    /// Schedule a database for deletion. [`authorized_descriptor`] proves the
    /// caller covers the database's `delete_scope` before the on-disk existence
    /// check (inside the port's `schedule_delete`), same boundary as `download`.
    /// Unknown id / absent file are `404`.
    pub(crate) async fn delete(&self, id: &str) -> Result<(), DatabaseError> {
        let descriptor =
            authorized_descriptor(&self.catalogue, &self.granted, id, |d| &d.delete_scope)?;
        self.files.schedule_delete(descriptor.clone()).await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use scopes_rust::Permission;

    use super::*;

    /// An in-memory [`DatabaseFiles`]: a database "exists" iff its id is in the
    /// set, so the capability logic (scope gate, id→descriptor, absent→404) is
    /// exercised without a real filesystem.
    struct FakeDatabaseFiles {
        present: HashSet<String>,
    }

    impl FakeDatabaseFiles {
        fn with(present: &[&str]) -> FakeDatabaseFiles {
            FakeDatabaseFiles {
                present: present.iter().map(|id| (*id).to_owned()).collect(),
            }
        }
    }

    #[async_trait::async_trait]
    impl DatabaseFiles for FakeDatabaseFiles {
        async fn read_catalogue_metadata(
            &self,
            catalogue: Arc<[DatabaseDescriptor]>,
        ) -> Result<Vec<DatabaseMetadata>, DatabaseError> {
            Ok(catalogue
                .iter()
                .map(|descriptor| {
                    let exists = self.present.contains(&descriptor.id);
                    DatabaseMetadata {
                        id: descriptor.id.clone(),
                        label: descriptor.label.clone(),
                        description: descriptor.description.clone(),
                        exists,
                        size_bytes: u64::from(exists),
                        table_count: exists.then_some(1),
                        modified_at: None,
                        pending_deletion: false,
                    }
                })
                .collect())
        }

        async fn temp_download_for_descriptor(
            &self,
            descriptor: DatabaseDescriptor,
        ) -> Result<PathBuf, DatabaseError> {
            if self.present.contains(&descriptor.id) {
                Ok(PathBuf::from(format!("/snap/{}", descriptor.id)))
            } else {
                Err(DatabaseError::NotFound { id: descriptor.id })
            }
        }

        async fn schedule_delete(
            &self,
            descriptor: DatabaseDescriptor,
        ) -> Result<(), DatabaseError> {
            if self.present.contains(&descriptor.id) {
                Ok(())
            } else {
                Err(DatabaseError::NotFound { id: descriptor.id })
            }
        }
    }

    fn descriptors() -> Vec<DatabaseDescriptor> {
        vec![
            DatabaseDescriptor {
                id: "health-data.sqlite".to_owned(),
                label: "Health data".to_owned(),
                description: "Clinical records.".to_owned(),
                read_scope: Scope::fhir_system_all(Permission::READ_SEARCH),
                delete_scope: Scope::fhir_system_all(Permission::DELETE),
            },
            DatabaseDescriptor {
                id: "wildflower.sqlite".to_owned(),
                label: "App data".to_owned(),
                description: "App state.".to_owned(),
                read_scope: Scope::wildflower_all(Permission::READ),
                delete_scope: Scope::wildflower_all(Permission::DELETE),
            },
        ]
    }

    fn grant(scopes: &str) -> Grant {
        Grant::parse(scopes.split_whitespace())
    }

    fn reader(present: &[&str], scopes: &str) -> DatabasesReader<FakeDatabaseFiles> {
        DatabasesReader::new(
            FakeDatabaseFiles::with(present),
            Arc::from(descriptors()),
            grant(scopes),
        )
    }

    fn deleter(present: &[&str], scopes: &str) -> DatabasesDeleter<FakeDatabaseFiles> {
        DatabasesDeleter::new(
            FakeDatabaseFiles::with(present),
            Arc::from(descriptors()),
            grant(scopes),
        )
    }

    #[tokio::test]
    async fn list_is_authenticated_only_and_reports_every_database() {
        // No resource scope at all — listing still returns metadata for both.
        let metadata = reader(&["health-data.sqlite"], "openid")
            .list()
            .await
            .expect("list");
        assert_eq!(metadata.len(), 2);
        let health = metadata
            .iter()
            .find(|m| m.id == "health-data.sqlite")
            .unwrap();
        assert!(health.exists);
        let absent = metadata
            .iter()
            .find(|m| m.id == "wildflower.sqlite")
            .unwrap();
        assert!(!absent.exists);
    }

    #[tokio::test]
    async fn download_with_covering_scope_returns_the_snapshot() {
        let snapshot = reader(&["wildflower.sqlite"], "wildflower/*.r")
            .download("wildflower.sqlite")
            .await
            .expect("download");
        assert_eq!(snapshot.filename, "wildflower.sqlite");
    }

    #[tokio::test]
    async fn download_under_scoped_is_insufficient_scope_before_existence() {
        // Present-vs-absent doesn't matter: the scope gate rejects first.
        let error = reader(&[], "wildflower/*.r")
            .download("health-data.sqlite")
            .await
            .expect_err("under-scoped download");
        let DatabaseError::InsufficientScope { missing_scopes } = error else {
            panic!("expected InsufficientScope, got {error:?}");
        };
        assert_eq!(missing_scopes, vec!["system/*.rs".to_owned()]);
    }

    #[tokio::test]
    async fn download_unknown_id_is_not_found() {
        let error = reader(&[], "system/*.cruds wildflower/*.cruds")
            .download("nope.sqlite")
            .await
            .expect_err("unknown id");
        assert!(matches!(error, DatabaseError::NotFound { .. }));
    }

    #[tokio::test]
    async fn download_known_but_absent_is_not_found() {
        let error = reader(&[], "wildflower/*.r")
            .download("wildflower.sqlite")
            .await
            .expect_err("absent file");
        assert!(matches!(error, DatabaseError::NotFound { .. }));
    }

    #[tokio::test]
    async fn delete_with_covering_scope_schedules() {
        deleter(&["wildflower.sqlite"], "wildflower/*.d")
            .delete("wildflower.sqlite")
            .await
            .expect("delete");
    }

    #[tokio::test]
    async fn delete_under_scoped_is_insufficient_scope() {
        let error = deleter(&["health-data.sqlite"], "wildflower/*.d")
            .delete("health-data.sqlite")
            .await
            .expect_err("under-scoped delete");
        assert!(matches!(error, DatabaseError::InsufficientScope { .. }));
    }

    #[tokio::test]
    async fn delete_known_but_absent_is_not_found() {
        let error = deleter(&[], "wildflower/*.d")
            .delete("wildflower.sqlite")
            .await
            .expect_err("absent file");
        assert!(matches!(error, DatabaseError::NotFound { .. }));
    }

    /// Default-safety guard: the `/databases` handler files must reach the store
    /// **only** through a `Scoped<…>` capability — never a raw router `State<…>`
    /// or the filesystem adapter directly. Bypassing the capability would need one
    /// of these tokens, and this test fails if one appears, so a forgotten
    /// per-database scope check can't ship silently. (Mirrors gatekeeper's
    /// `access_handlers_reach_the_store_only_through_capabilities`.)
    ///
    /// The routes tree is enumerated at test time, so a NEW handler file is
    /// guarded by default. (Advisory-strength: the needles are textual.)
    #[test]
    fn database_handlers_reach_the_store_only_through_capabilities() {
        // Raw router state, or any direct filesystem / adapter access — the only
        // ways to reach a database without a capability.
        const FORBIDDEN: &[&str] = &["State<", "crate::files", "crate::adapters", "DatabaseFiles"];
        let routes_dir =
            std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/http/routes"));
        let mut checked = 0;
        for path in rs_files_under(routes_dir) {
            let relative = path
                .strip_prefix(routes_dir)
                .expect("enumerated under routes_dir")
                .to_string_lossy()
                .replace('\\', "/");
            // Module glue and test-support files only — every operation handler
            // is gated.
            if relative.ends_with("mod.rs") || relative.ends_with("tests.rs") {
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
