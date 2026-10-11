//! Admin-gated capabilities for the admin API — the relay's copy of the
//! slices' default-safe authorization pattern (apps-rust's
//! `domain::capabilities`, recipe in `docs/Authorization/Scope-Gated
//! Endpoints How-To.md`). They live in `domain/` beside the [`TunnelStore`]
//! port they operate through, never importing `crate::site`, so a forgotten
//! permission check can't compile a tunnel-touching handler, and the whole
//! surface stays unit-testable against the in-memory `FakeTunnelStore`.
//!
//! The relay authorises by request signature, not by scope: every
//! capability but [`ClaimCodesRedeemer`] is gated by the admin signature
//! (`keyid="admin"`, see [`crate::site::signature`]), checked by the
//! [`Admin`](crate::live_bindings::Admin) extractor before the capability is
//! built. The redeemer serves the unauthenticated `POST /claim`, where the
//! claim code is the credential. So the structs are generic over the store port and hold their
//! dependencies **lifted from the state**, never the
//! [`TunnelRegistry`](crate::live_bindings::state::TunnelRegistry) itself.
//! The bindings that name the `SqliteTunnelStore` adapter, build a
//! capability from the router state and serve a change (rathole's services,
//! the served tunnels the front and verifier share) live beside the state in
//! [`crate::live_bindings`], so `domain/` stays store-agnostic and free of
//! side effects.
//!
//! One capability per file — [`TunnelsReader`], [`TunnelsCreator`],
//! [`TunnelsDeleter`], [`ClaimCodesIssuer`], [`ClaimCodesRedeemer`] — each
//! with its store logic and its own tests. A tunnel change decides against
//! the store, writes it and returns the tunnel it created or deleted, with
//! an `undo` for when serving fails. Claim codes change only the store.
//!
//! [`TunnelStore`]: crate::domain::TunnelStore

mod claim_codes_issuer;
mod claim_codes_redeemer;
mod tunnels_creator;
mod tunnels_deleter;
mod tunnels_reader;

pub(crate) use claim_codes_issuer::ClaimCodesIssuer;
pub(crate) use claim_codes_redeemer::ClaimCodesRedeemer;
pub(crate) use tunnels_creator::TunnelsCreator;
pub(crate) use tunnels_deleter::TunnelsDeleter;
pub(crate) use tunnels_reader::TunnelsReader;

#[cfg(test)]
mod tests {
    /// Default-safety guard: the admin handlers must reach the tunnels
    /// **only** through an `Admin<…>` capability — never the raw router
    /// state, the store, a registry change, or a hand-written signer check.
    /// Bypassing the capability would need one of these tokens, and this
    /// test fails if one appears outside the file's tests, so a forgotten
    /// admin check can't ship silently. (Mirrors apps-rust's
    /// `apps_handlers_reach_the_store_only_through_capabilities`;
    /// advisory-strength: the needles are textual.)
    #[test]
    fn admin_handlers_reach_the_tunnels_only_through_capabilities() {
        const FORBIDDEN: &[&str] = &["State<Arc<TunnelRegistry", ".store", ".change(", "SignedBy"];
        let source = include_str!("../../site/admin.rs");
        let handlers = source
            .split("#[cfg(test)]")
            .next()
            .expect("split yields at least one part");
        assert!(handlers.contains("Admin<"), "admin.rs uses no capability");
        for needle in FORBIDDEN {
            assert!(
                !handlers.contains(needle),
                "an admin handler reaches the tunnels directly (`{needle}`); \
                 acquire them through an `Admin<…>` capability instead",
            );
        }
    }
}
