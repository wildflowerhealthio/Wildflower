//! Core types for the collector slice's host side — no diesel-query or axum
//! coupling in the logic: the [`Remote`] row/wire shape and the
//! [`config_tag`]/[`required_config_tag`] discriminant readers, [`RemoteError`]
//! (the semantic failure vocabulary the HTTP layer renders), the [`RemotesStore`]
//! persistence port, and the scope-gated [`capabilities`] the HTTP handlers
//! acquire (each owns the store logic for its operation — denormalizing the
//! `tag`, stamping `added_at`, mapping the store's primitive absence/conflict
//! signals onto [`RemoteError`]). **Nothing here depends on `crate::http`** — the
//! concrete `SqliteRemotesStore` is injected through the [`RemotesStore`] port,
//! and the `FixedScopeCapability` bindings that name it live beside the router
//! state in [`crate::state`], so this whole layer is store-agnostic and
//! transport-free.

pub(crate) mod capabilities;
mod remote;
mod remote_error;
mod remotes_store;

#[cfg(test)]
pub(crate) mod test_fake;

pub use remote::{config_tag, required_config_tag, Remote};
pub use remote_error::RemoteError;
pub use remotes_store::RemotesStore;

#[cfg(test)]
mod http_free_guard {
    /// `domain/` must never depend on `crate::http` — the scope-gated
    /// capabilities live here and operate through the [`RemotesStore`] port, so a
    /// stray `use crate::http::…` would re-couple the domain to the transport
    /// layer (and let a guard test assert `domain/` is transport-free). This test
    /// enumerates the `domain/` tree and fails if any non-comment line names
    /// `crate::http`, so the invariant can't silently regress. (Doc comments may
    /// mention it in prose — those lines are skipped.)
    #[test]
    fn domain_never_references_crate_http() {
        // Assembled from parts so this guard's own source doesn't contain the
        // literal it scans for (which would make it flag itself).
        let needle = concat!("crate", "::", "http");
        let domain_dir = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/domain"));
        for path in rs_files_under(domain_dir) {
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            for (n, line) in source.lines().enumerate() {
                if line.trim_start().starts_with("//") {
                    continue;
                }
                assert!(
                    !line.contains(needle),
                    "domain/ file {} line {} imports the transport layer (`{needle}`) — domain \
                     must stay transport-free; route the dependency through the `RemotesStore` port",
                    path.display(),
                    n + 1,
                );
            }
        }
    }

    fn rs_files_under(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut files = Vec::new();
        for entry in std::fs::read_dir(dir).expect("read domain dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                files.extend(rs_files_under(&path));
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                files.push(path);
            }
        }
        files
    }
}
