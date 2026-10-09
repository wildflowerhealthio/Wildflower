//! [`ListedServer`], one registered server as the base lists it: what it
//! shows of the record, with the server's status on the unit runner and its
//! certificate's state.

use serde::{Serialize, Serializer};
use unit_runner::{RunPolicy, UnitId, UnitStatus, UnitStatuses};
use wildflower_server_rust::CertificateState;

use crate::domain::certificate_state_wire::CertificateStateWire;
use crate::domain::server_status::ServerStatusWire;
use crate::domain::{CertificateAuthority, RelayKind, ServerDetail, ServerRecord, ServerStatus};

/// One registered server, with its status on the unit runner and its
/// certificate's state.
///
/// `Serialize` writes camelCase
/// `{domain, relay, tunnelName, launcherUrl, certificateAuthority,
/// runPolicy, status, certificate}`, `status` being a [`ServerStatus`] as the
/// `server-status` event carries it, and `certificate` the status's
/// certificate state, written as the status writes it. Neither the token nor
/// the relay's dial settings are written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedServer {
    /// The server's record.
    pub record: ServerRecord,
    /// The server's status, with its certificate's state.
    pub status: ServerStatus,
}

impl ListedServer {
    /// Each of `records`, in order, with its status in `statuses`, keyed by
    /// domain: a server `UnitRunner` doesn't hold is listed as never run.
    /// Each server's certificate state is still to be found (see
    /// [`ServerStatus::run_certificate`]).
    #[must_use]
    pub fn unit_statuses(
        records: Vec<ServerRecord>,
        statuses: &UnitStatuses<ServerDetail>,
    ) -> Vec<(ServerRecord, UnitStatus<ServerDetail>)> {
        records
            .into_iter()
            .map(|record| {
                let unit_status = statuses
                    .get(&UnitId::new(record.domain()))
                    .cloned()
                    .unwrap_or_else(UnitStatus::never_run);
                (record, unit_status)
            })
            .collect()
    }

    /// The server `record` describes, with its `unit_status` and its
    /// `certificate`'s state.
    #[must_use]
    pub fn new(
        record: ServerRecord,
        unit_status: UnitStatus<ServerDetail>,
        certificate: CertificateState,
    ) -> Self {
        let status = ServerStatus {
            domain: record.domain(),
            unit_status,
            certificate,
        };
        Self { record, status }
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
        let status = &self.status;
        ListedServerWire {
            domain: &status.domain,
            relay: &self.record.relay,
            tunnel_name: self.record.tunnel_name.as_str(),
            launcher_url: self.record.launcher_url.as_str(),
            certificate_authority: self.record.certificate_authority,
            run_policy: self.record.run_policy,
            status: ServerStatusWire::of(&status.domain, &status.unit_status, &status.certificate),
            certificate: CertificateStateWire::of(&status.certificate),
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
    use crate::domain::fixtures::launcher_url;
    use crate::domain::server_status::tests::{
        golden, issued_certificate, running_and_reachable, stopped_with_an_error, LAB, RUTH,
    };
    use crate::TunnelToken;

    /// Each of `records` with its status in `statuses` and its run's
    /// certificate state, or else what its cache says: an expired
    /// certificate.
    fn list(
        records: Vec<ServerRecord>,
        statuses: &UnitStatuses<ServerDetail>,
    ) -> Vec<ListedServer> {
        ListedServer::unit_statuses(records, statuses)
            .into_iter()
            .map(|(record, unit_status)| {
                let certificate = ServerStatus::run_certificate(&unit_status)
                    .cloned()
                    .unwrap_or_else(|| {
                        CertificateState::of_cached(
                            Some(issued_certificate()),
                            record.certificate_authority,
                            Utc.with_ymd_and_hms(2027, 1, 1, 0, 0, 0).unwrap(),
                        )
                    });
                ListedServer::new(record, unit_status, certificate)
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
            launcher_url: launcher_url(),
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

        let listed = list(golden_records(), &statuses);

        assert_eq!(
            serde_json::to_value(&listed).unwrap(),
            golden()["listedServers"]
        );
    }

    #[test]
    fn a_server_the_runner_does_not_hold_is_listed_as_never_run() {
        let listed = ListedServer::unit_statuses(golden_records(), &UnitStatuses::new());
        assert_eq!(listed[0].1, UnitStatus::never_run());
        assert_eq!(listed[1].1, UnitStatus::never_run());
    }

    /// Only a status whose run has reported a certificate state carries it;
    /// any other needs what the cache says.
    #[test]
    fn only_a_run_that_reported_one_has_a_certificate_state() {
        assert_eq!(
            ServerStatus::run_certificate(&running_and_reachable())
                .map(|certificate| certificate.status),
            Some(CertificateStatus::NoRenewalNeeded)
        );
        assert_eq!(
            ServerStatus::run_certificate(&stopped_with_an_error()),
            None
        );
        assert_eq!(
            ServerStatus::run_certificate(&UnitStatus::never_run()),
            None
        );
    }

    /// A listed server's certificate is its status's.
    #[test]
    fn a_listed_server_s_certificate_is_its_status_s() {
        let statuses = [(UnitId::from(RUTH), running_and_reachable())]
            .into_iter()
            .collect();
        let listed = serde_json::to_value(list(golden_records(), &statuses)).unwrap();
        for server in listed.as_array().unwrap() {
            assert_eq!(server["certificate"], server["status"]["certificate"]);
        }
    }

    #[test]
    fn the_token_is_never_listed() {
        let listed = list(golden_records(), &UnitStatuses::new());
        let rendered = serde_json::to_string(&listed).unwrap();
        assert!(!rendered.contains("s3cret-tunnel-token"), "{rendered}");
        assert!(!rendered.contains("redacted"), "{rendered}");
        assert!(!rendered.contains("2333"), "{rendered}");
    }
}
