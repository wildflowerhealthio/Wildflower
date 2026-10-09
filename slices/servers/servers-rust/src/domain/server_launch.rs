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
use unit_runner::RunState;
use url::{form_urlencoded, Url};
use wildflower_server_rust::{CertificateStatus, ServerHealth};

use crate::domain::{LaunchError, ServerDetail, ServerStatus};

/// The URL a server's launcher opens at: `launcher_url` with `iss`, the
/// server's FHIR base (its `public_origin`, as
/// [`ServerRecord::public_origin`](crate::ServerRecord::public_origin) builds
/// it, at [`FHIR_R4_PATH`]), and the minted `launch` appended to its query.
/// Any `iss` or `launch` the launcher URL already carries is dropped; its
/// other query parameters are kept as they are written, byte for byte, and so
/// is its fragment.
#[must_use]
pub fn launch_url(launcher_url: &Url, public_origin: &Url, launch: &str) -> Url {
    let mut fhir_base = public_origin.clone();
    fhir_base.set_path(FHIR_R4_PATH);
    let launch_params = form_urlencoded::Serializer::new(String::new())
        .append_pair("iss", fhir_base.as_str())
        .append_pair("launch", launch)
        .finish();
    let query = launcher_url
        .query()
        .into_iter()
        .flat_map(|query| query.split('&'))
        .filter(|param| !param.is_empty() && !is_a_launch_param(param))
        .chain([launch_params.as_str()])
        .collect::<Vec<_>>()
        .join("&");
    let mut url = launcher_url.clone();
    url.set_query(Some(&query));
    url
}

/// Whether the query parameter `param`, one `name[=value]` of a query, is
/// named `iss` or `launch` once its name is decoded.
fn is_a_launch_param(param: &str) -> bool {
    form_urlencoded::parse(param.as_bytes())
        .next()
        .is_some_and(|(name, _)| name == "iss" || name == "launch")
}

/// The detail of the run of the server whose status is `status`, once the
/// server can be launched: its run is up, its `/health` has answered through
/// its relay, and its certificate is valid (no renewal needed, or renewal
/// due) and from a CA browsers trust. Nothing waits for any of them: the base waits, and asks again.
///
/// The certificate is the status's, the state the base receives: its run's,
/// once the run has reported one, or else what its cache says. So the base,
/// deciding from the same status, refuses what the host refuses.
///
/// # Errors
///
/// - [`LaunchError::ServerNotRunning`] when its run isn't up;
/// - [`LaunchError::NotYetProbed`] when its `/health` hasn't been asked yet,
///   or its run hasn't reported a detail;
/// - [`LaunchError::Unreachable`] when it didn't answer;
/// - [`LaunchError::NoValidCertificate`] when its certificate isn't valid;
/// - [`LaunchError::UntrustedCertificate`] when it is, but from a CA browsers
///   don't trust, such as Let's Encrypt's staging CA.
pub fn ensure_launchable(status: &ServerStatus) -> Result<&ServerDetail, LaunchError> {
    let domain = || status.domain.clone();
    if status.unit_status.run_state != RunState::Running {
        return Err(LaunchError::ServerNotRunning { domain: domain() });
    }
    // A run that hasn't reported its detail yet hasn't probed its health
    // either.
    let not_yet_probed = || LaunchError::NotYetProbed { domain: domain() };
    let detail = status
        .unit_status
        .detail
        .as_ref()
        .ok_or_else(not_yet_probed)?;
    match detail.health.as_ref().ok_or_else(not_yet_probed)? {
        ServerHealth::Unreachable { error } => {
            return Err(LaunchError::Unreachable {
                domain: domain(),
                error: error.clone(),
            })
        }
        ServerHealth::Reachable(_) => {}
    }
    if !matches!(
        status.certificate.status,
        CertificateStatus::NoRenewalNeeded | CertificateStatus::RenewalDue
    ) {
        return Err(LaunchError::NoValidCertificate { domain: domain() });
    }
    let issuer = status.certificate.issuer;
    if !issuer.is_browser_trusted() {
        return Err(LaunchError::UntrustedCertificate {
            domain: domain(),
            issuer,
        });
    }
    Ok(detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use unit_runner::UnitStatus;

    use crate::domain::server_status::tests::{
        cached, golden_statuses, running_and_reachable, RUTH,
    };
    use crate::domain::{golden, CertificateAuthority};

    fn launcher(url: &str) -> Url {
        Url::parse(url).unwrap()
    }

    fn ruth_origin() -> Url {
        tunnel_rust::public_origin_url(RUTH).unwrap()
    }

    #[test]
    fn the_launch_url_carries_the_server_s_fhir_base_and_the_launch() {
        assert_eq!(
            launch_url(
                &launcher("https://wildflowerhealth.io/owner-ui/"),
                &ruth_origin(),
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
            &ruth_origin(),
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
    fn the_launch_url_keeps_the_launcher_s_other_params_as_they_are_written() {
        let url = launch_url(
            &launcher("https://launcher.example/app?a=b%20c&flag&iss=old&%6Caunch=encoded"),
            &ruth_origin(),
            "nonce-1",
        );
        assert_eq!(
            url.query(),
            Some("a=b%20c&flag&iss=https%3A%2F%2Fruth.relay.example.com%2Ffhir-r4&launch=nonce-1")
        );
    }

    /// The status of [`RUTH`] whose `unit_status` is given, with its run's
    /// certificate, or, without one, a cache's valid one.
    fn status_of(unit_status: UnitStatus<ServerDetail>) -> ServerStatus {
        ServerStatus {
            domain: RUTH.to_owned(),
            certificate: ServerStatus::run_certificate(&unit_status)
                .cloned()
                .unwrap_or_else(|| cached(CertificateStatus::NoRenewalNeeded)),
            unit_status,
        }
    }

    /// The status of a running, reachable [`RUTH`] whose certificate's
    /// status is `certificate_status`.
    fn running_and_reachable_with(certificate_status: CertificateStatus) -> ServerStatus {
        let mut status = status_of(running_and_reachable());
        status.certificate.status = certificate_status;
        status
    }

    #[test]
    fn a_running_reachable_server_with_a_valid_certificate_is_launchable() {
        for certificate_status in [
            CertificateStatus::NoRenewalNeeded,
            CertificateStatus::RenewalDue,
        ] {
            assert!(
                ensure_launchable(&running_and_reachable_with(certificate_status)).is_ok(),
                "{certificate_status:?}"
            );
        }
    }

    #[test]
    fn a_server_that_isn_t_running_is_refused() {
        let starting = UnitStatus {
            run_state: RunState::Starting,
            ..running_and_reachable()
        };
        for unit_status in [starting, UnitStatus::never_run()] {
            assert!(matches!(
                ensure_launchable(&status_of(unit_status)),
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
                ensure_launchable(&status_of(unit_status)),
                Err(LaunchError::NotYetProbed { .. })
            ));
        }

        let mut unreachable = running_and_reachable();
        unreachable.detail.as_mut().unwrap().health = Some(ServerHealth::Unreachable {
            error: "the relay answered 502".to_owned(),
        });
        assert!(matches!(
            ensure_launchable(&status_of(unreachable)),
            Err(LaunchError::Unreachable { error, .. }) if error == "the relay answered 502"
        ));
    }

    #[test]
    fn a_server_without_a_valid_certificate_is_refused() {
        for certificate_status in [
            CertificateStatus::Ordering,
            CertificateStatus::OrderFailing,
            CertificateStatus::NotIssued,
            CertificateStatus::Expired,
            CertificateStatus::CacheUnreadable,
        ] {
            assert!(
                matches!(
                    ensure_launchable(&running_and_reachable_with(certificate_status)),
                    Err(LaunchError::NoValidCertificate { .. })
                ),
                "{certificate_status:?}"
            );
        }
    }

    #[test]
    fn a_valid_certificate_from_a_ca_browsers_don_t_trust_is_refused() {
        let mut on_staging = running_and_reachable_with(CertificateStatus::NoRenewalNeeded);
        on_staging.certificate.issuer = CertificateAuthority::LetsEncryptStaging;
        let refused = ensure_launchable(&on_staging);
        assert!(
            matches!(
                &refused,
                Err(LaunchError::UntrustedCertificate { issuer, .. })
                    if *issuer == CertificateAuthority::LetsEncryptStaging
            ),
            "{refused:?}"
        );
        // A certificate that isn't valid is refused as that first.
        on_staging.certificate.status = CertificateStatus::Ordering;
        assert!(matches!(
            ensure_launchable(&on_staging),
            Err(LaunchError::NoValidCertificate { .. })
        ));
    }

    /// Which CAs browsers trust is as the golden file says: `servers-core`
    /// checks its own against the same entries.
    #[test]
    fn the_browser_trusted_cas_are_as_the_golden_file_says() {
        let golden = golden();
        let authorities = [
            CertificateAuthority::LetsEncrypt,
            CertificateAuthority::LetsEncryptStaging,
        ];
        for authority in authorities {
            let wire_name = serde_json::to_value(authority).unwrap();
            assert_eq!(
                golden["browserTrustedCertificateAuthorities"][wire_name.as_str().unwrap()],
                authority.is_browser_trusted(),
                "{authority:?}"
            );
        }
        assert_eq!(
            golden["browserTrustedCertificateAuthorities"]
                .as_object()
                .unwrap()
                .len(),
            authorities.len(),
            "every CA is checked"
        );
    }

    #[test]
    fn a_run_that_hasn_t_reported_its_certificate_is_decided_by_the_cache_s() {
        let mut unreported = running_and_reachable();
        unreported.detail.as_mut().unwrap().certificate = None;
        let cached_as = |certificate_status| ServerStatus {
            certificate: cached(certificate_status),
            ..status_of(unreported.clone())
        };
        assert!(ensure_launchable(&cached_as(CertificateStatus::NoRenewalNeeded)).is_ok());
        assert!(matches!(
            ensure_launchable(&cached_as(CertificateStatus::Expired)),
            Err(LaunchError::NoValidCertificate { .. })
        ));
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
        for certificate_status in statuses {
            let status = running_and_reachable_with(certificate_status);
            let wire_status =
                serde_json::to_value(&status).unwrap()["certificate"]["status"].clone();
            let refusal = ensure_launchable(&status).err().map(|error| error.kind());
            assert_eq!(
                serde_json::to_value(refusal).unwrap(),
                golden["launchRefusalsByCertificateStatus"][wire_status.as_str().unwrap()],
                "{certificate_status:?}"
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
            let refusal = ensure_launchable(&status).err().map(|error| error.kind());
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
