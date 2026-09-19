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

// The scope-gated `/access` capabilities — the per-(resource, permission)
// operations, generic over the store port. Their `Capability` bindings to the
// concrete state live in `crate::live_bindings`.
pub(crate) mod capabilities;

// The in-memory `FakeGatekeeperStore` + fixtures the domain unit tests share.
#[cfg(test)]
pub(crate) mod test_fake;

pub mod authorization_code;
pub mod authorization_request;
pub mod client;
// Pure builders for the OAuth client-callback URLs (`redirect_uri` + `code`/`error`
// + `state`) — no axum/store coupling, so the `/oauth` surface and the Owner
// consent action can return the same URL. Lifted out of `http::routes::oauth`.
pub mod client_redirect;
// The trust-on-first-use registration verdict: how a pending authorization-code
// request compares against the `clients` row it names right now. Derived on every
// read, never stored, so `/authorize` and the consent surfaces agree.
pub mod client_registration;
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

#[cfg(test)]
mod http_free_guard {
    /// `domain/` must never depend on `crate::http` — the capabilities live here
    /// and are built from `crate::live_bindings`, so a stray `use crate::http::…` would
    /// re-couple the domain to the transport layer. This test enumerates the
    /// `domain/` tree and fails if any non-comment line names `crate::http`, so
    /// the invariant can't silently regress. (Doc comments may mention it in
    /// prose — those lines are skipped.)
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
                     must stay transport-free; route the dependency through a port or `crate::live_bindings`",
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
