//! [`StaticHostsService`] — run a set of services, each on its own dedicated
//! loopback port, started and stopped at runtime.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Mutex;

use axum::extract::Request;
use axum::response::Response;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tower::make::Shared;
use tower::Service;
use url::Url;

use crate::error::ServerError;
use crate::params::{loopback_authority, StaticHostJob};

/// Runs static hosts — each a tower [`Service`] bound on `{host}:{port}` — and
/// lets the caller start and stop them at runtime. The loopback base URL the bind
/// host is picked out of is fixed at construction; each [`start`](Self::start)
/// job carries its own port.
///
/// Each running host owns a graceful-shutdown signal; dropping the service (or
/// calling [`stop`](Self::stop)) winds the host's listener down. This is the
/// capability that makes restartless install/uninstall possible — in the apps
/// slice today only the startup seed drives it, but the same calls work at
/// runtime.
pub struct StaticHostsService {
    loopback_base_url: Url,
    /// `id -> graceful-shutdown signal`. Dropping the sender (on `stop` or when
    /// the whole service drops) resolves the host's shutdown future, so the
    /// listener drains and ends.
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl StaticHostsService {
    #[must_use]
    pub fn new(loopback_base_url: Url) -> Self {
        Self {
            loopback_base_url,
            running: Mutex::new(HashMap::new()),
        }
    }

    /// Bind `job.port` on the service hostname and serve `job.service`. Any host
    /// previously running under the same id is stopped first.
    ///
    /// # Errors
    ///
    /// - [`ServerError::Bind`] if the port can't be bound (typically already in
    ///   use). Recoverable — the caller may still register the id for
    ///   reverse-proxy dispatch so remote traffic routes; only direct loopback
    ///   launches to that port fail.
    /// - [`ServerError::LockPoisoned`] if the running-hosts lock was poisoned.
    pub async fn start<S>(&self, job: StaticHostJob<S>) -> Result<(), ServerError>
    where
        S: Service<Request, Response = Response, Error = Infallible> + Clone + Send + 'static,
        S::Future: Send,
    {
        let StaticHostJob { id, port, service } = job;
        self.stop(&id)?;

        let authority = loopback_authority(&self.loopback_base_url, port);
        let listener = TcpListener::bind(&authority)
            .await
            .map_err(|source| ServerError::Bind {
                addr: authority.clone(),
                source,
            })?;
        tracing::info!(host = %id, addr = %authority, "serving static host on loopback");

        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let serve_id = id.clone();
        tokio::spawn(async move {
            // `Shared` adapts the `Clone` service into the `MakeService`
            // `axum::serve` wants, keeping this generic over the served service.
            let served = axum::serve(listener, Shared::new(service))
                .with_graceful_shutdown(async move {
                    // Resolves when the matching sender is sent or dropped.
                    let _ = stop_rx.await;
                })
                .await;
            if let Err(error) = served {
                tracing::error!(host = %serve_id, %error, "static-host listener stopped");
            }
        });

        self.running
            .lock()
            .map_err(|_| ServerError::lock("static hosts"))?
            .insert(id, stop_tx);
        Ok(())
    }

    /// Stop a running host by id. Returns `Ok(false)` if none was running.
    /// Idempotent. Removing the entry drops its shutdown sender, which resolves
    /// the host's graceful-shutdown future; the listener drains and ends without
    /// blocking this (synchronous) call.
    ///
    /// # Errors
    ///
    /// [`ServerError::LockPoisoned`] if the running-hosts lock was poisoned.
    pub fn stop(&self, id: &str) -> Result<bool, ServerError> {
        Ok(self
            .running
            .lock()
            .map_err(|_| ServerError::lock("static hosts"))?
            .remove(id)
            .is_some())
    }

    #[cfg(test)]
    pub(crate) fn is_running(&self, id: &str) -> bool {
        // A poisoned lock reads as "not running" rather than panicking — test
        // helper, never on a request path.
        self.running
            .lock()
            .map(|guard| guard.contains_key(id))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::routing::get;
    use axum::Router;

    /// Bind an ephemeral loopback port, then release it so a caller can claim it.
    /// (A tiny reuse race, acceptable in a test.)
    async fn free_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    }

    fn hello_router(body: &'static str) -> Router {
        Router::new().fallback(get(move || async move { body }))
    }

    /// A started host serves its content on the loopback port and reports as
    /// running; stopping it clears the running state and is idempotent.
    #[tokio::test]
    async fn start_serves_then_stop_clears_running_state() {
        let svc = StaticHostsService::new(Url::parse("http://127.0.0.1").unwrap());
        let port = free_port().await;

        svc.start(StaticHostJob {
            id: "alpha".to_owned(),
            port,
            service: hello_router("ALPHA"),
        })
        .await
        .expect("listener should bind");
        assert!(svc.is_running("alpha"));

        // It actually serves (the connect succeeds because the listener is bound
        // before the serve task spawns).
        let body = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .expect("request to static host")
            .text()
            .await
            .expect("body");
        assert_eq!(body, "ALPHA");

        assert!(svc.stop("alpha").unwrap());
        assert!(!svc.is_running("alpha"));
        assert!(
            !svc.stop("alpha").unwrap(),
            "stopping an absent host returns false"
        );
    }

    /// Two hosts run independently; stopping one leaves the other running.
    #[tokio::test]
    async fn hosts_are_independent() {
        let svc = StaticHostsService::new(Url::parse("http://127.0.0.1").unwrap());
        let (p1, p2) = (free_port().await, free_port().await);

        svc.start(StaticHostJob {
            id: "a".to_owned(),
            port: p1,
            service: hello_router("A"),
        })
        .await
        .expect("bind a");
        svc.start(StaticHostJob {
            id: "b".to_owned(),
            port: p2,
            service: hello_router("B"),
        })
        .await
        .expect("bind b");
        assert!(svc.is_running("a") && svc.is_running("b"));

        svc.stop("a").unwrap();
        assert!(!svc.is_running("a"));
        assert!(svc.is_running("b"));
    }

    /// Starting a second host on an already-bound port surfaces the bind scope
    /// as [`ServerError::Bind`] (distinct from a lock error), and the failed
    /// host is not recorded as running.
    #[tokio::test]
    async fn start_on_a_taken_port_returns_a_bind_error() {
        let svc = StaticHostsService::new(Url::parse("http://127.0.0.1").unwrap());
        let port = free_port().await;

        svc.start(StaticHostJob {
            id: "first".to_owned(),
            port,
            service: hello_router("FIRST"),
        })
        .await
        .expect("first bind");

        let err = svc
            .start(StaticHostJob {
                id: "second".to_owned(),
                port,
                service: hello_router("SECOND"),
            })
            .await
            .expect_err("second bind on the same port should fail");
        assert!(matches!(err, ServerError::Bind { .. }), "got {err:?}");
        assert!(!svc.is_running("second"));
    }
}
