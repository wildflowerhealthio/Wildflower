//! Shared handler state for the databases slice. Holds the data directory and
//! the host-supplied catalogue of databases to expose; the slice has no built-in
//! knowledge of which databases exist.

use std::path::PathBuf;

use crate::config::DatabaseDescriptor;

/// Handler state: the data directory plus the catalogue of databases the host
/// asked us to expose. Cheap to share behind an `Arc`, mirroring `apps-rust`'s
/// `AppsState`.
pub struct DatabasesState {
    data_dir: PathBuf,
    databases: Vec<DatabaseDescriptor>,
}

impl DatabasesState {
    /// Build the state over the host's data directory and database catalogue.
    ///
    /// # Panics
    ///
    /// Panics if any catalogue id is not header-safe (see
    /// [`DatabaseDescriptor::has_header_safe_id`]). The id is used verbatim both
    /// as an on-disk filename and in the download handler's
    /// `Content-Disposition` header, so a malformed id is a host misconfiguration
    /// that must fail loudly at startup rather than surface as a corrupt header
    /// or a path escape. The catalogue is host-owned and build-time constant, so
    /// this fires only on a broken build, never on client input.
    #[must_use]
    pub fn new(data_dir: PathBuf, databases: Vec<DatabaseDescriptor>) -> Self {
        for descriptor in &databases {
            assert!(
                descriptor.has_header_safe_id(),
                "database catalogue id {:?} is not header-safe: ids must be non-empty and \
                 ASCII alphanumeric plus '.', '-', '_' (used verbatim as a filename and in the \
                 download Content-Disposition header)",
                descriptor.id,
            );
        }
        Self {
            data_dir,
            databases,
        }
    }

    /// The catalogue, in display order — drives `GET /databases`.
    pub(crate) fn databases(&self) -> &[DatabaseDescriptor] {
        &self.databases
    }

    /// Resolve a resource id to its descriptor, rejecting unknown ids. This is
    /// the only way an id becomes a path, so an id absent from the host
    /// catalogue can never reach the filesystem (path-traversal guard).
    pub(crate) fn descriptor(&self, id: &str) -> Option<&DatabaseDescriptor> {
        self.databases.iter().find(|descriptor| descriptor.id == id)
    }

    /// The on-disk path for a catalogued database. Built from the host-supplied
    /// catalogue filename, never from raw client input.
    pub(crate) fn path_for(&self, descriptor: &DatabaseDescriptor) -> PathBuf {
        self.data_dir.join(&descriptor.id)
    }

    /// Resolve `id` to the descriptor + path of a database that is both
    /// catalogued *and* present on disk, or `None`. The single home of the
    /// "known and exists, else 404" rule the `download` / `delete` handlers
    /// share.
    pub(crate) fn existing(&self, id: &str) -> Option<(&DatabaseDescriptor, PathBuf)> {
        let descriptor = self.descriptor(id)?;
        let path = self.path_for(descriptor);
        path.exists().then_some((descriptor, path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A catalogue id that isn't header-safe is a host misconfiguration and must
    /// panic at construction, before it can reach a header or the filesystem.
    #[test]
    #[should_panic(expected = "is not header-safe")]
    fn new_rejects_a_non_header_safe_id() {
        let bad = DatabaseDescriptor {
            id: "evil\".sqlite".to_owned(),
            label: "Evil".to_owned(),
            description: "Quote in the id.".to_owned(),
            read_scope: scopes_rust::Scope::wildflower_all(scopes_rust::Permission::READ),
            delete_scope: scopes_rust::Scope::wildflower_all(scopes_rust::Permission::DELETE),
        };
        let _ = DatabasesState::new(PathBuf::from("/data"), vec![bad]);
    }
}
