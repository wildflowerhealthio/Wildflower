//! Launching a server's launcher: whether the server can be launched now
//! ([`ensure_launchable`]) and the URL its launcher opens at
//! ([`launch_url`]); the URL its Authorization app opens at
//! ([`authorization_app_url`]); the sign-in either opens through
//! ([`sign_in_url`]); and the sign-in that opens the consent waiting on the
//! server at its page ([`consent_sign_in_url`]).
//!
//! A SMART EHR launch hands the launcher two query parameters, and they are
//! the only credentials the launched app gets: `iss`, the server's FHIR base,
//! and `launch`, a value the server's authorization server minted for any client. The
//! app's `/oauth/authorize` presents the `launch` and parks a consent, which
//! the server's consent card answers in a browser signed in as the Owner. A
//! consent asked from another browser or device is opened at its page by the
//! base, signed in the same way.
//!
//! The base opens none of these URLs itself: it opens [`sign_in_url`], which
//! signs the browser in as the Owner with a one-time code and sends it on to
//! the launch, Authorization or consent URL.

use url::{form_urlencoded, Position, Url};
use wildflowerhealthio_tunnel::TunnelState;
use wildflowerhealthio_unit_runner::RunState;
use wildflowerhealthio_wildflower_server::{CertificateStatus, ServerHealth};

use crate::domain::{ConsentKey, LaunchError, ServerDetail, ServerStatus};

/// The URL a server's launcher opens at: `launcher_url` with `iss`, the
/// server's FHIR base (its `public_origin`, as
/// [`ServerRecord::public_origin`](crate::ServerRecord::public_origin) builds
/// it, where FHIR is served), and the minted `launch` appended to its query.
/// Any `iss` or `launch` the launcher URL already carries is dropped; its
/// other query parameters are kept as they are written, byte for byte, and so
/// is its fragment.
#[must_use]
pub fn launch_url(launcher_url: &Url, public_origin: &Url, launch: &str) -> Url {
    let fhir_base = wildflowerhealthio_shared_structures::origin_string(public_origin);
    with_query_params(launcher_url, &[("iss", &fhir_base), ("launch", launch)])
}

/// The URL a server's Authorization app opens at: `authorization_url` with
/// `iss`, the server's FHIR base (its `public_origin`), appended to its
/// query. Any `iss` the Authorization URL already carries is dropped; its
/// other query parameters are kept as they are written, byte for byte, and so
/// is its fragment.
#[must_use]
pub fn authorization_app_url(authorization_url: &Url, public_origin: &Url) -> Url {
    let fhir_base = wildflowerhealthio_shared_structures::origin_string(public_origin);
    with_query_params(authorization_url, &[("iss", &fhir_base)])
}

/// The URL that signs a browser in as the Owner on the server at
/// `public_origin` with the same-device sign-in `code`, then sends it on to
/// `next`: `https://<domain>/oauth/sign-in?code=…&next=…`.
///
/// # Panics
///
/// Never: an absolute path joined to an origin is a URL.
#[must_use]
pub fn sign_in_url(public_origin: &Url, code: &str, next: &str) -> Url {
    let mut url = public_origin
        .join("/oauth/sign-in")
        .expect("an absolute path joined to an origin is a URL");
    url.query_pairs_mut()
        .append_pair("code", code)
        .append_pair("next", next);
    url
}

/// The URL that signs a browser in as the Owner on the server at
/// `public_origin` with the same-device sign-in `code`, then sends it on to
/// the page that decides the consent `consent`, with `then=back`, so the page
/// goes back, or closes, once it is decided, rather than sending the browser
/// on to the client: the browser or device that asked finishes the flow.
///
/// The page is a path on the server, the one kind of `next` the sign-in
/// allows on its own origin: `/oauth/authorize/{id}/consent?then=back` for
/// an app's authorization request, `/oauth/device?user_code=…&then=back` for
/// a device's or a browser pairing's.
///
/// # Panics
///
/// Never: an absolute path joined to an origin is a URL.
#[must_use]
pub fn consent_sign_in_url(public_origin: &Url, code: &str, consent: &ConsentKey) -> Url {
    let mut page = public_origin
        .join("/oauth/")
        .expect("an absolute path joined to an origin is a URL");
    match consent {
        ConsentKey::AuthorizationCode { id } => {
            page.path_segments_mut()
                .expect("a URL joined to an origin has path segments")
                .pop_if_empty()
                .extend(["authorize", id, "consent"]);
            page.query_pairs_mut().append_pair("then", "back");
        }
        ConsentKey::DeviceCode { user_code } | ConsentKey::BrowserPairing { user_code } => {
            page.path_segments_mut()
                .expect("a URL joined to an origin has path segments")
                .pop_if_empty()
                .push("device");
            page.query_pairs_mut()
                .append_pair("user_code", user_code)
                .append_pair("then", "back");
        }
    }
    sign_in_url(public_origin, code, &page[Position::BeforePath..])
}

/// `url` with `params` appended to its query, encoded, after its own
/// parameters but those named as one of `params` is, which are dropped. Its
/// other parameters are kept as they are written, byte for byte, and so is its
/// fragment.
fn with_query_params(url: &Url, params: &[(&str, &str)]) -> Url {
    let appended = form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params)
        .finish();
    let query = url
        .query()
        .into_iter()
        .flat_map(|query| query.split('&'))
        .filter(|param| !param.is_empty() && !is_named_as_one_of(param, params))
        .chain([appended.as_str()])
        .collect::<Vec<_>>()
        .join("&");
    let mut url = url.clone();
    url.set_query(Some(&query));
    url
}

/// Whether the query parameter `param`, one `name[=value]` of a query, is
/// named as one of `params` is once its name is decoded.
fn is_named_as_one_of(param: &str, params: &[(&str, &str)]) -> bool {
    form_urlencoded::parse(param.as_bytes())
        .next()
        .is_some_and(|(name, _)| params.iter().any(|(param_name, _)| name == *param_name))
}

/// The detail of the run of the server whose status is `status`, once the
/// server can be launched: its run is up, its relay hasn't refused its
/// tunnel, its `/health` has answered through its relay, and its certificate
/// is valid (no renewal needed, or renewal due) and from a CA browsers trust.
/// Nothing waits for any of them: the base waits, and asks again.
///
/// The certificate is the status's, the state the base receives: its run's,
/// once the run has reported one, or else what its cache says. So the base,
/// deciding from the same status, refuses what the host refuses.
///
/// # Errors
///
/// - [`LaunchError::ServerNotRunning`] when its run isn't up;
/// - [`LaunchError::TokenRejected`] when the relay refused its tunnel's token;
/// - [`LaunchError::TunnelUnknown`] when the relay has no tunnel of its name;
/// - [`LaunchError::NotYetProbed`] when its run hasn't reported a detail, or
///   its `/health` hasn't been asked yet;
/// - [`LaunchError::Unreachable`] when it didn't answer;
/// - [`LaunchError::NoValidCertificate`] when its certificate isn't valid;
/// - [`LaunchError::UntrustedCertificate`] when it is, but from a CA browsers
///   don't trust, such as Let's Encrypt's staging CA.
pub fn ensure_launchable(status: &ServerStatus) -> Result<&ServerDetail, LaunchError> {
    let domain = &status.domain;
    if status.unit_status.run_state != RunState::Running {
        return Err(LaunchError::ServerNotRunning {
            domain: domain.clone(),
        });
    }
    // A run that hasn't reported its detail yet hasn't probed its health
    // either.
    let not_yet_probed = || LaunchError::NotYetProbed {
        domain: domain.clone(),
    };
    let detail = status
        .unit_status
        .detail
        .as_ref()
        .ok_or_else(not_yet_probed)?;
    // A refused tunnel is refused before the health: the monitor stops after
    // its first answer, so a reachable health may predate the refusal.
    match detail.tunnel {
        Some(TunnelState::TokenRejected) => {
            return Err(LaunchError::TokenRejected {
                domain: domain.clone(),
            })
        }
        Some(TunnelState::TunnelUnknown) => {
            return Err(LaunchError::TunnelUnknown {
                domain: domain.clone(),
            })
        }
        Some(
            TunnelState::Connecting | TunnelState::Connected | TunnelState::Reconnecting { .. },
        )
        | None => {}
    }
    match detail.health.as_ref().ok_or_else(not_yet_probed)? {
        ServerHealth::Unreachable { error } => {
            return Err(LaunchError::Unreachable {
                domain: domain.clone(),
                error: error.clone(),
            })
        }
        ServerHealth::Reachable(_) => {}
    }
    if !matches!(
        status.certificate.status,
        CertificateStatus::NoRenewalNeeded | CertificateStatus::RenewalDue
    ) {
        return Err(LaunchError::NoValidCertificate {
            domain: domain.clone(),
        });
    }
    let issuer = status.certificate.issuer;
    if !issuer.is_browser_trusted() {
        return Err(LaunchError::UntrustedCertificate {
            domain: domain.clone(),
            issuer,
        });
    }
    Ok(detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wildflowerhealthio_shared_structures::health_check::HealthReport;
    use wildflowerhealthio_unit_runner::UnitStatus;

    use crate::domain::server_status::tests::{
        cached, golden_statuses, running_and_reachable, RUTH,
    };
    use crate::domain::{golden, CertificateAuthority};

    fn launcher(url: &str) -> Url {
        Url::parse(url).unwrap()
    }

    fn ruth_origin() -> Url {
        wildflowerhealthio_tunnel::public_origin_url(RUTH).unwrap()
    }

    #[test]
    fn the_launch_url_carries_the_server_s_fhir_base_and_the_launch() {
        assert_eq!(
            launch_url(
                &launcher("https://launcher.wildflowerhealth.io/"),
                &ruth_origin(),
                "nonce-1"
            )
            .as_str(),
            "https://launcher.wildflowerhealth.io/?iss=https%3A%2F%2Fruth.relay.example.com&launch=nonce-1"
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
                    "https://ruth.relay.example.com".to_owned()
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
            Some("a=b%20c&flag&iss=https%3A%2F%2Fruth.relay.example.com&launch=nonce-1")
        );
    }

    #[test]
    fn the_authorization_app_url_carries_the_server_s_fhir_base() {
        assert_eq!(
            authorization_app_url(
                &launcher("https://authorization.wildflowerhealth.io/"),
                &ruth_origin()
            )
            .as_str(),
            "https://authorization.wildflowerhealth.io/?iss=https%3A%2F%2Fruth.relay.example.com"
        );
    }

    #[test]
    fn the_authorization_app_url_keeps_its_query_and_fragment_and_replaces_its_iss() {
        let url = authorization_app_url(
            &launcher(
                "https://manage.example/app?a=b%20c&iss=https://other.example&launch=kept#/grants",
            ),
            &ruth_origin(),
        );
        assert_eq!(
            url.query(),
            Some("a=b%20c&launch=kept&iss=https%3A%2F%2Fruth.relay.example.com")
        );
        assert_eq!(url.fragment(), Some("/grants"));
    }

    #[test]
    fn the_sign_in_url_carries_the_code_and_where_to_go_next() {
        let next = launch_url(
            &launcher("https://launcher.example/app?theme=dark"),
            &ruth_origin(),
            "nonce-1",
        );
        let url = sign_in_url(&ruth_origin(), "code-1", next.as_str());
        assert_eq!(url.origin(), ruth_origin().origin());
        assert_eq!(url.path(), "/oauth/sign-in");
        assert_eq!(
            url.query_pairs()
                .map(|(name, value)| (name.into_owned(), value.into_owned()))
                .collect::<Vec<_>>(),
            [
                ("code".to_owned(), "code-1".to_owned()),
                ("next".to_owned(), next.to_string()),
            ]
        );
    }

    /// The `next` the sign-in `url` sends the browser on to.
    fn next_of(url: &Url) -> String {
        url.query_pairs()
            .find_map(|(name, value)| (name == "next").then(|| value.into_owned()))
            .expect("a next")
    }

    #[test]
    fn an_app_s_consent_opens_at_its_card_on_the_server_then_goes_back() {
        let url = consent_sign_in_url(
            &ruth_origin(),
            "code-1",
            &ConsentKey::AuthorizationCode {
                id: "req/1 ?".to_owned(),
            },
        );
        assert_eq!(url.origin(), ruth_origin().origin());
        assert_eq!(url.path(), "/oauth/sign-in");
        assert_eq!(
            url.query_pairs()
                .next()
                .map(|(name, value)| (name.into_owned(), value.into_owned())),
            Some(("code".to_owned(), "code-1".to_owned()))
        );
        assert_eq!(
            next_of(&url),
            "/oauth/authorize/req%2F1%20%3F/consent?then=back"
        );
    }

    #[test]
    fn a_device_s_consent_opens_at_the_device_page_with_its_code_then_goes_back() {
        let url = consent_sign_in_url(
            &ruth_origin(),
            "code-1",
            &ConsentKey::DeviceCode {
                user_code: "ABCD-EFGH".to_owned(),
            },
        );
        assert_eq!(next_of(&url), "/oauth/device?user_code=ABCD-EFGH&then=back");
    }

    #[test]
    fn a_browser_pairing_s_consent_opens_at_the_device_page_with_its_code_then_goes_back() {
        let url = consent_sign_in_url(
            &ruth_origin(),
            "code-1",
            &ConsentKey::BrowserPairing {
                user_code: "WXYZ-BCDF".to_owned(),
            },
        );
        assert_eq!(next_of(&url), "/oauth/device?user_code=WXYZ-BCDF&then=back");
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
    fn a_server_whose_relay_refused_its_tunnel_is_refused_whatever_its_health() {
        for health in [Some(ServerHealth::Reachable(HealthReport::pass())), None] {
            let refused_as = |tunnel| {
                let mut refused = running_and_reachable();
                let detail = refused.detail.as_mut().unwrap();
                detail.health.clone_from(&health);
                detail.tunnel = Some(tunnel);
                ensure_launchable(&status_of(refused)).map(|_| ())
            };
            assert!(
                matches!(
                    refused_as(TunnelState::TokenRejected),
                    Err(LaunchError::TokenRejected { .. })
                ),
                "{health:?}"
            );
            assert!(
                matches!(
                    refused_as(TunnelState::TunnelUnknown),
                    Err(LaunchError::TunnelUnknown { .. })
                ),
                "{health:?}"
            );
        }
        // A tunnel that is dialing again is no refusal of its own.
        let mut reconnecting = running_and_reachable();
        reconnecting.detail.as_mut().unwrap().tunnel = Some(TunnelState::Reconnecting {
            error: "the relay closed the connection".to_owned(),
        });
        assert!(ensure_launchable(&status_of(reconnecting)).is_ok());
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

    /// Which CAs browsers trust is as the golden file says: `servers-core-js`
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
    /// `servers-core-js` checks its own readiness against the same entries.
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
    /// one the golden file pins: `servers-core-js` checks its own readiness
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
