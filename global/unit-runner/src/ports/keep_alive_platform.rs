//! [`KeepAlivePlatform`], how the runner starts and stops the platform's
//! keep-alive task.

use std::future::Future;
use std::pin::Pin;

/// A keep-alive start's or stop's future.
pub type KeepAliveOperation<'a> = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>>;

/// What the runner needs from the platform to keep the app alive: a Tauri
/// app's background-service plugin, or a fake in tests.
///
/// Neither call tells the runner about the task itself. The keep-alive task
/// the platform runs reports its own start and end to the runner
/// ([`UnitRunnerCore::keep_alive_started`](crate::UnitRunnerCore::keep_alive_started),
/// [`UnitRunnerCore::keep_alive_ended`](crate::UnitRunnerCore::keep_alive_ended)),
/// whoever started it.
pub trait KeepAlivePlatform: Send + Sync + 'static {
    /// Start the keep-alive task. A task already running counts as started.
    fn start(&self) -> KeepAliveOperation<'_>;

    /// Stop the keep-alive task, with the runner's own stop reason. A task
    /// already stopped counts as stopped.
    fn stop(&self) -> KeepAliveOperation<'_>;
}
