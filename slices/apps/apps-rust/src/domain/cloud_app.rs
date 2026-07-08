//! `CloudAppRow` — the internal materialization of a cloud app: the parent `apps`
//! registry row's mutable fields joined onto its `cloud_apps` child (the launch
//! `url` template + `requires_tunnel`).
//!
//! This is **not** a wire type — the catalogue speaks [`AppListEntry`](super::AppListEntry)
//! (a `provenance`-discriminated union whose cloud variant carries the same
//! `url` / `requires_tunnel`). `CloudAppRow` is what the `db::cloud_apps` layer
//! reads/writes and what the launch handler resolves a cloud target from; the
//! JOIN mapping is hand-written (not `sql_row!`) because `id` / `name` /
//! `subtitle` / `enabled` come from the parent and `url` / `requires_tunnel`
//! from the child.

use super::app_url::AppUrl;

/// A cloud app's editable state — parent registry fields plus the `cloud_apps`
/// child. The `url` is a template: `{origin}` is replaced with the served origin
/// at launch time, `{launch}` with a fresh per-launch nonce. See [`AppUrl`] for
/// the accepted shapes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudAppRow {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    /// `None` means the row has no explicit subtitle.
    pub subtitle: Option<String>,
    /// The launch URL template. See [`AppUrl`] for the accepted shapes /
    /// placeholders.
    pub url: AppUrl,
    pub requires_tunnel: bool,
}
