//! The create capability — [`AppsCreator`], gated by `wildflower/Apps.c`
//! ([`apps_creator_scopes`](super::apps_creator_scopes)).

use std::sync::Arc;

use bytes::Bytes;
use scopes_rust::{Permission, Scope, WildflowerResource};

use crate::domain::actions::{self, CloudAppPayload};
use crate::domain::{
    AppKind, AppRegistration, AppsError, AppsStore, CloudAppConfiguration, CloudInsertError,
    SelfHostedAppConfiguration, SelfHostedAppConfigurationPayload, SelfHostedInstaller,
};
use crate::id_utils::mint_app_id;

/// Register a new cloud / self-hosted app — `wildflower/Apps.c`.
pub(crate) fn apps_creator_scopes() -> Vec<Scope> {
    vec![Scope::wildflower(
        WildflowerResource::Apps,
        Permission::CREATE,
    )]
}

/// Registration of new apps — `POST /cloud-apps` and `POST /self-hosted-apps`.
/// Gated by `wildflower/Apps.c`. Holds the store, the self-hosted installer, and
/// the loopback ports reserved against a new upload — all lifted from the state.
pub(crate) struct AppsCreator<S: AppsStore, I: SelfHostedInstaller> {
    store: S,
    installer: Arc<I>,
    reserved_ports: Vec<u16>,
}

impl<S: AppsStore, I: SelfHostedInstaller> AppsCreator<S, I> {
    pub(crate) fn new(store: S, installer: Arc<I>, reserved_ports: Vec<u16>) -> Self {
        Self {
            store,
            installer,
            reserved_ports,
        }
    }

    /// Create a cloud app: mint the id, validate the content, synthesize the
    /// `(registration, configuration)`, and insert. A [`CloudInsertError::IdTaken`]
    /// means the server-minted id was already taken (a vanishingly-unlikely 21-char
    /// collision), surfaced as a logged [`AppsError::Infrastructure`] rather than
    /// silently returning the existing row.
    pub(crate) fn create_cloud_app(
        &self,
        payload: CloudAppPayload,
    ) -> Result<(AppRegistration, CloudAppConfiguration), AppsError> {
        let id = mint_app_id();
        let (name, subtitle, url) =
            actions::validate_cloud_fields(payload.name, payload.subtitle, payload.url)?;
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
            requires_tunnel: payload.requires_tunnel,
        };
        let config = CloudAppConfiguration { url };
        self.store
            .insert_cloud_app(&registration, &config)?
            .map_err(|error| match error {
                CloudInsertError::IdTaken => {
                    tracing::error!("app id collision on {}", registration.id);
                    AppsError::infrastructure("insert_cloud_app id collision", "id already exists")
                }
            })
    }

    /// Install a self-hosted app from an uploaded `bundle`: derive the slug (id /
    /// subdomain) from `name`, stage the bundle, synthesize the pair, insert
    /// (reserving the host's own loopback port so an upload never binds over it),
    /// and start the listener — unwinding the staged files if the insert fails.
    pub(crate) async fn create_self_hosted_app(
        &self,
        name: String,
        subtitle: Option<String>,
        bundle: Bytes,
    ) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
        // The slug is the name reduced to a DNS label; a name that slugs to
        // nothing is a `400 InvalidName` before anything is staged.
        let slug = actions::slugify(&name).ok_or_else(|| AppsError::InvalidName {
            message: "name must contain at least one letter or digit".to_owned(),
        })?;

        // Stage the bundle onto disk (extract + move into place) so a committed
        // row always points at present files.
        let staged = self.installer.stage(bundle).await?;

        // Synthesize the registration + create payload the store persists — the
        // slug is the id and subdomain, `position` is a placeholder the store
        // overrides, and an empty subtitle clears to `None`. The store owns `port`
        // and writes `seeded = false`.
        let registration = AppRegistration {
            id: slug.clone(),
            kind: AppKind::SelfHosted,
            position: 0,
            on_homescreen: true,
            name,
            subtitle: subtitle.filter(|s| !s.is_empty()),
            local_only: true,
            client_id: None,
            requires_tunnel: false,
        };
        let create = SelfHostedAppConfigurationPayload {
            content_folder: staged.content_folder,
            subdomain: slug,
            launch_path: staged.launch_path,
        };

        // Insert; unwind the just-staged files if the row can't be written.
        let (registration, config) =
            match self
                .store
                .insert_self_hosted_app(&registration, &create, &self.reserved_ports)
            {
                Ok(pair) => pair,
                Err(error) => {
                    self.installer.discard(&create.content_folder);
                    return Err(error);
                }
            };

        // The row is committed and the files are in place — bring the listener online.
        self.installer
            .start_listener(&registration.id, &config)
            .await?;
        Ok((registration, config))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::actions::test_fake::{seeded_self_hosted, FakeAppsStore, FakeInstaller};

    #[test]
    // The single-threaded fake installer holds `RefCell`s (not `Sync`); the real
    // `SelfHostedAppsService` the binding uses is `Send + Sync`, so the `Arc` is
    // only non-Send/Sync in this test.
    #[allow(clippy::arc_with_non_send_sync)]
    fn creator_creates_cloud_apps() {
        let creator = AppsCreator::new(
            FakeAppsStore::default(),
            Arc::new(FakeInstaller::new("folder")),
            Vec::new(),
        );
        let (registration, config) = creator
            .create_cloud_app(CloudAppPayload {
                name: "My App".to_owned(),
                subtitle: None,
                url: "https://example.com/launch".to_owned(),
                requires_tunnel: false,
            })
            .expect("create");
        assert_eq!(registration.kind, AppKind::Cloud);
        assert!(!registration.id.is_empty());
        assert!(config.url.to_string().contains("example.com"));
    }

    /// A self-hosted install derives the slug id from the name, normalizes an empty
    /// subtitle to `None`, records the staged folder, and starts the listener —
    /// discarding nothing on success.
    #[tokio::test]
    // See `creator_creates_cloud_apps`: the fake installer's `Arc` is non-Send/Sync
    // only in test; the production binding uses the `Send + Sync` service.
    #[allow(clippy::arc_with_non_send_sync)]
    async fn creator_installs_a_self_hosted_app_and_starts_its_listener() {
        let installer = Arc::new(FakeInstaller::new("mint-abc"));
        let creator =
            AppsCreator::new(FakeAppsStore::default(), Arc::clone(&installer), Vec::new());
        let (registration, config) = creator
            .create_self_hosted_app(
                "My App".to_owned(),
                Some(String::new()),
                bytes::Bytes::new(),
            )
            .await
            .expect("install");
        assert_eq!(registration.id, "my-app", "the id is the slugified name");
        assert_eq!(registration.kind, AppKind::SelfHosted);
        assert_eq!(
            registration.subtitle, None,
            "an empty subtitle clears to None"
        );
        assert_eq!(
            config.content_folder, "mint-abc",
            "the staged folder verbatim"
        );
        assert_eq!(config.launch_path.as_deref(), Some("/launch.html"));
        assert_eq!(
            installer.started.borrow().as_slice(),
            ["my-app"],
            "the listener is started for the installed id",
        );
        assert!(
            installer.discarded.borrow().is_empty(),
            "nothing is discarded on success",
        );
    }

    /// A name that slugs to nothing is a `400 InvalidName` before anything is staged
    /// or started.
    #[tokio::test]
    #[allow(clippy::arc_with_non_send_sync)]
    async fn creator_self_hosted_rejects_a_nameless_slug_before_staging() {
        let installer = Arc::new(FakeInstaller::new("mint"));
        let creator =
            AppsCreator::new(FakeAppsStore::default(), Arc::clone(&installer), Vec::new());
        let result = creator
            .create_self_hosted_app("!!!".to_owned(), None, bytes::Bytes::new())
            .await;
        assert!(matches!(result, Err(AppsError::InvalidName { .. })));
        assert!(
            installer.started.borrow().is_empty() && installer.discarded.borrow().is_empty(),
            "a name that slugs to nothing never stages or starts",
        );
    }

    /// When the store rejects the insert (a taken slug → `400 InvalidName`), the
    /// just-staged bundle is unwound (`discard`) and the listener is never started.
    #[tokio::test]
    #[allow(clippy::arc_with_non_send_sync)]
    async fn creator_self_hosted_discards_the_bundle_when_the_insert_fails() {
        let store = FakeAppsStore::default();
        // A pre-existing app owns the slug, so the store insert reports a taken id.
        seeded_self_hosted(&store, "my-app", false);
        let installer = Arc::new(FakeInstaller::new("mint-xyz"));
        let creator = AppsCreator::new(store, Arc::clone(&installer), Vec::new());
        let result = creator
            .create_self_hosted_app("My App".to_owned(), None, bytes::Bytes::new())
            .await;
        assert!(matches!(result, Err(AppsError::InvalidName { .. })));
        assert_eq!(
            installer.discarded.borrow().as_slice(),
            ["mint-xyz"],
            "the staged folder is unwound when the row can't be written",
        );
        assert!(
            installer.started.borrow().is_empty(),
            "a failed insert never starts the listener",
        );
    }
}
