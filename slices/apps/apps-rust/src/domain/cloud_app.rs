//! [`CloudApp`] — a cloud app: assets served from a remote origin, reaching PHI
//! back through the tunnel. The standalone `cloud_apps` row, carrying every one
//! of its own columns (the shared catalogue fields `id` / `name` / `subtitle` /
//! `local_only` / `client_id`, plus the cloud payload `url` + `requires_tunnel`).
//! The table it lives in IS its provenance — there is no stored `provenance`
//! column. The home-screen ordering + `enabled` flag live in the separate
//! `home_screen` table (see [`App`](super::App)).
//!
//! Diesel maps this type straight to/from the `cloud_apps` table: the derives
//! plus the [`AppUrlColumn`](crate::db::columns::AppUrlColumn) mapping on `url`
//! (a validated URL stored as TEXT). A plain-data row type — the shared
//! catalogue verdicts (`smart` / `removable`) are the behavioural
//! [`AppRecord`](super::AppRecord) impl below.

use diesel::prelude::{Insertable, Queryable, Selectable};

use super::app_url::AppUrl;
use super::AppRecord;
use crate::db::columns::AppUrlColumn;
use crate::db::schema::cloud_apps;

/// A stored cloud app — the `cloud_apps` row. The `url` is a launch template:
/// `{origin}` is replaced with the served origin at launch time, `{launch}` with
/// a fresh per-launch nonce (see [`AppUrl`]).
#[derive(Debug, Clone, PartialEq, Eq, Queryable, Selectable, Insertable)]
#[diesel(table_name = cloud_apps)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct CloudApp {
    /// Stable id, globally unique across all kinds.
    pub id: String,
    pub name: String,
    /// `None` means "no subtitle"; the wire serializes it as an absent field.
    pub subtitle: Option<String>,
    /// The declared no-egress flag (a UI badge this pass). Cloud apps are not
    /// local-only, but the column is carried for the uniform catalogue shape.
    pub local_only: bool,
    /// Soft reference to a gatekeeper `clients.client_id`; `None` for non-SMART
    /// apps. Its presence is what [`AppRecord::smart`] reports.
    pub client_id: Option<String>,
    /// The launch URL template, mapped to/from the TEXT column via
    /// [`AppUrlColumn`]. See [`AppUrl`] for the accepted shapes / placeholders.
    #[diesel(serialize_as = AppUrlColumn, deserialize_as = AppUrlColumn)]
    pub url: AppUrl,
    /// Whether a launch must bring the tunnel up first (the app needs a public
    /// FHIR origin to call back into).
    pub requires_tunnel: bool,
}

impl AppRecord for CloudApp {
    /// A cloud app is a SMART app iff it carries a `client_id`.
    fn smart(&self) -> bool {
        self.client_id.is_some()
    }

    /// Every cloud app is removable through the admin surface.
    fn removable(&self) -> bool {
        true
    }
}
