//! [`BackgroundSessionPlatform`], how `UnitRunner` asks the platform to start
//! and end its background session.

use std::future::Future;

/// What `UnitRunner` needs from the platform to keep the app alive in the
/// background: a Tauri app's background-service plugin, or a fake in tests.
///
/// Neither call tells `UnitRunner` about the session itself. The session the
/// platform runs reports its own start and end to `UnitRunner`
/// ([`UnitRunner::session_started`](crate::UnitRunner::session_started),
/// [`UnitRunner::session_ended`](crate::UnitRunner::session_ended)),
/// whoever started it. So a call's future resolving says only that the
/// platform took the request: a start resolves once the platform has accepted
/// it, before the session reports its start; an end resolves once the platform
/// has asked the session to end, before the session reports its end.
pub trait BackgroundSessionPlatform: Send + Sync + 'static {
    /// Ask the platform to start the background session. A session already
    /// running counts as started.
    fn request_session_start(&self) -> impl Future<Output = anyhow::Result<()>> + Send;

    /// Ask the platform to end the background session, with `UnitRunner`'s own
    /// stop reason. A session already ended counts as ended.
    fn request_session_end(&self) -> impl Future<Output = anyhow::Result<()>> + Send;
}
