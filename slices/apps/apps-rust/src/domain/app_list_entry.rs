//! `AppListEntry` — the app-catalogue wire shape, a **union discriminated on
//! `provenance`**. It backs `GET /apps` and `PUT /home-screen`, and is also the
//! create / replace response for every kind (`POST /apps`,
//! `POST /self-hosted-apps`, `PUT /apps/{id}`).
//!
//! The shape mirrors the database: the shared fields are the parent `apps`
//! registry row (`id`, `name`, `subtitle`, `enabled`, `local_only`, plus the
//! computed `smart` / `removable`); each variant adds the fields from its typed
//! child table — `cloud_apps` contributes the launch `url` template and
//! `requires_tunnel`; `self_hosted_apps` contributes the `launch_path`. System
//! apps have no child table and add nothing.
//!
//! Both the cloud `url` and the self-hosted `launch_path` are **stored,
//! origin-independent templates** (they carry `{origin}` / `{launch}`
//! placeholders the launch handler substitutes per request) — not
//! request-time-resolved launch URLs. That's why they're safe to expose on a
//! read shape: a client can display / edit the template without it ever being a
//! concrete redirect target. See `docs/Apps/Explanation.md`.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::{AppUrl, Provenance};

/// One app-catalogue entry on the wire, discriminated on `provenance`. Serialized
/// internally-tagged: every variant carries a `"provenance"` field (`"system"` /
/// `"cloud"` / `"self-hosted"`) alongside its fields, so utoipa renders it as a
/// `oneOf` and the TS client decodes it as a discriminated union.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "provenance", rename_all = "kebab-case")]
pub enum AppListEntry {
    /// A system app — a compiled-in shell route. No child table, no extra fields.
    #[serde(rename_all = "camelCase")]
    System {
        id: String,
        enabled: bool,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subtitle: Option<String>,
        local_only: bool,
        smart: bool,
        removable: bool,
    },
    /// A cloud app — carries its stored launch `url` template and the
    /// tunnel-requirement flag from the `cloud_apps` child.
    #[serde(rename_all = "camelCase")]
    Cloud {
        id: String,
        enabled: bool,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subtitle: Option<String>,
        local_only: bool,
        smart: bool,
        removable: bool,
        /// The stored launch URL template (`{origin}` / `{launch}` tokens),
        /// serialized as its canonical string. See [`AppUrl`].
        #[schema(value_type = String)]
        url: AppUrl,
        requires_tunnel: bool,
    },
    /// A self-hosted app — carries its stored `launch_path` (absent for a
    /// root-served bundle) from the `self_hosted_apps` child.
    #[serde(rename_all = "camelCase")]
    SelfHosted {
        id: String,
        enabled: bool,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        subtitle: Option<String>,
        local_only: bool,
        smart: bool,
        removable: bool,
        /// The stored SMART launch path (origin-relative, with `{origin}` /
        /// `{launch}` tokens), or absent for a root-served (`index.html`) app.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        launch_path: Option<String>,
    },
}

impl AppListEntry {
    /// The app's stable id, whatever the variant.
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            AppListEntry::System { id, .. }
            | AppListEntry::Cloud { id, .. }
            | AppListEntry::SelfHosted { id, .. } => id,
        }
    }

    /// The catalogue display name.
    #[must_use]
    pub fn name(&self) -> &str {
        match self {
            AppListEntry::System { name, .. }
            | AppListEntry::Cloud { name, .. }
            | AppListEntry::SelfHosted { name, .. } => name,
        }
    }

    /// The descriptive subtitle, if any.
    #[must_use]
    pub fn subtitle(&self) -> Option<&str> {
        match self {
            AppListEntry::System { subtitle, .. }
            | AppListEntry::Cloud { subtitle, .. }
            | AppListEntry::SelfHosted { subtitle, .. } => subtitle.as_deref(),
        }
    }

    /// Whether the app is enabled on the homescreen.
    #[must_use]
    pub fn enabled(&self) -> bool {
        match self {
            AppListEntry::System { enabled, .. }
            | AppListEntry::Cloud { enabled, .. }
            | AppListEntry::SelfHosted { enabled, .. } => *enabled,
        }
    }

    /// The declared no-egress flag.
    #[must_use]
    pub fn local_only(&self) -> bool {
        match self {
            AppListEntry::System { local_only, .. }
            | AppListEntry::Cloud { local_only, .. }
            | AppListEntry::SelfHosted { local_only, .. } => *local_only,
        }
    }

    /// Whether this is a SMART app (the registry row carries a `client_id`).
    #[must_use]
    pub fn smart(&self) -> bool {
        match self {
            AppListEntry::System { smart, .. }
            | AppListEntry::Cloud { smart, .. }
            | AppListEntry::SelfHosted { smart, .. } => *smart,
        }
    }

    /// Whether the owner can remove this app through the admin surface.
    #[must_use]
    pub fn removable(&self) -> bool {
        match self {
            AppListEntry::System { removable, .. }
            | AppListEntry::Cloud { removable, .. }
            | AppListEntry::SelfHosted { removable, .. } => *removable,
        }
    }

    /// The variant's provenance discriminant.
    #[must_use]
    pub fn provenance(&self) -> Provenance {
        match self {
            AppListEntry::System { .. } => Provenance::System,
            AppListEntry::Cloud { .. } => Provenance::Cloud,
            AppListEntry::SelfHosted { .. } => Provenance::SelfHosted,
        }
    }

    /// Whether a launch needs the tunnel up — the cloud variant's flag, else
    /// `false` (system / self-hosted apps never require the tunnel).
    #[must_use]
    pub fn requires_tunnel(&self) -> bool {
        match self {
            AppListEntry::Cloud {
                requires_tunnel, ..
            } => *requires_tunnel,
            _ => false,
        }
    }

    /// The self-hosted variant's stored launch path, else `None`.
    #[must_use]
    pub fn launch_path(&self) -> Option<&str> {
        match self {
            AppListEntry::SelfHosted { launch_path, .. } => launch_path.as_deref(),
            _ => None,
        }
    }
}
