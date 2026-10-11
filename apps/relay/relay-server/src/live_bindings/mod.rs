//! The capability bindings — where the generic, store-agnostic capabilities
//! in `crate::domain::capabilities` meet the concrete
//! [`SqliteTunnelStore`](crate::db::SqliteTunnelStore) adapter and the
//! `Arc<TunnelRegistry>` router state (in [`state`]). Each binding lives in
//! its own file and lifts what its capability needs out of the state. The
//! ones that change tunnels also keep the registry, through which they serve
//! the change (rathole's services, the served tunnels);
//! those side effects stay here, out of `domain/`. Store calls block on
//! SQLite, so the bindings run them on blocking threads.
//!
//! [`LiveClaimCodesRedeemer`] is the one binding not built through `Admin<…>`:
//! it serves the unauthenticated `POST /claim`, which builds it once from the
//! registry.
//!
//! The admin handlers name the `Live…` bindings in `Admin<…>`, the
//! extractor that builds one only for a request signed with the admin key
//! — the relay's stand-in for scope-capabilities-rust's `Scoped<…>`, which
//! gates on OAuth scopes and answers `403` with a JSON body, where the relay
//! gates on the signer and answers a bare `401`.

mod admin;
mod claim_codes_issuer;
mod claim_codes_redeemer;
pub mod state;
mod tunnels_creator;
mod tunnels_deleter;
mod tunnels_reader;

pub(crate) use admin::{Admin, AdminCapability};
pub(crate) use claim_codes_issuer::LiveClaimCodesIssuer;
pub(crate) use claim_codes_redeemer::LiveClaimCodesRedeemer;
pub(crate) use tunnels_creator::LiveTunnelsCreator;
pub(crate) use tunnels_deleter::LiveTunnelsDeleter;
pub(crate) use tunnels_reader::LiveTunnelsReader;

use crate::domain::TunnelError;

/// Run `op` on a blocking thread: SQLite blocks while it reads, writes and
/// syncs the file.
async fn on_blocking<T: Send + 'static>(
    op: impl FnOnce() -> Result<T, TunnelError> + Send + 'static,
) -> Result<T, TunnelError> {
    tokio::task::spawn_blocking(op)
        .await
        .map_err(|e| TunnelError::infrastructure("a tunnel store task panicked", e))?
}
