//! The [`SelfHostedInstaller`] **port** — the filesystem + listener work the
//! self-hosted install action can't do itself, kept behind a trait so the action
//! stays pure (over [`AppsStore`](super::AppsStore) + this port) and unit-testable
//! against fakes. The native adapter ([`BundleInstaller`](crate::self_hosted_apps))
//! wraps the zip extractor and the `SelfHostedAppsService`; a test fake records the
//! calls.
//!
//! The action drives it in order: [`stage`](SelfHostedInstaller::stage) the uploaded
//! bundle onto disk (extract + move into place) so a committed row always points at
//! present files, then — after the store insert —
//! [`start_listener`](SelfHostedInstaller::start_listener) brings the loopback
//! listener online; if the insert fails after staging,
//! [`discard`](SelfHostedInstaller::discard) unwinds the staged folder. The bundle
//! rides in as a [`stage`](SelfHostedInstaller::stage) argument (not baked into the
//! installer), so one installer instance serves every upload.

use std::future::Future;

use bytes::Bytes;

use super::{AppsError, SelfHostedAppConfiguration};

/// A staged self-hosted bundle — extracted and moved into its serving folder,
/// named by `content_folder` (the row's future `content_folder`), with the
/// install-inferred `launch_path` (`None` for a root-served bundle).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StagedBundle {
    pub(crate) content_folder: String,
    pub(crate) launch_path: Option<String>,
}

/// The port the self-hosted install action drives for its platform work. The native
/// adapter performs real filesystem + listener operations; tests substitute a fake
/// that records the calls. Errors surface as the domain [`AppsError`] (a bad bundle
/// is a `400 InvalidZip`, an IO / listener failure a logged `500`), so the action
/// never sees the extractor's or service's own error types.
pub(crate) trait SelfHostedInstaller {
    /// Extract the uploaded `bundle` into a fresh serving folder (off the async
    /// runtime) and infer its launch path, moved into place so a committed row always
    /// points at present files. On failure nothing is left staged.
    fn stage(&self, bundle: Bytes) -> impl Future<Output = Result<StagedBundle, AppsError>>;

    /// Best-effort removal of an already-staged serving folder — unwinds the files
    /// when the row insert fails after staging.
    fn discard(&self, content_folder: &str);

    /// Bring the installed app's loopback listener online after the row commits.
    fn start_listener(
        &self,
        id: &str,
        config: &SelfHostedAppConfiguration,
    ) -> impl Future<Output = Result<(), AppsError>>;
}
