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
//!
//! rustls-acme has no "order now": an [`AcmeState`] orders only when its
//! cache holds no certificate, an expired one, or one due for renewal. So the
//! host's [`CertificateActions`] restart the run's ordering: the run drops
//! its `AcmeState`, ending any order or backoff it was waiting on, removes
//! the server's cached certificate for "order a new certificate" (the
//! install's account stays), and starts a fresh `AcmeState` from the same
//! configuration, publishing on the same channel. The tunnel listener serves
//! from [`CurrentAcmeResolver`], which each restart points at the new
//! state's resolver. Until the new state deploys a certificate, it has none
//! to serve, and visitors' handshakes fail. rustls-acme 0.15 can't revoke, so
//! a replaced certificate stays valid until it expires.

use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::Duration;

use anyhow::Context;
use async_trait::async_trait;
use base64::prelude::{Engine as _, BASE64_URL_SAFE_NO_PAD};
use chrono::{DateTime, NaiveDateTime, Utc};
use futures_util::StreamExt;
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls_acme::acme::AcmeError;
use rustls_acme::caches::DirCache;
use rustls_acme::{
    AcmeConfig, AcmeState, CertCache, EventError, EventOk, OrderError, ResolvesServerCertAcme,
};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot, watch};
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
        .directory(config.certificate_authority.directory_url().as_str())
        .cache_compose(
            certificate_cache,
            DirCache::new(config.acme_account_dir.clone()),
        )
}

/// The name of the file rustls-acme 0.15's [`DirCache`] caches the
/// certificate for `domain` from the CA at `directory_url` in:
/// `cached_cert_` and the unpadded URL-safe base64 of the SHA-256 of the
/// domain, a NUL, and the directory URL.
///
/// # Remarks
///
/// `DirCache` keeps this name to itself, so it is mirrored here; a test
/// removes an entry `DirCache` stored, so a change to its naming fails it.
fn cached_certificate_file_name(domain: &str, directory_url: &str) -> String {
    let digest = Sha256::new()
        .chain_update(domain)
        .chain_update([0])
        .chain_update(directory_url)
        .finalize();
    format!("cached_cert_{}", BASE64_URL_SAFE_NO_PAD.encode(digest))
}

/// Remove the certificate the cache in `config`'s `certificate_dir` holds
/// for `domain` from `config`'s CA, its key with it. The install's account,
/// and the server's certificates from other CAs, stay. Nothing cached is
/// fine.
///
/// # Errors
///
/// Returns an error if the cached certificate's file can't be removed.
async fn remove_cached_certificate(
    domain: &str,
    config: &DeviceCertificateConfig,
) -> io::Result<()> {
    let path = config.certificate_dir.join(cached_certificate_file_name(
        domain,
        config.certificate_authority.directory_url().as_str(),
    ));
    let removed = tokio::task::spawn_blocking(move || std::fs::remove_file(path))
        .await
        .map_err(io::Error::other)?;
    match removed {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        removed => removed,
    }
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
        .load_cert(
            &[domain.to_owned()],
            config.certificate_authority.directory_url().as_str(),
        )
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

/// The resolver the tunnel listener serves certificates from: the resolver
/// of the run's current [`AcmeState`], which serves the certificate it has
/// deployed, and the CA's validation certificate while an order's challenge
/// is pending. Each restart of the run's ordering points it at the new
/// state's resolver, which holds no certificate until the state deploys one.
#[derive(Debug)]
pub(crate) struct CurrentAcmeResolver(RwLock<Arc<ResolvesServerCertAcme>>);

impl CurrentAcmeResolver {
    fn new(acme_resolver: Arc<ResolvesServerCertAcme>) -> Self {
        Self(RwLock::new(acme_resolver))
    }

    /// Serve from `acme_resolver`, a new [`AcmeState`]'s, from now on.
    fn replace(&self, acme_resolver: Arc<ResolvesServerCertAcme>) {
        *self.0.write().unwrap_or_else(PoisonError::into_inner) = acme_resolver;
    }
}

impl ResolvesServerCert for CurrentAcmeResolver {
    fn resolve(&self, client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let acme_resolver = Arc::clone(&self.0.read().unwrap_or_else(PoisonError::into_inner));
        acme_resolver.resolve(client_hello)
    }
}

/// What a restart of a run's ordering does with the server's cached
/// certificate before it starts the new [`AcmeState`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CachedCertificate {
    /// Kept: the new state deploys it if it is valid, and orders at once
    /// otherwise.
    Kept,
    /// Removed, so the new state orders a new certificate at once.
    Removed,
}

/// A request to restart a run's ordering, and where the run answers once
/// the new [`AcmeState`] is in place: with the error removing the cached
/// certificate failed with, if it did.
struct RestartRequest {
    cached_certificate: CachedCertificate,
    restarted_tx: oneshot::Sender<io::Result<()>>,
}

/// The host's actions on a run's certificate: get one now, or order a new
/// one in place of the one held. Each restarts the run's ordering (see the
/// [module docs](self)). Clones reach the same run, and two are equal when
/// they do.
#[derive(Debug, Clone)]
pub struct CertificateActions {
    restart_tx: mpsc::Sender<RestartRequest>,
}

impl CertificateActions {
    /// Order a certificate now, even while a failed order backs off: the run
    /// starts its ordering again, deploying the cached certificate if it is
    /// valid. Answers once the new ordering has started.
    ///
    /// # Errors
    ///
    /// [`CertificateRestartError::RunStopped`] if the run has stopped.
    pub async fn get_certificate(&self) -> Result<(), CertificateRestartError> {
        self.restart(CachedCertificate::Kept).await
    }

    /// Drop the cached certificate and its key and order a new one now: the
    /// server has no certificate to serve until the new one is deployed.
    /// The install's ACME account stays. Answers once the new ordering has
    /// started.
    ///
    /// # Errors
    ///
    /// [`CertificateRestartError::RunStopped`] if the run has stopped, or
    /// [`CertificateRestartError::CachedCertificateNotRemoved`] if the cached
    /// certificate couldn't be removed, in which case the run has started
    /// again from it, as [`get_certificate`](Self::get_certificate) does.
    pub async fn order_new_certificate(&self) -> Result<(), CertificateRestartError> {
        self.restart(CachedCertificate::Removed).await
    }

    async fn restart(
        &self,
        cached_certificate: CachedCertificate,
    ) -> Result<(), CertificateRestartError> {
        let (restarted_tx, restarted_rx) = oneshot::channel();
        self.restart_tx
            .send(RestartRequest {
                cached_certificate,
                restarted_tx,
            })
            .await
            .map_err(|_| CertificateRestartError::RunStopped)?;
        restarted_rx
            .await
            .map_err(|_| CertificateRestartError::RunStopped)?
            .map_err(CertificateRestartError::CachedCertificateNotRemoved)
    }
}

/// Why [`CertificateActions`] couldn't restart a run's ordering as asked.
#[derive(Debug, thiserror::Error)]
pub enum CertificateRestartError {
    /// The run has stopped, so nothing orders the server's certificate.
    #[error("the server's run has stopped")]
    RunStopped,
    /// The cached certificate couldn't be removed; the run started its
    /// ordering again from it.
    #[error("the cached certificate couldn't be removed: {0}")]
    CachedCertificateNotRemoved(#[source] io::Error),
}

impl PartialEq for CertificateActions {
    fn eq(&self, other: &Self) -> bool {
        self.restart_tx.same_channel(&other.restart_tx)
    }
}

impl Eq for CertificateActions {}

/// The running certificate: the resolver serving whatever it has deployed,
/// the host's actions on it, and the token that stops ordering and renewing
/// when it's dropped.
pub(crate) struct DeviceCertificate {
    /// Serves the deployed certificate, and the CA's validation certificate
    /// while an order's challenge is pending.
    resolver: Arc<CurrentAcmeResolver>,
    /// Restarts the run's ordering.
    actions: CertificateActions,
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
        let (resolver, actions, task) =
            certificate_task(domain, config, certificate_tx, cancel.clone());
        tokio::spawn(task);
        Ok(Self {
            resolver,
            actions,
            cancel,
        })
    }

    /// The resolver the tunnel listener's TLS serves certificates from.
    pub(crate) fn resolver(&self) -> Arc<CurrentAcmeResolver> {
        Arc::clone(&self.resolver)
    }

    /// The host's actions on the certificate, for as long as the run lasts.
    pub(crate) fn actions(&self) -> CertificateActions {
        self.actions.clone()
    }
}

impl Drop for DeviceCertificate {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// The resolver serving the certificate for `domain` that `config`
/// describes, the host's actions on it, and the task that deploys, orders
/// and renews it until `cancel`, publishing its state on `certificate_tx`:
/// it reads the cached certificate first, then polls rustls-acme
/// ([`order_and_renew`]), starting again from the cache on each of the
/// actions' restarts.
fn certificate_task(
    domain: &str,
    config: &DeviceCertificateConfig,
    certificate_tx: watch::Sender<Option<CertificateState>>,
    cancel: CancellationToken,
) -> (
    Arc<CurrentAcmeResolver>,
    CertificateActions,
    impl std::future::Future<Output = ()> + Send + 'static,
) {
    let (mut acme_state, last_entry_certificate) = new_acme_state(domain, config);
    let resolver = Arc::new(CurrentAcmeResolver::new(acme_state.resolver()));
    let (restart_tx, mut restart_rx) = mpsc::channel(1);
    let mut reporter = CertificateReporter {
        issuer: config.certificate_authority,
        certificate_dir: config.certificate_dir.clone(),
        last_entry_certificate,
        certificate_tx,
    };
    let domain = domain.to_owned();
    let config = config.clone();
    let current_resolver = Arc::clone(&resolver);
    let task = async move {
        loop {
            let observed = observed_at_start(&domain, &config).await;
            let Some(request) =
                order_and_renew(acme_state, &reporter, observed, &cancel, &mut restart_rx).await
            else {
                return;
            };
            let removed = match request.cached_certificate {
                CachedCertificate::Kept => Ok(()),
                CachedCertificate::Removed => remove_cached_certificate(&domain, &config).await,
            };
            if let Err(error) = &removed {
                tracing::warn!("certificate: removing the cached certificate failed: {error}");
            }
            (acme_state, reporter.last_entry_certificate) = new_acme_state(&domain, &config);
            current_resolver.replace(acme_state.resolver());
            let _ = request.restarted_tx.send(removed);
        }
    };
    (resolver, CertificateActions { restart_tx }, task)
}

/// A fresh [`AcmeState`] for the certificate for `domain` that `config`
/// describes, over a cache of its own, and the certificate in the entry
/// that cache last loads or stores.
fn new_acme_state(
    domain: &str,
    config: &DeviceCertificateConfig,
) -> (AcmeState<io::Error>, LastEntryCertificate) {
    let certificate_cache = LastEntryCertCache::new(config.certificate_dir.clone());
    let last_entry_certificate = Arc::clone(&certificate_cache.last_entry_certificate);
    (
        acme_config(domain, config, certificate_cache).state(),
        last_entry_certificate,
    )
}

/// What a run starting its ordering for the certificate for `domain` that
/// `config` describes has observed of its cache, before rustls-acme reads it.
async fn observed_at_start(domain: &str, config: &DeviceCertificateConfig) -> ObservedCertificate {
    match cached_certificate(domain, config).await {
        Ok(cached) => ObservedCertificate::starting_with(cached),
        Err(error) => {
            ObservedCertificate::starting_with(None).after(CertificateEvent::CacheFailed {
                message: format!("{error:#}"),
            })
        }
    }
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

/// Poll `acme_state` until `cancel` or a request on `restart_rx`, logging
/// each event and reporting the certificate through `reporter`, from what
/// the run `observed` of its cache at start: polling is what makes
/// rustls-acme deploy, order and renew the certificate. It retries a failed
/// order itself, with backoff; until a certificate is deployed, the tunnel
/// listener's handshakes fail. Answers with the restart request that ended
/// it, dropping `acme_state` and any order or backoff it was waiting on;
/// `None` once cancelled.
async fn order_and_renew(
    mut acme_state: AcmeState<io::Error>,
    reporter: &CertificateReporter,
    mut observed: ObservedCertificate,
    cancel: &CancellationToken,
    restart_rx: &mut mpsc::Receiver<RestartRequest>,
) -> Option<RestartRequest> {
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
            Some(request) = restart_rx.recv() => return Some(request),
            () = cancel.cancelled() => return None,
        };
        let Some(event) = event else {
            // The state is an endless stream.
            return None;
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
/// rustls-acme 0.15's request error, `HttpsRequestError`, is in a private
/// module, so its status and body can't be matched: its message is all there
/// is to read. A refusal carries the CA's problem document, whose type says
/// whether it was a rate limit and whose detail, from Let's Encrypt, says
/// `retry after <YYYY-MM-DD HH:MM:SS> UTC`. A failure with no problem document
/// never reached the CA's ACME server. The tests read real rustls-acme errors
/// from a CA on this machine, so a change to that message fails them.
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

    /// The CA the tests order from: nothing answers at its directory, so an
    /// order fails at once instead of reaching a real CA.
    const TEST_CA: CertificateAuthority = CertificateAuthority::UnreachableForTests;

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
    /// `domain` from `certificate_authority`, as rustls-acme stores one.
    async fn cache_certificate(
        certificate_dir: &Path,
        domain: &str,
        certificate_authority: CertificateAuthority,
        cache_entry: &[u8],
    ) {
        DirCache::new(certificate_dir)
            .store_cert(
                &[domain.to_owned()],
                certificate_authority.directory_url().as_str(),
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
        /// in `certificate_dir`, ordering from `certificate_authority` with the
        /// install's account.
        fn config(
            &self,
            certificate_dir: &Path,
            certificate_authority: CertificateAuthority,
        ) -> DeviceCertificateConfig {
            DeviceCertificateConfig {
                certificate_authority,
                certificate_dir: certificate_dir.to_owned(),
                acme_account_dir: self.acme_account_dir.clone(),
            }
        }
    }

    /// The ACME state for [`DOMAIN`] over `data_root`, ordering from
    /// `certificate_authority`.
    fn acme_state(
        data_root: &DataRoot,
        certificate_authority: CertificateAuthority,
    ) -> AcmeState<io::Error> {
        let config = data_root.config(&data_root.certificate_dir, certificate_authority);
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
        let mut acme_state = acme_state(&data_root, TEST_CA);

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
        let certificate_authority = TEST_CA;
        let (cache_entry, _) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            certificate_authority,
            &cache_entry,
        )
        .await;
        let mut acme_state = acme_state(&data_root, certificate_authority);

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
        let certificate_authority = TEST_CA;
        let (cache_entry, _) = self_signed_cache_entry(DOMAIN, (2021, 1, 1));
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            certificate_authority,
            &cache_entry,
        )
        .await;
        let mut acme_state = acme_state(&data_root, certificate_authority);

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
        let certificate_authority = TEST_CA;
        let (cache_entry, _) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            certificate_authority,
            &cache_entry,
        )
        .await;

        let other_config =
            data_root.config(&data_root.other_certificate_dir, certificate_authority);
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
        // Only the account's store is polled, never the order, so nothing
        // reaches the staging CA.
        let mut same_server_other_ca =
            acme_state(&data_root, CertificateAuthority::LetsEncryptStaging);
        assert!(matches!(
            next_event(&mut same_server_other_ca).await,
            Ok(EventOk::AccountCacheStore)
        ));

        let mut same_server = acme_state(&data_root, certificate_authority);
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
            &data_root.config(&data_root.certificate_dir, TEST_CA),
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
        let certificate_authority = TEST_CA;
        let (cache_entry, _) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            certificate_authority,
            &cache_entry,
        )
        .await;
        let cancel = CancellationToken::new();
        let (_, _, task) = certificate_task(
            DOMAIN,
            &data_root.config(&data_root.certificate_dir, certificate_authority),
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
            &data_root.config(&data_root.certificate_dir, certificate_authority),
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
        let certificate_authority = TEST_CA;
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
                certificate_authority,
                &entry,
            )
            .await;
            let mut acme_state = acme_state(&data_root, certificate_authority);
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
        let certificate_authority = TEST_CA;
        let (ed25519_entry, _) =
            self_signed_cache_entry_signed_with(DOMAIN, (2099, 1, 1), &rcgen::PKCS_ED25519);
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            certificate_authority,
            &ed25519_entry,
        )
        .await;
        let config = data_root.config(&data_root.certificate_dir, certificate_authority);
        assert_eq!(
            cached_certificate_state(DOMAIN, &config).await.status,
            CertificateStatus::CacheUnreadable
        );

        let (certificate_tx, mut certificate_rx) = watch::channel(None);
        let cancel = CancellationToken::new();
        let (_, _, task) = certificate_task(DOMAIN, &config, certificate_tx, cancel.clone());
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
        let certificate_authority = TEST_CA;
        let config = data_root.config(&data_root.certificate_dir, certificate_authority);
        let state = cached_certificate_state(DOMAIN, &config).await;
        assert_eq!(state.status, CertificateStatus::NotIssued);
        assert_eq!(state.issuer, TEST_CA);

        let (lapsed, der) = self_signed_cache_entry(DOMAIN, (2021, 1, 1));
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            certificate_authority,
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
            certificate_authority,
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
        let certificate_authority = TEST_CA;
        let config = data_root.config(&data_root.certificate_dir, certificate_authority);
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            certificate_authority,
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
        let (_, _, task) = certificate_task(DOMAIN, &config, certificate_tx, cancel.clone());
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
        let directory_url = TEST_CA.directory_url();

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
        let certificate_authority = TEST_CA;
        let (cache_entry, der) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            certificate_authority,
            &cache_entry,
        )
        .await;
        let config = data_root.config(&data_root.certificate_dir, certificate_authority);

        for start in 0..2 {
            let (certificate_tx, mut certificate_rx) = watch::channel(None);
            let cancel = CancellationToken::new();
            let (_, _, task) = certificate_task(DOMAIN, &config, certificate_tx, cancel.clone());
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
        assert_eq!(history[0].issuer, TEST_CA);
    }

    /// A run with nothing cached is `Ordering`, then `OrderFailing` once its
    /// order fails, here because the CA can't be reached; nothing is
    /// recorded.
    #[tokio::test]
    async fn a_run_whose_first_order_fails_publishes_order_failing_with_the_error() {
        let data_root = data_root();
        let config = data_root.config(&data_root.certificate_dir, TEST_CA);
        let (certificate_tx, mut certificate_rx) = watch::channel(None);
        let cancel = CancellationToken::new();
        let (_, _, task) = certificate_task(DOMAIN, &config, certificate_tx, cancel.clone());
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

    /// A CA on this machine that answers every request with `status` and the
    /// problem document `problem`; the directory URL to order from it.
    async fn ca_answering(status: &str, problem: &str) -> Url {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let response = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/problem+json\r\n\
             content-length: {}\r\nconnection: close\r\n\r\n{problem}",
            problem.len()
        );
        tokio::spawn(async move {
            while let Ok((mut connection, _)) = listener.accept().await {
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    match connection.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&buffer[..read]),
                    }
                }
                let _ = connection.write_all(response.as_bytes()).await;
            }
        });
        Url::parse(&format!("http://{address}/directory")).expect("a URL")
    }

    /// The order error rustls-acme reports when it can't read the CA's
    /// directory at `directory_url`: a real [`AcmeError`], so a change to
    /// how rustls-acme reports a request's failure fails these tests.
    async fn order_error_reading(directory_url: &Url) -> CertificateOrderError {
        let client_config = Arc::new(
            rustls::ClientConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .expect("protocol versions")
            .with_root_certificates(rustls::RootCertStore::empty())
            .with_no_client_auth(),
        );
        let error = rustls_acme::acme::Directory::discover(&client_config, directory_url.as_str())
            .await
            .expect_err("the CA refuses");
        order_error(&EventError::Order(OrderError::Acme(error)))
    }

    /// A refusal under a rate limit is `RateLimited`, until the instant Let's
    /// Encrypt's detail names, read from rustls-acme's own report of the
    /// CA's answer.
    #[tokio::test]
    async fn a_rate_limit_is_read_from_the_ca_s_problem_document() {
        let rate_limited = ca_answering(
            "429 Too Many Requests",
            r#"{
  "type": "urn:ietf:params:acme:error:rateLimited",
  "detail": "too many certificates (50) already issued for \"relay.test\" in the last 168h0m0s, retry after 2026-10-09 12:34:56 UTC: see https://letsencrypt.org/docs/rate-limits/"
}"#,
        )
        .await;
        assert_eq!(
            order_error_reading(&rate_limited).await,
            CertificateOrderError::RateLimited {
                retry_after: Some(Utc.with_ymd_and_hms(2026, 10, 9, 12, 34, 56).unwrap())
            }
        );

        let undated = ca_answering(
            "429 Too Many Requests",
            r#"{"type": "urn:ietf:params:acme:error:rateLimited"}"#,
        )
        .await;
        assert_eq!(
            order_error_reading(&undated).await,
            CertificateOrderError::RateLimited { retry_after: None }
        );
    }

    /// Another ACME problem is `Other`, with rustls-acme's report of it.
    #[tokio::test]
    async fn another_acme_problem_is_other() {
        let malformed = ca_answering(
            "400 Bad Request",
            r#"{"type": "urn:ietf:params:acme:error:malformed"}"#,
        )
        .await;
        let error = order_error_reading(&malformed).await;
        assert!(
            matches!(
                &error,
                CertificateOrderError::Other { message }
                    if message.contains("urn:ietf:params:acme:error:malformed")
            ),
            "{error:?}"
        );
    }

    /// Removing the cached certificate removes the entry rustls-acme cached
    /// for the server's domain and CA alone: its entry from another CA, its
    /// history and the install's account stay.
    #[tokio::test]
    async fn removing_the_cached_certificate_removes_only_the_ca_s_entry() {
        // Arrange
        let data_root = data_root();
        let (staging_entry, _) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        let (production_entry, _) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        for (certificate_authority, entry) in [
            (CertificateAuthority::LetsEncryptStaging, &staging_entry),
            (CertificateAuthority::LetsEncrypt, &production_entry),
        ] {
            cache_certificate(
                &data_root.certificate_dir,
                DOMAIN,
                certificate_authority,
                entry,
            )
            .await;
        }
        std::fs::create_dir_all(&data_root.acme_account_dir).unwrap();
        std::fs::write(data_root.acme_account_dir.join("cached_account_x"), b"key").unwrap();
        let staging = data_root.config(
            &data_root.certificate_dir,
            CertificateAuthority::LetsEncryptStaging,
        );

        // Act
        remove_cached_certificate(DOMAIN, &staging)
            .await
            .expect("removed");

        // Assert
        let cache = DirCache::new(&data_root.certificate_dir);
        let cached_from = |certificate_authority: CertificateAuthority| {
            let cache = &cache;
            async move {
                cache
                    .load_cert(
                        &[DOMAIN.to_owned()],
                        certificate_authority.directory_url().as_str(),
                    )
                    .await
                    .expect("the cache reads")
            }
        };
        assert_eq!(
            cached_from(CertificateAuthority::LetsEncryptStaging).await,
            None
        );
        assert_eq!(
            cached_from(CertificateAuthority::LetsEncrypt).await,
            Some(production_entry)
        );
        assert_eq!(
            file_names(&data_root.acme_account_dir),
            ["cached_account_x"]
        );
        remove_cached_certificate(DOMAIN, &staging)
            .await
            .expect("nothing cached is fine");
    }

    /// What the fake CA does with each request.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum FakeCaAnswer {
        /// A `500` to every request, so every order fails.
        Failure,
        /// Every account and order accepted, and a certificate issued.
        Issuing,
    }

    /// A fake ACME CA on this machine, over plain HTTP: it accepts every
    /// account and order without checking a signature, an order needing no
    /// challenge, and issues each a new self-signed certificate for
    /// [`DOMAIN`]; or it fails every request. It counts the orders started,
    /// as reads of its directory, which each order begins with.
    struct FakeCa {
        port: u16,
        answer: Arc<Mutex<FakeCaAnswer>>,
        orders_started: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl FakeCa {
        async fn start(answer: FakeCaAnswer) -> Self {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind");
            let port = listener.local_addr().expect("address").port();
            let fake_ca = Self {
                port,
                answer: Arc::new(Mutex::new(answer)),
                orders_started: Arc::default(),
            };
            let answer = Arc::clone(&fake_ca.answer);
            let orders_started = Arc::clone(&fake_ca.orders_started);
            tokio::spawn(async move {
                while let Ok((mut connection, _)) = listener.accept().await {
                    let mut request = Vec::new();
                    let mut buffer = [0; 4096];
                    let head_end = loop {
                        if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                            break end + 4;
                        }
                        match connection.read(&mut buffer).await {
                            Ok(0) | Err(_) => break request.len(),
                            Ok(read) => request.extend_from_slice(&buffer[..read]),
                        }
                    };
                    let head = String::from_utf8_lossy(&request[..head_end]).to_lowercase();
                    let body_length = head
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .and_then(|length| length.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    while request.len() < head_end + body_length {
                        match connection.read(&mut buffer).await {
                            Ok(0) | Err(_) => break,
                            Ok(read) => request.extend_from_slice(&buffer[..read]),
                        }
                    }
                    let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
                    if path == "/directory" {
                        orders_started.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                    let answer = *answer.lock().unwrap();
                    let response = fake_ca_response(port, answer, &path);
                    let _ = connection.write_all(response.as_bytes()).await;
                }
            });
            fake_ca
        }

        /// The CA's config for the server in `certificate_dir`, ordering
        /// with `data_root`'s account.
        fn config(&self, data_root: &DataRoot) -> DeviceCertificateConfig {
            data_root.config(
                &data_root.certificate_dir,
                CertificateAuthority::LocalForTests { port: self.port },
            )
        }

        fn answer_with(&self, answer: FakeCaAnswer) {
            *self.answer.lock().unwrap() = answer;
        }

        /// Wait until `count` orders have started.
        async fn orders_started(&self, count: usize) {
            tokio::time::timeout(Duration::from_secs(10), async {
                while self
                    .orders_started
                    .load(std::sync::atomic::Ordering::SeqCst)
                    < count
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the orders in time");
        }
    }

    /// The fake CA at `port`'s answer to a request for `path`.
    fn fake_ca_response(port: u16, answer: FakeCaAnswer, path: &str) -> String {
        let base = format!("http://127.0.0.1:{port}");
        let (status, location, body) = match (answer, path) {
            (FakeCaAnswer::Failure, _) => ("500 Internal Server Error", None, String::new()),
            (FakeCaAnswer::Issuing, "/directory") => (
                "200 OK",
                None,
                serde_json::json!({
                    "newNonce": format!("{base}/nonce"),
                    "newAccount": format!("{base}/account"),
                    "newOrder": format!("{base}/order"),
                })
                .to_string(),
            ),
            (FakeCaAnswer::Issuing, "/nonce") => ("200 OK", None, String::new()),
            (FakeCaAnswer::Issuing, "/account") => (
                "201 Created",
                Some(format!("{base}/account/1")),
                "{}".to_owned(),
            ),
            (FakeCaAnswer::Issuing, "/order" | "/finalize") => (
                if path == "/order" {
                    "201 Created"
                } else {
                    "200 OK"
                },
                Some(format!("{base}/order/1")),
                serde_json::json!({
                    "status": if path == "/order" { "ready" } else { "valid" },
                    "certificate": format!("{base}/certificate"),
                    "authorizations": [],
                    "finalize": format!("{base}/finalize"),
                })
                .to_string(),
            ),
            (FakeCaAnswer::Issuing, "/certificate") => {
                let mut params = CertificateParams::new(vec![DOMAIN.to_owned()]).expect("params");
                params.not_before = rcgen::date_time_ymd(2020, 1, 1);
                params.not_after = rcgen::date_time_ymd(2099, 1, 1);
                let key_pair =
                    KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).expect("key pair");
                let certificate = params.self_signed(&key_pair).expect("self-signed");
                ("200 OK", None, certificate.pem())
            }
            (FakeCaAnswer::Issuing, _) => ("404 Not Found", None, String::new()),
        };
        let location = location
            .map(|location| format!("location: {location}\r\n"))
            .unwrap_or_default();
        format!(
            "HTTP/1.1 {status}\r\nreplay-nonce: nonce\r\n{location}\
             content-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// Getting a certificate orders one at once, even while a failed order
    /// backs off: here the third failure's 4 s backoff.
    #[tokio::test]
    async fn getting_a_certificate_orders_at_once_while_a_failed_order_backs_off() {
        // Arrange: the CA fails the first orders, 0, 1 and 3 s in.
        let data_root = data_root();
        let fake_ca = FakeCa::start(FakeCaAnswer::Failure).await;
        let (certificate_tx, mut certificate_rx) = watch::channel(None);
        let cancel = CancellationToken::new();
        let (_, actions, task) = certificate_task(
            DOMAIN,
            &fake_ca.config(&data_root),
            certificate_tx,
            cancel.clone(),
        );
        let _task = tokio::spawn(task);
        published(&mut certificate_rx, |state| {
            state.status == CertificateStatus::OrderFailing
        })
        .await;
        fake_ca.orders_started(3).await;
        fake_ca.answer_with(FakeCaAnswer::Issuing);

        // Act
        let asked_at = std::time::Instant::now();
        actions.get_certificate().await.expect("ordering restarted");

        // Assert
        let state = published(&mut certificate_rx, |state| {
            state.status == CertificateStatus::NoRenewalNeeded
        })
        .await;
        cancel.cancel();
        assert!(
            asked_at.elapsed() < Duration::from_secs(3),
            "deployed before the backoff ends"
        );
        assert!(state.held.is_some());
        assert_eq!(state.last_error, None);
    }

    /// Ordering a new certificate replaces the cached one with a new one,
    /// from the server's CA, recorded in the history, and leaves the
    /// install's account as it was.
    #[tokio::test]
    async fn ordering_a_new_certificate_replaces_the_cached_one_and_keeps_the_account() {
        // Arrange: the run orders its first certificate, creating the account.
        let data_root = data_root();
        let fake_ca = FakeCa::start(FakeCaAnswer::Issuing).await;
        let config = fake_ca.config(&data_root);
        let (certificate_tx, mut certificate_rx) = watch::channel(None);
        let cancel = CancellationToken::new();
        let (_, actions, task) = certificate_task(DOMAIN, &config, certificate_tx, cancel.clone());
        let _task = tokio::spawn(task);
        let first = published(&mut certificate_rx, |state| state.held.is_some())
            .await
            .held
            .expect("a certificate")
            .fingerprint;
        history_of_length(&data_root.certificate_dir, 1).await;
        let account_files = || {
            file_names(&data_root.acme_account_dir)
                .into_iter()
                .map(|name| {
                    let contents = std::fs::read(data_root.acme_account_dir.join(&name)).unwrap();
                    (name, contents)
                })
                .collect::<Vec<_>>()
        };
        let account_before = account_files();
        assert_eq!(account_before.len(), 1);

        // Act
        actions
            .order_new_certificate()
            .await
            .expect("ordering restarted");

        // Assert
        let state = published(&mut certificate_rx, |state| {
            state
                .held
                .as_ref()
                .is_some_and(|held| held.fingerprint != first)
        })
        .await;
        cancel.cancel();
        assert_eq!(state.status, CertificateStatus::NoRenewalNeeded);
        assert_eq!(state.issuer, config.certificate_authority);
        let second = state.held.expect("the new certificate").fingerprint;
        history_of_length(&data_root.certificate_dir, 2).await;
        let history = read_certificate_history(&data_root.certificate_dir).unwrap();
        assert_eq!(
            history
                .iter()
                .map(|entry| &entry.fingerprint)
                .collect::<Vec<_>>(),
            [&first, &second]
        );
        assert_eq!(
            cached_certificate(DOMAIN, &config)
                .await
                .unwrap()
                .map(|cached| cached.fingerprint),
            Some(second)
        );
        assert_eq!(account_files(), account_before);
    }

    /// Ordering a new certificate drops the held one at once: the run holds
    /// none, and is `Ordering`, until the new one is deployed.
    #[tokio::test]
    async fn ordering_a_new_certificate_holds_none_until_the_new_one_arrives() {
        // Arrange: a valid cached certificate, and a CA that fails.
        let data_root = data_root();
        let fake_ca = FakeCa::start(FakeCaAnswer::Failure).await;
        let config = fake_ca.config(&data_root);
        let (cache_entry, _) = self_signed_cache_entry(DOMAIN, (2099, 1, 1));
        cache_certificate(
            &data_root.certificate_dir,
            DOMAIN,
            config.certificate_authority,
            &cache_entry,
        )
        .await;
        let (certificate_tx, mut certificate_rx) = watch::channel(None);
        let cancel = CancellationToken::new();
        let (_, actions, task) = certificate_task(DOMAIN, &config, certificate_tx, cancel.clone());
        let _task = tokio::spawn(task);
        published(&mut certificate_rx, |state| {
            state.status == CertificateStatus::NoRenewalNeeded
        })
        .await;

        // Act
        actions
            .order_new_certificate()
            .await
            .expect("ordering restarted");

        // Assert
        let state = published(&mut certificate_rx, |state| state.held.is_none()).await;
        cancel.cancel();
        assert!(
            matches!(
                state.status,
                CertificateStatus::Ordering | CertificateStatus::OrderFailing
            ),
            "{state:?}"
        );
        assert_eq!(cached_certificate(DOMAIN, &config).await.unwrap(), None);
    }

    /// A run that has stopped refuses both actions.
    #[tokio::test]
    async fn a_stopped_run_refuses_the_actions() {
        let data_root = data_root();
        let cancel = CancellationToken::new();
        let (_, actions, task) = certificate_task(
            DOMAIN,
            &data_root.config(&data_root.certificate_dir, TEST_CA),
            watch::channel(None).0,
            cancel.clone(),
        );
        let task = tokio::spawn(task);
        cancel.cancel();
        task.await.expect("the task doesn't panic");

        assert!(actions.get_certificate().await.is_err());
        assert!(actions.order_new_certificate().await.is_err());
    }

    /// A CA that can't be reached at all, with no problem document, is
    /// `CaUnreachable`.
    #[tokio::test]
    async fn a_ca_that_can_t_be_reached_is_unreachable() {
        let error = order_error_reading(&TEST_CA.directory_url()).await;
        assert!(
            matches!(error, CertificateOrderError::CaUnreachable { .. }),
            "{error:?}"
        );
    }
}
