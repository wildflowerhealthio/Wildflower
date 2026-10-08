//! The server's device-held certificate for its domain, from an ACME CA
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
//!
//! The run reports its certificate as it goes: [`order_and_renew`] reads each
//! of rustls-acme's events as a [`CertificateEvent`], adds it to what the run
//! has observed of its certificate ([`ObservedCertificate`]), and publishes
//! the [`CertificateState`] derived from that on the host's channel, and
//! again whenever the certificate's renewal falls due or it expires, checked
//! against the wall clock at least once a minute ([`LONGEST_STATUS_WAIT`]),
//! so a device waking from suspend catches up.
//! rustls-acme's events don't carry the certificate, so the run reads it from
//! the cache entry rustls-acme last loaded or stored ([`LastEntryCertCache`]).
//! Each newly deployed certificate is recorded in the server's
//! [certificate history](crate::adapters::certificate_history).
//! [`cached_certificate_state`] reads what the cache says instead, for any
//! server without a run's state.

use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use anyhow::Context;
use async_trait::async_trait;
use chrono::{DateTime, NaiveDateTime, Utc};
use futures_util::StreamExt;
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls_acme::acme::AcmeError;
use rustls_acme::caches::DirCache;
use rustls_acme::{
    AcmeConfig, AcmeState, CertCache, EventError, EventOk, OrderError, ResolvesServerCertAcme,
};
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::adapters::certificate_history::record_in_certificate_history;
use crate::domain::certificate_state::{CertificateEvent, ObservedCertificate};
use crate::{
    CertificateAuthority, CertificateHistoryEntry, CertificateOrderError, CertificateState,
    DeviceCertificateConfig, IssuedCertificate,
};

/// Create `dir`, readable by this user only, and narrow an existing one to
/// this user.
///
/// # Errors
///
/// Returns an error if the folder can't be created or its permissions set.
///
/// # Remarks
///
/// rustls-acme writes its keys with the default permissions, so the folder
/// is what keeps them from other users on the device.
fn create_owner_only_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    std::fs::set_permissions(dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
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
fn acme_config(
    domain: &str,
    config: &DeviceCertificateConfig,
    certificate_cache: LastEntryCertCache,
) -> AcmeConfig<io::Error> {
    AcmeConfig::new([domain])
        .directory(config.acme_directory_url.as_str())
        .cache_compose(
            certificate_cache,
            DirCache::new(config.acme_account_dir.clone()),
        )
}

/// The certificate the cache entry rustls-acme last loaded or stored holds,
/// or why that entry isn't one; `None` before it has loaded or stored one.
/// Only what [`parse_cache_entry`] reads is kept, never the entry's key.
type LastEntryCertificate = Arc<Mutex<Option<Result<IssuedCertificate, String>>>>;

/// The server's certificate cache, a [`DirCache`] over its
/// `certificate_dir`, keeping the certificate in the entry rustls-acme last
/// loaded or stored so the run can read the certificate an event is about.
struct LastEntryCertCache {
    dir_cache: DirCache<PathBuf>,
    last_entry_certificate: LastEntryCertificate,
}

impl LastEntryCertCache {
    fn new(certificate_dir: PathBuf) -> Self {
        Self {
            dir_cache: DirCache::new(certificate_dir),
            last_entry_certificate: Arc::default(),
        }
    }

    /// Keep the certificate `entry` holds, or why it holds none, and drop
    /// the entry, its private key included.
    fn keep(&self, entry: &[u8]) {
        let certificate = parse_cache_entry(entry)
            .map_err(|error| format!("the cache entry is unreadable: {error:#}"));
        *self
            .last_entry_certificate
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(certificate);
    }
}

#[async_trait]
impl CertCache for LastEntryCertCache {
    type EC = io::Error;

    async fn load_cert(
        &self,
        domains: &[String],
        directory_url: &str,
    ) -> Result<Option<Vec<u8>>, io::Error> {
        let entry = self.dir_cache.load_cert(domains, directory_url).await?;
        if let Some(entry) = &entry {
            self.keep(entry);
        }
        Ok(entry)
    }

    async fn store_cert(
        &self,
        domains: &[String],
        directory_url: &str,
        cert: &[u8],
    ) -> Result<(), io::Error> {
        self.keep(cert);
        self.dir_cache
            .store_cert(domains, directory_url, cert)
            .await
    }
}

/// The certificate a cache entry holds: its leaf's validity and fingerprint.
///
/// The entry is checked as rustls-acme 0.15's `AcmeState::parse_cert` checks
/// it before deploying it: its PEM sections, at least two, are the private
/// key, a PKCS #8 ECDSA key, then the certificate chain, leaf first. So an
/// entry rustls-acme won't deploy is never read as a certificate the run
/// holds.
///
/// # Errors
///
/// Returns an error if the entry isn't PEM, has fewer than two sections, its
/// key isn't an ECDSA key, or its leaf isn't X.509.
fn parse_cache_entry(cache_entry: &[u8]) -> anyhow::Result<IssuedCertificate> {
    let sections = pem::parse_many(cache_entry).context("the cache entry isn't PEM")?;
    let [key, leaf, ..] = &sections[..] else {
        anyhow::bail!(
            "the cache entry has {} PEM sections, not a key and a certificate chain",
            sections.len()
        );
    };
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.contents()));
    rustls::crypto::ring::sign::any_ecdsa_type(&key)
        .context("the cache entry's key isn't an ECDSA key")?;
    let leaf = leaf.contents();
    let (_, certificate) =
        x509_parser::parse_x509_certificate(leaf).context("the leaf isn't X.509")?;
    let validity = certificate.validity();
    let instant = |time: x509_parser::time::ASN1Time| {
        DateTime::from_timestamp(time.timestamp(), 0).context("the validity is out of range")
    };
    let fingerprint =
        Sha256::digest(leaf)
            .iter()
            .fold(String::with_capacity(64), |mut hex, byte| {
                let _ = write!(hex, "{byte:02x}");
                hex
            });
    Ok(IssuedCertificate {
        not_before: instant(validity.not_before)?,
        not_after: instant(validity.not_after)?,
        fingerprint,
    })
}

/// The certificate the cache in `config`'s `certificate_dir` holds for
/// `domain` from `config`'s CA; `None` when it holds none.
///
/// # Errors
///
/// Returns an error if the cache can't be read, or the entry it holds isn't a
/// certificate (see [`parse_cache_entry`]).
async fn cached_certificate(
    domain: &str,
    config: &DeviceCertificateConfig,
) -> anyhow::Result<Option<IssuedCertificate>> {
    let Some(entry) = DirCache::new(&config.certificate_dir)
        .load_cert(&[domain.to_owned()], config.acme_directory_url.as_str())
        .await
        .context("reading the certificate cache failed")?
    else {
        return Ok(None);
    };
    parse_cache_entry(&entry)
        .context("the cached certificate is unreadable")
        .map(Some)
}

/// What the cache of the server at `domain` that `config` describes says of
/// its certificate now (see [`CertificateState::of_cached`]): the state of
/// any server without a run's state. A cache that can't be read, or holds an
/// entry that isn't a certificate, is
/// [`CacheUnreadable`](crate::CertificateStatus::CacheUnreadable), with the
/// error.
pub async fn cached_certificate_state(
    domain: &str,
    config: &DeviceCertificateConfig,
) -> CertificateState {
    match cached_certificate(domain, config).await {
        Ok(cached) => CertificateState::of_cached(cached, config.certificate_authority, Utc::now()),
        Err(error) => CertificateState::of_unreadable_cache(
            config.certificate_authority,
            format!("{error:#}"),
        ),
    }
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
    /// Start the certificate for `domain` that `config` describes:
    /// create its key folders, readable by this user only, then deploy a
    /// cached certificate, order one when it is missing or expired, and renew
    /// it, publishing its state on `certificate_tx`. Spawns onto the ambient
    /// tokio runtime, and runs until the `DeviceCertificate` is dropped.
    ///
    /// # Errors
    ///
    /// Returns an error if a key folder can't be created or narrowed to this
    /// user. A failed order isn't one: rustls-acme retries it.
    pub(crate) fn start(
        domain: &str,
        config: &DeviceCertificateConfig,
        certificate_tx: watch::Sender<Option<CertificateState>>,
    ) -> anyhow::Result<Self> {
        for key_dir in [&config.certificate_dir, &config.acme_account_dir] {
            create_owner_only_dir(key_dir).with_context(|| {
                format!("failed to create the key folder {}", key_dir.display())
            })?;
        }
        let cancel = CancellationToken::new();
        let (resolver, task) = certificate_task(domain, config, certificate_tx, cancel.clone());
        tokio::spawn(task);
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

/// The resolver serving the certificate for `domain` that `config`
/// describes, and the task that deploys, orders and renews it until `cancel`,
/// publishing its state on `certificate_tx`: it reads the cached certificate
/// first, then polls rustls-acme ([`order_and_renew`]).
fn certificate_task(
    domain: &str,
    config: &DeviceCertificateConfig,
    certificate_tx: watch::Sender<Option<CertificateState>>,
    cancel: CancellationToken,
) -> (
    Arc<ResolvesServerCertAcme>,
    impl std::future::Future<Output = ()> + Send + 'static,
) {
    let certificate_cache = LastEntryCertCache::new(config.certificate_dir.clone());
    let reporter = CertificateReporter {
        issuer: config.certificate_authority,
        certificate_dir: config.certificate_dir.clone(),
        last_entry_certificate: Arc::clone(&certificate_cache.last_entry_certificate),
        certificate_tx,
    };
    let acme_state = acme_config(domain, config, certificate_cache).state();
    let resolver = acme_state.resolver();
    let domain = domain.to_owned();
    let config = config.clone();
    let task = async move {
        let observed = match cached_certificate(&domain, &config).await {
            Ok(cached) => ObservedCertificate::starting_with(cached),
            Err(error) => {
                ObservedCertificate::starting_with(None).after(CertificateEvent::CacheFailed {
                    message: format!("{error:#}"),
                })
            }
        };
        order_and_renew(acme_state, reporter, observed, cancel).await;
    };
    (resolver, task)
}

/// Where a run reports its certificate: the host's channel, and the
/// server's certificate history.
struct CertificateReporter {
    /// The CA the run orders from.
    issuer: CertificateAuthority,
    /// The server's `certificates/` folder, which holds its history.
    certificate_dir: PathBuf,
    /// The certificate in the entry the run's [`LastEntryCertCache`] last
    /// loaded or stored.
    last_entry_certificate: LastEntryCertificate,
    /// The host's channel for the run's [`CertificateState`].
    certificate_tx: watch::Sender<Option<CertificateState>>,
}

impl CertificateReporter {
    /// Publish the state `observed` derives now, unless it is the one
    /// published last.
    fn publish(&self, observed: &ObservedCertificate) {
        let state = observed.state(self.issuer, Utc::now());
        self.certificate_tx.send_if_modified(|published| {
            let changed = published.as_ref() != Some(&state);
            *published = Some(state);
            changed
        });
    }

    /// The certificate the cache entry rustls-acme last loaded or stored
    /// holds; `None` before it has loaded or stored one.
    ///
    /// # Errors
    ///
    /// Returns an error if that entry isn't a certificate.
    fn last_cached(&self) -> anyhow::Result<Option<IssuedCertificate>> {
        self.last_entry_certificate
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .transpose()
            .map_err(anyhow::Error::msg)
    }

    /// Record `issued` in the server's history, unless it records it
    /// already, as it does the cached certificate a run deploys at start.
    async fn record(&self, issued: &IssuedCertificate) {
        let entry = CertificateHistoryEntry::deployed(issued, self.issuer, Utc::now());
        let certificate_dir = self.certificate_dir.clone();
        let recorded = tokio::task::spawn_blocking(move || {
            record_in_certificate_history(&certificate_dir, entry)
        })
        .await;
        if let Err(error) = recorded
            .map_err(io::Error::other)
            .and_then(|recorded| recorded)
        {
            tracing::warn!("certificate: recording it in the history failed: {error}");
        }
    }
}

/// Poll `acme_state` until `cancel`, logging each event and reporting the
/// certificate through `reporter`, from what the run `observed` of its cache
/// at start: polling is what makes rustls-acme deploy, order and renew the
/// certificate. It retries a failed order itself, with backoff; until a
/// certificate is deployed, the tunnel listener's handshakes fail.
async fn order_and_renew(
    mut acme_state: AcmeState<io::Error>,
    reporter: CertificateReporter,
    mut observed: ObservedCertificate,
    cancel: CancellationToken,
) {
    reporter.publish(&observed);
    loop {
        let next_status_change = observed.next_status_change(Utc::now());
        let event = tokio::select! {
            event = acme_state.next() => event,
            () = wait_toward(next_status_change) => {
                // Published only if the wall clock says it changed.
                reporter.publish(&observed);
                continue;
            }
            () = cancel.cancelled() => return,
        };
        let Some(event) = event else {
            // The state is an endless stream.
            return;
        };
        match &event {
            Ok(event) => tracing::info!(?event, "certificate"),
            Err(error) => tracing::warn!("certificate: {error}"),
        }
        for certificate_event in certificate_events(&event, || reporter.last_cached()) {
            if let CertificateEvent::Deployed(issued) = &certificate_event {
                reporter.record(issued).await;
            }
            observed = observed.after(certificate_event);
        }
        reporter.publish(&observed);
    }
}

/// The longest a run waits before it derives its certificate's state again.
///
/// A wait is measured on the monotonic clock, which stops while the device is
/// suspended, but a status changes at a wall-clock instant: a run waiting the
/// whole way to a renewal could wake long after it. Each wait is cut to this,
/// and the state is derived again from the wall clock on each wake.
const LONGEST_STATUS_WAIT: Duration = Duration::from_secs(60);

/// Wait toward `instant`, the next status change: until it, or for
/// [`LONGEST_STATUS_WAIT`], whichever is sooner. Forever when there is none.
async fn wait_toward(instant: Option<DateTime<Utc>>) {
    match instant {
        Some(instant) => tokio::time::sleep(status_wait(instant, Utc::now())).await,
        None => std::future::pending().await,
    }
}

/// How long to wait at `now` toward the status change at `instant`: until
/// it, at most [`LONGEST_STATUS_WAIT`], and not at all once it has passed.
fn status_wait(instant: DateTime<Utc>, now: DateTime<Utc>) -> Duration {
    (instant - now)
        .to_std()
        .map_or(Duration::ZERO, |until| until.min(LONGEST_STATUS_WAIT))
}

/// What `event` says the run's certificate did, reading the certificate an
/// event deployed with `last_cached`: rustls-acme deploys a cached
/// certificate as it loads it, and a new one just before it stores it, so a
/// new one is read once its store is done, whether the store worked or not.
/// A certificate that can't be read is a cache failure.
fn certificate_events(
    event: &rustls_acme::Event<io::Error, io::Error>,
    last_cached: impl FnOnce() -> anyhow::Result<Option<IssuedCertificate>>,
) -> Vec<CertificateEvent> {
    let deployed = || match last_cached() {
        Ok(cached) => cached.map(CertificateEvent::Deployed),
        Err(error) => Some(CertificateEvent::CacheFailed {
            message: format!("{error:#}"),
        }),
    };
    match event {
        Ok(EventOk::DeployedCachedCert | EventOk::CertCacheStore) => {
            deployed().into_iter().collect()
        }
        Ok(EventOk::DeployedNewCert | EventOk::AccountCacheStore) => Vec::new(),
        Err(error @ EventError::CertCacheStore(_)) => deployed()
            .into_iter()
            .chain([CertificateEvent::CacheFailed {
                message: error.to_string(),
            }])
            .collect(),
        Err(
            error @ (EventError::CertCacheLoad(_)
            | EventError::AccountCacheLoad(_)
            | EventError::AccountCacheStore(_)),
        ) => vec![CertificateEvent::CacheFailed {
            message: error.to_string(),
        }],
        Err(error @ EventError::CachedCertParse(_)) => {
            vec![CertificateEvent::CachedCertificateUnusable {
                message: error.to_string(),
            }]
        }
        Err(error) => vec![CertificateEvent::OrderFailed(order_error(error))],
    }
}

/// `error` in terms the base can phrase.
fn order_error(error: &EventError<io::Error, io::Error>) -> CertificateOrderError {
    match error {
        EventError::Order(OrderError::Acme(error @ AcmeError::HttpRequest(_))) => {
            ca_request_error(&error.to_string())
        }
        EventError::Order(OrderError::BadAuth(auth)) => CertificateOrderError::ChallengeFailed {
            detail: auth
                .challenges
                .iter()
                .find_map(|challenge| challenge.error.as_ref()?.detail.clone()),
        },
        EventError::Order(OrderError::TooManyAttemptsAuth(_)) => {
            CertificateOrderError::ChallengeFailed { detail: None }
        }
        EventError::Order(OrderError::BadOrder(order)) => CertificateOrderError::Other {
            message: order
                .error
                .as_ref()
                .and_then(|problem| problem.detail.clone())
                .unwrap_or_else(|| error.to_string()),
        },
        _ => CertificateOrderError::Other {
            message: error.to_string(),
        },
    }
}

/// The ACME problem type the CA answers a request with when it is refused
/// under a rate limit.
const RATE_LIMITED_PROBLEM: &str = "urn:ietf:params:acme:error:rateLimited";

/// The prefix of every ACME problem type.
const ACME_PROBLEM_PREFIX: &str = "urn:ietf:params:acme:error:";

/// The error of a request to the CA's API that failed with `message`.
///
/// rustls-acme's request error type isn't public, so its message is all there
/// is to read: a refusal carries the CA's problem document, whose type says
/// whether it was a rate limit and whose detail, from Let's Encrypt, says
/// `retry after <YYYY-MM-DD HH:MM:SS> UTC`. A failure with no problem document
/// never reached the CA's ACME server.
fn ca_request_error(message: &str) -> CertificateOrderError {
    if message.contains(RATE_LIMITED_PROBLEM) {
        CertificateOrderError::RateLimited {
            retry_after: retry_after(message),
        }
    } else if message.contains(ACME_PROBLEM_PREFIX) {
        CertificateOrderError::Other {
            message: message.to_owned(),
        }
    } else {
        CertificateOrderError::CaUnreachable {
            message: message.to_owned(),
        }
    }
}

/// The instant a rate-limit refusal's `message` says to retry after, when it
/// says one in Let's Encrypt's form.
fn retry_after(message: &str) -> Option<DateTime<Utc>> {
    const MARKER: &str = "retry after ";
    const FORMAT_LENGTH: usize = "YYYY-MM-DD HH:MM:SS".len();
    let start = message.find(MARKER)? + MARKER.len();
    let timestamp = message.get(start..start + FORMAT_LENGTH)?;
    NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|instant| instant.and_utc())
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use rcgen::{CertificateParams, KeyPair};
    use tempfile::TempDir;
    use url::Url;

    use super::*;
    use crate::{read_certificate_history, CertificateStatus};

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
        self_signed_cache_entry_signed_with(domain, not_after, &rcgen::PKCS_ECDSA_P256_SHA256)
    }

    /// [`self_signed_cache_entry`], with a key of `algorithm`.
    fn self_signed_cache_entry_signed_with(
        domain: &str,
        not_after: (i32, u8, u8),
        algorithm: &'static rcgen::SignatureAlgorithm,
    ) -> (Vec<u8>, rustls::pki_types::CertificateDer<'static>) {
        let mut params = CertificateParams::new(vec![domain.to_owned()]).expect("params");
        params.not_before = rcgen::date_time_ymd(2020, 1, 1);
        params.not_after = rcgen::date_time_ymd(not_after.0, not_after.1, not_after.2);
        let key_pair = KeyPair::generate_for(algorithm).expect("key pair");
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
                certificate_authority: CertificateAuthority::LetsEncryptStaging,
                acme_directory_url: acme_directory_url.clone(),
                certificate_dir: certificate_dir.to_owned(),
                acme_account_dir: self.acme_account_dir.clone(),
            }
        }
    }

    /// The ACME state for [`DOMAIN`] over `data_root`, ordering from
    /// `acme_directory_url`.
    fn acme_state(data_root: &DataRoot, acme_directory_url: &Url) -> AcmeState<io::Error> {
        let config = data_root.config(&data_root.certificate_dir, acme_directory_url);
        acme_config(
            DOMAIN,
            &config,
            LastEntryCertCache::new(config.certificate_dir.clone()),
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

        let other_config = data_root.config(&data_root.other_certificate_dir, &acme_directory_url);
        let mut other_server = acme_config(
            "other.relay.test",
            &other_config,
            LastEntryCertCache::new(other_config.certificate_dir.clone()),
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
            watch::channel(None).0,
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
    async fn cancelling_stops_ordering_and_renewal() {
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
        let (_, task) = certificate_task(
            DOMAIN,
            &data_root.config(&data_root.certificate_dir, &acme_directory_url),
            watch::channel(None).0,
            cancel.clone(),
        );
        let order_and_renew_task = tokio::spawn(task);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !order_and_renew_task.is_finished(),
            "the state is polled until cancelled"
        );

        cancel.cancel();

        tokio::time::timeout(Duration::from_secs(5), order_and_renew_task)
            .await
            .expect("the task stops in time")
            .expect("the task doesn't panic");
        let device_certificate = DeviceCertificate::start(
            DOMAIN,
            &data_root.config(&data_root.certificate_dir, &acme_directory_url),
            watch::channel(None).0,
        )
        .expect("start the certificate");
        let dropped_certificate_cancel = device_certificate.cancel.clone();
        drop(device_certificate);
        assert!(dropped_certificate_cancel.is_cancelled());
    }

    /// The SHA-256 of `der`, in lowercase hex, computed apart from the code
    /// under test.
    fn sha256_hex(der: &[u8]) -> String {
        Sha256::digest(der)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /// A cache entry reads as its leaf's validity and fingerprint.
    #[test]
    fn a_cache_entry_reads_as_its_leaf_s_validity_and_fingerprint() {
        let (cache_entry, der) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        assert_eq!(
            parse_cache_entry(&cache_entry).expect("a certificate"),
            IssuedCertificate {
                not_before: Utc.with_ymd_and_hms(2020, 1, 1, 0, 0, 0).unwrap(),
                not_after: Utc.with_ymd_and_hms(2099, 1, 1, 0, 0, 0).unwrap(),
                fingerprint: sha256_hex(&der),
            }
        );
        assert!(parse_cache_entry(b"no PEM here").is_err());
    }

    /// Every entry rustls-acme refuses to deploy is refused here too: one
    /// with no key before its certificate, one whose key isn't ECDSA, and one
    /// that isn't PEM. Each is checked against rustls-acme itself.
    #[tokio::test]
    async fn an_entry_rustls_acme_cannot_use_is_not_a_certificate() {
        let (ecdsa_entry, _) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        let certificate_only = String::from_utf8(ecdsa_entry)
            .expect("PEM")
            .split_inclusive("-----END PRIVATE KEY-----\n")
            .nth(1)
            .expect("the certificate after the key")
            .to_owned()
            .into_bytes();
        let (ed25519_entry, _) =
            self_signed_cache_entry_signed_with(DOMAIN, (2099, 1, 1), &rcgen::PKCS_ED25519);
        let acme_directory_url = unreachable_acme_directory_url();
        for (name, entry) in [
            ("a certificate alone", certificate_only),
            ("an Ed25519 key", ed25519_entry),
            ("not PEM", b"no PEM here".to_vec()),
        ] {
            assert!(parse_cache_entry(&entry).is_err(), "{name}");

            let data_root = data_root();
            cache_certificate(
                &data_root.certificate_dir,
                DOMAIN,
                &acme_directory_url,
                &entry,
            )
            .await;
            let mut acme_state = acme_state(&data_root, &acme_directory_url);
            assert!(
                matches!(
                    next_event(&mut acme_state).await,
                    Err(EventError::CachedCertParse(_))
                ),
                "{name}"
            );
        }
    }

    /// A run whose cached certificate rustls-acme can't use starts without
    /// it, ordering, with the cache's error.
    #[tokio::test]
    async fn a_run_does_not_hold_a_cached_certificate_rustls_acme_cannot_use() {
        let data_root = data_root();
        let acme_directory_url = unreachable_acme_directory_url();
        let (ed25519_entry, _) =
            self_signed_cache_entry_signed_with(DOMAIN, (2099, 1, 1), &rcgen::PKCS_ED25519);
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            &acme_directory_url,
            &ed25519_entry,
        )
        .await;
        let config = data_root.config(&data_root.certificate_dir, &acme_directory_url);
        assert_eq!(
            cached_certificate_state(DOMAIN, &config).await.status,
            CertificateStatus::CacheUnreadable
        );

        let (certificate_tx, mut certificate_rx) = watch::channel(None);
        let cancel = CancellationToken::new();
        let (_, task) = certificate_task(DOMAIN, &config, certificate_tx, cancel.clone());
        let _task = tokio::spawn(task);
        let state = published(&mut certificate_rx, |_| true).await;
        cancel.cancel();
        assert_eq!(state.status, CertificateStatus::Ordering);
        assert_eq!(state.held, None);
    }

    /// rustls-acme refusing the cached certificate is a cache failure that
    /// drops it.
    #[test]
    fn a_cached_certificate_rustls_acme_refuses_is_unusable() {
        let (ed25519_entry, _) =
            self_signed_cache_entry_signed_with(DOMAIN, (2099, 1, 1), &rcgen::PKCS_ED25519);
        let refused = rustls_acme::CertParseError::InvalidPrivateKey;
        let events = certificate_events(&Err(EventError::CachedCertParse(refused)), || {
            parse_cache_entry(&ed25519_entry).map(Some)
        });
        assert!(
            matches!(
                &events[..],
                [CertificateEvent::CachedCertificateUnusable { .. }]
            ),
            "{events:?}"
        );
    }

    /// A lapsed cached certificate reads as `Expired`, never `OrderFailing`;
    /// nothing cached as `NotIssued`, and a valid one as `NoRenewalNeeded`.
    #[tokio::test]
    async fn the_cached_state_is_what_the_cache_says() {
        let data_root = data_root();
        let acme_directory_url = unreachable_acme_directory_url();
        let config = data_root.config(&data_root.certificate_dir, &acme_directory_url);
        let state = cached_certificate_state(DOMAIN, &config).await;
        assert_eq!(state.status, CertificateStatus::NotIssued);
        assert_eq!(state.issuer, CertificateAuthority::LetsEncryptStaging);

        let (lapsed, der) = self_signed_cache_entry(DOMAIN, (2021, 1, 1));
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            &acme_directory_url,
            &lapsed,
        )
        .await;
        let state = cached_certificate_state(DOMAIN, &config).await;
        assert_eq!(state.status, CertificateStatus::Expired);
        assert_eq!(state.last_error, None);
        assert_eq!(
            state.held.map(|issued| issued.fingerprint),
            Some(sha256_hex(&der))
        );

        let (valid, _) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            &acme_directory_url,
            &valid,
        )
        .await;
        let state = cached_certificate_state(DOMAIN, &config).await;
        assert_eq!(state.status, CertificateStatus::NoRenewalNeeded);
    }

    /// A cache entry that isn't a certificate makes the cache's state
    /// `CacheUnreadable`, with the error, and a run's start `Ordering` with
    /// the cache's error, never a certificate it doesn't hold.
    #[tokio::test]
    async fn an_unreadable_cache_entry_is_reported_not_dropped() {
        let data_root = data_root();
        let acme_directory_url = unreachable_acme_directory_url();
        let config = data_root.config(&data_root.certificate_dir, &acme_directory_url);
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            &acme_directory_url,
            b"no PEM here",
        )
        .await;

        let state = cached_certificate_state(DOMAIN, &config).await;
        assert_eq!(state.status, CertificateStatus::CacheUnreadable);
        assert!(
            matches!(
                &state.last_error,
                Some(CertificateOrderError::Cache { message })
                    if message.contains("the cached certificate is unreadable")
            ),
            "{state:?}"
        );

        let (certificate_tx, mut certificate_rx) = watch::channel(None);
        let cancel = CancellationToken::new();
        let (_, task) = certificate_task(DOMAIN, &config, certificate_tx, cancel.clone());
        let _task = tokio::spawn(task);
        let state = published(&mut certificate_rx, |_| true).await;
        cancel.cancel();
        assert_eq!(state.status, CertificateStatus::Ordering);
        assert_eq!(state.held, None);
        assert!(
            matches!(state.last_error, Some(CertificateOrderError::Cache { .. })),
            "{state:?}"
        );
    }

    /// The cache keeps the certificate an entry holds, or why it holds none,
    /// and never the entry's private key.
    #[tokio::test]
    async fn the_cache_keeps_the_certificate_not_the_key() {
        let data_root = data_root();
        let cache = LastEntryCertCache::new(data_root.certificate_dir.clone());
        let (cache_entry, der) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        let domains = [DOMAIN.to_owned()];
        let directory_url = unreachable_acme_directory_url();

        cache
            .store_cert(&domains, directory_url.as_str(), &cache_entry)
            .await
            .expect("stored");
        let kept = cache
            .last_entry_certificate
            .lock()
            .unwrap()
            .clone()
            .expect("an entry kept");
        assert_eq!(kept.map(|kept| kept.fingerprint), Ok(sha256_hex(&der)));

        cache
            .store_cert(&domains, directory_url.as_str(), b"no PEM here")
            .await
            .expect("stored");
        let kept = cache.last_entry_certificate.lock().unwrap().clone();
        assert!(
            matches!(&kept, Some(Err(reason)) if reason.contains("unreadable")),
            "{kept:?}"
        );
    }

    /// Wait until the history in `certificate_dir` has `length` entries,
    /// failing the test if it doesn't in time.
    async fn history_of_length(certificate_dir: &Path, length: usize) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while read_certificate_history(certificate_dir)
                .expect("the history")
                .len()
                != length
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the history in time");
    }

    /// Wait until the published state satisfies `predicate`.
    async fn published(
        certificate_rx: &mut watch::Receiver<Option<CertificateState>>,
        predicate: impl Fn(&CertificateState) -> bool,
    ) -> CertificateState {
        let state = tokio::time::timeout(
            Duration::from_secs(10),
            certificate_rx.wait_for(|state| state.as_ref().is_some_and(&predicate)),
        )
        .await
        .expect("the state in time")
        .expect("the run holds its sender");
        state.clone().expect("a state")
    }

    /// A run publishes its cached certificate as `NoRenewalNeeded`, and
    /// records it in the history once, however often the server starts.
    #[tokio::test]
    async fn a_run_publishes_its_cached_certificate_and_records_it_once() {
        let data_root = data_root();
        let acme_directory_url = unreachable_acme_directory_url();
        let (cache_entry, der) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            &acme_directory_url,
            &cache_entry,
        )
        .await;
        let config = data_root.config(&data_root.certificate_dir, &acme_directory_url);

        for start in 0..2 {
            let (certificate_tx, mut certificate_rx) = watch::channel(None);
            let cancel = CancellationToken::new();
            let (_, task) = certificate_task(DOMAIN, &config, certificate_tx, cancel.clone());
            let task = tokio::spawn(task);
            let state = published(&mut certificate_rx, |state| {
                state.status == CertificateStatus::NoRenewalNeeded
            })
            .await;
            assert_eq!(
                state.held.map(|issued| issued.fingerprint),
                Some(sha256_hex(&der))
            );
            if start == 0 {
                // The deploy event, which records it, follows the cache read.
                history_of_length(&data_root.certificate_dir, 1).await;
            }
            cancel.cancel();
            task.await.expect("the task doesn't panic");
        }

        let history = read_certificate_history(&data_root.certificate_dir).expect("the history");
        assert_eq!(history.len(), 1, "{history:?}");
        assert_eq!(history[0].fingerprint, sha256_hex(&der));
        assert_eq!(history[0].issuer, CertificateAuthority::LetsEncryptStaging);
    }

    /// A run with nothing cached is `Ordering`, then `OrderFailing` once its
    /// order fails, here because the CA can't be reached; nothing is
    /// recorded.
    #[tokio::test]
    async fn a_run_whose_first_order_fails_publishes_order_failing_with_the_error() {
        let data_root = data_root();
        let config = data_root.config(
            &data_root.certificate_dir,
            &unreachable_acme_directory_url(),
        );
        let (certificate_tx, mut certificate_rx) = watch::channel(None);
        let cancel = CancellationToken::new();
        let (_, task) = certificate_task(DOMAIN, &config, certificate_tx, cancel.clone());
        let _task = tokio::spawn(task);

        let state = published(&mut certificate_rx, |state| {
            state.status == CertificateStatus::OrderFailing
        })
        .await;
        assert!(
            matches!(
                state.last_error,
                Some(CertificateOrderError::CaUnreachable { .. })
            ),
            "{state:?}"
        );
        assert_eq!(state.held, None);
        cancel.cancel();
        assert!(read_certificate_history(&data_root.certificate_dir)
            .unwrap()
            .is_empty());
    }

    /// A new certificate is read once its store is done, whether it worked
    /// or not; a failed store is reported too.
    #[test]
    fn a_new_certificate_is_read_once_its_store_is_done() {
        let (cache_entry, _) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        let issued = parse_cache_entry(&cache_entry).unwrap();
        let last_cached = || Ok(Some(issued.clone()));

        assert_eq!(
            certificate_events(&Ok(EventOk::DeployedNewCert), last_cached),
            Vec::new()
        );
        assert_eq!(
            certificate_events(&Ok(EventOk::CertCacheStore), last_cached),
            vec![CertificateEvent::Deployed(issued.clone())]
        );
        let failed_store = certificate_events(
            &Err(EventError::CertCacheStore(io::Error::other("disk full"))),
            last_cached,
        );
        assert_eq!(failed_store[0], CertificateEvent::Deployed(issued.clone()));
        assert!(matches!(
            &failed_store[1],
            CertificateEvent::CacheFailed { message } if message.contains("disk full")
        ));
    }

    /// A wait toward a status change is cut to a minute, so a suspended
    /// device's run catches up within one once it wakes.
    #[test]
    fn a_status_wait_is_at_most_a_minute() {
        let now = Utc.with_ymd_and_hms(2026, 10, 8, 12, 0, 0).unwrap();
        assert_eq!(
            status_wait(now + chrono::Duration::days(30), now),
            LONGEST_STATUS_WAIT
        );
        assert_eq!(
            status_wait(now + chrono::Duration::seconds(10), now),
            Duration::from_secs(10)
        );
        assert_eq!(
            status_wait(now - chrono::Duration::seconds(10), now),
            Duration::ZERO
        );
    }

    /// A deployed certificate whose cache entry can't be read is a cache
    /// failure, not a certificate.
    #[test]
    fn an_unreadable_deployed_certificate_is_a_cache_failure() {
        let events = certificate_events(&Ok(EventOk::DeployedCachedCert), || {
            Err(anyhow::anyhow!("not a certificate"))
        });
        assert!(
            matches!(
                &events[..],
                [CertificateEvent::CacheFailed { message }] if message.contains("not a certificate")
            ),
            "{events:?}"
        );
    }

    /// A fault in the account or certificate cache is a cache failure, not an
    /// order's.
    #[test]
    fn a_cache_fault_is_not_an_order_failure() {
        let no_certificate = || Ok(None);
        for fault in [
            EventError::CertCacheLoad(io::Error::other("unreadable")),
            EventError::AccountCacheLoad(io::Error::other("unreadable")),
            EventError::AccountCacheStore(io::Error::other("disk full")),
        ] {
            let events = certificate_events(&Err(fault), no_certificate);
            assert!(
                matches!(&events[..], [CertificateEvent::CacheFailed { .. }]),
                "{events:?}"
            );
        }
    }

    /// A challenge the CA couldn't complete is `ChallengeFailed`, with the
    /// CA's detail.
    #[test]
    fn a_failed_authorization_is_a_failed_challenge() {
        let auth: rustls_acme::acme::Auth = serde_json::from_value(serde_json::json!({
            "status": "invalid",
            "identifier": {"type": "dns", "value": DOMAIN},
            "challenges": [{
                "type": "tls-alpn-01",
                "url": "https://ca.test/challenge",
                "token": "token",
                "error": {
                    "type": "urn:ietf:params:acme:error:connection",
                    "detail": "Connection refused",
                },
            }],
        }))
        .expect("an authorization");
        assert_eq!(
            order_error(&EventError::Order(OrderError::BadAuth(auth))),
            CertificateOrderError::ChallengeFailed {
                detail: Some("Connection refused".to_owned())
            }
        );
        assert_eq!(
            order_error(&EventError::Order(OrderError::TooManyAttemptsAuth(
                DOMAIN.to_owned()
            ))),
            CertificateOrderError::ChallengeFailed { detail: None }
        );
    }

    /// A refusal under a rate limit is `RateLimited`, until the instant Let's
    /// Encrypt's detail names; another ACME problem is `Other`, and a failure
    /// with none `CaUnreachable`.
    #[test]
    fn a_ca_s_answer_is_read_from_its_problem_document() {
        let rate_limited = r#"http request error: non 2xx http status: 429 "{\n  \"type\": \"urn:ietf:params:acme:error:rateLimited\",\n  \"detail\": \"too many certificates (50) already issued for \\\"relay.test\\\" in the last 168h0m0s, retry after 2026-10-09 12:34:56 UTC: see https://letsencrypt.org/docs/rate-limits/\"\n}""#;
        assert_eq!(
            ca_request_error(rate_limited),
            CertificateOrderError::RateLimited {
                retry_after: Some(Utc.with_ymd_and_hms(2026, 10, 9, 12, 34, 56).unwrap())
            }
        );
        assert_eq!(
            ca_request_error(
                r#"http request error: non 2xx http status: 429 "{\"type\": \"urn:ietf:params:acme:error:rateLimited\"}""#
            ),
            CertificateOrderError::RateLimited { retry_after: None }
        );
        let malformed = r#"http request error: non 2xx http status: 400 "{\"type\": \"urn:ietf:params:acme:error:malformed\"}""#;
        assert_eq!(
            ca_request_error(malformed),
            CertificateOrderError::Other {
                message: malformed.to_owned()
            }
        );
        assert_eq!(
            ca_request_error("http request error: io error: Connection refused"),
            CertificateOrderError::CaUnreachable {
                message: "http request error: io error: Connection refused".to_owned()
            }
        );
    }
}
