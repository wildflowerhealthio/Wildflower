//! The site's certificate, from Let's Encrypt over TLS-ALPN-01.
//!
//! rustls-acme does the work. [`state`] configures it: the relay's local
//! hostnames as the certificate's names, the production or staging
//! directory, an optional account contact, and a cache under
//! `<state dir>/acme` keyed by those names and the directory. [`drive`] polls
//! it for as long as the relay runs: at startup it deploys a cached
//! certificate that is still valid or orders a new one, and from then on it
//! renews once a third of the lifetime is left. Its validation handshakes
//! arrive through the front like any other connection for a local hostname
//! and are answered by the [`super::Site`] with the state's resolver.

use std::io;
use std::path::Path;

use futures_util::StreamExt;
use rustls_acme::caches::DirCache;
use rustls_acme::{AcmeConfig, AcmeState};
use tokio::sync::broadcast;

use crate::settings::AcmeSettings;

/// The ACME state for `local_hostnames`, caching under `state_dir`. Nothing
/// happens until it is polled by [`drive`]; its
/// [`resolver`](AcmeState::resolver) serves whatever it has deployed.
#[must_use]
pub fn state(
    local_hostnames: &[String],
    settings: &AcmeSettings,
    state_dir: &Path,
) -> AcmeState<io::Error> {
    let config = AcmeConfig::new(local_hostnames)
        .contact(&settings.contact)
        .directory_lets_encrypt(!settings.staging)
        .cache(DirCache::new(state_dir.join("acme")));
    tracing::info!(
        hostnames = ?local_hostnames,
        staging = settings.staging,
        "ACME certificate configured"
    );
    config.state()
}

/// Poll `state` until shutdown, logging each event. Failures are logged and
/// retried by rustls-acme with backoff; until a certificate is deployed, TLS
/// handshakes for the site fail.
///
/// # Errors
///
/// Currently never; the `Result` keeps the signature in line with the other
/// relay tasks it is joined with.
pub async fn drive(
    mut state: AcmeState<io::Error>,
    mut shutdown_rx: broadcast::Receiver<bool>,
) -> anyhow::Result<()> {
    loop {
        let event = tokio::select! {
            event = state.next() => event,
            _ = shutdown_rx.recv() => return Ok(()),
        };
        match event {
            Some(Ok(ok)) => tracing::info!(event = ?ok, "ACME"),
            Some(Err(e)) => tracing::warn!("ACME: {e}"),
            // The state is an endless stream; this never happens.
            None => return Ok(()),
        }
    }
}
