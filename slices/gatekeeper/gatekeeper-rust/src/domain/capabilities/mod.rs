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
pub(crate) mod writers;

pub use access::grantable_admin_scopes;
pub(crate) use access::{
    ApproveDeviceConsentInput, ApproveOAuthConsentInput, Capability, ConsentDecider,
    ConsentOutcome, ConsentReader, DeviceConsentView, FixedScopeCapability, GrantsReader,
    GrantsRevoker, OAuthConsentView, Scoped, TokenRevoker,
};
