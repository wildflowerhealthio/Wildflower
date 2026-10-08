//! Changing a registered server.
//!
//! [`set_run_policy`], [`update_server`] and [`remove_server`] each change the
//! registry in one [`ServerRegistry::modify`] or remove, so a change another
//! command makes at the same time is kept. Each touches only the server it
//! names: setting one server's policy leaves every other server's as it is.

use std::io;
use std::path::Path;

use chrono::{DateTime, Utc};
use unit_runner::RunPolicy;
use url::Url;

use crate::domain::{RegistryError, RunPolicyChoice, ServerChangeError, ServerRecord};
use crate::ports::ServerRegistry;

/// Set the run policy of the server with `domain` to `choice`, applied at
/// `now`, and return the policy stored. Every other server keeps its own
/// policy.
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
        let server = servers
            .iter_mut()
            .find(|server| server.domain() == domain)
            .ok_or_else(|| not_registered(domain))?;
        server.run_policy = run_policy;
        Ok(())
    }))?;
    Ok(run_policy)
}

/// What [`update_server`] wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerUpdate {
    /// The server's record as written.
    pub record: ServerRecord,
    /// Whether a field a run reads changed (see
    /// [`ServerRecord::run_inputs_differ`]), so a run built from the record
    /// before could differ from one built from `record`.
    pub run_inputs_changed: bool,
}

/// Set the launcher the server with `domain` opens apps from, and whether
/// its certificates come from the ACME staging directory, and return what
/// was written. Its other fields are kept as they are when the change is
/// made.
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
) -> Result<ServerUpdate, ServerChangeError> {
    let launcher_url = parse_launcher_url(launcher_url)?;
    let mut update = None;
    registry.modify(Box::new(|servers| {
        let server = servers
            .iter_mut()
            .find(|server| server.domain() == domain)
            .ok_or_else(|| not_registered(domain))?;
        let before = server.clone();
        server.launcher_url = launcher_url;
        server.staging_certificates = staging_certificates;
        update = Some(ServerUpdate {
            run_inputs_changed: before.run_inputs_differ(server),
            record: server.clone(),
        });
        Ok(())
    }))?;
    Ok(update.expect("a change that succeeds has updated the record"))
}

/// Delete the server with `domain`: its run policy is set to
/// [`RunPolicy::Off`], then its folder under `data_root`, which holds its
/// databases and certificates, is deleted, then its record. The server must
/// not be running.
///
/// The folder goes before the record, so a folder that can't be deleted
/// leaves the server registered and the removal can be retried; a folder
/// already gone is fine. A deletion that fails partway leaves the server
/// registered with only part of its folder, so some of its databases or
/// certificates may already be gone; retrying deletes the rest. Its policy is
/// already `Off` by then, so it doesn't run on what's left.
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
    let mut server_dir = None;
    registry.modify(Box::new(|servers| {
        let server = servers
            .iter_mut()
            .find(|server| server.domain() == domain)
            .ok_or_else(|| not_registered(domain))?;
        server.run_policy = RunPolicy::Off;
        server_dir = Some(server.server_dir(data_root));
        Ok(())
    }))?;
    let server_dir = server_dir.expect("a change that succeeds has found the record");
    match std::fs::remove_dir_all(server_dir) {
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
    fn setting_a_policy_on_one_server_leaves_the_others_as_they_are() {
        let ended = RunPolicy::Until {
            at: now() - TimeDelta::minutes(5),
        };
        for choice in [
            RunPolicyChoice::Off,
            RunPolicyChoice::WhileOpen,
            RunPolicyChoice::Always,
            RunPolicyChoice::For { seconds: 60 },
        ] {
            let (_data_root, registry) = registry_holding(&[
                with_policy(official_record("ruth"), RunPolicy::Always),
                official_record("lab"),
                with_policy(official_record("demo"), RunPolicy::WhileOpen),
                with_policy(official_record("clinic"), ended),
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
                vec![RunPolicy::Always, stored, RunPolicy::WhileOpen, ended],
                "{choice:?}"
            );
        }
    }

    /// An `Until` whose deadline has passed no longer wants its server running,
    /// but nothing rewrites it: it stays in the file exactly as it was set.
    #[test]
    fn an_expired_until_stays_in_the_file() {
        let (data_root, registry) = registry_holding(&[official_record("ruth")]);
        let stored = set_run_policy(
            registry.as_ref(),
            "ruth.relay.wildflowerhealth.io",
            RunPolicyChoice::For { seconds: 60 },
            now(),
        )
        .unwrap();
        let after_the_deadline = now() + TimeDelta::minutes(5);
        assert!(!stored.wants_running(after_the_deadline, true));

        update_server(
            registry.as_ref(),
            "ruth.relay.wildflowerhealth.io",
            "https://launcher.example.com/",
            false,
        )
        .unwrap();

        assert_eq!(
            JsonServerRegistry::in_data_root(data_root.path())
                .read_all()
                .unwrap()[0]
                .run_policy,
            stored
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
                RunPolicyChoice::WhileOpen,
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

        let update = update_server(
            registry.as_ref(),
            "ruth.relay.wildflowerhealth.io",
            "http://localhost:5200/app",
            true,
        )
        .unwrap();

        let updated = ServerRecord {
            launcher_url: Url::parse("http://localhost:5200/app").unwrap(),
            staging_certificates: true,
            ..ruth
        };
        assert_eq!(
            update,
            ServerUpdate {
                record: updated.clone(),
                run_inputs_changed: true,
            }
        );
        assert_eq!(
            registry.read_all().unwrap(),
            vec![updated, self_hosted_record("lab")]
        );
    }

    #[test]
    fn update_says_whether_a_field_a_run_reads_changed() {
        let (_data_root, registry) = registry_holding(&[official_record("ruth")]);
        let update = |launcher_url, staging_certificates| {
            update_server(
                registry.as_ref(),
                "ruth.relay.wildflowerhealth.io",
                launcher_url,
                staging_certificates,
            )
            .unwrap()
            .run_inputs_changed
        };

        assert!(
            !update("http://localhost:5200/app", false),
            "only the base reads the launcher"
        );
        assert!(
            !update("http://localhost:5200/app", false),
            "nothing changed"
        );
        assert!(
            update("http://localhost:5200/app", true),
            "the certificate source"
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
        for server in [official_record("ruth"), self_hosted_record("lab")] {
            let server_dir = server.server_dir(data_root.path());
            std::fs::create_dir_all(server.certificate_dir(data_root.path())).unwrap();
            std::fs::write(server_dir.join("wildflower.sqlite"), "data").unwrap();
        }
        let acme_account_dir = data_root.path().join(crate::ACME_ACCOUNT_DIR_NAME);
        std::fs::create_dir_all(&acme_account_dir).unwrap();

        remove_server(
            registry.as_ref(),
            data_root.path(),
            "ruth.relay.wildflowerhealth.io",
        )
        .unwrap();

        assert!(!ruth_dir.exists());
        assert!(lab_dir.join("wildflower.sqlite").exists());
        assert!(self_hosted_record("lab")
            .certificate_dir(data_root.path())
            .exists());
        assert!(acme_account_dir.exists(), "the install's account stays");
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
    /// removal can be tried again, with its run policy `Off`, so it doesn't run
    /// on what's left of its folder.
    #[cfg(unix)]
    #[test]
    fn a_folder_that_cannot_be_deleted_keeps_the_server_off() {
        let always = ServerRecord {
            run_policy: RunPolicy::Always,
            ..official_record("ruth")
        };
        let (data_root, registry) = registry_holding(&[always]);
        let ruth_dir = official_record("ruth").server_dir(data_root.path());
        std::fs::create_dir_all(ruth_dir.parent().unwrap()).unwrap();
        // A file where the folder should be fails `remove_dir_all` for any
        // user, where a read-only parent doesn't stop root.
        std::fs::write(&ruth_dir, "").unwrap();

        let result = remove_server(
            registry.as_ref(),
            data_root.path(),
            "ruth.relay.wildflowerhealth.io",
        );

        assert!(
            matches!(result, Err(ServerChangeError::DeletingFolder { ref domain, .. }) if domain == "ruth.relay.wildflowerhealth.io"),
            "{result:?}"
        );
        assert_eq!(
            registry.read_all().unwrap(),
            vec![ServerRecord {
                run_policy: RunPolicy::Off,
                ..official_record("ruth")
            }]
        );
    }
}
