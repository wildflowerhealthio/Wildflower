//! `App` — one whole app: the parent registry row (`apps` table) plus its
//! [`AppKind`] payload (the kind-specific child-table data, or nothing for a
//! system app). The single domain representation every read hands back and
//! every projection starts from.
//!
//! Not a wire type — the catalogue speaks [`AppListEntry`](super::AppListEntry),
//! built by exactly one projection (`From<&App>`). The stored `apps.provenance`
//! column is decoded into the [`AppKind`] variant, never carried as a separate
//! field, so a kind/payload mismatch is unrepresentable. `client_id` is a soft
//! reference to the gatekeeper `clients` table whose presence makes an app
//! "smart" — see `docs/Apps/Explanation.md` §"`client_id` is a soft reference".

use super::{CloudApp, Provenance, SelfHostedApp};

/// One whole app: the kind-independent parent-row fields plus the kind payload.
/// Read by the store's JOIN projection; the launch handler dispatches on
/// [`Self::kind`], the wire projects through `From<&App> for AppListEntry`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct App {
    /// Stable id, globally unique across all kinds (the parent primary key, so
    /// there is no cross-table id collision to resolve).
    pub id: String,
    pub name: String,
    /// `None` means "no subtitle"; the wire serializes it as an absent field.
    pub subtitle: Option<String>,
    pub enabled: bool,
    /// Display order for `GET /apps` (`ORDER BY position`) and drag-to-reorder.
    pub position: i64,
    /// The declared no-egress flag (a UI badge this pass).
    pub local_only: bool,
    /// Soft reference to a gatekeeper `clients.client_id`; `None` for non-SMART
    /// apps. Its presence is what [`Self::smart`] reports.
    pub client_id: Option<String>,
    /// The kind payload — the child-table data for cloud / self-hosted apps,
    /// nothing for system apps (their launch source is compiled in).
    pub kind: AppKind,
}

/// The kind-specific payload. The variant *is* the stored provenance
/// ([`AppKind::provenance`] derives the column value), so an `App` can't claim
/// one kind while carrying another kind's fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppKind {
    /// A compiled-in shell route. Deliberately fieldless: the launch URL is not
    /// stored in the database — launch resolution consults
    /// [`system_app::find`](super::system_app::find), keeping catalogue reads
    /// free of launch-only data.
    System,
    /// A locally-served app on a dedicated loopback port (`self_hosted_apps`
    /// child row).
    SelfHosted(SelfHostedApp),
    /// A remote `https://` launch template (`cloud_apps` child row).
    Cloud(CloudApp),
}

impl AppKind {
    /// The provenance discriminant this variant stores/serializes as.
    #[must_use]
    pub fn provenance(&self) -> Provenance {
        match self {
            AppKind::System => Provenance::System,
            AppKind::SelfHosted(_) => Provenance::SelfHosted,
            AppKind::Cloud(_) => Provenance::Cloud,
        }
    }
}

impl App {
    /// How this app's launch target resolves — derived from the kind payload.
    #[must_use]
    pub fn provenance(&self) -> Provenance {
        self.kind.provenance()
    }

    /// Whether this app is a SMART app — i.e. it carries a `client_id` soft
    /// reference to a gatekeeper OAuth client.
    #[must_use]
    pub fn smart(&self) -> bool {
        self.client_id.is_some()
    }

    /// Whether the owner can remove this app through the admin surface: cloud and
    /// uploaded (non-seeded) self-hosted apps are removable; system and seeded
    /// self-hosted apps are not. See `docs/Apps/Explanation.md` §"Removability".
    #[must_use]
    pub fn removable(&self) -> bool {
        match &self.kind {
            AppKind::System => false,
            AppKind::Cloud(_) => true,
            AppKind::SelfHosted(app) => !app.seeded,
        }
    }

    /// The cloud payload, `None` for other kinds.
    #[must_use]
    pub fn as_cloud(&self) -> Option<&CloudApp> {
        match &self.kind {
            AppKind::Cloud(app) => Some(app),
            _ => None,
        }
    }

    /// The self-hosted payload, `None` for other kinds.
    #[must_use]
    pub fn as_self_hosted(&self) -> Option<&SelfHostedApp> {
        match &self.kind {
            AppKind::SelfHosted(app) => Some(app),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::AppUrl;

    fn app(kind: AppKind, client_id: Option<&str>) -> App {
        App {
            id: "app-x".to_owned(),
            name: "App X".to_owned(),
            subtitle: None,
            enabled: true,
            position: 0,
            local_only: false,
            client_id: client_id.map(str::to_owned),
            kind,
        }
    }

    fn self_hosted(seeded: bool) -> AppKind {
        AppKind::SelfHosted(SelfHostedApp {
            port: 8081,
            content_folder: "app-x".to_owned(),
            subdomain: "app-x".to_owned(),
            seeded,
            launch_path: None,
        })
    }

    fn cloud() -> AppKind {
        AppKind::Cloud(CloudApp {
            url: AppUrl::External("https://example.com/launch".to_owned()),
            requires_tunnel: false,
        })
    }

    /// The provenance is the variant — one source of truth per kind.
    #[test]
    fn provenance_derives_from_the_kind() {
        assert_eq!(app(AppKind::System, None).provenance(), Provenance::System);
        assert_eq!(
            app(self_hosted(true), None).provenance(),
            Provenance::SelfHosted,
        );
        assert_eq!(app(cloud(), None).provenance(), Provenance::Cloud);
    }

    /// `smart` is exactly "carries a client_id", independent of kind.
    #[test]
    fn smart_reports_the_client_id_presence() {
        assert!(app(cloud(), Some("client")).smart());
        assert!(!app(cloud(), None).smart());
        assert!(app(AppKind::System, Some("client")).smart());
    }

    /// The removability matrix: cloud and uploaded self-hosted are removable;
    /// system and seeded self-hosted are not.
    #[test]
    fn removable_matrix() {
        assert!(app(cloud(), None).removable());
        assert!(app(self_hosted(false), None).removable());
        assert!(!app(self_hosted(true), None).removable());
        assert!(!app(AppKind::System, None).removable());
    }

    /// The narrowing accessors return the payload only for their own kind.
    #[test]
    fn narrowing_accessors_match_their_kind_only() {
        let cloud_app = app(cloud(), None);
        assert!(cloud_app.as_cloud().is_some());
        assert!(cloud_app.as_self_hosted().is_none());

        let self_hosted_app = app(self_hosted(false), None);
        assert!(self_hosted_app.as_self_hosted().is_some());
        assert!(self_hosted_app.as_cloud().is_none());

        let system_app = app(AppKind::System, None);
        assert!(system_app.as_cloud().is_none());
        assert!(system_app.as_self_hosted().is_none());
    }
}
