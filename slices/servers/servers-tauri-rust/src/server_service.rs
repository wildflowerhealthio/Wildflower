//! The [`ServerService`] port: what starts and stops a server's run. The app
//! implements it over the background server service; tests use a fake.

use servers_rust::ServerRecord;

/// Starts and stops servers, reporting each run's state and tunnel liveness
/// to the [`ServerStatuses`](crate::ServerStatuses) it was built with.
#[async_trait::async_trait]
pub trait ServerService: Send + Sync {
    /// Start `server` from its folder. A config that can't be built, or a
    /// service that doesn't start, is an error, and nothing runs.
    ///
    /// # Errors
    ///
    /// Why the server couldn't be started.
    async fn start(&self, server: &ServerRecord) -> Result<(), String>;

    /// Stop the server with `domain`, returning once its run has ended and its
    /// last state has been reported. A server that isn't running counts as
    /// stopped.
    ///
    /// # Errors
    ///
    /// Why the server couldn't be stopped. It may still be running.
    async fn stop(&self, domain: &str) -> Result<(), String>;

    /// No server is to run, for `reason`: a run the platform or the OS starts
    /// on its own (a phone's background task, the plugin's recovery) ends at
    /// once, logging it.
    fn publish_no_server(&self, reason: String);
}
