//! Changing a registered server, and choosing which servers run.
//!
//! [`set_run_policy`], [`update_server`] and [`remove_server`] each change the
//! registry in one [`ServerRegistry::modify`] or remove, so a change another
//! command makes at the same time is kept. [`servers_to_run`] is the choice
//! the host's reconciler starts and stops servers by.
//!
//! **At most one server runs.** [`MAX_RUNNING_SERVERS`] caps the servers
//! [`servers_to_run`] returns, and setting a policy other than
//! [`RunPolicy::Off`] on one server sets every other server `Off` in the same
//! change, so the cap never has to choose between active servers the user
//! picked.

use std::io;
use std::path::Path;

use chrono::{DateTime, Utc};
use url::Url;

use crate::domain::{RegistryError, RunPolicy, RunPolicyChoice, ServerChangeError, ServerRecord};
use crate::ports::ServerRegistry;

/// The most servers that run at once.
pub const MAX_RUNNING_SERVERS: usize = 1;

/// Set the run policy of the server with `domain` to `choice`, applied at
/// `now`, and return the policy stored. A policy other than
/// [`RunPolicy::Off`] sets every other server `Off` in the same change.
///
/// # Errors
///
/// The [`ServerChangeError`] [`RunPolicyChoice::into_run_policy_at`] refuses
/// `choice` with, [`RegistryError::NotRegistered`] when no server has
/// `domain`, or a registry failure. Nothing is written on any of them.
pub fn set_run_policy(
    registry: &dyn ServerRegistry,
    domain: &str,
    choice: RunPolicyChoice,
    now: DateTime<Utc>,
) -> Result<RunPolicy, ServerChangeError> {
    let run_policy = choice.into_run_policy_at(now)?;
    registry.modify(Box::new(|servers| {
        if !servers.iter().any(|server| server.domain() == domain) {
            return Err(not_registered(domain));
        }
        for server in servers.iter_mut() {
            if server.domain() == domain {
                server.run_policy = run_policy;
            } else if run_policy != RunPolicy::Off {
                server.run_policy = RunPolicy::Off;
            }
        }
        Ok(())
    }))?;
    Ok(run_policy)
}

/// Set the launcher the server with `domain` opens apps from, and whether
/// its certificates come from the ACME staging directory. Its other fields
/// are kept as they are when the change is made.
///
/// # Errors
///
/// [`ServerChangeError::InvalidLauncherUrl`] unless `launcher_url` is an
/// absolute `http` or `https` URL with a host and no credentials,
/// [`RegistryError::NotRegistered`] when no server has `domain`, or a registry
/// failure. Nothing is written on any of them.
pub fn update_server(
    registry: &dyn ServerRegistry,
    domain: &str,
    launcher_url: &str,
    staging_certificates: bool,
) -> Result<(), ServerChangeError> {
    let launcher_url = parse_launcher_url(launcher_url)?;
    registry.modify(Box::new(|servers| {
        let server = servers
            .iter_mut()
            .find(|server| server.domain() == domain)
            .ok_or_else(|| not_registered(domain))?;
        server.launcher_url = launcher_url;
        server.staging_certificates = staging_certificates;
        Ok(())
    }))?;
    Ok(())
}

/// Delete the server with `domain`: its folder under `data_root`, which holds
/// its databases and certificates, then its record. The server must not be
/// running.
///
/// The folder goes first, so a folder that can't be deleted leaves the server
/// registered and the removal can be retried; a folder already gone is fine.
///
/// # Errors
///
/// [`RegistryError::NotRegistered`] when no server has `domain`,
/// [`ServerChangeError::DeletingFolder`] when its folder can't be deleted, or
/// a registry failure.
pub fn remove_server(
    registry: &dyn ServerRegistry,
    data_root: &Path,
    domain: &str,
) -> Result<(), ServerChangeError> {
    let server = registry
        .read_all()?
        .into_iter()
        .find(|server| server.domain() == domain)
        .ok_or_else(|| not_registered(domain))?;
    match std::fs::remove_dir_all(server.server_dir(data_root)) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(ServerChangeError::DeletingFolder {
                domain: domain.to_owned(),
                source,
            })
        }
    }
    registry.remove(domain)?;
    Ok(())
}

/// The servers that should be running at `now`: those whose policy is active
/// ([`RunPolicy::is_active_at`]), in registry order, at most
/// [`MAX_RUNNING_SERVERS`] of them.
#[must_use]
pub fn servers_to_run(servers: Vec<ServerRecord>, now: DateTime<Utc>) -> Vec<ServerRecord> {
    servers
        .into_iter()
        .filter(|server| server.run_policy.is_active_at(now))
        .take(MAX_RUNNING_SERVERS)
        .collect()
}

/// A launcher URL as entered, if the base can open apps from it: an absolute
/// `http` or `https` URL with a host and no credentials.
fn parse_launcher_url(entered: &str) -> Result<Url, ServerChangeError> {
    let invalid = |reason: String| ServerChangeError::InvalidLauncherUrl { reason };
    let launcher_url = Url::parse(entered)
        .map_err(|error| invalid(format!("{entered:?} is not a URL: {error}")))?;
    if !matches!(launcher_url.scheme(), "http" | "https") {
        return Err(invalid(format!("{entered:?} is not an http or https URL")));
    }
    if launcher_url.host_str().is_none_or(str::is_empty) {
        return Err(invalid(format!("{entered:?} has no host")));
    }
    if !launcher_url.username().is_empty() || launcher_url.password().is_some() {
        return Err(invalid(format!("{entered:?} holds credentials")));
    }
    Ok(launcher_url)
}

fn not_registered(domain: &str) -> RegistryError {
    RegistryError::NotRegistered {
        domain: domain.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use chrono::{TimeDelta, TimeZone};

    use super::*;
    use crate::domain::fixtures::{official_record, self_hosted_record};
    use crate::JsonServerRegistry;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 6, 17, 0, 0).unwrap()
    }

    fn with_policy(record: ServerRecord, run_policy: RunPolicy) -> ServerRecord {
        ServerRecord {
            run_policy,
            ..record
        }
    }

    /// A registry in a fresh data root holding `servers`, in order.
    fn registry_holding(servers: &[ServerRecord]) -> (tempfile::TempDir, Arc<dyn ServerRegistry>) {
        let data_root = tempfile::tempdir().unwrap();
        let registry: Arc<dyn ServerRegistry> =
            Arc::new(JsonServerRegistry::in_data_root(data_root.path()));
        for server in servers {
            registry.insert(Box::new(|_| server.clone())).unwrap();
        }
        (data_root, registry)
    }

    fn policies(registry: &dyn ServerRegistry) -> Vec<RunPolicy> {
        registry
            .read_all()
            .unwrap()
            .into_iter()
            .map(|server| server.run_policy)
            .collect()
    }

    #[test]
    fn setting_a_policy_on_one_server_sets_the_others_off() {
        for choice in [
            RunPolicyChoice::WhileInUse,
            RunPolicyChoice::Always,
            RunPolicyChoice::For { seconds: 60 },
        ] {
            let (_data_root, registry) = registry_holding(&[
                with_policy(official_record("ruth"), RunPolicy::Always),
                official_record("lab"),
                with_policy(official_record("demo"), RunPolicy::WhileInUse),
            ]);

            let stored = set_run_policy(
                registry.as_ref(),
                "lab.relay.wildflowerhealth.io",
                choice,
                now(),
            )
            .unwrap();

            assert_eq!(
                policies(registry.as_ref()),
                vec![RunPolicy::Off, stored, RunPolicy::Off],
                "{choice:?}"
            );
        }
    }

    #[test]
    fn setting_a_server_off_leaves_the_others_as_they_are() {
        let (_data_root, registry) = registry_holding(&[
            with_policy(official_record("ruth"), RunPolicy::Always),
            with_policy(official_record("lab"), RunPolicy::WhileInUse),
        ]);

        set_run_policy(
            registry.as_ref(),
            "lab.relay.wildflowerhealth.io",
            RunPolicyChoice::Off,
            now(),
        )
        .unwrap();

        assert_eq!(
            policies(registry.as_ref()),
            vec![RunPolicy::Always, RunPolicy::Off]
        );
    }

    #[test]
    fn for_is_stored_as_until_its_deadline() {
        let (_data_root, registry) = registry_holding(&[official_record("ruth")]);

        let stored = set_run_policy(
            registry.as_ref(),
            "ruth.relay.wildflowerhealth.io",
            RunPolicyChoice::For { seconds: 7200 },
            now(),
        )
        .unwrap();

        let deadline = RunPolicy::Until {
            at: now() + TimeDelta::hours(2),
        };
        assert_eq!(stored, deadline);
        assert_eq!(policies(registry.as_ref()), vec![deadline]);
    }

    #[test]
    fn a_rejected_policy_writes_nothing() {
        let (_data_root, registry) = registry_holding(&[
            with_policy(official_record("ruth"), RunPolicy::Always),
            official_record("lab"),
        ]);

        for seconds in [0, -30] {
            assert!(matches!(
                set_run_policy(
                    registry.as_ref(),
                    "lab.relay.wildflowerhealth.io",
                    RunPolicyChoice::For { seconds },
                    now(),
                ),
                Err(ServerChangeError::NonPositiveDuration { .. })
            ));
        }
        assert_eq!(
            policies(registry.as_ref()),
            vec![RunPolicy::Always, RunPolicy::Off]
        );
    }

    #[test]
    fn a_policy_for_an_unregistered_server_writes_nothing() {
        let (_data_root, registry) =
            registry_holding(&[with_policy(official_record("ruth"), RunPolicy::Always)]);

        assert!(matches!(
            set_run_policy(
                registry.as_ref(),
                "lab.relay.wildflowerhealth.io",
                RunPolicyChoice::WhileInUse,
                now(),
            ),
            Err(ServerChangeError::Registry(RegistryError::NotRegistered { domain }))
                if domain == "lab.relay.wildflowerhealth.io"
        ));
        assert_eq!(policies(registry.as_ref()), vec![RunPolicy::Always]);
    }

    #[test]
    fn update_sets_the_launcher_and_staging_and_keeps_the_rest() {
        let ruth = with_policy(official_record("ruth"), RunPolicy::Always);
        let (_data_root, registry) = registry_holding(&[ruth.clone(), self_hosted_record("lab")]);

        update_server(
            registry.as_ref(),
            "ruth.relay.wildflowerhealth.io",
            "http://localhost:5200/app",
            true,
        )
        .unwrap();

        assert_eq!(
            registry.read_all().unwrap(),
            vec![
                ServerRecord {
                    launcher_url: Url::parse("http://localhost:5200/app").unwrap(),
                    staging_certificates: true,
                    ..ruth
                },
                self_hosted_record("lab"),
            ]
        );
    }

    #[test]
    fn a_launcher_the_base_cannot_open_is_refused() {
        let (_data_root, registry) = registry_holding(&[official_record("ruth")]);

        for launcher_url in [
            "",
            "/app",
            "ftp://launcher.example.com/",
            "file:///app",
            "https://user:secret@launcher.example.com/",
        ] {
            assert!(
                matches!(
                    update_server(
                        registry.as_ref(),
                        "ruth.relay.wildflowerhealth.io",
                        launcher_url,
                        true,
                    ),
                    Err(ServerChangeError::InvalidLauncherUrl { .. })
                ),
                "{launcher_url:?}"
            );
        }
        assert_eq!(registry.read_all().unwrap(), vec![official_record("ruth")]);
    }

    #[test]
    fn update_of_an_unregistered_server_is_refused() {
        let (_data_root, registry) = registry_holding(&[]);
        assert!(matches!(
            update_server(
                registry.as_ref(),
                "ruth.relay.wildflowerhealth.io",
                "https://wildflowerhealth.io/app",
                false,
            ),
            Err(ServerChangeError::Registry(
                RegistryError::NotRegistered { .. }
            ))
        ));
    }

    #[test]
    fn remove_deletes_the_server_s_folder_and_record_only() {
        let (data_root, registry) =
            registry_holding(&[official_record("ruth"), self_hosted_record("lab")]);
        let ruth_dir = official_record("ruth").server_dir(data_root.path());
        let lab_dir = self_hosted_record("lab").server_dir(data_root.path());
        for server_dir in [&ruth_dir, &lab_dir] {
            std::fs::create_dir_all(server_dir.join("certificates")).unwrap();
            std::fs::write(server_dir.join("wildflower.sqlite"), "data").unwrap();
        }

        remove_server(
            registry.as_ref(),
            data_root.path(),
            "ruth.relay.wildflowerhealth.io",
        )
        .unwrap();

        assert!(!ruth_dir.exists());
        assert!(lab_dir.join("wildflower.sqlite").exists());
        assert_eq!(
            registry.read_all().unwrap(),
            vec![self_hosted_record("lab")]
        );
    }

    #[test]
    fn remove_of_a_server_that_never_ran_needs_no_folder() {
        let (data_root, registry) = registry_holding(&[official_record("ruth")]);

        remove_server(
            registry.as_ref(),
            data_root.path(),
            "ruth.relay.wildflowerhealth.io",
        )
        .unwrap();

        assert_eq!(registry.read_all().unwrap(), Vec::new());
    }

    #[test]
    fn remove_of_an_unregistered_server_deletes_nothing() {
        let (data_root, registry) = registry_holding(&[]);
        let ruth_dir = official_record("ruth").server_dir(data_root.path());
        std::fs::create_dir_all(&ruth_dir).unwrap();

        assert!(matches!(
            remove_server(
                registry.as_ref(),
                data_root.path(),
                "ruth.relay.wildflowerhealth.io",
            ),
            Err(ServerChangeError::Registry(
                RegistryError::NotRegistered { .. }
            ))
        ));
        assert!(ruth_dir.exists());
    }

    /// A folder that can't be deleted keeps the server registered, so the
    /// removal can be tried again.
    #[cfg(unix)]
    #[test]
    fn a_folder_that_cannot_be_deleted_keeps_the_server() {
        use std::os::unix::fs::PermissionsExt;

        let (data_root, registry) = registry_holding(&[official_record("ruth")]);
        let ruth_dir = official_record("ruth").server_dir(data_root.path());
        std::fs::create_dir_all(ruth_dir.join("certificates")).unwrap();
        let servers_dir = ruth_dir.parent().unwrap().to_owned();
        std::fs::set_permissions(&servers_dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let result = remove_server(
            registry.as_ref(),
            data_root.path(),
            "ruth.relay.wildflowerhealth.io",
        );

        std::fs::set_permissions(&servers_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            matches!(result, Err(ServerChangeError::DeletingFolder { ref domain, .. }) if domain == "ruth.relay.wildflowerhealth.io"),
            "{result:?}"
        );
        assert_eq!(registry.read_all().unwrap(), vec![official_record("ruth")]);
    }

    #[test]
    fn the_servers_to_run_are_those_whose_policy_is_active_capped_at_one() {
        let ended = with_policy(
            official_record("ended"),
            RunPolicy::Until {
                at: now() - TimeDelta::minutes(5),
            },
        );
        let until = with_policy(
            official_record("until"),
            RunPolicy::Until {
                at: now() + TimeDelta::minutes(5),
            },
        );
        let always = with_policy(official_record("always"), RunPolicy::Always);
        let domains = |servers: Vec<ServerRecord>| -> Vec<String> {
            servers_to_run(servers, now())
                .iter()
                .map(ServerRecord::domain)
                .collect()
        };

        assert_eq!(domains(Vec::new()), Vec::<String>::new());
        assert_eq!(
            domains(vec![official_record("off"), ended.clone()]),
            Vec::<String>::new()
        );
        assert_eq!(
            domains(vec![
                official_record("off"),
                ended,
                until.clone(),
                always.clone()
            ]),
            vec![until.domain()]
        );
        assert_eq!(
            domains(vec![with_policy(
                official_record("ruth"),
                RunPolicy::WhileInUse
            )]),
            vec!["ruth.relay.wildflowerhealth.io".to_owned()]
        );
        assert_eq!(domains(vec![always.clone()]), vec![always.domain()]);
    }
}
