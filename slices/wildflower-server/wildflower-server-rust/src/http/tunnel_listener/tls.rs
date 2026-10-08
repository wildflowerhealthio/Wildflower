//! The tunnel listener's TLS: each visitor's connection is a TLS connection
//! to the server's domain, which the relay passes through by its SNI
//! without terminating it. The certificate is the device's own (see
//! `live_bindings::device_certificate`), and the CA's TLS-ALPN-01 validation
//! handshakes (ALPN `acme-tls/1`, RFC 8737) arrive the same way and are
//! answered here.

use std::sync::Arc;

use anyhow::Context;
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls::ServerConfig;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;

/// The ALPN protocol of a TLS-ALPN-01 validation handshake (RFC 8737).
const ACME_TLS_ALPN: &[u8] = b"acme-tls/1";

/// The TLS the tunnel listener accepts: the server's certificate, for its
/// domain only.
#[derive(Clone)]
pub(crate) struct TunnelTls {
    acceptor: TlsAcceptor,
}

impl TunnelTls {
    /// TLS for connections naming `public_host` in their SNI, with the
    /// certificates `certificate_resolver` serves: rustls-acme's in
    /// production, which also serves the CA's validation certificate.
    ///
    /// # Panics
    ///
    /// If the `ring` provider supports none of rustls's safe default protocol
    /// versions, which it always does.
    pub(crate) fn new(
        public_host: &str,
        certificate_resolver: Arc<dyn ResolvesServerCert>,
    ) -> Self {
        let mut config =
            ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("ring supports the default protocol versions")
                .with_no_client_auth()
                .with_cert_resolver(Arc::new(PublicHostResolver {
                    public_host: public_host.to_ascii_lowercase(),
                    certificate_resolver,
                }));
        // rustls picks the first of these the client offers, so a client
        // offering both gets HTTP/1.1. Validators offer `acme-tls/1` alone.
        config.alpn_protocols = vec![b"http/1.1".to_vec(), ACME_TLS_ALPN.to_vec()];
        Self {
            acceptor: TlsAcceptor::from(Arc::new(config)),
        }
    }

    /// Complete the TLS handshake on `stream`. Returns the TLS stream for
    /// HTTP, or `None` for a validation handshake, which is closed as soon as
    /// it completes.
    ///
    /// # Errors
    ///
    /// Returns an error if the handshake fails: the client named another host
    /// or none (see [`PublicHostResolver`]), no certificate is deployed yet, or
    /// the client isn't speaking TLS.
    ///
    /// Nothing here bounds how long the client takes; the caller runs it under
    /// a timeout.
    pub(super) async fn accept<S: AsyncRead + AsyncWrite + Unpin>(
        &self,
        stream: S,
    ) -> anyhow::Result<Option<TlsStream<S>>> {
        let mut tls_stream = self
            .acceptor
            .accept(stream)
            .await
            .context("TLS handshake failed")?;
        if tls_stream.get_ref().1.alpn_protocol() == Some(ACME_TLS_ALPN) {
            tracing::info!("certificate: answered a TLS-ALPN-01 validation");
            // The validator has what it came for; a failed close is its own.
            let _ = tls_stream.shutdown().await;
            return Ok(None);
        }
        Ok(Some(tls_stream))
    }
}

/// A certificate resolver that answers only a ClientHello naming the server's
/// domain in its SNI, and leaves the rest to `certificate_resolver`. Any other
/// name, or none, gets no certificate, so the handshake fails before the
/// client sees one.
///
/// # Remarks
///
/// The relay routes by SNI, so through it every connection names the domain.
/// A relay that doesn't (a plain rathole server) could hand over a
/// connection for any name; this keeps the certificate to its own. The
/// tunnel front then holds the request's `Host` to the same domain, so SNI
/// and `Host` agree.
#[derive(Debug)]
struct PublicHostResolver {
    /// The server's domain, lowercase.
    public_host: String,
    /// What answers a ClientHello that names it.
    certificate_resolver: Arc<dyn ResolvesServerCert>,
}

impl ResolvesServerCert for PublicHostResolver {
    fn resolve(&self, client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let names_public_host = client_hello
            .server_name()
            .is_some_and(|server_name| server_name.eq_ignore_ascii_case(&self.public_host));
        if !names_public_host {
            tracing::debug!(
                server_name = client_hello.server_name(),
                "refused a TLS handshake for another host"
            );
            return None;
        }
        self.certificate_resolver.resolve(client_hello)
    }
}

#[cfg(test)]
pub(in crate::http) mod tests {
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
    use rustls::sign::SingleCertAndKey;
    use rustls::{ClientConfig, RootCertStore};
    use tokio::io::{AsyncReadExt, DuplexStream};
    use tokio_rustls::client;
    use tokio_rustls::TlsConnector;

    use super::*;

    /// The server's domain in these tests.
    pub(in crate::http) const PUBLIC_HOST: &str = "dev1.relay.test";

    /// A self-signed certificate for `domain` and a resolver serving it, as a
    /// deployed certificate would be served.
    pub(in crate::http) fn self_signed(
        domain: &str,
    ) -> (CertificateDer<'static>, Arc<dyn ResolvesServerCert>) {
        let key_pair =
            rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).expect("key pair");
        let certificate = rcgen::CertificateParams::new(vec![domain.to_owned()])
            .expect("params")
            .self_signed(&key_pair)
            .expect("self-signed");
        let private_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_pair.serialize_der()));
        let signing_key =
            rustls::crypto::ring::sign::any_ecdsa_type(&private_key).expect("an ECDSA key");
        let certified_key = CertifiedKey::new(vec![certificate.der().clone()], signing_key);
        (
            certificate.der().clone(),
            Arc::new(SingleCertAndKey::from(certified_key)),
        )
    }

    /// The tunnel listener's TLS for [`PUBLIC_HOST`] with a self-signed
    /// certificate, and that certificate for the client to trust.
    pub(in crate::http) fn tunnel_tls() -> (TunnelTls, CertificateDer<'static>) {
        let (certificate, certificate_resolver) = self_signed(PUBLIC_HOST);
        (
            TunnelTls::new(PUBLIC_HOST, certificate_resolver),
            certificate,
        )
    }

    /// A client trusting `certificate`, offering `alpn_protocols`.
    fn connector(certificate: &CertificateDer<'static>, alpn_protocols: &[&[u8]]) -> TlsConnector {
        let mut roots = RootCertStore::empty();
        roots.add(certificate.clone()).expect("a root");
        let mut config =
            ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("protocol versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
        config.alpn_protocols = alpn_protocols
            .iter()
            .map(|protocol| protocol.to_vec())
            .collect();
        TlsConnector::from(Arc::new(config))
    }

    /// A TLS client handshake over `visitor`, trusting `certificate`, naming
    /// `server_name` and offering HTTP/1.1.
    pub(in crate::http) async fn connect(
        visitor: DuplexStream,
        certificate: &CertificateDer<'static>,
        server_name: &str,
    ) -> std::io::Result<client::TlsStream<DuplexStream>> {
        connector(certificate, &[b"http/1.1"])
            .connect(
                ServerName::try_from(server_name.to_owned()).expect("a DNS name"),
                visitor,
            )
            .await
    }

    #[tokio::test]
    async fn a_handshake_for_the_public_host_is_accepted_for_http() {
        let (tunnel_tls, certificate) = tunnel_tls();
        let (visitor, server_end) = tokio::io::duplex(64 * 1024);

        let (client, accepted) = tokio::join!(
            connect(visitor, &certificate, PUBLIC_HOST),
            tunnel_tls.accept(server_end)
        );

        let mut client = client.expect("the client trusts the certificate");
        let mut accepted = accepted.expect("accepted").expect("for HTTP");
        assert_eq!(accepted.get_ref().1.alpn_protocol(), Some(&b"http/1.1"[..]));
        client.write_all(b"GET").await.expect("write");
        let mut request_start = [0; 3];
        accepted.read_exact(&mut request_start).await.expect("read");
        assert_eq!(&request_start, b"GET");
    }

    /// SNI is compared without regard to case, as DNS names are.
    #[tokio::test]
    async fn the_public_host_matches_in_any_case() {
        let (tunnel_tls, certificate) = tunnel_tls();
        let (visitor, server_end) = tokio::io::duplex(64 * 1024);
        let uppercase_public_host = PUBLIC_HOST.to_ascii_uppercase();

        let (client, accepted) = tokio::join!(
            connect(visitor, &certificate, &uppercase_public_host),
            tunnel_tls.accept(server_end)
        );

        client.expect("the handshake completes");
        assert!(accepted.expect("accepted").is_some());
    }

    /// A ClientHello naming another host gets no certificate, even one the
    /// resolver behind holds for that host.
    #[tokio::test]
    async fn a_handshake_for_another_host_fails() {
        let (other_certificate, other_resolver) = self_signed("other.relay.test");
        let tunnel_tls = TunnelTls::new(PUBLIC_HOST, other_resolver);
        let (visitor, server_end) = tokio::io::duplex(64 * 1024);

        let (client, accepted) = tokio::join!(
            connect(visitor, &other_certificate, "other.relay.test"),
            tunnel_tls.accept(server_end)
        );

        assert!(client.is_err());
        assert!(accepted.is_err());
    }

    /// Before a certificate is deployed, there is none to offer, so the
    /// handshake fails rather than presenting anything else.
    #[tokio::test]
    async fn a_handshake_fails_until_a_certificate_is_deployed() {
        #[derive(Debug)]
        struct NoCertificate;
        impl ResolvesServerCert for NoCertificate {
            fn resolve(&self, _client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
                None
            }
        }
        let (_, certificate) = tunnel_tls();
        let tunnel_tls = TunnelTls::new(PUBLIC_HOST, Arc::new(NoCertificate));
        let (visitor, server_end) = tokio::io::duplex(64 * 1024);

        let (client, accepted) = tokio::join!(
            connect(visitor, &certificate, PUBLIC_HOST),
            tunnel_tls.accept(server_end)
        );

        assert!(client.is_err());
        assert!(accepted.is_err());
    }

    /// A validation handshake, offering `acme-tls/1` alone, is answered and
    /// closed, never handed to HTTP.
    #[tokio::test]
    async fn a_validation_handshake_is_answered_and_closed() {
        let (tunnel_tls, certificate) = tunnel_tls();
        let (visitor, server_end) = tokio::io::duplex(64 * 1024);

        let (client, accepted) = tokio::join!(
            connector(&certificate, &[ACME_TLS_ALPN]).connect(
                ServerName::try_from(PUBLIC_HOST).expect("a DNS name"),
                visitor
            ),
            tunnel_tls.accept(server_end)
        );

        let mut client = client.expect("the validation handshake completes");
        assert_eq!(client.get_ref().1.alpn_protocol(), Some(ACME_TLS_ALPN));
        assert!(accepted.expect("accepted").is_none(), "not for HTTP");
        let mut unread = Vec::new();
        assert_eq!(
            client
                .read_to_end(&mut unread)
                .await
                .expect("a clean close"),
            0,
            "the server closes it"
        );
    }
}
