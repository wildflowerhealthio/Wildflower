//! Project a persisted [`AppRow`] into the wire-level [`AppEntry`], layering
//! the bundled-registry metadata onto bundled/action rows. Shared between
//! the list, create, and update handlers so they all surface the same shape
//! and the same id is never described differently by different routes.

use crate::db::AppRow;
use crate::domain::{find_bundled, AppEntry, AppKind};

/// Build the wire entry for one persisted row. `None` for a row whose
/// `kind` is unknown — defensive against a future migration that adds a
/// `kind` value the registry doesn't know about; the row would otherwise
/// surface as a half-built entry with empty metadata.
pub(super) fn build_entry(row: &AppRow) -> Option<AppEntry> {
    match row.kind.as_str() {
        "bundled" | "action" => {
            let app = find_bundled(&row.id)?;
            Some(AppEntry {
                id: row.id.clone(),
                name: app.name.to_owned(),
                subtitle: Some(app.subtitle.to_owned()),
                requires_tunnel: app.requires_tunnel,
                kind: app.kind.into(),
                enabled: row.enabled,
            })
        }
        "custom" => {
            let url = row.custom_url.clone().unwrap_or_default();
            Some(AppEntry {
                id: row.id.clone(),
                name: row
                    .custom_name
                    .clone()
                    .unwrap_or_else(|| "Custom App".to_owned()),
                // Custom apps surface their URL as the subtitle (matching
                // TS). An empty url -> no subtitle.
                subtitle: if url.is_empty() { None } else { Some(url) },
                requires_tunnel: row.custom_requires_tunnel.unwrap_or(false),
                kind: AppKind::Custom,
                enabled: row.enabled,
            })
        }
        _ => None,
    }
}
