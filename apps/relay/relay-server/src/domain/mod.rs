//! Pure relay tunnel domain — no diesel, axum, rusqlite or rathole coupling.
//!
//! [`Tunnel`] is a device's tunnel name and token, and [`StoredTunnel`] one
//! created through the admin API, as the [`TunnelStore`] persistence *port*
//! keeps it (the `SQLite` adapter lives in [`crate::db`]). The stored tunnels
//! are the ones the relay serves. [`TunnelError`] is the failure vocabulary
//! the admin API renders. The `capabilities` decide a read, create or delete
//! and drive the store through the port, so they run against an in-memory
//! fake in tests. [`names`] draws the default name of a tunnel created
//! without one.
//!
//! A [`ClaimCode`] is a short, single-use code that redeems once for a
//! tunnel's name and token. The [`ClaimCodeStore`] port keeps each as a
//! [`StoredClaimCode`], by its [`ClaimCodeHash`]; the admin sees it once, as
//! an [`IssuedClaimCode`].

pub(crate) mod capabilities;
mod claim_code;
mod claim_code_store;
mod issued_claim_code;
pub mod names;
mod stored_claim_code;
mod stored_tunnel;
mod tunnel;
mod tunnel_error;
mod tunnel_store;
// The in-memory `FakeTunnelStore` the capability tests drive, plus the
// `stored_tunnel` builder the `db` and registry tests seed from too. At the
// domain root (not under `capabilities`) since it's reused above that layer
// — the apps-rust `domain::test_fake` placement.
#[cfg(test)]
pub(crate) mod test_fake;

pub use claim_code::{ClaimCode, ClaimCodeHash};
pub use claim_code_store::ClaimCodeStore;
pub use issued_claim_code::IssuedClaimCode;
pub use stored_claim_code::StoredClaimCode;
pub use stored_tunnel::StoredTunnel;
pub use tunnel::Tunnel;
pub use tunnel_error::TunnelError;
pub use tunnel_store::TunnelStore;
