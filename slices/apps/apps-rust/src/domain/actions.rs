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
//! field validation ([`AppUrl`] parsing, the launch-path shape). The port stays
//! free of those semantics; the routes stay a straight `?`. Mirrors collector's
//! `actions.rs`.

use crate::domain::{
    App, AppError, AppUrl, AppsStore, CloudContent, NewCloudApp, NewSelfHostedUpload,
    UploadInsertError,
};

/// The `GET /apps` catalogue — every app, whole, in display order.
///
/// # Errors
///
/// [`AppError::Infrastructure`] if the store read fails.
pub(crate) fn list_apps(store: &impl AppsStore) -> Result<Vec<App>, AppError> {
    store.list_apps()
}

/// A single whole app by id, or [`AppError::NotFound`] when absent — the launch
/// dispatch and admin existence check.
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

/// Create a cloud app from a server-minted spec. Returns the inserted whole
/// [`App`] read back in-txn. A `None` from the store means the (server-minted)
/// id was already taken — a vanishingly-unlikely 21-char-random collision, so it
/// surfaces as a logged [`Infrastructure`](AppError::Infrastructure) 500 rather
/// than silently returning the existing row.
///
/// # Errors
///
/// [`AppError::Infrastructure`] on a store write failure or an id collision.
pub(crate) fn create_cloud_app(store: &impl AppsStore, new: &NewCloudApp) -> Result<App, AppError> {
    store.insert_cloud_app(new)?.ok_or_else(|| {
        tracing::error!("app id collision on {}", new.id);
        AppError::infrastructure("insert_cloud_app id collision", "id already exists")
    })
}

/// Install an uploaded self-hosted app. Returns the inserted whole [`App`] read
/// back in-txn, or maps the store's allocation-failure signal onto the wire
/// vocabulary: a slug clash is a name problem the caller can retry differently
/// ([`InvalidName`](AppError::InvalidName)), an exhausted port space is a server
/// resource fault no rename fixes (a logged
/// [`Infrastructure`](AppError::Infrastructure) 500 — it must not read as a
/// `400`).
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
) -> Result<App, AppError> {
    match store.insert_self_hosted_app(upload)? {
        Ok(app) => Ok(app),
        Err(UploadInsertError::SlugSpaceExhausted) => Err(AppError::InvalidName {
            message: "could not allocate a unique id for this name".to_owned(),
        }),
        Err(UploadInsertError::PortSpaceExhausted) => Err(AppError::infrastructure(
            "no free loopback port for a new self-hosted app",
            "port space exhausted",
        )),
    }
}

/// A `PUT /apps/{id}` content update, discriminated on kind — the domain form of
/// the HTTP `AppContentBody` union, with the cloud `url` still a raw string so
/// its validation happens *after* the editability/kind decision (a bad url on a
/// non-editable app is `409`, not `400`).
pub(crate) enum ContentUpdate {
    /// Full replace of a cloud app's content.
    Cloud {
        name: String,
        subtitle: Option<String>,
        url: String,
        requires_tunnel: bool,
    },
    /// Replace a self-hosted app's launch path (`None` / empty → root-served).
    SelfHosted { launch_path: Option<String> },
}

/// Replace an editable app's *content*, resolving existence and editability
/// before validating any field: an unknown id is [`NotFound`](AppError::NotFound)
/// regardless of the body; a system app, a seeded self-hosted app, or a body
/// whose kind doesn't match the stored app is
/// [`NotEditable`](AppError::NotEditable); only then is the field validated
/// (`400` on a bad name / url / launch path). `enabled` is **not** content —
/// `PUT /home-screen` owns it. Returns the updated whole [`App`] read back in-txn.
///
/// # Errors
///
/// [`AppError::NotFound`] on an unknown id; [`AppError::NotEditable`] on a system
/// app, a seeded self-hosted app, or a kind mismatch; [`AppError::InvalidName`] /
/// [`AppError::InvalidUrl`] on a bad field; [`AppError::Infrastructure`] on a
/// store failure (or the row vanishing between the read and the write).
pub(crate) fn replace_app_content(
    store: &impl AppsStore,
    id: &str,
    update: ContentUpdate,
) -> Result<App, AppError> {
    // Resolve existence before validating any field: a PUT to an unknown id is a
    // 404 regardless of the body. Then require the body's arm to match the stored
    // kind (a mismatch — or a system app — is `409`, not a silent no-op); the
    // whole `App` is in hand, so the seeded check reads straight off its record.
    let app = get_app(store, id)?;
    let updated = match (&app, update) {
        (
            App::Cloud { .. },
            ContentUpdate::Cloud {
                name,
                subtitle,
                url,
                requires_tunnel,
            },
        ) => {
            let content = validate_cloud_content(name, subtitle, url, requires_tunnel)?;
            store.replace_cloud_content(id, &content)?
        }
        (App::SelfHosted { app: child, .. }, ContentUpdate::SelfHosted { launch_path }) => {
            if child.seeded {
                // A migration-seeded app (patient-browser) is read-only, same
                // 409 as delete.
                return Err(AppError::NotEditable { id: id.to_owned() });
            }
            let launch_path = validate_launch_path(launch_path)?;
            store.replace_self_hosted_launch_path(id, launch_path.as_deref())?
        }
        // A system app, or a body targeting the wrong kind for this id.
        _ => return Err(AppError::NotEditable { id: id.to_owned() }),
    };
    updated.ok_or_else(|| {
        AppError::infrastructure("app vanished between find and replace", format!("id={id}"))
    })
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
/// the resulting catalogue in its new order.
///
/// # Errors
///
/// [`AppError::InvalidHomeScreen`] when `entries` isn't an exact permutation of
/// the live registry; [`AppError::Infrastructure`] on a store failure.
pub(crate) fn replace_home_screen(
    store: &impl AppsStore,
    entries: &[(String, bool)],
) -> Result<Vec<App>, AppError> {
    store
        .replace_home_screen(entries)?
        .ok_or_else(|| AppError::InvalidHomeScreen {
            message: "home-screen body must list every app exactly once".to_owned(),
        })
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
    use crate::domain::system_app::SYSTEM_APPS;
    use crate::domain::{CloudApp, SelfHostedApp};

    /// An in-memory [`AppsStore`] modelling the real primitive semantics —
    /// `insert_cloud_app` reports a duplicate id as `None`, `find_app`/`replace_*`
    /// report an absent id as `None`, `delete_app` reports a miss as `false`,
    /// `replace_home_screen` reports a non-permutation as `None` — with no diesel
    /// and no database. Lets the actions' semantic mapping be exercised directly;
    /// the `SQLite` adapter's own coverage lives in `crate::db`.
    ///
    /// `upload_failure`, when set, makes `insert_self_hosted_app` report that
    /// allocation failure instead of writing — exercising the action's
    /// [`UploadInsertError`] mapping without driving a real allocator to
    /// exhaustion (the adapter covers real exhaustion in `crate::db`).
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
        fn list_apps(&self) -> Result<Vec<App>, AppError> {
            let mut apps = self.apps.borrow().clone();
            apps.sort_by_key(App::position);
            Ok(apps)
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
            let app = App::Cloud {
                position: self.next_position(),
                enabled: true,
                app: CloudApp {
                    id: new.id.clone(),
                    name: new.content.name.clone(),
                    subtitle: new.content.subtitle.clone(),
                    local_only: false,
                    client_id: None,
                    url: new.content.url.clone(),
                    requires_tunnel: new.content.requires_tunnel,
                },
            };
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
            let app = App::SelfHosted {
                position: self.next_position(),
                enabled: true,
                app: SelfHostedApp {
                    id: slug.clone(),
                    name: new.name.clone(),
                    subtitle: new.subtitle.clone(),
                    local_only: true,
                    client_id: None,
                    port,
                    content_folder: new.content_folder.clone(),
                    subdomain: slug,
                    seeded: false,
                    launch_path: new.launch_path.clone(),
                },
            };
            self.seed(app.clone());
            Ok(Ok(app))
        }

        fn replace_cloud_content(
            &self,
            id: &str,
            content: &CloudContent,
        ) -> Result<Option<App>, AppError> {
            let mut apps = self.apps.borrow_mut();
            let Some(App::Cloud { app, .. }) = apps.iter_mut().find(|a| a.id() == id) else {
                return Ok(None);
            };
            app.name = content.name.clone();
            app.subtitle = content.subtitle.clone();
            app.url = content.url.clone();
            app.requires_tunnel = content.requires_tunnel;
            Ok(apps.iter().find(|a| a.id() == id).cloned())
        }

        fn replace_self_hosted_launch_path(
            &self,
            id: &str,
            launch_path: Option<&str>,
        ) -> Result<Option<App>, AppError> {
            let mut apps = self.apps.borrow_mut();
            let Some(App::SelfHosted { app, .. }) = apps.iter_mut().find(|a| a.id() == id) else {
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
        ) -> Result<Option<Vec<App>>, AppError> {
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
            Ok(Some(apps.clone()))
        }
    }

    /// Overwrite an [`App`]'s home-screen placement in place (the fake's stand-in
    /// for the store's `home_screen` renumber).
    fn set_placement(app: &mut App, new_position: i64, new_enabled: bool) {
        match app {
            App::System {
                position, enabled, ..
            }
            | App::Cloud {
                position, enabled, ..
            }
            | App::SelfHosted {
                position, enabled, ..
            } => {
                *position = new_position;
                *enabled = new_enabled;
            }
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
        store.seed(App::SelfHosted {
            position: store.next_position(),
            enabled: true,
            app: SelfHostedApp {
                id: id.to_owned(),
                name: "Seeded".to_owned(),
                subtitle: None,
                local_only: true,
                client_id: None,
                port: 8081,
                content_folder: id.to_owned(),
                subdomain: id.to_owned(),
                seeded,
                launch_path: None,
            },
        });
    }

    fn system(store: &FakeAppsStore, id: &'static str) {
        store.seed(App::System {
            position: store.next_position(),
            enabled: true,
            app: SYSTEM_APPS
                .iter()
                .copied()
                .find(|s| s.id == id)
                .unwrap_or(SYSTEM_APPS[0]),
        });
    }

    fn cloud_update(name: &str, url: &str) -> ContentUpdate {
        ContentUpdate::Cloud {
            name: name.to_owned(),
            subtitle: None,
            url: url.to_owned(),
            requires_tunnel: false,
        }
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
    fn create_cloud_app_inserts_then_reports_a_taken_id_as_infrastructure() {
        let store = FakeAppsStore::default();
        let created = create_cloud_app(&store, &new_cloud("app-x")).expect("insert");
        assert_eq!(created.id(), "app-x");
        assert!(created.enabled());
        // A second insert on the same (server-minted) id is a logged 500, never a
        // silent overwrite of the existing row.
        assert!(matches!(
            create_cloud_app(&store, &new_cloud("app-x")),
            Err(AppError::Infrastructure { .. })
        ));
    }

    #[test]
    fn create_self_hosted_app_returns_the_installed_app() {
        let store = FakeAppsStore::default();
        let app = create_self_hosted_app(&store, &new_upload("my-app")).expect("insert");
        assert_eq!(app.id(), "my-app");
        assert!(app.as_self_hosted().is_some());
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
    fn replace_app_content_unknown_id_is_not_found() {
        let store = FakeAppsStore::default();
        assert!(matches!(
            replace_app_content(&store, "ghost", cloud_update("n", "https://x.example")),
            Err(AppError::NotFound { .. })
        ));
    }

    #[test]
    fn replace_app_content_rewrites_a_cloud_app() {
        let store = FakeAppsStore::default();
        create_cloud_app(&store, &new_cloud("app-x")).expect("insert");
        let updated = replace_app_content(
            &store,
            "app-x",
            cloud_update("Renamed", "https://example.com/new"),
        )
        .expect("replace");
        assert_eq!(updated.name(), "Renamed");
        assert_eq!(
            store.find_app("app-x").unwrap().unwrap().name(),
            "Renamed",
            "the store now holds the rewritten row",
        );
    }

    #[test]
    fn replace_app_content_on_a_system_app_is_not_editable() {
        let store = FakeAppsStore::default();
        system(&store, "api-docs");
        assert!(matches!(
            replace_app_content(&store, "api-docs", cloud_update("n", "https://x.example")),
            Err(AppError::NotEditable { .. })
        ));
    }

    /// Editability resolves before field validation: a cloud-body PUT to a system
    /// app is `409`, even when its url is also bad — the mismatch is caught before
    /// the url is parsed.
    #[test]
    fn replace_app_content_editability_precedes_url_validation() {
        let store = FakeAppsStore::default();
        system(&store, "api-docs");
        assert!(
            matches!(
                replace_app_content(&store, "api-docs", cloud_update("n", "javascript:alert(1)")),
                Err(AppError::NotEditable { .. }),
            ),
            "the kind mismatch must win over the bad url",
        );
    }

    #[test]
    fn replace_app_content_on_a_seeded_self_hosted_app_is_not_editable() {
        let store = FakeAppsStore::default();
        seeded_self_hosted(&store, "patient-browser", true);
        assert!(matches!(
            replace_app_content(
                &store,
                "patient-browser",
                ContentUpdate::SelfHosted {
                    launch_path: Some("/launch.html".to_owned()),
                },
            ),
            Err(AppError::NotEditable { .. })
        ));
    }

    #[test]
    fn replace_app_content_rejects_a_body_of_the_wrong_kind() {
        let store = FakeAppsStore::default();
        create_cloud_app(&store, &new_cloud("app-x")).expect("insert");
        // A self-hosted body targeting a cloud app is a provenance mismatch.
        assert!(matches!(
            replace_app_content(
                &store,
                "app-x",
                ContentUpdate::SelfHosted {
                    launch_path: Some("/launch.html".to_owned()),
                },
            ),
            Err(AppError::NotEditable { .. })
        ));
    }

    #[test]
    fn replace_app_content_validates_the_cloud_fields() {
        let store = FakeAppsStore::default();
        create_cloud_app(&store, &new_cloud("app-x")).expect("insert");
        assert!(matches!(
            replace_app_content(&store, "app-x", cloud_update("", "https://x.example")),
            Err(AppError::InvalidName { .. })
        ));
        assert!(matches!(
            replace_app_content(&store, "app-x", cloud_update("n", "javascript:alert(1)")),
            Err(AppError::InvalidUrl { .. })
        ));
    }

    #[test]
    fn replace_app_content_edits_and_validates_a_self_hosted_launch_path() {
        let store = FakeAppsStore::default();
        seeded_self_hosted(&store, "my-app", false);
        let updated = replace_app_content(
            &store,
            "my-app",
            ContentUpdate::SelfHosted {
                launch_path: Some("/launch.html".to_owned()),
            },
        )
        .expect("replace");
        assert_eq!(
            updated.as_self_hosted().unwrap().launch_path.as_deref(),
            Some("/launch.html"),
        );
        // A non-origin-relative path is rejected.
        assert!(matches!(
            replace_app_content(
                &store,
                "my-app",
                ContentUpdate::SelfHosted {
                    launch_path: Some("https://evil.example/launch".to_owned()),
                },
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
        // A second delete is a miss — the row was gone, so it's a logged 500, not
        // a 404.
        assert!(matches!(
            delete_app(&store, "app-x"),
            Err(AppError::Infrastructure { .. })
        ));
    }

    #[test]
    fn replace_home_screen_permutation_returns_the_reordered_catalogue() {
        let store = FakeAppsStore::default();
        create_cloud_app(&store, &new_cloud("a")).expect("insert");
        create_cloud_app(&store, &new_cloud("b")).expect("insert");
        let updated =
            replace_home_screen(&store, &[("b".to_owned(), true), ("a".to_owned(), false)])
                .expect("permutation");
        let ids: Vec<&str> = updated.iter().map(App::id).collect();
        assert_eq!(ids, vec!["b", "a"], "the catalogue comes back reordered");
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
