//! The relay's own HTTPS site, served on its local hostnames.
//!
//! The front hands a connection here when the ClientHello names one of the
//! relay's local hostnames (see [`crate::route::Destination::Local`]),
//! together with the hello bytes it has already read. The site terminates
//! TLS in-process with a certificate from its cert resolver, then serves its
//! axum router over HTTP/1.1. In production the resolver is rustls-acme's,
//! so the same `:443` routing also carries Let's Encrypt's TLS-ALPN-01
//! validation handshakes (ALPN `acme-tls/1`), which the site closes as soon
//! as the handshake completes.
//!
//! - `routes`: the axum router.
//! - `acme`: ordering and renewing the certificate.
//! - `signature`: verifying signed requests (RFC 9421).

pub mod acme;
mod routes;
pub mod signature;

use std::sync::Arc;
use std::time::Duration;

use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use rathole_settings_rust::PublicRatholeSettings;
use rustls::server::ResolvesServerCert;
use rustls::ServerConfig;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::broadcast;
use tokio_rustls::TlsAcceptor;

use self::signature::Verifier;

/// The ALPN protocol of a TLS-ALPN-01 validation handshake (RFC 8737).
const ACME_TLS_ALPN: &[u8] = b"acme-tls/1";

/// TLS and HTTP for the relay's local hostnames.
pub struct Site {
    tls: TlsAcceptor,
    router: axum::Router,
}

impl std::fmt::Debug for Site {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Site").finish_non_exhaustive()
    }
}

impl Site {
    /// A site whose certificates come from `cert_resolver`, normally
    /// the resolver of [`acme::state`], serving `rathole_settings` at
    /// `GET /rathole` and checking signed requests with `verifier`.
    ///
    /// # Panics
    ///
    /// If the `ring` provider supports none of rustls's safe default
    /// protocol versions, which it always does.
    #[must_use]
    pub fn new(
        cert_resolver: Arc<dyn ResolvesServerCert>,
        rathole_settings: PublicRatholeSettings,
        verifier: Verifier,
    ) -> Self {
        let mut config =
            ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("ring supports the default protocol versions")
                .with_no_client_auth()
                .with_cert_resolver(cert_resolver);
        // rustls picks the first of these the client offers, so a client
        // offering both gets HTTP/1.1. Validators offer `acme-tls/1` alone.
        config.alpn_protocols = vec![b"http/1.1".to_vec(), ACME_TLS_ALPN.to_vec()];
        Self {
            tls: TlsAcceptor::from(Arc::new(config)),
            router: routes::router(rathole_settings, verifier),
        }
    }

    /// Complete the TLS handshake on `stream` within `handshake_timeout`, then
    /// serve HTTP on it until the client is done or the relay shuts down. A
    /// TLS-ALPN-01 validation handshake is closed as soon as it completes.
    /// Failures are logged and close the connection.
    pub async fn serve<S>(
        &self,
        stream: S,
        handshake_timeout: Duration,
        mut shutdown_rx: broadcast::Receiver<bool>,
    ) where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let mut tls = match tokio::time::timeout(handshake_timeout, self.tls.accept(stream)).await {
            Ok(Ok(tls)) => tls,
            Ok(Err(e)) => {
                tracing::debug!("site: TLS handshake failed: {e}");
                return;
            }
            Err(_) => {
                tracing::debug!("site: no TLS handshake within the deadline");
                return;
            }
        };
        if tls.get_ref().1.alpn_protocol() == Some(ACME_TLS_ALPN) {
            tracing::info!("site: answered a TLS-ALPN-01 validation");
            let _ = tls.shutdown().await;
            return;
        }

        // The timer enables hyper's header read timeout (30 s by default),
        // which also closes a keep-alive connection left idle that long.
        let connection = hyper::server::conn::http1::Builder::new()
            .timer(TokioTimer::new())
            .serve_connection(
                TokioIo::new(tls),
                TowerToHyperService::new(self.router.clone()),
            );
        tokio::select! {
            result = connection => {
                if let Err(e) = result {
                    tracing::debug!("site: connection ended: {e}");
                }
            }
            _ = shutdown_rx.recv() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use rathole_settings_rust::{NoisePattern, Transport};
    use rustls::pki_types::ServerName;
    use rustls::{ClientConfig, RootCertStore};
    use tokio_rustls::TlsConnector;

    use super::*;
    use crate::settings::AcmeSettings;

    /// Before rustls-acme has deployed a certificate, the site has none to
    /// offer, so a handshake fails rather than presenting anything else.
    #[tokio::test]
    async fn handshake_fails_until_acme_deploys_a_certificate() {
        let state_dir = tempfile::tempdir().expect("tempdir");
        let acme = acme::state(
            &["relay.example.com".to_owned()],
            &AcmeSettings {
                staging: true,
                contact: None,
            },
            state_dir.path(),
        );
        let site = Site::new(
            acme.resolver(),
            PublicRatholeSettings {
                remote_addr: "relay.example.com:2333".to_owned(),
                transport: Transport::Noise,
                noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
                public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
                domain: "relay.example.com".to_owned(),
            },
            Verifier::new(&[], None),
        );
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (_shutdown_tx, shutdown_rx) = broadcast::channel(1);
        let served = tokio::spawn(async move {
            site.serve(server_io, Duration::from_secs(5), shutdown_rx)
                .await;
        });

        let config =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("protocol versions")
                .with_root_certificates(RootCertStore::empty())
                .with_no_client_auth();
        let name = ServerName::try_from("relay.example.com").expect("dns name");
        let handshake = TlsConnector::from(Arc::new(config))
            .connect(name, client_io)
            .await;
        assert!(handshake.is_err(), "no certificate yet, no handshake");
        served.await.expect("site task");
    }
}
