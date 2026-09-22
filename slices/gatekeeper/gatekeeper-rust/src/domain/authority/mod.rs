//! **Authority proofs** — the typed answer to "on what authority is this row
//! written?". Every privileged write (approve a request, issue a code, record or
//! widen a grant, widen a registration, mint a token) happens in exactly one
//! [`writer`](crate::domain::capabilities::writers), and each writer method
//! takes one of these proofs as its argument. A proof has private fields and a
//! single constructor — the function that checks the rule it stands for — so
//! holding the value *is* the evidence the check ran.
//!
//! The audit is therefore two short lists: the constructors here, and the
//! writers (a source guard pins every privileged store call to them).
//!
//!  - [`DelegatedScopes`] — what an approving Owner may delegate: clamped to the
//!    requested/allowed ceiling **and** covered by the approver's own grant. No
//!    grant, code, or widened registration can carry a scope the approver did
//!    not hold.
//!  - [`HostBootstrap`] — the host's own boot-time owner token, the one authority
//!    with no approving human; constructible only in `seeding` (guarded below).
//!  - [`MintAuthority`] — the sealed trait the minter mints under; implementors
//!    carry their scopes privately, so a token's scopes are never a
//!    caller-assembled slice.
//!
//! Not proofs: the registration-acknowledgement check (a consent-UI rule run
//! before any clamp) and the pending-request bookkeeping writes (park, poll,
//! deny), which grant no authority and stay on the ordinary store port.

mod delegated_scopes;
mod host_bootstrap;
mod mint_authority;

pub(crate) use delegated_scopes::{DelegatedScopes, ScopeCeiling};
pub(crate) use host_bootstrap::HostBootstrap;
pub(crate) use mint_authority::MintAuthority;

#[cfg(test)]
mod construction_site_guard {
    use crate::domain::source_guard::{production_lines, relative_to, rs_files_under};

    /// [`HostBootstrap`](super::HostBootstrap) is the one authority minted with
    /// no approving human, so its constructor may be called from exactly one
    /// place: the boot-time seeding. This test enumerates `src/` and fails if
    /// the constructor is named anywhere else (its own definition file aside),
    /// so a second unproven mint can't appear silently. Comments and unit-test
    /// modules are skipped (see [`production_lines`]).
    #[test]
    fn host_bootstrap_is_constructed_only_by_seeding() {
        let needle = concat!("HostBootstrap::", "for_host(");
        let allowed = ["seeding.rs", "domain/authority/host_bootstrap.rs"];
        let src = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
        for path in rs_files_under(src) {
            let relative = relative_to(&path, src);
            if allowed.contains(&relative.as_str()) {
                continue;
            }
            let source =
                std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {relative}: {e}"));
            for (n, line) in production_lines(&source) {
                assert!(
                    !line.contains(needle),
                    "{relative}:{n} constructs the host bootstrap authority; only seeding may \
                     mint a token with no approving human",
                );
            }
        }
    }
}
