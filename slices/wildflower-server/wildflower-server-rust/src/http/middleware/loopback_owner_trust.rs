//! Desktop loopback-owner trust: the middleware that presents the host's owner
//! `Authorization: Bearer` header on behalf of a direct-local caller, so the
//! webview (which holds no credential of its own) authenticates on connection
//! provenance.

use std::net::SocketAddr;

use gatekeeper_rust::{ensure_bearer_header, is_pre_auth_public_path};

use crate::http::listener_identity::ListenerIdentity;

/// Desktop loopback-owner trust: presents the host's owner `Authorization:
/// Bearer` header on behalf of a direct-local caller. Holds a `watch::Receiver`
/// for the minted host owner token; each request reads the current token off
/// the channel and builds the header inline. The token only changes when
/// `setup_gatekeeper` re-mints, and loopback owner traffic is low-volume, so
/// rebuilding the short header string per request is negligible — not worth
/// caching behind a lock.
#[derive(Clone)]
pub(crate) struct LoopbackOwnerTrust {
    /// The channel `setup_gatekeeper` publishes the minted host owner token on.
    pub(crate) token_rx: tokio::sync::watch::Receiver<Option<String>>,
}

/// Present the host's own owner token on behalf of a **direct-local** request —
/// one that arrived on the local listener (never the tunnel listener) from a
/// loopback socket peer AND without a `Forwarded` header (a caller relayed by a
/// front carries one). The desktop webview holds no credential of its own, so
/// it authenticates on *connection provenance*: the server attaches the host's
/// owner bearer, and the gatekeeper gate and emr's own JWKS bearer check both
/// validate it normally — no slice-side special-casing.
///
/// SECURITY: this trusts *every* direct-loopback caller as owner, not only the
/// webview — any local process on the machine reaches the same surface. That is
/// the desktop single-user trust model (a local process running as the user can
/// already read the app's data on disk). It stays gated on the local listener
/// and on `!forwarded` so it never extends to a tunnel connection (handed over
/// in process, so its peer reads as loopback) or a front-relayed caller, and
/// skips gatekeeper's pre-auth public surface ([`is_pre_auth_public_path`])
/// where a stray owner bearer could confuse client authentication. A request
/// that already presents its own bearer is left untouched (via the shared
/// [`ensure_bearer_header`]).
/// Applied inside the loopback-peer gate, so a non-loopback peer is already
/// rejected before this runs.
pub(crate) async fn inject_loopback_owner_token(
    axum::extract::State(trust): axum::extract::State<LoopbackOwnerTrust>,
    listener_identity: Option<axum::Extension<ListenerIdentity>>,
    connect_info: Option<axum::Extension<axum::extract::ConnectInfo<SocketAddr>>>,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let listener_identity =
        listener_identity.map(|axum::Extension(listener_identity)| listener_identity);
    let peer_is_loopback = connect_info
        .is_some_and(|axum::Extension(axum::extract::ConnectInfo(addr))| addr.ip().is_loopback());
    let forwarded = shared_structures_rust::served_origin::is_forwarded(req.headers());
    let is_public_surface = is_pre_auth_public_path(req.uri().path());

    if should_present_owner_token(
        listener_identity,
        peer_is_loopback,
        forwarded,
        is_public_surface,
    ) {
        if let Some(bearer) = current_owner_bearer(&trust) {
            ensure_bearer_header(req.headers_mut(), &bearer);
        }
    }
    next.run(req).await
}

/// The stamp gate: present the owner bearer only for a **direct-local**,
/// non-forwarded request on the local listener that isn't on the pre-auth
/// public surface. A missing `listener_identity` is not local. Pulled out as a
/// pure conjunction so the security-critical rule is unit-tested — e.g. an
/// inverted `forwarded` check, or a tunnel connection let through on its
/// loopback peer, fails the test rather than shipping silently.
fn should_present_owner_token(
    listener_identity: Option<ListenerIdentity>,
    peer_is_loopback: bool,
    forwarded: bool,
    is_public_surface: bool,
) -> bool {
    listener_identity == Some(ListenerIdentity::Local)
        && peer_is_loopback
        && !forwarded
        && !is_public_surface
}

/// The current owner `Authorization: Bearer` header, built from the latest
/// token on the watch channel. `None` before the host mints a token (or on the
/// impossible header-parse failure). `borrow()` takes `&self` and needs no lock,
/// so concurrent loopback requests read the shared receiver freely.
fn current_owner_bearer(trust: &LoopbackOwnerTrust) -> Option<axum::http::HeaderValue> {
    let token = trust.token_rx.borrow().clone();
    token.and_then(|t| axum::http::HeaderValue::from_str(&format!("Bearer {t}")).ok())
}

#[cfg(test)]
mod tests {
    use super::should_present_owner_token;
    use crate::http::listener_identity::ListenerIdentity;

    const LOCAL: Option<ListenerIdentity> = Some(ListenerIdentity::Local);

    /// The owner bearer is stamped only for a direct-local, non-forwarded request
    /// on the local listener off the pre-auth public surface. Each guard,
    /// flipped alone, must withhold the stamp — most critically a tunnel
    /// connection (a loopback peer with no `Forwarded` of its own) and an
    /// inverted `forwarded` check must NOT extend owner trust to a remote caller.
    #[test]
    fn owner_token_presented_only_for_direct_local_private_requests() {
        // The one case that stamps: local listener, loopback peer, not
        // forwarded, not public.
        assert!(should_present_owner_token(LOCAL, true, false, false));
        // The tunnel listener → never, whatever the peer and headers say.
        for client_address in [None, Some("192.0.2.1:4711".parse().unwrap())] {
            assert!(!should_present_owner_token(
                Some(ListenerIdentity::Tunnel { client_address }),
                true,
                false,
                false
            ));
        }
        // No listener identity (never came through `serve`) → never.
        assert!(!should_present_owner_token(None, true, false, false));
        // Not a loopback peer → never (the loopback-peer gate rejects it anyway).
        assert!(!should_present_owner_token(LOCAL, false, false, false));
        // Forwarded (relayed by a front) → never, even from a loopback proxy peer.
        assert!(!should_present_owner_token(LOCAL, true, true, false));
        // Pre-auth public surface (`/oauth`, `/.well-known`) → never.
        assert!(!should_present_owner_token(LOCAL, true, false, true));
    }
}
