//! Launching a server's launcher: whether the server can be launched now
//! ([`ensure_launchable`]) and the URL its launcher opens at
//! ([`launch_url`]).
//!
//! A SMART EHR launch hands the launcher two query parameters, and they are
//! the only credentials the launched app gets: `iss`, the server's FHIR base,
//! and `launch`, a value the server's gatekeeper minted for any client. The
//! app's `/oauth/authorize` presents the `launch` and parks a consent the
//! base's consent sheet answers.

use shared_structures_rust::FHIR_R4_PATH;
use unit_runner::{RunState, UnitStatus};
use url::Url;
use wildflower_server_rust::{CertificateStatus, ServerHealth};

use crate::domain::{LaunchError, ServerDetail};

/// The URL the server `domain`'s launcher opens at: `launcher_url` with
/// `iss=https://<domain>/fhir-r4` and the minted `launch` appended to its
/// query. Any `iss` or `launch` the launcher URL already carries is replaced;
/// its other query parameters and its fragment are kept.
#[must_use]
pub fn launch_url(launcher_url: &Url, domain: &str, launch: &str) -> Url {
    let kept_query_pairs: Vec<(String, String)> = launcher_url
        .query_pairs()
        .filter(|(name, _)| name != "iss" && name != "launch")
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    let mut url = launcher_url.clone();
    url.query_pairs_mut()
        .clear()
        .extend_pairs(kept_query_pairs)
        .append_pair("iss", &format!("https://{domain}{FHIR_R4_PATH}"))
        .append_pair("launch", launch);
    url
}

/// The detail of the server `domain`'s run, from its `unit_status` on
/// `UnitRunner`, once the server can be launched: its run is up, its
/// `/health` has answered through its relay, and its run holds a valid
/// certificate (no renewal needed, or renewal due). Nothing waits for any of
/// them: the base waits, and asks again.
///
/// # Errors
///
/// - [`LaunchError::ServerNotRunning`] when the server has no status, or its
///   run isn't up;
/// - [`LaunchError::NotYetProbed`] when its `/health` hasn't been asked yet,
///   or its run hasn't reported a detail;
/// - [`LaunchError::Unreachable`] when it didn't answer;
/// - [`LaunchError::NoValidCertificate`] when the run holds no valid
///   certificate, or hasn't reported one.
pub fn ensure_launchable<'a>(
    domain: &str,
    unit_status: Option<&'a UnitStatus<ServerDetail>>,
) -> Result<&'a ServerDetail, LaunchError> {
    let running = unit_status
        .filter(|unit_status| unit_status.run_state == RunState::Running)
        .ok_or_else(|| LaunchError::ServerNotRunning {
            domain: domain.to_owned(),
        })?;
    // A run that hasn't reported its detail yet hasn't probed its health
    // either.
    let not_yet_probed = || LaunchError::NotYetProbed {
        domain: domain.to_owned(),
    };
    let detail = running.detail.as_ref().ok_or_else(not_yet_probed)?;
    match detail.health.as_ref().ok_or_else(not_yet_probed)? {
        ServerHealth::Unreachable { error } => {
            return Err(LaunchError::Unreachable {
                domain: domain.to_owned(),
                error: error.clone(),
            })
        }
        ServerHealth::Reachable(_) => {}
    }
    let holds_valid_certificate = detail.certificate.as_ref().is_some_and(|certificate| {
        matches!(
            certificate.status,
            CertificateStatus::NoRenewalNeeded | CertificateStatus::RenewalDue
        )
    });
    if !holds_valid_certificate {
        return Err(LaunchError::NoValidCertificate {
            domain: domain.to_owned(),
        });
    }
    Ok(detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::server_status::tests::{golden_statuses, running_and_reachable, RUTH};
    use crate::domain::{golden, ServerStatus};

    fn launcher(url: &str) -> Url {
        Url::parse(url).unwrap()
    }

    #[test]
    fn the_launch_url_carries_the_server_s_fhir_base_and_the_launch() {
        assert_eq!(
            launch_url(
                &launcher("https://wildflowerhealth.io/owner-ui/"),
                RUTH,
                "nonce-1"
            )
            .as_str(),
            "https://wildflowerhealth.io/owner-ui/?iss=https%3A%2F%2Fruth.relay.example.com%2Ffhir-r4&launch=nonce-1"
        );
    }

    #[test]
    fn the_launch_url_keeps_the_launcher_s_query_and_fragment_and_replaces_its_launch_params() {
        let url = launch_url(
            &launcher("https://launcher.example/app?theme=dark&iss=https://other.example&launch=stale#/home"),
            RUTH,
            "nonce-1",
        );
        assert_eq!(
            url.query_pairs()
                .map(|(name, value)| (name.into_owned(), value.into_owned()))
                .collect::<Vec<_>>(),
            [
                ("theme".to_owned(), "dark".to_owned()),
                (
                    "iss".to_owned(),
                    "https://ruth.relay.example.com/fhir-r4".to_owned()
                ),
                ("launch".to_owned(), "nonce-1".to_owned()),
            ]
        );
        assert_eq!(url.fragment(), Some("/home"));
        assert_eq!(url.path(), "/app");
    }

    #[test]
    fn a_running_reachable_server_with_a_valid_certificate_is_launchable() {
        let unit_status = running_and_reachable();
        assert!(ensure_launchable(RUTH, Some(&unit_status)).is_ok());

        let mut renewal_due = running_and_reachable();
        renewal_due
            .detail
            .as_mut()
            .unwrap()
            .certificate
            .as_mut()
            .unwrap()
            .status = CertificateStatus::RenewalDue;
        assert!(ensure_launchable(RUTH, Some(&renewal_due)).is_ok());
    }

    #[test]
    fn a_server_that_isn_t_running_is_refused() {
        let starting = UnitStatus {
            run_state: RunState::Starting,
            ..running_and_reachable()
        };
        for unit_status in [None, Some(&starting), Some(&UnitStatus::never_run())] {
            assert!(matches!(
                ensure_launchable(RUTH, unit_status),
                Err(LaunchError::ServerNotRunning { .. })
            ));
        }
    }

    #[test]
    fn a_server_not_yet_probed_or_unreachable_is_refused() {
        let mut not_yet_probed = running_and_reachable();
        not_yet_probed.detail.as_mut().unwrap().health = None;
        let without_a_detail = UnitStatus {
            detail: None,
            ..running_and_reachable()
        };
        for unit_status in [not_yet_probed, without_a_detail] {
            assert!(matches!(
                ensure_launchable(RUTH, Some(&unit_status)),
                Err(LaunchError::NotYetProbed { .. })
            ));
        }

        let mut unreachable = running_and_reachable();
        unreachable.detail.as_mut().unwrap().health = Some(ServerHealth::Unreachable {
            error: "the relay answered 502".to_owned(),
        });
        assert!(matches!(
            ensure_launchable(RUTH, Some(&unreachable)),
            Err(LaunchError::Unreachable { error, .. }) if error == "the relay answered 502"
        ));
    }

    #[test]
    fn a_server_without_a_valid_certificate_is_refused() {
        let mut unreported = running_and_reachable();
        unreported.detail.as_mut().unwrap().certificate = None;
        assert!(matches!(
            ensure_launchable(RUTH, Some(&unreported)),
            Err(LaunchError::NoValidCertificate { .. })
        ));
        for status in [
            CertificateStatus::Ordering,
            CertificateStatus::OrderFailing,
            CertificateStatus::NotIssued,
            CertificateStatus::Expired,
            CertificateStatus::CacheUnreadable,
        ] {
            let mut without_a_valid_certificate = running_and_reachable();
            without_a_valid_certificate
                .detail
                .as_mut()
                .unwrap()
                .certificate
                .as_mut()
                .unwrap()
                .status = status;
            assert!(
                matches!(
                    ensure_launchable(RUTH, Some(&without_a_valid_certificate)),
                    Err(LaunchError::NoValidCertificate { .. })
                ),
                "{status:?}"
            );
        }
    }

    /// A running, reachable server's refusal for each certificate status, or
    /// none for a valid certificate, is the one the golden file pins:
    /// `servers-core` checks its own readiness against the same entries.
    #[test]
    fn each_certificate_status_s_refusal_is_as_the_golden_file_says() {
        let golden = golden();
        let statuses = [
            CertificateStatus::NotIssued,
            CertificateStatus::Ordering,
            CertificateStatus::NoRenewalNeeded,
            CertificateStatus::RenewalDue,
            CertificateStatus::Expired,
            CertificateStatus::CacheUnreadable,
            CertificateStatus::OrderFailing,
        ];
        for status in statuses {
            let mut unit_status = running_and_reachable();
            let certificate = unit_status
                .detail
                .as_mut()
                .unwrap()
                .certificate
                .as_mut()
                .unwrap();
            certificate.status = status;
            let wire_status = serde_json::to_value(ServerStatus {
                domain: RUTH.to_owned(),
                certificate: certificate.clone(),
                unit_status: unit_status.clone(),
            })
            .unwrap()["certificate"]["status"]
                .clone();
            let refusal = ensure_launchable(RUTH, Some(&unit_status))
                .err()
                .map(|error| error.kind());
            assert_eq!(
                serde_json::to_value(refusal).unwrap(),
                golden["launchRefusalsByCertificateStatus"][wire_status.as_str().unwrap()],
                "{status:?}"
            );
        }
        assert_eq!(
            golden["launchRefusalsByCertificateStatus"]
                .as_object()
                .unwrap()
                .len(),
            statuses.len(),
            "every certificate status is checked"
        );
    }

    /// Each golden status's refusal, or none for a launchable server, is the
    /// one the golden file pins: `servers-core` checks its own readiness
    /// against the same entries.
    #[test]
    fn each_golden_status_s_refusal_is_as_the_golden_file_says() {
        let golden = golden();
        for (name, status) in golden_statuses() {
            let refusal = ensure_launchable(RUTH, Some(&status.unit_status))
                .err()
                .map(|error| error.kind());
            assert_eq!(
                serde_json::to_value(refusal).unwrap(),
                golden["launchRefusals"][name],
                "{name}"
            );
        }
        assert_eq!(
            golden["launchRefusals"].as_object().unwrap().len(),
            golden_statuses().len(),
            "every golden status is checked"
        );
    }
}
