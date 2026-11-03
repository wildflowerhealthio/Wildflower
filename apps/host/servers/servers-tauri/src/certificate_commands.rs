//! The certificate commands: the base orders a running server a
//! certificate, if needed or forced (see
//! [`CertificateOrderKind`]), through the
//! [`RunningCertificateControl`](wildflowerhealthio_wildflower_server::RunningCertificateControl)
//! in its run's detail, and reads how much of its CA's duplicate-certificate
//! limit the server's domain has used, as the server's certificate history
//! records it. Each order checks that limit first and is refused once it
//! looks used up
//! ([`ensure_limit_not_used_up`](wildflowerhealthio_servers::ensure_limit_not_used_up)),
//! since the CA would refuse it. Every failure answers as `{kind, message}`, a
//! [`CertificateOrderRequestError`], and is logged by domain.

use std::path::Path;
use std::sync::Arc;

use chrono::Utc;
use tauri_plugin_log::log;
use wildflowerhealthio_servers::{
    CertificateOrderRequestError, RegistryError, ServerDetail, ServerRecord, ServerRegistry,
};
use wildflowerhealthio_tauri_unit_runner::{UnitId, UnitStatuses};
use wildflowerhealthio_wildflower_server::{CertificateOrderKind, DuplicateCertificateLimit};

use crate::ServersState;

/// How much of the server `domain`'s CA's duplicate-certificate limit its
/// domain has used, as this device's certificate history records it; `null`
/// for a CA with no limit a server reaches, as Let's Encrypt's staging CA.
/// Invoked as `invoke('server_duplicate_certificate_limit', { domain })`.
///
/// # Errors
///
/// The [`CertificateOrderRequestError`] reading it failed with: the server isn't
/// registered, or its history couldn't be read.
#[tauri::command]
pub async fn server_duplicate_certificate_limit(
    servers: tauri::State<'_, ServersState>,
    domain: String,
) -> Result<Option<DuplicateCertificateLimit>, CertificateOrderRequestError> {
    duplicate_certificate_limit(Arc::clone(&servers.registry), &servers.data_root, &domain)
        .await
        .inspect_err(|error| {
            log::warn!(
                "[servers] reading the duplicate-certificate limit of {domain} failed: {error}"
            );
        })
}

/// Have the running server `domain` order a certificate if needed, even
/// while a failed order backs off: its run starts its ordering again,
/// deploying the cached certificate if it is valid
/// ([`CertificateOrderKind::IfNeeded`]). Invoked as
/// `invoke('server_order_certificate', { domain })`; answers with nothing
/// once the new ordering has started.
///
/// # Errors
///
/// The [`CertificateOrderRequestError`] that stopped it: the server isn't
/// registered or running, its history couldn't be read, or its CA's
/// duplicate-certificate limit is used up.
#[tauri::command]
pub async fn server_order_certificate(
    servers: tauri::State<'_, ServersState>,
    domain: String,
) -> Result<(), CertificateOrderRequestError> {
    restart_certificate_ordering(
        Arc::clone(&servers.registry),
        &servers.data_root,
        &servers.server_units.statuses(),
        domain,
        CertificateOrderKind::IfNeeded,
    )
    .await
}

/// Have the running server `domain` drop its cached certificate and key and
/// order a new one now ([`CertificateOrderKind::Forced`]); the install's ACME
/// account stays. Until the new one is deployed, the server has no
/// certificate to serve and can't be reached. Invoked as
/// `invoke('server_force_new_certificate', { domain })`; answers with
/// nothing once the new ordering has started.
///
/// # Errors
///
/// The [`CertificateOrderRequestError`] that stopped it, as for
/// [`server_order_certificate`], or `cachedCertificateNotRemoved`, after
/// which the run has started its ordering again from the cached certificate.
#[tauri::command]
pub async fn server_force_new_certificate(
    servers: tauri::State<'_, ServersState>,
    domain: String,
) -> Result<(), CertificateOrderRequestError> {
    restart_certificate_ordering(
        Arc::clone(&servers.registry),
        &servers.data_root,
        &servers.server_units.statuses(),
        domain,
        CertificateOrderKind::Forced,
    )
    .await
}

/// Restart the ordering of the server `domain`, registered in `registry`
/// with its folder in `data_root`, through its run in `statuses`, as `kind`
/// asks, unless its CA's duplicate-certificate limit looks used up.
async fn restart_certificate_ordering(
    registry: Arc<dyn ServerRegistry>,
    data_root: &Path,
    statuses: &UnitStatuses<ServerDetail>,
    domain: String,
    kind: CertificateOrderKind,
) -> Result<(), CertificateOrderRequestError> {
    let result = async {
        let limit = duplicate_certificate_limit(registry, data_root, &domain).await?;
        wildflowerhealthio_servers::ensure_limit_not_used_up(&domain, limit.as_ref())?;
        wildflowerhealthio_servers::running_certificate_control(
            &domain,
            statuses.get(&UnitId::new(&domain)),
        )?
        .restart(kind)
        .await
        .map_err(|control_error| CertificateOrderRequestError::of_control(&domain, &control_error))
    }
    .await;
    match &result {
        Ok(()) => log::info!("[servers] {domain} is ordering its certificate ({kind:?})"),
        Err(error) => {
            log::warn!("[servers] ordering the certificate of {domain} ({kind:?}) failed: {error}");
        }
    }
    result
}

/// How much of its CA's duplicate-certificate limit the server `domain`,
/// registered in `registry` with its folder in `data_root`, has used by its
/// certificate history, as of now; `None` for a CA with no limit.
async fn duplicate_certificate_limit(
    registry: Arc<dyn ServerRegistry>,
    data_root: &Path,
    domain: &str,
) -> Result<Option<DuplicateCertificateLimit>, CertificateOrderRequestError> {
    let record = read_registered_record(registry, domain.to_owned()).await?;
    let config = record.device_certificate_config(data_root);
    let history_unreadable = |message: String| CertificateOrderRequestError::HistoryUnreadable {
        domain: domain.to_owned(),
        message,
    };
    let history = tokio::task::spawn_blocking(move || {
        wildflowerhealthio_wildflower_server::read_certificate_history(&config.certificate_dir)
    })
    .await
    .map_err(|error| history_unreadable(error.to_string()))?
    .map_err(|error| history_unreadable(error.to_string()))?;
    Ok(DuplicateCertificateLimit::from_deployments_in_window(
        &history,
        record.certificate_authority,
        Utc::now(),
    ))
}

/// The record of the server `domain` in `registry`, read on a blocking
/// thread.
async fn read_registered_record(
    registry: Arc<dyn ServerRegistry>,
    domain: String,
) -> Result<ServerRecord, CertificateOrderRequestError> {
    tokio::task::spawn_blocking(move || registry.read(&domain))
        .await
        .map_err(|error| RegistryError::storage("reading a server's record", error))?
        .map_err(CertificateOrderRequestError::from)
}

#[cfg(test)]
mod tests {
    use chrono::TimeDelta;
    use url::Url;
    use wildflowerhealthio_rathole_settings::TunnelName;
    use wildflowerhealthio_servers::{
        CertificateAuthority, JsonServerRegistry, RelayKind, RunPolicy, TunnelToken,
    };
    use wildflowerhealthio_tauri_unit_runner::RunState;
    use wildflowerhealthio_wildflower_server::CertificateHistoryEntry;

    use super::*;
    use crate::test_statuses::not_reporting;

    const DOMAIN: &str = "ruth.relay.example.com";

    /// A registry in a fresh folder holding the server [`DOMAIN`], whose
    /// certificates come from `certificate_authority`, and its folder's
    /// certificate history recording one certificate from that CA deployed
    /// each of `deployed_ago`.
    fn registry_with_history(
        certificate_authority: CertificateAuthority,
        deployed_ago: &[TimeDelta],
    ) -> (tempfile::TempDir, Arc<dyn ServerRegistry>) {
        let data_root = tempfile::tempdir().unwrap();
        let registry = JsonServerRegistry::in_data_root(
            data_root.path(),
            Url::parse("https://authorization.wildflowerhealth.io/").unwrap(),
        );
        let record = ServerRecord {
            relay: RelayKind::Rathole,
            tunnel_name: TunnelName::parse("ruth").unwrap(),
            token: TunnelToken::new("the-token"),
            public_settings: serde_json::from_value(serde_json::json!({
                "remote_addr": "relay.example.com:2333",
                "transport": "noise",
                "noise_pattern": "Noise_NK_25519_ChaChaPoly_BLAKE2s",
                "public_key": "Y2FmZWJhYmVjYWZlYmFiZWNhZmViYWJlY2FmZWJhYmU=",
                "domain": "relay.example.com",
            }))
            .unwrap(),
            launcher_url: Url::parse("https://launcher.example/").unwrap(),
            authorization_url: Url::parse("https://authorization.example/").unwrap(),
            certificate_authority,
            run_policy: RunPolicy::WhileOpen,
        };
        assert_eq!(record.domain(), DOMAIN);
        let certificate_dir = record
            .device_certificate_config(data_root.path())
            .certificate_dir;
        let history: Vec<CertificateHistoryEntry> = deployed_ago
            .iter()
            .map(|age| {
                let deployed_at = Utc::now() - *age;
                CertificateHistoryEntry {
                    deployed_at,
                    issuer: certificate_authority,
                    fingerprint: format!("{deployed_at}"),
                    not_before: deployed_at,
                    not_after: deployed_at + TimeDelta::days(90),
                }
            })
            .collect();
        std::fs::create_dir_all(&certificate_dir).unwrap();
        std::fs::write(
            certificate_dir.join("history.json"),
            serde_json::to_vec(&history).unwrap(),
        )
        .unwrap();
        registry.insert(Box::new(move |_| record)).unwrap();
        (data_root, Arc::new(registry))
    }

    /// Five days, one certificate a day: Let's Encrypt's limit.
    fn five_days_of_certificates() -> Vec<TimeDelta> {
        (1..=5).map(TimeDelta::days).collect()
    }

    /// The servers' statuses with the server [`DOMAIN`] in `run_state`, its
    /// run not reporting.
    fn statuses_in(run_state: RunState) -> UnitStatuses<ServerDetail> {
        [(UnitId::new(DOMAIN), not_reporting(run_state))].into()
    }

    #[tokio::test]
    async fn the_limit_used_is_the_history_s_certificates_in_the_ca_s_window() {
        // Arrange: one from 8 days ago, outside the window.
        let (data_root, registry) = registry_with_history(
            CertificateAuthority::LetsEncrypt,
            &[TimeDelta::days(8), TimeDelta::days(2), TimeDelta::hours(1)],
        );

        // Act
        let limit = duplicate_certificate_limit(registry, data_root.path(), DOMAIN)
            .await
            .unwrap()
            .expect("Let's Encrypt has a limit");

        // Assert
        assert_eq!((limit.allowed, limit.used), (5, 2));
    }

    #[tokio::test]
    async fn staging_has_no_limit() {
        let (data_root, registry) = registry_with_history(
            CertificateAuthority::LetsEncryptStaging,
            &five_days_of_certificates(),
        );
        assert_eq!(
            duplicate_certificate_limit(registry, data_root.path(), DOMAIN)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn each_order_is_refused_for_a_server_that_is_not_running() {
        for statuses in [UnitStatuses::new(), statuses_in(RunState::Starting)] {
            for kind in [CertificateOrderKind::IfNeeded, CertificateOrderKind::Forced] {
                let (data_root, registry) =
                    registry_with_history(CertificateAuthority::LetsEncrypt, &[]);
                let refused = restart_certificate_ordering(
                    registry,
                    data_root.path(),
                    &statuses,
                    DOMAIN.to_owned(),
                    kind,
                )
                .await;
                assert!(
                    matches!(
                        refused,
                        Err(CertificateOrderRequestError::ServerNotRunning { .. })
                    ),
                    "{kind:?}: {refused:?}"
                );
            }
        }
    }

    #[tokio::test]
    async fn each_order_is_refused_once_the_production_ca_s_limit_is_used_up() {
        for kind in [CertificateOrderKind::IfNeeded, CertificateOrderKind::Forced] {
            let (data_root, registry) = registry_with_history(
                CertificateAuthority::LetsEncrypt,
                &five_days_of_certificates(),
            );
            let refused = restart_certificate_ordering(
                registry,
                data_root.path(),
                &UnitStatuses::new(),
                DOMAIN.to_owned(),
                kind,
            )
            .await;
            assert!(
                matches!(
                    refused,
                    Err(CertificateOrderRequestError::LimitUsedUp { allowed: 5, .. })
                ),
                "{kind:?}: {refused:?}"
            );
        }
    }

    #[tokio::test]
    async fn staging_s_orders_are_not_held_to_a_limit() {
        // A staging server with as many certificates passes the limit's
        // check, so it is refused only for not running.
        let (data_root, registry) = registry_with_history(
            CertificateAuthority::LetsEncryptStaging,
            &five_days_of_certificates(),
        );
        let refused = restart_certificate_ordering(
            registry,
            data_root.path(),
            &UnitStatuses::new(),
            DOMAIN.to_owned(),
            CertificateOrderKind::Forced,
        )
        .await;
        assert!(
            matches!(
                refused,
                Err(CertificateOrderRequestError::ServerNotRunning { .. })
            ),
            "{refused:?}"
        );
    }

    #[tokio::test]
    async fn an_order_for_a_server_that_is_not_registered_is_refused() {
        let (data_root, registry) = registry_with_history(CertificateAuthority::LetsEncrypt, &[]);
        let refused = restart_certificate_ordering(
            registry,
            data_root.path(),
            &UnitStatuses::new(),
            "someone-else.relay.example.com".to_owned(),
            CertificateOrderKind::IfNeeded,
        )
        .await;
        assert!(
            matches!(
                refused,
                Err(CertificateOrderRequestError::Registry(
                    RegistryError::NotRegistered { .. }
                ))
            ),
            "{refused:?}"
        );
    }
}
