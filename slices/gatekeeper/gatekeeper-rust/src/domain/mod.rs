//! The gatekeeper's domain vocabulary — pure types and business rules
//! shared by every other layer. No `crate::http` dependency runs here — the
//! domain types carry diesel derives that name their [`crate::db`] `table!` for
//! the bind/read mapping, but no transport code lives in this layer: the
//! [`GatekeeperStore`] port abstracts persistence ([`crate::db`]'s
//! `SqliteGatekeeperStore` owns the SQL behind it); the store-touching logic
//! lives with each entity module (the refresh-token rotation, the session
//! revoke) or inside a [`capabilities`] capability (the scope-gated `/access`
//! operations, generic over the store port); and everything fails with the
//! domain's own [`gatekeeper_error`] vocabulary. Persistence mappings live in
//! [`crate::db`], transport in [`crate::http`], the router state (which builds
//! the capabilities) in [`crate::live_bindings`].

// The persistence port. Mirrors collector's `remotes_store`.
pub mod gatekeeper_store;

// The authority proofs every privileged write demands — the typed answer to "on
// what authority is this row written?". Constructed only by the one function
// that checks the rule each proof stands for.
pub(crate) mod authority;

// The capabilities: the scope-gated `/access` surface (`access/`) and the
// proof-gated privileged writers (`writers/`), generic over the store port. The
// `Capability` bindings to the concrete state live in `crate::live_bindings`.
pub(crate) mod capabilities;

// The in-memory `FakeGatekeeperStore` + fixtures the domain unit tests share.
#[cfg(test)]
pub(crate) mod test_fake;

pub mod authorization_code;
pub mod authorization_request;
pub mod client;
// The `client_id` / `client_secret` pair a client presents (RFC 6749 §2.3.1),
// zeroized on drop; how it arrived is the HTTP layer's `PresentedCredentials`.
pub mod client_credentials;
// Pure builders for the OAuth client-callback URLs (`redirect_uri` + `code`/`error`
// + `state`) — no axum/store coupling, so the `/oauth` surface and the Owner
// consent action can return the same URL. Lifted out of `http::routes::oauth`.
pub mod client_redirect;
// The trust-on-first-use registration verdict: how a pending authorization-code
// request compares against the `clients` row it names right now. Derived on every
// read, never stored, so `/authorize` and the consent surfaces agree.
pub(crate) mod client_registration;
// The domain's failure vocabulary (collector's `RemoteError` is the model):
// semantic client-facing variants plus the opaque `Infrastructure`.
pub mod gatekeeper_error;
pub mod grant;
// The closed set of OAuth error codes (RFC 6749 §5.2 + the redirect/device
// codes) — a pure domain vocabulary lifted out of the OAuth route tree so the
// error model can name it without reaching into `http`.
pub mod oauth_error_code;
// URL/path builders for the gatekeeper's user-facing `/gatekeeper/*` webview
// pages — pure string builders (no axum/state), duplicated TS ⇄ Rust and
// drift-tested against `gatekeeper-core/src/page-paths.ts`.
pub mod page_paths;
// The head of the single pending-consent queue the host popup surfaces —
// device-code and authorization-code requests share one FIFO slot, so the head
// carries whichever key its consent surface reads by.
pub mod pending_consent;
pub mod refresh_token;
// The retention windows for the three accumulating tables plus the sweep that
// applies them — the policy half of the startup/daily reaper `setup_gatekeeper`
// spawns. Lives here (not in `db`) because the windows are a domain decision;
// the store only takes cutoffs.
pub mod retention;
// The logout session-token revoke over the `Revocation` port.
pub(crate) mod session;
pub mod signing_key;
pub mod token;

pub use authorization_code::PendingCodeConsent;
pub use gatekeeper_store::{GatekeeperStore, GatekeeperTx};

/// Shared helpers for the crate's **source-guard** tests — the advisory-strength
/// tests that enumerate source files and assert a textual invariant (a handler
/// never names the store, a privileged call never leaves the writers, a proof is
/// constructed in one place). One enumerator, so every guard walks the tree the
/// same way.
#[cfg(test)]
pub(crate) mod source_guard {
    use std::path::{Path, PathBuf};

    /// Every `.rs` file under `dir`, recursively, sorted for stable failures.
    pub(crate) fn rs_files_under(dir: &Path) -> Vec<PathBuf> {
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

    /// `path` relative to `root`, with forward slashes, for matching against the
    /// guards' allow-lists.
    pub(crate) fn relative_to(path: &Path, root: &Path) -> String {
        path.strip_prefix(root)
            .expect("enumerated under root")
            .to_string_lossy()
            .replace('\\', "/")
    }

    /// The non-test, non-comment lines of a source file, numbered from 1. A
    /// guard scans these: line and doc comments may name anything in prose, and
    /// the unit-test module (everything from the first `#[cfg(test)]` on) may
    /// arrange state directly — planting rows, constructing proofs — without
    /// being the production path the guard exists to pin.
    pub(crate) fn production_lines(source: &str) -> impl Iterator<Item = (usize, &str)> {
        source
            .lines()
            .enumerate()
            .take_while(|(_, line)| line.trim_start() != "#[cfg(test)]")
            .filter(|(_, line)| !line.trim_start().starts_with("//"))
            .map(|(n, line)| (n + 1, line))
    }
}

#[cfg(test)]
mod http_free_guard {
    use super::source_guard::{production_lines, rs_files_under};

    /// `domain/` must never depend on `crate::http` — the capabilities live here
    /// and are built from `crate::live_bindings`, so a stray `use crate::http::…` would
    /// re-couple the domain to the transport layer. This test enumerates the
    /// `domain/` tree and fails if any non-comment line names `crate::http`, so
    /// the invariant can't silently regress.
    #[test]
    fn domain_never_references_crate_http() {
        // Assembled from parts so this guard's own source doesn't contain the
        // literal it scans for (which would make it flag itself).
        let needle = concat!("crate", "::", "http");
        let domain_dir = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/domain"));
        for path in rs_files_under(domain_dir) {
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            for (n, line) in production_lines(&source) {
                assert!(
                    !line.contains(needle),
                    "domain/ file {} line {n} imports the transport layer (`{needle}`) — domain \
                     must stay transport-free; route the dependency through a port or `crate::live_bindings`",
                    path.display(),
                );
            }
        }
    }
}
