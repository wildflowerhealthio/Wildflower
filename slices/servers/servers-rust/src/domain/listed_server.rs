//! [`ListedServer`], one registered server as the base lists it: what it
//! shows of the record, with the server's status on the unit runner and its
//! certificate's state.

use serde::{Serialize, Serializer};
use unit_runner::{RunPolicy, UnitId, UnitStatus, UnitStatuses};
use wildflower_server_rust::CertificateState;

use crate::domain::certificate_state_wire::CertificateStateWire;
use crate::domain::server_status::ServerStatusWire;
use crate::domain::{CertificateAuthority, RelayKind, ServerDetail, ServerRecord};

/// One registered server, with its status on the unit runner and the state
/// of the certificate its cache holds.
///
/// `Serialize` writes camelCase
/// `{domain, relay, tunnelName, launcherUrl, certificateAuthority,
/// runPolicy, status, certificate}`, `status` being a
/// [`ServerStatus`](crate::ServerStatus) as the `server-status` event carries
/// it, and `certificate` the certificate state its run reported, or, with
/// none, its `cached_certificate`, written as the status writes one. Neither
/// the token nor the relay's dial settings are written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedServer {
    /// The server's record.
    pub record: ServerRecord,
    /// What `UnitRunner` reports for the server.
    pub unit_status: UnitStatus<ServerDetail>,
    /// What the server's certificate cache says (see
    /// [`CertificateState::of_cached`]).
    pub cached_certificate: CertificateState,
}

impl ListedServer {
    /// Each of `records`, in order, with its status in `statuses`, keyed by
    /// domain, and the state of the certificate its cache holds. A server
    /// `UnitRunner` doesn't hold is listed as never run.
    #[must_use]
    pub fn list(
        records: Vec<(ServerRecord, CertificateState)>,
        statuses: &UnitStatuses<ServerDetail>,
    ) -> Vec<Self> {
        records
            .into_iter()
            .map(|(record, cached_certificate)| {
                let unit_status = statuses
                    .get(&UnitId::new(record.domain()))
                    .cloned()
                    .unwrap_or_else(UnitStatus::never_run);
                Self {
                    record,
                    unit_status,
                    cached_certificate,
                }
            })
            .collect()
    }

    /// The certificate state the server's run reported, or, without one,
    /// the state of the certificate its cache holds.
    #[must_use]
    pub fn certificate(&self) -> &CertificateState {
        self.unit_status
            .detail
            .as_ref()
            .and_then(|detail| detail.certificate.as_ref())
            .unwrap_or(&self.cached_certificate)
    }
}

/// [`ListedServer`]'s wire shape, borrowed from the server it writes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListedServerWire<'a> {
    domain: &'a str,
    relay: &'a RelayKind,
    tunnel_name: &'a str,
    launcher_url: &'a str,
    certificate_authority: CertificateAuthority,
    run_policy: RunPolicy,
    status: ServerStatusWire<'a>,
    certificate: CertificateStateWire<'a>,
}

impl Serialize for ListedServer {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let domain = self.record.domain();
        ListedServerWire {
            domain: &domain,
            relay: &self.record.relay,
            tunnel_name: self.record.tunnel_name.as_str(),
            launcher_url: self.record.launcher_url.as_str(),
            certificate_authority: self.record.certificate_authority,
            run_policy: self.record.run_policy,
            status: ServerStatusWire::of(&domain, &self.unit_status),
            certificate: CertificateStateWire::of(self.certificate()),
        }
        .serialize(serializer)
    }
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};
    use rathole_settings_rust::{NoisePattern, PublicRatholeSettings, Transport, TunnelName};
    use url::Url;

    use wildflower_server_rust::CertificateStatus;

    use super::*;
    use crate::domain::server_status::tests::{
        golden, issued_certificate, running_and_reachable, stopped_with_an_error, LAB, RUTH,
    };
    use crate::TunnelToken;

    /// What each golden server's cache holds: the certificate its run
    /// reports, for the running one, and an expired one for the stopped one.
    fn with_cached_certificates(
        records: Vec<ServerRecord>,
    ) -> Vec<(ServerRecord, CertificateState)> {
        records
            .into_iter()
            .map(|record| {
                let cached = CertificateState::of_cached(
                    Some(issued_certificate()),
                    record.certificate_authority,
                    Utc.with_ymd_and_hms(2027, 1, 1, 0, 0, 0).unwrap(),
                );
                (record, cached)
            })
            .collect()
    }

    fn record(relay: RelayKind, tunnel_name: &str, relay_domain: &str) -> ServerRecord {
        ServerRecord {
            relay,
            tunnel_name: TunnelName::parse(tunnel_name).unwrap(),
            token: TunnelToken::new("s3cret-tunnel-token"),
            public_settings: PublicRatholeSettings {
                remote_addr: format!("{relay_domain}:2333"),
                transport: Transport::Noise,
                noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
                public_key: "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=".to_owned(),
                domain: relay_domain.to_owned(),
            },
            launcher_url: ServerRecord::default_launcher_url(),
            certificate_authority: CertificateAuthority::LetsEncrypt,
            run_policy: RunPolicy::Off,
        }
    }

    /// The two servers the golden file lists.
    fn golden_records() -> Vec<ServerRecord> {
        vec![
            ServerRecord {
                run_policy: RunPolicy::Until {
                    at: Utc.with_ymd_and_hms(2026, 10, 6, 17, 42, 0).unwrap(),
                },
                ..record(
                    RelayKind::SelfHostedWildflower {
                        base_url: Url::parse("https://relay.example.com").unwrap(),
                    },
                    "ruth",
                    "relay.example.com",
                )
            },
            ServerRecord {
                launcher_url: Url::parse("http://localhost:5200/app").unwrap(),
                certificate_authority: CertificateAuthority::LetsEncryptStaging,
                ..record(RelayKind::Rathole, "lab", "rathole.example.com")
            },
        ]
    }

    #[test]
    fn each_server_is_listed_with_its_status_as_the_golden_file_says() {
        let statuses = [
            (UnitId::from(RUTH), running_and_reachable()),
            (UnitId::from(LAB), stopped_with_an_error()),
        ]
        .into_iter()
        .collect();

        let listed = ListedServer::list(with_cached_certificates(golden_records()), &statuses);

        assert_eq!(
            serde_json::to_value(&listed).unwrap(),
            golden()["listedServers"]
        );
    }

    #[test]
    fn a_server_the_runner_does_not_hold_is_listed_as_never_run() {
        let listed = ListedServer::list(
            with_cached_certificates(golden_records()),
            &UnitStatuses::new(),
        );
        assert_eq!(listed[0].unit_status, UnitStatus::never_run());
        assert_eq!(listed[1].unit_status, UnitStatus::never_run());
    }

    /// A running server lists the certificate state its run reports; a
    /// stopped one the state of the certificate its cache holds, a lapsed one
    /// `Expired`.
    #[test]
    fn a_server_lists_its_run_s_certificate_or_else_its_cached_one() {
        let statuses = [(UnitId::from(RUTH), running_and_reachable())]
            .into_iter()
            .collect();
        let listed = ListedServer::list(with_cached_certificates(golden_records()), &statuses);
        assert_eq!(
            listed[0].certificate().status,
            CertificateStatus::NoRenewalNeeded
        );
        assert_eq!(listed[1].certificate().status, CertificateStatus::Expired);
    }

    #[test]
    fn the_token_is_never_listed() {
        let listed = ListedServer::list(
            with_cached_certificates(golden_records()),
            &UnitStatuses::new(),
        );
        let rendered = serde_json::to_string(&listed).unwrap();
        assert!(!rendered.contains("s3cret-tunnel-token"), "{rendered}");
        assert!(!rendered.contains("redacted"), "{rendered}");
        assert!(!rendered.contains("2333"), "{rendered}");
    }
}
