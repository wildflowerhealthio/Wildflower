//! Domain actions over the [`AppsStore`] port — the seam the HTTP routes call
//! instead of touching a concrete store. Each function takes `&impl AppsStore`,
//! so it runs against the `SQLite` adapter in production and against an in-memory
//! fake in tests, with no database or HTTP layer in the way.
//!
//! This is where the apps slice's semantics live: the actions map the store's
//! primitive absence / conflict / allocation-failure signals (`Option` / `bool` /
//! [`UploadInsertError`]) onto the semantic [`AppError`] variants
//! ([`NotFound`](AppError::NotFound), [`NotEditable`](AppError::NotEditable),
//! [`InvalidHomeScreen`](AppError::InvalidHomeScreen), the id-collision
//! [`Infrastructure`](AppError::Infrastructure) verdict), and hold the write-side
//! field validation ([`AppUrl`] parsing, the launch-path shape). Because the write
//! routes are now split per kind, a per-kind path given an id of another kind is a
//! [`NotFound`](AppError::NotFound) (a `404`) — the old body/kind-mismatch `409`
//! can no longer be expressed. Mirrors collector's `actions.rs`.

use crate::domain::{
    App, AppError, AppRegistration, AppUrl, AppsStore, CloudApp, CloudContent, NewCloudApp,
    NewSelfHostedUpload, SelfHostedApp, SystemApp, UploadInsertError,
};

/// The `GET /apps` catalogue — every app's registration, in display order.
///
/// # Errors
///
/// [`AppError::Infrastructure`] if the store read fails.
pub(crate) fn list_registrations(store: &impl AppsStore) -> Result<Vec<AppRegistration>, AppError> {
    store.list_registrations()
}

/// A single whole app by id, or [`AppError::NotFound`] when absent — the launch
/// dispatch and the delete removability check.
///
/// # Errors
///
/// [`AppError::NotFound`] when no app has this id; [`AppError::Infrastructure`]
/// if the store read fails.
pub(crate) fn get_app(store: &impl AppsStore, id: &str) -> Result<App, AppError> {
    store
        .find_app(id)?
        .ok_or_else(|| AppError::NotFound { id: id.to_owned() })
}

/// The cloud detail for `GET`/`PUT /cloud-apps/{id}` — [`AppError::NotFound`] when
/// no *cloud* app has this id (an unknown id, or one of another kind).
///
/// # Errors
///
/// [`AppError::NotFound`] / [`AppError::Infrastructure`].
pub(crate) fn get_cloud_app(store: &impl AppsStore, id: &str) -> Result<CloudApp, AppError> {
    match get_app(store, id)? {
        App::Cloud(app) => Ok(app),
        _ => Err(AppError::NotFound { id: id.to_owned() }),
    }
}

/// The self-hosted detail for `GET`/`PUT /self-hosted-apps/{id}` —
/// [`AppError::NotFound`] when no *self-hosted* app has this id.
///
/// # Errors
///
/// [`AppError::NotFound`] / [`AppError::Infrastructure`].
pub(crate) fn get_self_hosted_app(
    store: &impl AppsStore,
    id: &str,
) -> Result<SelfHostedApp, AppError> {
    match get_app(store, id)? {
        App::SelfHosted(app) => Ok(app),
        _ => Err(AppError::NotFound { id: id.to_owned() }),
    }
}

/// The system detail for `GET /system-apps/{id}` — [`AppError::NotFound`] when no
/// *system* app has this id.
///
/// # Errors
///
/// [`AppError::NotFound`] / [`AppError::Infrastructure`].
pub(crate) fn get_system_app(store: &impl AppsStore, id: &str) -> Result<SystemApp, AppError> {
    match get_app(store, id)? {
        App::System(app) => Ok(app),
        _ => Err(AppError::NotFound { id: id.to_owned() }),
    }
}

/// Create a cloud app from a server-minted spec. Returns the inserted cloud detail
/// read back in-txn. A `None` from the store means the (server-minted) id was
/// already taken — a vanishingly-unlikely 21-char-random collision, so it surfaces
/// as a logged [`Infrastructure`](AppError::Infrastructure) 500 rather than
/// silently returning the existing row.
///
/// # Errors
///
/// [`AppError::Infrastructure`] on a store write failure or an id collision.
pub(crate) fn create_cloud_app(
    store: &impl AppsStore,
    new: &NewCloudApp,
) -> Result<CloudApp, AppError> {
    let app = store.insert_cloud_app(new)?.ok_or_else(|| {
        tracing::error!("app id collision on {}", new.id);
        AppError::infrastructure("insert_cloud_app id collision", "id already exists")
    })?;
    expect_cloud(app)
}

/// Install an uploaded self-hosted app. Returns the inserted self-hosted detail
/// read back in-txn, or maps the store's allocation-failure signal onto the wire
/// vocabulary: a slug clash is a name problem the caller can retry differently
/// ([`InvalidName`](AppError::InvalidName)), an exhausted port space is a server
/// resource fault no rename fixes (a logged
/// [`Infrastructure`](AppError::Infrastructure) 500 — it must not read as a `400`).
///
/// The filesystem staging (extract → move → start the listener) stays in the
/// handler; this action is only the store insert + its semantic mapping.
///
/// # Errors
///
/// [`AppError::InvalidName`] when no unique slug was found;
/// [`AppError::Infrastructure`] on a store write failure or an exhausted port
/// space.
pub(crate) fn create_self_hosted_app(
    store: &impl AppsStore,
    upload: &NewSelfHostedUpload,
) -> Result<SelfHostedApp, AppError> {
    match store.insert_self_hosted_app(upload)? {
        Ok(app) => expect_self_hosted(app),
        Err(UploadInsertError::SlugSpaceExhausted) => Err(AppError::InvalidName {
            message: "could not allocate a unique id for this name".to_owned(),
        }),
        Err(UploadInsertError::PortSpaceExhausted) => Err(AppError::infrastructure(
            "no free loopback port for a new self-hosted app",
            "port space exhausted",
        )),
    }
}

/// Replace a cloud app's *content* (`name` / `subtitle` / `url` /
/// `requires_tunnel`) — the `PUT /cloud-apps/{id}` body. Resolves the kind before
/// validating any field: an id that isn't a cloud app (unknown, or another kind)
/// is [`NotFound`](AppError::NotFound); only then is the field validated (`400` on
/// a bad name / url). `enabled` is **not** content — `PUT /home-screen` owns it.
/// Returns the updated cloud detail read back in-txn.
///
/// # Errors
///
/// [`AppError::NotFound`] when no cloud app has this id;
/// [`AppError::InvalidName`] / [`AppError::InvalidUrl`] on a bad field;
/// [`AppError::Infrastructure`] on a store failure.
pub(crate) fn replace_cloud_content(
    store: &impl AppsStore,
    id: &str,
    name: String,
    subtitle: Option<String>,
    url: String,
    requires_tunnel: bool,
) -> Result<CloudApp, AppError> {
    // A non-cloud (or unknown) id is a 404 for this per-kind path, resolved before
    // any field is validated (a bad url on a non-cloud id is still a 404).
    if !matches!(get_app(store, id)?, App::Cloud(_)) {
        return Err(AppError::NotFound { id: id.to_owned() });
    }
    let content = validate_cloud_content(name, subtitle, url, requires_tunnel)?;
    let updated = store.replace_cloud_content(id, &content)?.ok_or_else(|| {
        AppError::infrastructure(
            "cloud app vanished between find and replace",
            format!("id={id}"),
        )
    })?;
    expect_cloud(updated)
}

/// Replace a self-hosted app's `launch_path` (`None` / empty → root-served) — the
/// `PUT /self-hosted-apps/{id}` body. An id that isn't a self-hosted app is
/// [`NotFound`](AppError::NotFound); a **seeded** self-hosted app is edit-protected
/// ([`NotEditable`](AppError::NotEditable), `409`); only then is the path validated
/// (`400` on a non-origin-relative value). Returns the updated self-hosted detail.
///
/// # Errors
///
/// [`AppError::NotFound`] / [`AppError::NotEditable`] / [`AppError::InvalidUrl`] /
/// [`AppError::Infrastructure`].
pub(crate) fn replace_self_hosted_launch_path(
    store: &impl AppsStore,
    id: &str,
    launch_path: Option<String>,
) -> Result<SelfHostedApp, AppError> {
    match get_app(store, id)? {
        App::SelfHosted(app) if app.seeded => {
            // A migration-seeded app (patient-browser) is read-only, same 409 as
            // delete.
            return Err(AppError::NotEditable { id: id.to_owned() });
        }
        App::SelfHosted(_) => {}
        _ => return Err(AppError::NotFound { id: id.to_owned() }),
    }
    let launch_path = validate_launch_path(launch_path)?;
    let updated = store
        .replace_self_hosted_launch_path(id, launch_path.as_deref())?
        .ok_or_else(|| {
            AppError::infrastructure(
                "self-hosted app vanished between find and replace",
                format!("id={id}"),
            )
        })?;
    expect_self_hosted(updated)
}

/// Delete an app that a prior read confirmed is present and removable. A `false`
/// from the store means the row vanished between the read and the delete — it was
/// just read under the same store, so it can't legitimately have gone; surface it
/// as a logged [`Infrastructure`](AppError::Infrastructure) 500, never a
/// misleading 404.
///
/// # Errors
///
/// [`AppError::Infrastructure`] on a store failure or a vanished row.
pub(crate) fn delete_app(store: &impl AppsStore, id: &str) -> Result<(), AppError> {
    if store.delete_app(id)? {
        Ok(())
    } else {
        Err(AppError::infrastructure(
            "row vanished between find_app and delete_app",
            format!("id={id}"),
        ))
    }
}

/// Atomically reorder + enable/disable the whole homescreen. The body must list
/// every registry app exactly once (its order is the new display order); a
/// non-permutation is [`InvalidHomeScreen`](AppError::InvalidHomeScreen). Returns
/// the resulting registry in its new order.
///
/// # Errors
///
/// [`AppError::InvalidHomeScreen`] when `entries` isn't an exact permutation of
/// the live registry; [`AppError::Infrastructure`] on a store failure.
pub(crate) fn replace_home_screen(
    store: &impl AppsStore,
    entries: &[(String, bool)],
) -> Result<Vec<AppRegistration>, AppError> {
    store
        .replace_home_screen(entries)?
        .ok_or_else(|| AppError::InvalidHomeScreen {
            message: "home-screen body must list every app exactly once".to_owned(),
        })
}

/// Narrow a store-returned [`App`] to its cloud detail; a mismatch is a store bug
/// (the insert/replace just built a cloud app), surfaced as a logged 500.
fn expect_cloud(app: App) -> Result<CloudApp, AppError> {
    match app {
        App::Cloud(app) => Ok(app),
        other => Err(AppError::infrastructure(
            "expected a cloud app from the store",
            other.id().to_owned(),
        )),
    }
}

/// Narrow a store-returned [`App`] to its self-hosted detail; a mismatch is a store
/// bug, surfaced as a logged 500.
fn expect_self_hosted(app: App) -> Result<SelfHostedApp, AppError> {
    match app {
        App::SelfHosted(app) => Ok(app),
        other => Err(AppError::infrastructure(
            "expected a self-hosted app from the store",
            other.id().to_owned(),
        )),
    }
}

/// Validate a cloud replace body into the store's [`CloudContent`] spec: the name
/// must be non-empty and the url must parse through the write-side [`AppUrl`]
/// filter. `enabled` has no place here — homescreen curation owns it.
fn validate_cloud_content(
    name: String,
    subtitle: Option<String>,
    url: String,
    requires_tunnel: bool,
) -> Result<CloudContent, AppError> {
    if name.is_empty() {
        return Err(AppError::InvalidName {
            message: "name must not be empty".to_owned(),
        });
    }
    let url = url.parse::<AppUrl>().map_err(|e| AppError::InvalidUrl {
        message: e.to_string(),
    })?;
    Ok(CloudContent {
        name,
        // Empty `""` clears the subtitle.
        subtitle: subtitle.filter(|s| !s.is_empty()),
        url,
        requires_tunnel,
    })
}

/// Validate a `launchPath` value. A cleared value (`None` / empty) passes through
/// as `None`. A non-empty path must be origin-relative — start with a single `/`
/// (not `//`, a protocol-relative authority) — so it hangs safely off the app's
/// own origin at launch; anything else is a `400 InvalidUrl`.
fn validate_launch_path(value: Option<String>) -> Result<Option<String>, AppError> {
    match value.filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(path) if path.starts_with('/') && !path.starts_with("//") => Ok(Some(path)),
        Some(_) => Err(AppError::InvalidUrl {
            message: "launch path must be an origin-relative /path".to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::domain::AppKind;

    /// An in-memory [`AppsStore`] modelling the real primitive semantics —
    /// `insert_cloud_app` reports a duplicate id as `None`, `find_app`/`replace_*`
    /// report an absent id as `None`, `delete_app` reports a miss as `false`,
    /// `replace_home_screen` reports a non-permutation as `None` — with no diesel
    /// and no database. Lets the actions' semantic mapping be exercised directly;
    /// the `SQLite` adapter's own coverage lives in `crate::db`.
    #[derive(Default)]
    struct FakeAppsStore {
        apps: RefCell<Vec<App>>,
        upload_failure: Option<UploadInsertError>,
    }

    impl FakeAppsStore {
        fn seed(&self, app: App) {
            self.apps.borrow_mut().push(app);
        }

        fn next_position(&self) -> i64 {
            self.apps
                .borrow()
                .iter()
                .map(App::position)
                .max()
                .map_or(0, |m| m + 1)
        }

        fn id_taken(&self, id: &str) -> bool {
            self.apps.borrow().iter().any(|a| a.id() == id)
        }
    }

    impl AppsStore for FakeAppsStore {
        fn list_registrations(&self) -> Result<Vec<AppRegistration>, AppError> {
            let mut apps = self.apps.borrow().clone();
            apps.sort_by_key(App::position);
            Ok(apps.iter().map(|a| a.registration().clone()).collect())
        }

        fn find_app(&self, id: &str) -> Result<Option<App>, AppError> {
            Ok(self.apps.borrow().iter().find(|a| a.id() == id).cloned())
        }

        fn list_self_hosted_apps(&self) -> Result<Vec<App>, AppError> {
            Ok(self
                .apps
                .borrow()
                .iter()
                .filter(|a| a.as_self_hosted().is_some())
                .cloned()
                .collect())
        }

        fn insert_cloud_app(&self, new: &NewCloudApp) -> Result<Option<App>, AppError> {
            if self.id_taken(&new.id) {
                return Ok(None);
            }
            let app = App::Cloud(CloudApp {
                registration: AppRegistration {
                    id: new.id.clone(),
                    kind: AppKind::Cloud,
                    position: self.next_position(),
                    enabled: true,
                    name: new.content.name.clone(),
                    subtitle: new.content.subtitle.clone(),
                    local_only: false,
                    client_id: None,
                    requires_tunnel: new.content.requires_tunnel,
                },
                url: new.content.url.clone(),
            });
            self.seed(app.clone());
            Ok(Some(app))
        }

        fn insert_self_hosted_app(
            &self,
            new: &NewSelfHostedUpload,
        ) -> Result<Result<App, UploadInsertError>, AppError> {
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
            let app = App::SelfHosted(SelfHostedApp {
                registration: AppRegistration {
                    id: slug.clone(),
                    kind: AppKind::SelfHosted,
                    position: self.next_position(),
                    enabled: true,
                    name: new.name.clone(),
                    subtitle: new.subtitle.clone(),
                    local_only: true,
                    client_id: None,
                    requires_tunnel: false,
                },
                port,
                content_folder: new.content_folder.clone(),
                subdomain: slug,
                seeded: false,
                launch_path: new.launch_path.clone(),
            });
            self.seed(app.clone());
            Ok(Ok(app))
        }

        fn replace_cloud_content(
            &self,
            id: &str,
            content: &CloudContent,
        ) -> Result<Option<App>, AppError> {
            let mut apps = self.apps.borrow_mut();
            let Some(App::Cloud(cloud)) = apps.iter_mut().find(|a| a.id() == id) else {
                return Ok(None);
            };
            cloud.registration.name = content.name.clone();
            cloud.registration.subtitle = content.subtitle.clone();
            cloud.registration.requires_tunnel = content.requires_tunnel;
            cloud.url = content.url.clone();
            Ok(apps.iter().find(|a| a.id() == id).cloned())
        }

        fn replace_self_hosted_launch_path(
            &self,
            id: &str,
            launch_path: Option<&str>,
        ) -> Result<Option<App>, AppError> {
            let mut apps = self.apps.borrow_mut();
            let Some(App::SelfHosted(app)) = apps.iter_mut().find(|a| a.id() == id) else {
                return Ok(None);
            };
            app.launch_path = launch_path.map(str::to_owned);
            Ok(apps.iter().find(|a| a.id() == id).cloned())
        }

        fn delete_app(&self, id: &str) -> Result<bool, AppError> {
            let mut apps = self.apps.borrow_mut();
            let before = apps.len();
            apps.retain(|a| a.id() != id);
            Ok(apps.len() != before)
        }

        fn replace_home_screen(
            &self,
            entries: &[(String, bool)],
        ) -> Result<Option<Vec<AppRegistration>>, AppError> {
            let mut apps = self.apps.borrow_mut();
            let current: std::collections::HashSet<String> =
                apps.iter().map(|a| a.id().to_owned()).collect();
            let body: std::collections::HashSet<&str> =
                entries.iter().map(|(id, _)| id.as_str()).collect();
            let is_permutation = entries.len() == current.len()
                && body.len() == entries.len()
                && body.iter().all(|id| current.contains(*id));
            if !is_permutation {
                return Ok(None);
            }
            for (position, (id, enabled)) in entries.iter().enumerate() {
                let new_position = i64::try_from(position).expect("home-screen length fits i64");
                if let Some(app) = apps.iter_mut().find(|a| a.id() == id) {
                    set_placement(app, new_position, *enabled);
                }
            }
            apps.sort_by_key(App::position);
            Ok(Some(
                apps.iter().map(|a| a.registration().clone()).collect(),
            ))
        }
    }

    /// Overwrite an [`App`]'s registration placement in place (the fake's stand-in
    /// for the store's `position` renumber).
    fn set_placement(app: &mut App, new_position: i64, new_enabled: bool) {
        let reg = match app {
            App::System(app) => &mut app.registration,
            App::Cloud(app) => &mut app.registration,
            App::SelfHosted(app) => &mut app.registration,
        };
        reg.position = new_position;
        reg.enabled = new_enabled;
    }

    fn registration(id: &str, kind: AppKind) -> AppRegistration {
        AppRegistration {
            id: id.to_owned(),
            kind,
            position: 0,
            enabled: true,
            name: id.to_owned(),
            subtitle: None,
            local_only: kind != AppKind::Cloud,
            client_id: None,
            requires_tunnel: false,
        }
    }

    fn cloud_content(name: &str) -> CloudContent {
        CloudContent {
            name: name.to_owned(),
            subtitle: None,
            url: AppUrl::External("https://example.com/launch".to_owned()),
            requires_tunnel: false,
        }
    }

    fn new_cloud(id: &str) -> NewCloudApp {
        NewCloudApp {
            id: id.to_owned(),
            content: cloud_content(id),
        }
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
        store.seed(App::SelfHosted(SelfHostedApp {
            registration: reg,
            port: 8081,
            content_folder: id.to_owned(),
            subdomain: id.to_owned(),
            seeded,
            launch_path: None,
        }));
    }

    fn system(store: &FakeAppsStore, id: &str) {
        let mut reg = registration(id, AppKind::System);
        reg.position = store.next_position();
        store.seed(App::System(SystemApp {
            registration: reg,
            url: AppUrl::OriginRelative("/docs".to_owned()),
        }));
    }

    #[test]
    fn get_app_maps_absent_to_not_found_and_present_to_the_app() {
        let store = FakeAppsStore::default();
        assert!(matches!(
            get_app(&store, "ghost"),
            Err(AppError::NotFound { .. })
        ));
        create_cloud_app(&store, &new_cloud("app-x")).expect("insert");
        assert_eq!(get_app(&store, "app-x").expect("found").id(), "app-x");
    }

    #[test]
    fn get_cloud_app_maps_wrong_kind_to_not_found() {
        let store = FakeAppsStore::default();
        seeded_self_hosted(&store, "patient-browser", true);
        assert!(
            matches!(
                get_cloud_app(&store, "patient-browser"),
                Err(AppError::NotFound { .. })
            ),
            "a self-hosted id is not a cloud app — 404, not a mismatch",
        );
    }

    #[test]
    fn create_cloud_app_inserts_then_reports_a_taken_id_as_infrastructure() {
        let store = FakeAppsStore::default();
        let created = create_cloud_app(&store, &new_cloud("app-x")).expect("insert");
        assert_eq!(created.registration.id, "app-x");
        assert!(created.registration.enabled);
        // A second insert on the same (server-minted) id is a logged 500.
        assert!(matches!(
            create_cloud_app(&store, &new_cloud("app-x")),
            Err(AppError::Infrastructure { .. })
        ));
    }

    #[test]
    fn create_self_hosted_app_returns_the_installed_app() {
        let store = FakeAppsStore::default();
        let app = create_self_hosted_app(&store, &new_upload("my-app")).expect("insert");
        assert_eq!(app.registration.id, "my-app");
    }

    #[test]
    fn create_self_hosted_maps_slug_exhaustion_to_invalid_name() {
        let store = FakeAppsStore {
            upload_failure: Some(UploadInsertError::SlugSpaceExhausted),
            ..FakeAppsStore::default()
        };
        assert!(matches!(
            create_self_hosted_app(&store, &new_upload("my-app")),
            Err(AppError::InvalidName { .. })
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
            Err(AppError::Infrastructure { .. })
        ));
    }

    #[test]
    fn replace_cloud_content_unknown_id_is_not_found() {
        let store = FakeAppsStore::default();
        assert!(matches!(
            replace_cloud_content(
                &store,
                "ghost",
                "n".to_owned(),
                None,
                "https://x.example".to_owned(),
                false,
            ),
            Err(AppError::NotFound { .. })
        ));
    }

    #[test]
    fn replace_cloud_content_rewrites_a_cloud_app() {
        let store = FakeAppsStore::default();
        create_cloud_app(&store, &new_cloud("app-x")).expect("insert");
        let updated = replace_cloud_content(
            &store,
            "app-x",
            "Renamed".to_owned(),
            None,
            "https://example.com/new".to_owned(),
            false,
        )
        .expect("replace");
        assert_eq!(updated.registration.name, "Renamed");
        assert_eq!(
            store.find_app("app-x").unwrap().unwrap().name(),
            "Renamed",
            "the store now holds the rewritten row",
        );
    }

    /// A per-kind path resolves the kind before validating fields: a cloud replace
    /// of a system id is `404` (not a cloud app), even when its url is also bad —
    /// the kind mismatch wins, and can no longer be expressed as a `409`.
    #[test]
    fn replace_cloud_content_on_a_system_id_is_not_found_before_url_validation() {
        let store = FakeAppsStore::default();
        system(&store, "api-docs");
        assert!(
            matches!(
                replace_cloud_content(
                    &store,
                    "api-docs",
                    "n".to_owned(),
                    None,
                    "javascript:alert(1)".to_owned(),
                    false,
                ),
                Err(AppError::NotFound { .. }),
            ),
            "the wrong-kind 404 must win over the bad url",
        );
    }

    #[test]
    fn replace_cloud_content_validates_the_cloud_fields() {
        let store = FakeAppsStore::default();
        create_cloud_app(&store, &new_cloud("app-x")).expect("insert");
        assert!(matches!(
            replace_cloud_content(
                &store,
                "app-x",
                String::new(),
                None,
                "https://x.example".to_owned(),
                false,
            ),
            Err(AppError::InvalidName { .. })
        ));
        assert!(matches!(
            replace_cloud_content(
                &store,
                "app-x",
                "n".to_owned(),
                None,
                "javascript:alert(1)".to_owned(),
                false,
            ),
            Err(AppError::InvalidUrl { .. })
        ));
    }

    #[test]
    fn replace_self_hosted_launch_path_on_a_seeded_app_is_not_editable() {
        let store = FakeAppsStore::default();
        seeded_self_hosted(&store, "patient-browser", true);
        assert!(matches!(
            replace_self_hosted_launch_path(
                &store,
                "patient-browser",
                Some("/launch.html".to_owned()),
            ),
            Err(AppError::NotEditable { .. })
        ));
    }

    #[test]
    fn replace_self_hosted_launch_path_on_a_cloud_id_is_not_found() {
        let store = FakeAppsStore::default();
        create_cloud_app(&store, &new_cloud("app-x")).expect("insert");
        assert!(matches!(
            replace_self_hosted_launch_path(&store, "app-x", Some("/launch.html".to_owned())),
            Err(AppError::NotFound { .. })
        ));
    }

    #[test]
    fn replace_self_hosted_launch_path_edits_and_validates() {
        let store = FakeAppsStore::default();
        seeded_self_hosted(&store, "my-app", false);
        let updated =
            replace_self_hosted_launch_path(&store, "my-app", Some("/launch.html".to_owned()))
                .expect("replace");
        assert_eq!(updated.launch_path.as_deref(), Some("/launch.html"));
        // A non-origin-relative path is rejected.
        assert!(matches!(
            replace_self_hosted_launch_path(
                &store,
                "my-app",
                Some("https://evil.example/launch".to_owned()),
            ),
            Err(AppError::InvalidUrl { .. })
        ));
    }

    #[test]
    fn delete_app_succeeds_then_reports_a_miss_as_infrastructure() {
        let store = FakeAppsStore::default();
        create_cloud_app(&store, &new_cloud("app-x")).expect("insert");
        delete_app(&store, "app-x").expect("delete succeeds");
        assert!(matches!(
            get_app(&store, "app-x"),
            Err(AppError::NotFound { .. })
        ));
        // A second delete is a miss — the row was gone, so it's a logged 500.
        assert!(matches!(
            delete_app(&store, "app-x"),
            Err(AppError::Infrastructure { .. })
        ));
    }

    #[test]
    fn replace_home_screen_permutation_returns_the_reordered_registry() {
        let store = FakeAppsStore::default();
        create_cloud_app(&store, &new_cloud("a")).expect("insert");
        create_cloud_app(&store, &new_cloud("b")).expect("insert");
        let updated =
            replace_home_screen(&store, &[("b".to_owned(), true), ("a".to_owned(), false)])
                .expect("permutation");
        let ids: Vec<&str> = updated.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"], "the registry comes back reordered");
        assert!(
            !store.find_app("a").unwrap().unwrap().enabled(),
            "a disabled"
        );
    }

    #[test]
    fn replace_home_screen_non_permutation_is_invalid_home_screen() {
        let store = FakeAppsStore::default();
        create_cloud_app(&store, &new_cloud("a")).expect("insert");
        create_cloud_app(&store, &new_cloud("b")).expect("insert");
        // A subset isn't an exact permutation.
        assert!(matches!(
            replace_home_screen(&store, &[("a".to_owned(), true)]),
            Err(AppError::InvalidHomeScreen { .. })
        ));
    }
}
