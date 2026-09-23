//! The gatekeeper's capabilities — the narrow, purpose-built doors through which
//! the HTTP layer reaches the store, split by **what unlocks them**:
//!
//!  - [`access`] — the `/access/*` Owner surface, gated on the caller's
//!    **scopes**: acquired through the `Scoped<…>` extractor, which checks the
//!    covering scope before the capability exists. The origin of the
//!    default-safe pattern (`docs/Authorization/Scope-Gated Endpoints How-To.md`).
//!  - [`oauth`] — the `/oauth/*` pre-auth surface, gated on the **client**:
//!    anything done on a client's own behalf takes an `AuthenticatedClient`
//!    proof, produced by the one capability there.
//!  - [`session`] — the token verification both authN gates run, and the
//!    authenticated-only self-service operations on the caller's own session
//!    (acquired through the shared `Authenticated<…>` extractor).
//!  - [`writers`] — the privileged writes themselves (approve a request, issue a
//!    code, record a grant, mint a token), each gated on an **authority proof**
//!    from [`crate::domain::authority`]. Flow capabilities in every other group
//!    compose these rather than calling the privileged store methods directly;
//!    a source-guard test makes that structural.
//!
//! Every capability is generic over the [`GatekeeperStore`](crate::domain::GatekeeperStore)
//! port and holds its dependencies lifted from the state (never an
//! `Arc<GatekeeperState>` it reaches into), so its logic is unit-testable
//! against the in-memory fake. The bindings that name the concrete
//! `SqliteGatekeeperStore` and build a capability from the router state live in
//! [`crate::live_bindings`], so nothing here depends on a concrete adapter or on
//! `crate::http`.

pub(crate) mod access;
pub(crate) mod oauth;
pub(crate) mod session;
pub(crate) mod writers;

pub use access::grantable_admin_scopes;
pub(crate) use access::{
    ApproveDeviceConsentInput, ApproveOAuthConsentInput, Capability, ConsentDecider,
    ConsentOutcome, ConsentReader, DeviceConsentView, FixedScopeCapability, GrantsReader,
    GrantsRevoker, OAuthConsentView, Scoped, TokenRevoker,
};

#[cfg(test)]
mod source_guards {
    use crate::domain::source_guard::{production_lines, relative_to, rs_files_under};

    /// Default-safety guard: every handler file reaches the store **only**
    /// through a capability extractor — `Scoped<…>` (scope-gated),
    /// `Authenticated<…>` (the caller's own session), or `Live<…>` (the
    /// pre-auth front door, whose gate is the proof its methods take) — never a
    /// raw `State<Arc<GatekeeperState>>` or a state field. This test fails if
    /// one appears, so a forgotten gate can't ship silently.
    ///
    /// The routes tree is enumerated at test time, so a NEW handler file is
    /// guarded by default; only module glue (`mod.rs`) is exempt. (Advisory-
    /// strength, deliberately: the needles are textual; comments and unit-test
    /// modules are skipped.)
    #[test]
    fn handlers_reach_the_state_only_through_capabilities() {
        // Raw router state, or any field of it — the only ways to reach data
        // or a seam without a capability.
        const FORBIDDEN: &[&str] = &[
            "State<",
            ".store",
            ".revocation_store",
            ".first_party_client_id",
            ".self_hosted_redirects",
            ".active_pending_consent_sender",
            ".loopback_base_url",
        ];

        let routes_dir =
            std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/http/routes"));
        let mut checked = 0;
        for path in rs_files_under(routes_dir) {
            let relative = relative_to(&path, routes_dir);
            if relative.ends_with("mod.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read handler source {relative}: {e}"));
            for (n, line) in production_lines(&source) {
                for needle in FORBIDDEN {
                    assert!(
                        !line.contains(needle),
                        "handler `{relative}:{n}` reaches the state directly (`{needle}`); \
                         acquire a capability through `Scoped<…>`, `Authenticated<…>`, or \
                         `Live<…>` instead",
                    );
                }
            }
            checked += 1;
        }
        assert!(
            checked >= 15,
            "only {checked} handler files enumerated — did src/http/routes move?",
        );
    }

    /// The authN gates verify a token through the `TokenVerifier` capability,
    /// not against the stores directly, so the verification policy has exactly
    /// one home. Same textual strength as the handler guard.
    #[test]
    fn middleware_verifies_only_through_the_token_verifier() {
        const FORBIDDEN: &[&str] = &[".store", ".revocation_store"];
        let middleware_dir =
            std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src/http/middleware"));
        let mut checked = 0;
        for path in rs_files_under(middleware_dir) {
            let relative = relative_to(&path, middleware_dir);
            let source = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("read middleware source {relative}: {e}"));
            for (n, line) in production_lines(&source) {
                for needle in FORBIDDEN {
                    assert!(
                        !line.contains(needle),
                        "middleware `{relative}:{n}` reaches a store directly (`{needle}`); \
                         verify through `LiveTokenVerifier` instead",
                    );
                }
            }
            checked += 1;
        }
        assert!(
            checked >= 3,
            "only {checked} middleware files enumerated — did src/http/middleware move?",
        );
    }
}
