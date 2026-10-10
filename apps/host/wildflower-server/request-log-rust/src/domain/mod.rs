//! The request log's domain — no diesel, axum or wire coupling: the log's
//! types and row caps ([`request_log`]), its time-based [`retention`], the
//! [`RequestLogStore`] persistence port, [`RequestLogError`] (the failure
//! vocabulary the HTTP layer renders), and the scope-gated [`capabilities`] the
//! HTTP handlers acquire. **Nothing here depends on `crate::http`** — the
//! concrete `SqliteRequestLogStore` is injected through the port, and the
//! `FixedScopeCapability` binding that names it lives beside the router state
//! in `crate::live_bindings`.

pub mod capabilities;
pub mod request_log;
mod request_log_error;
pub(crate) mod retention;

pub use request_log::{CallerClass, RequestLogStore};
pub use request_log_error::RequestLogError;

#[cfg(test)]
mod http_free_guard {
    /// `domain/` must never depend on `crate::http` — the scope-gated
    /// capability lives here and operates through the [`RequestLogStore`] port,
    /// so a stray `use crate::http::…` would re-couple the domain to the
    /// transport layer. This test enumerates the `domain/` tree and fails if any
    /// non-comment line names `crate::http`, so the invariant can't silently
    /// regress. (Doc comments may mention it in prose — those lines are
    /// skipped.)
    ///
    /// [`RequestLogStore`]: super::RequestLogStore
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
                     must stay transport-free; route the dependency through the \
                     `RequestLogStore` port",
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
