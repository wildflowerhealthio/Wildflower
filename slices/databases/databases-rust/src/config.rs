//! Open-time configuration for the databases slice, mirroring
//! `apps-rust`'s `AppsConfig`. There is no shared `Connection` here — the slice
//! works at the file level, so it needs only the directory the databases live
//! in plus the host-supplied catalogue of which databases to expose.

use std::path::PathBuf;

use scopes_rust::Scope;

/// One database the host exposes for export / delete. `id` doubles as the
/// on-disk filename and the REST resource id (e.g. `health-data.sqlite`), so it
/// must be a bare filename with no path separators. The host owns every field —
/// the slice has no built-in knowledge of which databases exist, so adding a new
/// one is a build-time change in the composing app alone.
#[derive(Debug, Clone)]
pub struct DatabaseDescriptor {
    /// Resource id == filename, e.g. `health-data.sqlite`.
    pub id: String,
    /// Human label for the settings screen, e.g. `Health data`.
    pub label: String,
    /// One-line, user-facing description of what the database holds.
    pub description: String,
    /// The scope a caller's token must cover to **download** this database. Host
    /// policy keyed off what the database holds — e.g. `system/*.rs` (FHIR
    /// read+search) for the clinical database, `wildflower/*.r` for the app-data
    /// database — so a narrowly-scoped token can't export data it can't read. The
    /// per-database check lives in [`DatabasesReader`](crate::http) because the
    /// required scope is data-dependent (which database), not fixed per route.
    pub read_scope: Scope,
    /// The scope a caller's token must cover to **delete** this database
    /// (`system/*.d` / `wildflower/*.d`, matching `read_scope`'s grammar).
    pub delete_scope: Scope,
}

impl DatabaseDescriptor {
    /// Whether `id` is safe to embed verbatim both as an on-disk filename and in
    /// a `Content-Disposition: attachment; filename="{id}"` header value:
    /// non-empty and composed only of ASCII alphanumerics plus `.`, `-`, and
    /// `_`. The download handler
    /// ([`handle_download_database`](crate::http)) formats the id straight into
    /// that header with an infallible `expect`, and the id doubles as the bare
    /// filename resolved beneath the data dir — this charset keeps both uses free
    /// of quote-escaping, control characters, and path separators. Enforced when
    /// the host catalogue enters the slice (see
    /// [`DatabasesState::new`](crate::DatabasesState)).
    #[must_use]
    pub fn has_header_safe_id(&self) -> bool {
        !self.id.is_empty()
            && self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    }
}

/// What [`setup_databases`](crate::setup_databases) needs: the host's app-data
/// directory (the parent of every database file) and the catalogue of databases
/// to expose. The Tauri host passes `ServerRuntimeConfig::app_data_dir` and the
/// descriptors for the databases it opens.
#[derive(Debug, Clone)]
pub struct DatabasesConfig {
    /// The directory holding the database files — every resource id resolves to
    /// `data_dir.join(id)`.
    pub data_dir: PathBuf,
    /// The databases to expose, in display order. The host is the single source
    /// of truth; an id absent from this list is a `404`, which is also the
    /// path-traversal guard (only listed filenames ever reach the filesystem).
    pub databases: Vec<DatabaseDescriptor>,
}

#[cfg(test)]
mod tests {
    use scopes_rust::Permission;

    use super::*;

    fn descriptor(id: &str) -> DatabaseDescriptor {
        DatabaseDescriptor {
            id: id.to_owned(),
            label: "Label".to_owned(),
            description: "Description".to_owned(),
            // The scopes are irrelevant to header-safety; any real scope will do.
            read_scope: Scope::wildflower_all(Permission::READ),
            delete_scope: Scope::wildflower_all(Permission::DELETE),
        }
    }

    /// The real-shaped catalogue ids (bare `*.sqlite` filenames) are header-safe.
    #[test]
    fn catalogue_shaped_ids_are_header_safe() {
        for id in ["health-data.sqlite", "wildflower.sqlite", "a_b.C-1.sqlite3"] {
            assert!(
                descriptor(id).has_header_safe_id(),
                "expected {id:?} to be header-safe"
            );
        }
    }

    /// Anything with a quote, a control byte, a path separator, non-ASCII, or an
    /// empty id is rejected — those are exactly the cases that would break the
    /// verbatim `Content-Disposition` header or the on-disk filename.
    #[test]
    fn unsafe_ids_are_rejected() {
        for id in [
            "",
            "evil\".sqlite",
            "a b.sqlite",
            "a/b.sqlite",
            "a\\b.sqlite",
            "a\nb.sqlite",
            "café.sqlite",
        ] {
            assert!(
                !descriptor(id).has_header_safe_id(),
                "expected {id:?} to be rejected"
            );
        }
    }
}
