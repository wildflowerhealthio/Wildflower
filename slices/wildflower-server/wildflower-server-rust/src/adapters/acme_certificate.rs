//! The server's device-held certificate for its public host, from an ACME CA
//! over TLS-ALPN-01, cached in the folders its [`DeviceCertificateConfig`]
//! names.
//!
//! rustls-acme does the work. [`acme_config`] configures it: the server's
//! domain as the certificate's one name, the CA's directory, no contact, the
//! install's ACME account (one per CA, shared by every server) and the
//! server's own certificate cache. [`DeviceCertificate::start`] creates the
//! cache folders and orders and renews the certificate for as long as the
//! server runs:
//!
//! ```text
//!   start ─ cached certificate for (domain, CA)?
//!     valid      ──► deployed            renew once a third of its life is left
//!     expired    ──► deployed, ordered at once
//!     none       ──► ordered (the account is created first if there's none)
//!
//!   order done   ──► deployed and cached; renew once a third is left
//!   order failed ──► retried with backoff, 1 s doubling up to ~18 h
//! ```
//!
//! The CA's validation handshakes reach the server like any visitor, through
//! the relay and the tunnel, and are answered by the tunnel listener's
//! [`TunnelTlsAcceptor`](crate::http::tunnel_listener::tls::TunnelTlsAcceptor)
//! with the certificate's resolver. Nothing renews a stopped server's
//! certificate: it lapses, and the next start orders again.

use std::io;
use std::path::Path;
use std::sync::Arc;

use anyhow::Context;
use futures_util::StreamExt;
use rustls_acme::caches::DirCache;
use rustls_acme::{AcmeConfig, AcmeState, ResolvesServerCertAcme};
use tokio_util::sync::CancellationToken;

use crate::DeviceCertificateConfig;

/// Create `key_dir`, a folder rustls-acme caches private keys in, readable by
/// this user only, and narrow an existing one to this user.
///
/// # Errors
///
/// Returns an error if the folder can't be created or its permissions set.
///
/// # Remarks
///
/// rustls-acme writes its files with the default permissions, so the folder
/// is what keeps the keys from other users on the device.
fn create_key_dir(key_dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(key_dir)?;
    #[cfg(unix)]
    std::fs::set_permissions(key_dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    Ok(())
}

/// The rustls-acme configuration for the server at `domain`: its certificate
/// is ordered from the CA at `config`'s directory, cached in its
/// `certificate_dir` and ordered with the install's account, cached in its
/// `acme_account_dir`.
///
/// # Remarks
///
/// Both caches key their files by the CA's directory as well, so the
/// staging and production CAs each have their own account and certificate.
/// The certificate's file is also keyed by `domain`, but each server has its
/// own `certificate_dir`, so deleting a server deletes its certificates and
/// not the account. No contact is given: the CA would use it only for
/// announcements.
fn acme_config(domain: &str, config: &DeviceCertificateConfig) -> AcmeConfig<io::Error> {
    AcmeConfig::new([domain])
        .directory(config.acme_directory_url.as_str())
        .cache_compose(
            DirCache::new(config.certificate_dir.clone()),
            DirCache::new(config.acme_account_dir.clone()),
        )
}

/// The running certificate: the resolver serving whatever it has deployed,
/// and the token that stops ordering and renewing when it's dropped.
pub(crate) struct DeviceCertificate {
    /// Serves the deployed certificate, and the CA's validation certificate
    /// while an order's challenge is pending.
    resolver: Arc<ResolvesServerCertAcme>,
    /// Stops the task ordering and renewing the certificate.
    cancel: CancellationToken,
}

impl DeviceCertificate {
    /// Start the certificate for `public_host` that `config` describes:
    /// create its key folders, readable by this user only, then deploy a
    /// cached certificate, order one when it is missing or expired, and renew
    /// it. Spawns onto the ambient tokio runtime, and runs until the
    /// `DeviceCertificate` is dropped.
    ///
    /// # Errors
    ///
    /// Returns an error if a key folder can't be created or narrowed to this
    /// user. A failed order isn't one: rustls-acme retries it.
    pub(crate) fn start(
        public_host: &str,
        config: &DeviceCertificateConfig,
    ) -> anyhow::Result<Self> {
        for key_dir in [&config.certificate_dir, &config.acme_account_dir] {
            create_key_dir(key_dir).with_context(|| {
                format!("failed to create the key folder {}", key_dir.display())
            })?;
        }
        let acme_state = acme_config(public_host, config).state();
        let resolver = acme_state.resolver();
        let cancel = CancellationToken::new();
        tokio::spawn(order_and_renew(acme_state, cancel.clone()));
        Ok(Self { resolver, cancel })
    }

    /// The resolver the tunnel listener's TLS serves certificates from.
    pub(crate) fn resolver(&self) -> Arc<ResolvesServerCertAcme> {
        Arc::clone(&self.resolver)
    }
}

impl Drop for DeviceCertificate {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Poll `acme_state` until `cancel`, logging each event: polling is what
/// makes rustls-acme deploy, order and renew the certificate. It retries a
/// failed order itself, with backoff; until a certificate is deployed, the
/// tunnel listener's handshakes fail.
async fn order_and_renew(mut acme_state: AcmeState<io::Error>, cancel: CancellationToken) {
    loop {
        let event = tokio::select! {
            event = acme_state.next() => event,
            () = cancel.cancelled() => return,
        };
        match event {
            Some(Ok(event)) => tracing::info!(?event, "certificate"),
            Some(Err(error)) => tracing::warn!("certificate: {error}"),
            // The state is an endless stream.
            None => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use rcgen::{CertificateParams, KeyPair};
    use rustls_acme::{CertCache, EventError, EventOk};
    use tempfile::TempDir;
    use url::Url;

    use super::*;

    /// The domain the certificates are for.
    const DOMAIN: &str = "dev1.relay.test";

    /// A CA directory nothing answers at, so an order fails at once instead of
    /// reaching a real CA.
    fn unreachable_acme_directory_url() -> Url {
        Url::parse("https://127.0.0.1:9/directory").expect("a URL")
    }

    /// A self-signed certificate for `domain`, valid until `not_after` (a
    /// year, month and day), in the form rustls-acme caches: the private key's
    /// PEM, then the certificate's. Returns the certificate's DER too.
    fn self_signed_cache_entry(
        domain: &str,
        not_after: (i32, u8, u8),
    ) -> (Vec<u8>, rustls::pki_types::CertificateDer<'static>) {
        let mut params = CertificateParams::new(vec![domain.to_owned()]).expect("params");
        params.not_before = rcgen::date_time_ymd(2020, 1, 1);
        params.not_after = rcgen::date_time_ymd(not_after.0, not_after.1, not_after.2);
        let key_pair = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).expect("key pair");
        let certificate = params.self_signed(&key_pair).expect("self-signed");
        let cache_entry = [key_pair.serialize_pem(), certificate.pem()]
            .concat()
            .into_bytes();
        (cache_entry, certificate.der().clone())
    }

    /// Put `cache_entry` in `certificate_dir` as the cached certificate for
    /// `domain` from the CA at `acme_directory_url`, as rustls-acme stores
    /// one.
    async fn cache_certificate(
        certificate_dir: &Path,
        domain: &str,
        acme_directory_url: &Url,
        cache_entry: &[u8],
    ) {
        DirCache::new(certificate_dir)
            .store_cert(
                &[domain.to_owned()],
                acme_directory_url.as_str(),
                cache_entry,
            )
            .await
            .expect("cache the certificate");
    }

    /// A data root's folders: the install's account and two servers'
    /// certificates.
    struct DataRoot {
        _root: TempDir,
        acme_account_dir: std::path::PathBuf,
        certificate_dir: std::path::PathBuf,
        other_certificate_dir: std::path::PathBuf,
    }

    fn data_root() -> DataRoot {
        let root = tempfile::tempdir().expect("data root");
        DataRoot {
            acme_account_dir: root.path().join("acme-account"),
            certificate_dir: root
                .path()
                .join("servers")
                .join(DOMAIN)
                .join("certificates"),
            other_certificate_dir: root
                .path()
                .join("servers")
                .join("other.relay.test")
                .join("certificates"),
            _root: root,
        }
    }

    impl DataRoot {
        /// The certificate config of the server whose certificates are cached
        /// in `certificate_dir`, ordering from `acme_directory_url` with the
        /// install's account.
        fn config(
            &self,
            certificate_dir: &Path,
            acme_directory_url: &Url,
        ) -> DeviceCertificateConfig {
            DeviceCertificateConfig {
                acme_directory_url: acme_directory_url.clone(),
                certificate_dir: certificate_dir.to_owned(),
                acme_account_dir: self.acme_account_dir.clone(),
            }
        }
    }

    /// The ACME state for [`DOMAIN`] over `data_root`, ordering from
    /// `acme_directory_url`.
    fn acme_state(data_root: &DataRoot, acme_directory_url: &Url) -> AcmeState<io::Error> {
        acme_config(
            DOMAIN,
            &data_root.config(&data_root.certificate_dir, acme_directory_url),
        )
        .state()
    }

    /// The next event, failing the test if none comes in time.
    async fn next_event(
        acme_state: &mut AcmeState<io::Error>,
    ) -> rustls_acme::Event<io::Error, io::Error> {
        tokio::time::timeout(Duration::from_secs(10), acme_state.next())
            .await
            .expect("an event in time")
            .expect("the state is endless")
    }

    fn file_names(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir).map_or_else(
            |_| Vec::new(),
            |entries| {
                entries
                    .map(|entry| {
                        entry
                            .expect("entry")
                            .file_name()
                            .to_string_lossy()
                            .into_owned()
                    })
                    .collect()
            },
        )
    }

    /// With nothing cached, the install's account is created in the account
    /// folder, never the server's, and a certificate is ordered at once.
    #[tokio::test]
    async fn with_nothing_cached_the_account_is_created_and_a_certificate_ordered() {
        let data_root = data_root();
        let mut acme_state = acme_state(&data_root, &unreachable_acme_directory_url());

        assert!(matches!(
            next_event(&mut acme_state).await,
            Ok(EventOk::AccountCacheStore)
        ));
        assert!(matches!(
            next_event(&mut acme_state).await,
            Err(EventError::Order(_))
        ));
        assert_eq!(file_names(&data_root.acme_account_dir).len(), 1);
        assert!(file_names(&data_root.certificate_dir).is_empty());
    }

    /// A valid cached certificate is deployed and served, and nothing is
    /// ordered: the next event waits for its renewal, years away.
    #[tokio::test]
    async fn a_valid_cached_certificate_is_deployed_without_an_order() {
        let data_root = data_root();
        let acme_directory_url = unreachable_acme_directory_url();
        let (cache_entry, _) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            &acme_directory_url,
            &cache_entry,
        )
        .await;
        let mut acme_state = acme_state(&data_root, &acme_directory_url);

        assert!(matches!(
            next_event(&mut acme_state).await,
            Ok(EventOk::DeployedCachedCert)
        ));
        let next = tokio::time::timeout(Duration::from_millis(500), acme_state.next()).await;
        assert!(next.is_err(), "no order is placed");
        assert!(file_names(&data_root.acme_account_dir).is_empty());
    }

    /// An expired cached certificate, as a stopped server leaves one, is
    /// re-ordered as soon as the server starts.
    #[tokio::test]
    async fn an_expired_cached_certificate_is_ordered_again_at_once() {
        let data_root = data_root();
        let acme_directory_url = unreachable_acme_directory_url();
        let (cache_entry, _) = self_signed_cache_entry(DOMAIN, (2021, 1, 1));
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            &acme_directory_url,
            &cache_entry,
        )
        .await;
        let mut acme_state = acme_state(&data_root, &acme_directory_url);

        assert!(matches!(
            next_event(&mut acme_state).await,
            Ok(EventOk::DeployedCachedCert)
        ));
        assert!(matches!(
            next_event(&mut acme_state).await,
            Ok(EventOk::AccountCacheStore)
        ));
        assert!(matches!(
            next_event(&mut acme_state).await,
            Err(EventError::Order(_))
        ));
    }

    /// A certificate is cached for its server's domain and CA: another
    /// server's folder, or the same server ordering from another CA, finds
    /// none, and the account is shared across servers.
    #[tokio::test]
    async fn the_certificate_cache_is_per_server_and_per_ca() {
        let data_root = data_root();
        let acme_directory_url = unreachable_acme_directory_url();
        let (cache_entry, _) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            &acme_directory_url,
            &cache_entry,
        )
        .await;

        let mut other_server = acme_config(
            "other.relay.test",
            &data_root.config(&data_root.other_certificate_dir, &acme_directory_url),
        )
        .state();
        assert!(matches!(
            next_event(&mut other_server).await,
            Ok(EventOk::AccountCacheStore)
        ));
        let other_ca = Url::parse("https://127.0.0.1:9/other-directory").expect("a URL");
        let mut same_server_other_ca = acme_state(&data_root, &other_ca);
        assert!(matches!(
            next_event(&mut same_server_other_ca).await,
            Ok(EventOk::AccountCacheStore)
        ));

        let mut same_server = acme_state(&data_root, &acme_directory_url);
        assert!(matches!(
            next_event(&mut same_server).await,
            Ok(EventOk::DeployedCachedCert)
        ));
        assert_eq!(
            file_names(&data_root.acme_account_dir).len(),
            2,
            "one account per CA, in the install's account folder"
        );
    }

    /// Starting creates the certificate's and the account's key folders,
    /// and narrows an existing one, to this user.
    #[cfg(unix)]
    #[tokio::test]
    async fn starting_makes_the_key_dirs_readable_by_this_user_only() {
        use std::os::unix::fs::PermissionsExt;
        let data_root = data_root();
        std::fs::create_dir_all(&data_root.acme_account_dir).unwrap();
        std::fs::set_permissions(
            &data_root.acme_account_dir,
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();

        let _device_certificate = DeviceCertificate::start(
            DOMAIN,
            &data_root.config(
                &data_root.certificate_dir,
                &unreachable_acme_directory_url(),
            ),
        )
        .expect("create the key folders");

        for key_dir in [&data_root.acme_account_dir, &data_root.certificate_dir] {
            let mode = std::fs::metadata(key_dir).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700, "{}", key_dir.display());
        }
    }

    /// Cancelling stops the task ordering and renewing, even while it waits
    /// for a renewal years away; dropping a [`DeviceCertificate`] cancels it.
    #[tokio::test]
    async fn cancelling_stops_ordering_and_renewing() {
        let data_root = data_root();
        let acme_directory_url = unreachable_acme_directory_url();
        let (cache_entry, _) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            &acme_directory_url,
            &cache_entry,
        )
        .await;
        let cancel = CancellationToken::new();
        let ordering_and_renewing = tokio::spawn(order_and_renew(
            acme_state(&data_root, &acme_directory_url),
            cancel.clone(),
        ));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !ordering_and_renewing.is_finished(),
            "the state is polled until cancelled"
        );

        cancel.cancel();

        tokio::time::timeout(Duration::from_secs(5), ordering_and_renewing)
            .await
            .expect("the task stops in time")
            .expect("the task doesn't panic");
        let device_certificate = DeviceCertificate::start(
            DOMAIN,
            &data_root.config(&data_root.certificate_dir, &acme_directory_url),
        )
        .expect("start the certificate");
        let device_certificate_cancel = device_certificate.cancel.clone();
        drop(device_certificate);
        assert!(device_certificate_cancel.is_cancelled());
    }
}
