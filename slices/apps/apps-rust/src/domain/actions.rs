//! Domain actions over the [`AppsStore`] port — the seam the HTTP routes call
//! instead of touching a concrete store. Each function takes `&impl AppsStore`,
//! so it runs against the `SQLite` adapter in production and against an in-memory
//! fake in tests, with no database or HTTP layer in the way.
//!
//! This is where the apps slice's semantics live: the actions **synthesize** the
//! `(registration, configuration)` a create/replace persists (the store takes only
//! those two real halves), validate the write-side fields ([`AppUrl`] parsing, the
//! launch-path shape), gate on kind + seeded (a per-kind path given an id of another
//! kind is a [`NotFound`](AppsError::NotFound) `404`; a seeded self-hosted edit is a
//! [`NotEditable`](AppsError::NotEditable) `409`), and map the store's primitive
//! signals — absence / non-permutation (`Option`), a delete miss (`bool`), a
//! granular insert failure ([`CloudInsertError`] / [`UploadInsertError`]) — onto the
//! semantic [`AppsError`] variants. The HTTP handlers stay thin: parse the body,
//! call an action. The combined `App` (launch / delete behaviour) lives in the HTTP
//! layer; the store returns the registration + the [`AppConfiguration`] union.
//! Mirrors collector's `actions.rs`.

use crate::domain::{
    AppConfiguration, AppKind, AppRegistration, AppUrl, AppsError, AppsStore,
    CloudAppConfiguration, CloudInsertError, NewSelfHostedUpload, SelfHostedAppConfiguration,
    SystemAppConfiguration, UploadInsertError,
};

/// The `GET /apps` catalogue — every app's registration, in display order.
///
/// # Errors
///
/// [`AppsError::Infrastructure`] if the store read fails.
pub(crate) fn list_registrations(
    store: &impl AppsStore,
) -> Result<Vec<AppRegistration>, AppsError> {
    store.list_registrations()
}

/// A single whole app by id as its `(registration, configuration)` pair, or
/// [`AppsError::NotFound`] when absent — the launch dispatch and the delete
/// removability check.
///
/// # Errors
///
/// [`AppsError::NotFound`] when no app has this id; [`AppsError::Infrastructure`]
/// if the store read fails.
pub(crate) fn get_app(
    store: &impl AppsStore,
    id: &str,
) -> Result<(AppRegistration, AppConfiguration), AppsError> {
    store
        .find_app(id)?
        .ok_or_else(|| AppsError::NotFound { id: id.to_owned() })
}

/// The cloud pair for `GET`/`PUT /cloud-apps/{id}` — [`AppsError::NotFound`] when
/// no *cloud* app has this id (an unknown id, or one of another kind).
///
/// # Errors
///
/// [`AppsError::NotFound`] / [`AppsError::Infrastructure`].
pub(crate) fn get_cloud_app(
    store: &impl AppsStore,
    id: &str,
) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
    match get_app(store, id)? {
        (registration, AppConfiguration::Cloud(config)) => Ok((registration, config)),
        _ => Err(AppsError::NotFound { id: id.to_owned() }),
    }
}

/// The self-hosted pair for `GET`/`PUT /self-hosted-apps/{id}` —
/// [`AppsError::NotFound`] when no *self-hosted* app has this id.
///
/// # Errors
///
/// [`AppsError::NotFound`] / [`AppsError::Infrastructure`].
pub(crate) fn get_self_hosted_app(
    store: &impl AppsStore,
    id: &str,
) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
    match get_app(store, id)? {
        (registration, AppConfiguration::SelfHosted(config)) => Ok((registration, config)),
        _ => Err(AppsError::NotFound { id: id.to_owned() }),
    }
}

/// The system pair for `GET /system-apps/{id}` — [`AppsError::NotFound`] when no
/// *system* app has this id.
///
/// # Errors
///
/// [`AppsError::NotFound`] / [`AppsError::Infrastructure`].
pub(crate) fn get_system_app(
    store: &impl AppsStore,
    id: &str,
) -> Result<(AppRegistration, SystemAppConfiguration), AppsError> {
    match get_app(store, id)? {
        (registration, AppConfiguration::System(config)) => Ok((registration, config)),
        _ => Err(AppsError::NotFound { id: id.to_owned() }),
    }
}

/// Create a cloud app from the server-minted `id` and the raw create-body fields.
/// Validates them, synthesizes the `(registration, configuration)`, and persists
/// it. A [`CloudInsertError::IdTaken`] means the (server-minted) id was already
/// taken — a vanishingly-unlikely 21-char-random collision, so it surfaces as a
/// logged [`Infrastructure`](AppsError::Infrastructure) 500 rather than silently
/// returning the existing row.
///
/// # Errors
///
/// [`AppsError::InvalidName`] / [`AppsError::InvalidUrl`] on a bad field;
/// [`AppsError::Infrastructure`] on a store write failure or an id collision.
pub(crate) fn create_cloud_app(
    store: &impl AppsStore,
    id: String,
    name: String,
    subtitle: Option<String>,
    url: String,
    requires_tunnel: bool,
) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
    let (name, subtitle, url) = validate_cloud_fields(name, subtitle, url)?;
    let registration = AppRegistration {
        id,
        kind: AppKind::Cloud,
        // The store assigns the tail `position`; this is a placeholder.
        position: 0,
        on_homescreen: true,
        name,
        subtitle,
        local_only: false,
        client_id: None,
        requires_tunnel,
    };
    let config = CloudAppConfiguration { url };
    store
        .insert_cloud_app(&registration, &config)?
        .map_err(|error| match error {
            CloudInsertError::IdTaken => {
                tracing::error!("app id collision on {}", registration.id);
                AppsError::infrastructure("insert_cloud_app id collision", "id already exists")
            }
        })
}

/// Install an uploaded self-hosted app. Returns the inserted self-hosted pair read
/// back in-txn, or maps the store's allocation-failure signal onto the wire
/// vocabulary: a slug clash is a name problem the caller can retry differently
/// ([`InvalidName`](AppsError::InvalidName)), an exhausted port space is a server
/// resource fault no rename fixes (a logged
/// [`Infrastructure`](AppsError::Infrastructure) 500 — it must not read as a `400`).
///
/// The slug/port are store-allocated, so this keeps its [`NewSelfHostedUpload`]
/// spec. The filesystem staging (extract → move → start the listener) stays in the
/// handler; this action is only the store insert + its semantic mapping.
///
/// # Errors
///
/// [`AppsError::InvalidName`] when no unique slug was found;
/// [`AppsError::Infrastructure`] on a store write failure or an exhausted port
/// space.
pub(crate) fn create_self_hosted_app(
    store: &impl AppsStore,
    upload: &NewSelfHostedUpload,
) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
    store
        .insert_self_hosted_app(upload)?
        .map_err(|error| match error {
            UploadInsertError::SlugSpaceExhausted => AppsError::InvalidName {
                message: "could not allocate a unique id for this name".to_owned(),
            },
            UploadInsertError::PortSpaceExhausted => AppsError::infrastructure(
                "no free loopback port for a new self-hosted app",
                "port space exhausted",
            ),
        })
}

/// Replace a cloud app's *content* (`name` / `subtitle` / `url` /
/// `requires_tunnel`) — the `PUT /cloud-apps/{id}` body. Resolves the kind before
/// validating any field: an id that isn't a cloud app (unknown, or another kind)
/// is [`NotFound`](AppsError::NotFound); only then is the field validated (`400` on
/// a bad name / url). Overlays the edited fields onto the current registration and
/// hands the store the pair; the store writes only the editable subset, so
/// `on_homescreen` / position (the placement single-writer's) stay untouched.
///
/// # Errors
///
/// [`AppsError::NotFound`] when no cloud app has this id;
/// [`AppsError::InvalidName`] / [`AppsError::InvalidUrl`] on a bad field;
/// [`AppsError::Infrastructure`] on a store failure.
pub(crate) fn replace_cloud_app(
    store: &impl AppsStore,
    id: &str,
    name: String,
    subtitle: Option<String>,
    url: String,
    requires_tunnel: bool,
) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
    // A non-cloud (or unknown) id is a 404 for this per-kind path, resolved before
    // any field is validated (a bad url on a non-cloud id is still a 404).
    let (current, configuration) = get_app(store, id)?;
    if !matches!(configuration, AppConfiguration::Cloud(_)) {
        return Err(AppsError::NotFound { id: id.to_owned() });
    }
    let (name, subtitle, url) = validate_cloud_fields(name, subtitle, url)?;
    // Overlay the editable fields onto the current registration; the store persists
    // only that subset, so the placeholder placement values ride along harmlessly.
    let edited = AppRegistration {
        name,
        subtitle,
        requires_tunnel,
        ..current
    };
    store
        .replace_cloud_app(&edited, &CloudAppConfiguration { url })?
        .ok_or_else(|| {
            AppsError::infrastructure(
                "cloud app vanished between find and replace",
                format!("id={id}"),
            )
        })
}

/// Replace a self-hosted app's `launch_path` (`None` / empty → root-served) — the
/// `PUT /self-hosted-apps/{id}` body. An id that isn't a self-hosted app is
/// [`NotFound`](AppsError::NotFound); a **seeded** self-hosted app is edit-protected
/// ([`NotEditable`](AppsError::NotEditable), `409`); only then is the path validated
/// (`400` on a non-origin-relative value). Overlays the new `launch_path` onto the
/// current configuration and hands the store the pair.
///
/// # Errors
///
/// [`AppsError::NotFound`] / [`AppsError::NotEditable`] / [`AppsError::InvalidUrl`] /
/// [`AppsError::Infrastructure`].
pub(crate) fn replace_self_hosted_app(
    store: &impl AppsStore,
    id: &str,
    launch_path: Option<String>,
) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
    let (current_registration, configuration) = get_app(store, id)?;
    let current_config = match configuration {
        AppConfiguration::SelfHosted(config) if config.seeded => {
            // A migration-seeded app (patient-browser) is read-only, same 409 as
            // delete.
            return Err(AppsError::NotEditable { id: id.to_owned() });
        }
        AppConfiguration::SelfHosted(config) => config,
        _ => return Err(AppsError::NotFound { id: id.to_owned() }),
    };
    let launch_path = validate_launch_path(launch_path)?;
    let edited = SelfHostedAppConfiguration {
        launch_path,
        ..current_config
    };
    store
        .replace_self_hosted_app(&current_registration, &edited)?
        .ok_or_else(|| {
            AppsError::infrastructure(
                "self-hosted app vanished between find and replace",
                format!("id={id}"),
            )
        })
}

/// Delete an app that a prior read confirmed is present and removable. A `false`
/// from the store means the row vanished between the read and the delete — it was
/// just read under the same store, so it can't legitimately have gone; surface it
/// as a logged [`Infrastructure`](AppsError::Infrastructure) 500, never a
/// misleading 404.
///
/// # Errors
///
/// [`AppsError::Infrastructure`] on a store failure or a vanished row.
pub(crate) fn delete_app(store: &impl AppsStore, id: &str) -> Result<(), AppsError> {
    let did_delete = store.delete_app(id)?;
    if did_delete {
        Ok(())
    } else {
        Err(AppsError::infrastructure(
            "row vanished between find_app and delete_app",
            format!("id={id}"),
        ))
    }
}

/// Atomically reorder + show/hide the whole homescreen. The body must list every
/// registry app exactly once (its order is the new display order); a
/// non-permutation is [`InvalidHomeScreen`](AppsError::InvalidHomeScreen). Returns
/// the resulting registry in its new order.
///
/// # Errors
///
/// [`AppsError::InvalidHomeScreen`] when `entries` isn't an exact permutation of
/// the live registry; [`AppsError::Infrastructure`] on a store failure.
pub(crate) fn replace_placements(
    store: &impl AppsStore,
    entries: &[(String, bool)],
) -> Result<Vec<AppRegistration>, AppsError> {
    store
        .replace_placements(entries)?
        .ok_or_else(|| AppsError::InvalidHomeScreen {
            message: "home-screen body must list every app exactly once".to_owned(),
        })
}

/// Validate the editable cloud fields: the name must be non-empty and the url must
/// parse through the write-side [`AppUrl`] filter. An empty subtitle (`""`) clears
/// it. `on_homescreen` has no place here — homescreen curation owns it.
fn validate_cloud_fields(
    name: String,
    subtitle: Option<String>,
    url: String,
) -> Result<(String, Option<String>, AppUrl), AppsError> {
    if name.is_empty() {
        return Err(AppsError::InvalidName {
            message: "name must not be empty".to_owned(),
        });
    }
    let url = url.parse::<AppUrl>().map_err(|e| AppsError::InvalidUrl {
        message: e.to_string(),
    })?;
    Ok((name, subtitle.filter(|s| !s.is_empty()), url))
}

/// Validate a `launchPath` value. A cleared value (`None` / empty) passes through
/// as `None`. A non-empty path must be origin-relative — start with a single `/`
/// (not `//`, a protocol-relative authority) — so it hangs safely off the app's
/// own origin at launch; anything else is a `400 InvalidUrl`.
fn validate_launch_path(value: Option<String>) -> Result<Option<String>, AppsError> {
    match value.filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(path) if path.starts_with('/') && !path.starts_with("//") => Ok(Some(path)),
        Some(_) => Err(AppsError::InvalidUrl {
            message: "launch path must be an origin-relative /path".to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    /// An in-memory [`AppsStore`] modelling the real primitive semantics —
    /// `insert_cloud_app` reports a duplicate id as [`CloudInsertError::IdTaken`],
    /// `find_app`/`replace_*` report an absent id as `None`, `delete_app` reports a
    /// miss as `false`, `replace_placements` reports a non-permutation as `None` —
    /// storing `(registration, configuration)` pairs with no diesel and no database.
    /// Lets the actions' semantic mapping be exercised directly; the `SQLite`
    /// adapter's own coverage lives in `crate::db`.
    #[derive(Default)]
    struct FakeAppsStore {
        apps: RefCell<Vec<(AppRegistration, AppConfiguration)>>,
        upload_failure: Option<UploadInsertError>,
    }

    impl FakeAppsStore {
        fn seed(&self, registration: AppRegistration, configuration: AppConfiguration) {
            self.apps.borrow_mut().push((registration, configuration));
        }

        fn next_position(&self) -> i64 {
            self.apps
                .borrow()
                .iter()
                .map(|(reg, _)| reg.position)
                .max()
                .map_or(0, |m| m + 1)
        }

        fn id_taken(&self, id: &str) -> bool {
            self.apps.borrow().iter().any(|(reg, _)| reg.id == id)
        }
    }

    impl AppsStore for FakeAppsStore {
        fn list_registrations(&self) -> Result<Vec<AppRegistration>, AppsError> {
            let mut apps = self.apps.borrow().clone();
            apps.sort_by_key(|(reg, _)| reg.position);
            Ok(apps.iter().map(|(reg, _)| reg.clone()).collect())
        }

        fn find_app(
            &self,
            id: &str,
        ) -> Result<Option<(AppRegistration, AppConfiguration)>, AppsError> {
            Ok(self
                .apps
                .borrow()
                .iter()
                .find(|(reg, _)| reg.id == id)
                .cloned())
        }

        fn list_self_hosted_apps(
            &self,
        ) -> Result<Vec<(AppRegistration, SelfHostedAppConfiguration)>, AppsError> {
            Ok(self
                .apps
                .borrow()
                .iter()
                .filter_map(|(reg, configuration)| match configuration {
                    AppConfiguration::SelfHosted(config) => Some((reg.clone(), config.clone())),
                    _ => None,
                })
                .collect())
        }

        fn insert_cloud_app(
            &self,
            registration: &AppRegistration,
            config: &CloudAppConfiguration,
        ) -> Result<Result<(AppRegistration, CloudAppConfiguration), CloudInsertError>, AppsError>
        {
            if self.id_taken(&registration.id) {
                return Ok(Err(CloudInsertError::IdTaken));
            }
            // The store owns `position`; everything else is the caller's.
            let stored = AppRegistration {
                position: self.next_position(),
                ..registration.clone()
            };
            self.seed(stored.clone(), AppConfiguration::Cloud(config.clone()));
            Ok(Ok((stored, config.clone())))
        }

        fn insert_self_hosted_app(
            &self,
            new: &NewSelfHostedUpload,
        ) -> Result<
            Result<(AppRegistration, SelfHostedAppConfiguration), UploadInsertError>,
            AppsError,
        > {
            if let Some(failure) = self.upload_failure {
                return Ok(Err(failure));
            }
            // A minimal slug allocator: the base, then `-2`, `-3`, … until free.
            let slug = (1..)
                .map(|n| {
                    if n == 1 {
                        new.base_slug.clone()
                    } else {
                        format!("{}-{n}", new.base_slug)
                    }
                })
                .find(|candidate| !self.id_taken(candidate))
                .expect("an unbounded suffix range always yields a free slug");
            let port = 8082 + u16::try_from(self.apps.borrow().len()).unwrap_or(0);
            let registration = AppRegistration {
                id: slug.clone(),
                kind: AppKind::SelfHosted,
                position: self.next_position(),
                on_homescreen: true,
                name: new.name.clone(),
                subtitle: new.subtitle.clone(),
                local_only: true,
                client_id: None,
                requires_tunnel: false,
            };
            let config = SelfHostedAppConfiguration {
                port,
                content_folder: new.content_folder.clone(),
                subdomain: slug,
                seeded: false,
                launch_path: new.launch_path.clone(),
            };
            self.seed(
                registration.clone(),
                AppConfiguration::SelfHosted(config.clone()),
            );
            Ok(Ok((registration, config)))
        }

        fn replace_cloud_app(
            &self,
            registration: &AppRegistration,
            config: &CloudAppConfiguration,
        ) -> Result<Option<(AppRegistration, CloudAppConfiguration)>, AppsError> {
            let mut apps = self.apps.borrow_mut();
            let Some((stored_reg, configuration)) =
                apps.iter_mut().find(|(reg, _)| reg.id == registration.id)
            else {
                return Ok(None);
            };
            let AppConfiguration::Cloud(stored_config) = configuration else {
                return Ok(None);
            };
            // Editable subset only — never placement / kind / client_id / local_only.
            stored_reg.name = registration.name.clone();
            stored_reg.subtitle = registration.subtitle.clone();
            stored_reg.requires_tunnel = registration.requires_tunnel;
            stored_config.url = config.url.clone();
            Ok(Some((stored_reg.clone(), stored_config.clone())))
        }

        fn replace_self_hosted_app(
            &self,
            registration: &AppRegistration,
            config: &SelfHostedAppConfiguration,
        ) -> Result<Option<(AppRegistration, SelfHostedAppConfiguration)>, AppsError> {
            let mut apps = self.apps.borrow_mut();
            let Some((stored_reg, configuration)) =
                apps.iter_mut().find(|(reg, _)| reg.id == registration.id)
            else {
                return Ok(None);
            };
            let AppConfiguration::SelfHosted(stored_config) = configuration else {
                return Ok(None);
            };
            stored_reg.name = registration.name.clone();
            stored_reg.subtitle = registration.subtitle.clone();
            stored_config.launch_path = config.launch_path.clone();
            Ok(Some((stored_reg.clone(), stored_config.clone())))
        }

        fn delete_app(&self, id: &str) -> Result<bool, AppsError> {
            let mut apps = self.apps.borrow_mut();
            let before = apps.len();
            apps.retain(|(reg, _)| reg.id != id);
            Ok(apps.len() != before)
        }

        fn replace_placements(
            &self,
            entries: &[(String, bool)],
        ) -> Result<Option<Vec<AppRegistration>>, AppsError> {
            let mut apps = self.apps.borrow_mut();
            let current: std::collections::HashSet<String> =
                apps.iter().map(|(reg, _)| reg.id.clone()).collect();
            let body: std::collections::HashSet<&str> =
                entries.iter().map(|(id, _)| id.as_str()).collect();
            let is_permutation = entries.len() == current.len()
                && body.len() == entries.len()
                && body.iter().all(|id| current.contains(*id));
            if !is_permutation {
                return Ok(None);
            }
            for (position, (id, on_homescreen)) in entries.iter().enumerate() {
                let new_position = i64::try_from(position).expect("home-screen length fits i64");
                if let Some((reg, _)) = apps.iter_mut().find(|(reg, _)| reg.id == *id) {
                    reg.position = new_position;
                    reg.on_homescreen = *on_homescreen;
                }
            }
            apps.sort_by_key(|(reg, _)| reg.position);
            Ok(Some(apps.iter().map(|(reg, _)| reg.clone()).collect()))
        }
    }

    fn registration(id: &str, kind: AppKind) -> AppRegistration {
        AppRegistration {
            id: id.to_owned(),
            kind,
            position: 0,
            on_homescreen: true,
            name: id.to_owned(),
            subtitle: None,
            local_only: kind != AppKind::Cloud,
            client_id: None,
            requires_tunnel: false,
        }
    }

    /// Create a cloud app through the action with a caller-chosen id (the HTTP layer
    /// mints it in production) and default content.
    fn create_cloud(
        store: &FakeAppsStore,
        id: &str,
    ) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
        create_cloud_app(
            store,
            id.to_owned(),
            id.to_owned(),
            None,
            "https://example.com/launch".to_owned(),
            false,
        )
    }

    fn new_upload(base_slug: &str) -> NewSelfHostedUpload {
        NewSelfHostedUpload {
            name: "My App".to_owned(),
            subtitle: None,
            base_slug: base_slug.to_owned(),
            content_folder: format!("{base_slug}-folder"),
            reserved_ports: Vec::new(),
            launch_path: None,
        }
    }

    fn seeded_self_hosted(store: &FakeAppsStore, id: &str, seeded: bool) {
        let mut reg = registration(id, AppKind::SelfHosted);
        reg.position = store.next_position();
        store.seed(
            reg,
            AppConfiguration::SelfHosted(SelfHostedAppConfiguration {
                port: 8081,
                content_folder: id.to_owned(),
                subdomain: id.to_owned(),
                seeded,
                launch_path: None,
            }),
        );
    }

    fn system(store: &FakeAppsStore, id: &str) {
        let mut reg = registration(id, AppKind::System);
        reg.position = store.next_position();
        store.seed(
            reg,
            AppConfiguration::System(SystemAppConfiguration {
                url: AppUrl::OriginRelative("/docs".to_owned()),
            }),
        );
    }

    #[test]
    fn get_app_maps_absent_to_not_found_and_present_to_the_app() {
        let store = FakeAppsStore::default();
        assert!(matches!(
            get_app(&store, "ghost"),
            Err(AppsError::NotFound { .. })
        ));
        create_cloud(&store, "app-x").expect("insert");
        assert_eq!(get_app(&store, "app-x").expect("found").0.id, "app-x");
    }

    #[test]
    fn get_cloud_app_maps_wrong_kind_to_not_found() {
        let store = FakeAppsStore::default();
        seeded_self_hosted(&store, "patient-browser", true);
        assert!(
            matches!(
                get_cloud_app(&store, "patient-browser"),
                Err(AppsError::NotFound { .. })
            ),
            "a self-hosted id is not a cloud app — 404, not a mismatch",
        );
    }

    #[test]
    fn create_cloud_app_inserts_then_reports_a_taken_id_as_infrastructure() {
        let store = FakeAppsStore::default();
        let (registration, _config) = create_cloud(&store, "app-x").expect("insert");
        assert_eq!(registration.id, "app-x");
        assert!(registration.on_homescreen);
        // A second insert on the same (server-minted) id is a logged 500.
        assert!(matches!(
            create_cloud(&store, "app-x"),
            Err(AppsError::Infrastructure { .. })
        ));
    }

    #[test]
    fn create_cloud_app_validates_its_fields() {
        let store = FakeAppsStore::default();
        assert!(matches!(
            create_cloud_app(
                &store,
                "app-x".to_owned(),
                String::new(),
                None,
                "https://x.example".to_owned(),
                false,
            ),
            Err(AppsError::InvalidName { .. })
        ));
        assert!(matches!(
            create_cloud_app(
                &store,
                "app-x".to_owned(),
                "Name".to_owned(),
                None,
                "javascript:alert(1)".to_owned(),
                false,
            ),
            Err(AppsError::InvalidUrl { .. })
        ));
    }

    #[test]
    fn create_self_hosted_app_returns_the_installed_app() {
        let store = FakeAppsStore::default();
        let (registration, _config) =
            create_self_hosted_app(&store, &new_upload("my-app")).expect("insert");
        assert_eq!(registration.id, "my-app");
    }

    #[test]
    fn create_self_hosted_maps_slug_exhaustion_to_invalid_name() {
        let store = FakeAppsStore {
            upload_failure: Some(UploadInsertError::SlugSpaceExhausted),
            ..FakeAppsStore::default()
        };
        assert!(matches!(
            create_self_hosted_app(&store, &new_upload("my-app")),
            Err(AppsError::InvalidName { .. })
        ));
    }

    #[test]
    fn create_self_hosted_maps_port_exhaustion_to_infrastructure() {
        let store = FakeAppsStore {
            upload_failure: Some(UploadInsertError::PortSpaceExhausted),
            ..FakeAppsStore::default()
        };
        // A server resource fault, not a name problem — must not read as a 400.
        assert!(matches!(
            create_self_hosted_app(&store, &new_upload("my-app")),
            Err(AppsError::Infrastructure { .. })
        ));
    }

    #[test]
    fn replace_cloud_app_unknown_id_is_not_found() {
        let store = FakeAppsStore::default();
        assert!(matches!(
            replace_cloud_app(
                &store,
                "ghost",
                "n".to_owned(),
                None,
                "https://x.example".to_owned(),
                false,
            ),
            Err(AppsError::NotFound { .. })
        ));
    }

    #[test]
    fn replace_cloud_app_rewrites_a_cloud_app() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "app-x").expect("insert");
        let (registration, _config) = replace_cloud_app(
            &store,
            "app-x",
            "Renamed".to_owned(),
            None,
            "https://example.com/new".to_owned(),
            false,
        )
        .expect("replace");
        assert_eq!(registration.name, "Renamed");
        assert_eq!(
            store.find_app("app-x").unwrap().unwrap().0.name,
            "Renamed",
            "the store now holds the rewritten row",
        );
    }

    /// A per-kind path resolves the kind before validating fields: a cloud replace
    /// of a system id is `404` (not a cloud app), even when its url is also bad —
    /// the kind mismatch wins, and can no longer be expressed as a `409`.
    #[test]
    fn replace_cloud_app_on_a_system_id_is_not_found_before_url_validation() {
        let store = FakeAppsStore::default();
        system(&store, "api-docs");
        assert!(
            matches!(
                replace_cloud_app(
                    &store,
                    "api-docs",
                    "n".to_owned(),
                    None,
                    "javascript:alert(1)".to_owned(),
                    false,
                ),
                Err(AppsError::NotFound { .. }),
            ),
            "the wrong-kind 404 must win over the bad url",
        );
    }

    #[test]
    fn replace_cloud_app_validates_the_cloud_fields() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "app-x").expect("insert");
        assert!(matches!(
            replace_cloud_app(
                &store,
                "app-x",
                String::new(),
                None,
                "https://x.example".to_owned(),
                false,
            ),
            Err(AppsError::InvalidName { .. })
        ));
        assert!(matches!(
            replace_cloud_app(
                &store,
                "app-x",
                "n".to_owned(),
                None,
                "javascript:alert(1)".to_owned(),
                false,
            ),
            Err(AppsError::InvalidUrl { .. })
        ));
    }

    #[test]
    fn replace_self_hosted_app_on_a_seeded_app_is_not_editable() {
        let store = FakeAppsStore::default();
        seeded_self_hosted(&store, "patient-browser", true);
        assert!(matches!(
            replace_self_hosted_app(&store, "patient-browser", Some("/launch.html".to_owned())),
            Err(AppsError::NotEditable { .. })
        ));
    }

    #[test]
    fn replace_self_hosted_app_on_a_cloud_id_is_not_found() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "app-x").expect("insert");
        assert!(matches!(
            replace_self_hosted_app(&store, "app-x", Some("/launch.html".to_owned())),
            Err(AppsError::NotFound { .. })
        ));
    }

    #[test]
    fn replace_self_hosted_app_edits_and_validates() {
        let store = FakeAppsStore::default();
        seeded_self_hosted(&store, "my-app", false);
        let (_registration, config) =
            replace_self_hosted_app(&store, "my-app", Some("/launch.html".to_owned()))
                .expect("replace");
        assert_eq!(config.launch_path.as_deref(), Some("/launch.html"));
        // A non-origin-relative path is rejected.
        assert!(matches!(
            replace_self_hosted_app(
                &store,
                "my-app",
                Some("https://evil.example/launch".to_owned()),
            ),
            Err(AppsError::InvalidUrl { .. })
        ));
    }

    #[test]
    fn delete_app_succeeds_then_reports_a_miss_as_infrastructure() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "app-x").expect("insert");
        delete_app(&store, "app-x").expect("delete succeeds");
        assert!(matches!(
            get_app(&store, "app-x"),
            Err(AppsError::NotFound { .. })
        ));
        // A second delete is a miss — the row was gone, so it's a logged 500.
        assert!(matches!(
            delete_app(&store, "app-x"),
            Err(AppsError::Infrastructure { .. })
        ));
    }

    #[test]
    fn replace_placements_permutation_returns_the_reordered_registry() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "a").expect("insert");
        create_cloud(&store, "b").expect("insert");
        let updated =
            replace_placements(&store, &[("b".to_owned(), true), ("a".to_owned(), false)])
                .expect("permutation");
        let ids: Vec<&str> = updated.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"], "the registry comes back reordered");
        assert!(
            !store.find_app("a").unwrap().unwrap().0.on_homescreen,
            "a hidden"
        );
    }

    #[test]
    fn replace_placements_non_permutation_is_invalid_home_screen() {
        let store = FakeAppsStore::default();
        create_cloud(&store, "a").expect("insert");
        create_cloud(&store, "b").expect("insert");
        // A subset isn't an exact permutation.
        assert!(matches!(
            replace_placements(&store, &[("a".to_owned(), true)]),
            Err(AppsError::InvalidHomeScreen { .. })
        ));
    }
}
