//! Scope-gated service extractors — the authorization (authZ) half of the
//! `/access` surface, and the mechanism that makes a forgotten permission check
//! structurally hard rather than merely a discipline.
//!
//! The generic machinery — the [`Scoped`] extractor and the [`GatedService`]
//! trait — now lives in [`shared_structures_rust::scope_gating`] so every HTTP
//! slice can copy this pattern; this module re-exports it and supplies the
//! gatekeeper-specific facades ([`facades`]).
//!
//! The [`require_valid_session`](crate::http::middleware::require_valid_session)
//! layer proves *who* the caller is (authN, `401` on failure) and stashes the
//! [`VerifiedClaims`] in the request extensions. Each `/access` handler then
//! acquires the store **only** through a [`Scoped<F>`] extractor: it reads those
//! claims, builds a coverage-checkable `Grant`, and hands back the narrow service
//! facade `F` **only if** the token covers `F`'s required scope — otherwise a
//! `403` naming the missing scopes. Because the facade is the sole door to the
//! store for these handlers (see [`facades`]), a handler that skips the scope
//! check simply has no way to reach any data: the check isn't a step you remember
//! to add, it's the price of admission to the store.
//!
//! The (resource, permission) → required-scope mapping lives in one place — each
//! facade's [`GatedService::required_scopes`] impl in [`facades`] — and the same
//! set is surfaced as [`facades::grantable_admin_scopes`], the admin half of the
//! grantable-scope vocabulary the consent surfaces offer. Enforced and grantable
//! can't drift because they read the same registry.

pub(crate) mod facades;

pub(crate) use shared_structures_rust::scope_gating::{GatedService, Scoped};
