//! [`BackgroundSessionPlatform`], how the runner starts and ends the platform's
//! background session.

use std::future::Future;
use std::pin::Pin;

/// A background session start's or end's future.
pub type BackgroundSessionOperation<'a> =
    Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>>;

/// What the runner needs from the platform to keep the app alive in the
/// background: a Tauri app's background-service plugin, or a fake in tests.
///
/// Neither call tells the runner about the session itself. The session the
/// platform runs reports its own start and end to the runner
/// ([`UnitRunnerCore::session_started`](crate::UnitRunnerCore::session_started),
/// [`UnitRunnerCore::session_ended`](crate::UnitRunnerCore::session_ended)),
/// whoever started it. So a call's future resolving says only that the
/// platform took the request: a start resolves once the platform has accepted
/// it, before the session reports its start; an end resolves once the platform
/// has asked the session to end, before the session reports its end.
pub trait BackgroundSessionPlatform: Send + Sync + 'static {
    /// Start the background session. A session already running counts as
    /// started.
    fn start(&self) -> BackgroundSessionOperation<'_>;

    /// End the background session, with the runner's own stop reason. A
    /// session already ended counts as ended.
    fn stop(&self) -> BackgroundSessionOperation<'_>;
}
