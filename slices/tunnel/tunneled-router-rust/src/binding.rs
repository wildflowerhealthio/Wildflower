//! Bind a route's dedicated loopback listener and serve its router.

use axum::Router;
use tokio::net::TcpListener;

/// Bind `router` on `{loopback_hostname}:{port}` and spawn an `axum::serve`
/// task for it.
///
/// Best-effort: a bind failure (typically the port is already taken) is logged
/// and returns without serving — it must not abort the rest of the build. The
/// caller still registers the router for forwarded-subdomain dispatch, so a
/// remote (relayed) request for the app keeps working even when its local
/// loopback listener didn't come up; only direct loopback launches to that port
/// fail until the next restart.
pub(crate) async fn bind_and_serve(loopback_hostname: &str, port: u16, id: &str, router: Router) {
    let bind_host = format!("{loopback_hostname}:{port}");
    match TcpListener::bind(&bind_host).await {
        Ok(listener) => {
            let id = id.to_owned();
            tracing::info!(app = %id, addr = %bind_host, "serving tunneled app on loopback");
            tokio::spawn(async move {
                if let Err(error) = axum::serve(listener, router.into_make_service()).await {
                    tracing::error!(app = %id, %error, "tunneled app listener stopped");
                }
            });
        }
        Err(error) => {
            tracing::error!(
                app = %id,
                addr = %bind_host,
                %error,
                "failed to bind tunneled app loopback listener; \
                 remote/forwarded traffic still routes, local launches will not reach it",
            );
        }
    }
}
