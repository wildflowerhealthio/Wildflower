//! Shared `#[cfg(test)]` fixtures for the tests that run against a real
//! in-memory [`SqliteAppsStore`](super::SqliteAppsStore). Registrations to seed
//! it with come from [`registration`](crate::domain::test_fake::registration).

use crate::domain::AppsError;

/// The migration-seeded registry, in display order.
pub(crate) const SEEDED_IDS: [&str; 9] = [
    "growth-chart",
    "medication-viewer",
    "precise-hbr",
    "medications-app",
    "web-trace-app",
    "web-server-docs",
    "importer-app",
    "ohif-viewer",
    "lifting-app",
];

/// The `context: source` text of an [`AppsError::Infrastructure`], for asserting on
/// the failure a corrupt-row read names.
pub(crate) fn error_text(error: &AppsError) -> String {
    match error {
        AppsError::Infrastructure { context, source } => format!("{context}: {source}"),
        other => format!("{other:?}"),
    }
}
