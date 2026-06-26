//! [`SelfHostedAppsService`] — the apps-slice orchestrator for locally-served
//! ("self-hosted") apps: the ones served from the user's device on a dedicated
//! loopback port and reachable remotely at `<id>.<public_host>` through the
//! tunnel.
//!
//! It owns the per-app loopback listeners (via
//! [`StaticHostsService`](shared_structures_server_rust::StaticHostsService)) and
//! shares the reverse-proxy routing table (via
//! [`ProxyTable`](shared_structures_server_rust::ProxyTable)) with the host's
//! [`TunnelSubdomainReverseProxy`](shared_structures_server_rust::TunnelSubdomainReverseProxy),
//! so [`start`](SelfHostedAppsService::start) brings an app online (served
//! locally AND routed for forwarded traffic) and
//! [`stop`](SelfHostedAppsService::stop) takes it offline — both at runtime,
//! without a restart.
//!
//! Today only the host's startup seed drives `start`; the runtime start/stop
//! capability is here for restartless installation once an install surface
//! exists. The existing `internal_apps` rows are still the only source of
//! self-hosted apps (the table is read-only, seeded by migration).

use std::path::PathBuf;

use shared_structures_server_rust::{
    LoopbackHostname, ProxyTable, ServerError, StaticHostJob, StaticHostsService,
};
use tower_http::cors::CorsLayer;

use crate::domain::InternalApp;

/// Orchestrates the self-hosted apps' loopback listeners and reverse-proxy
/// registrations. Constructed once by the host (held in scope for the process
/// lifetime so the running listeners aren't dropped); the same instance can
/// install/uninstall apps at runtime.
pub struct SelfHostedAppsService {
    static_hosts: StaticHostsService,
    /// Shared with the host's reverse proxy — a registration here routes
    /// forwarded `<id>.<public_host>` traffic to the app's loopback port.
    proxy_table: ProxyTable,
    /// The directory whose `<id>/` subdirectories hold each app's served files.
    apps_dir: PathBuf,
}

impl SelfHostedAppsService {
    /// `loopback` is the hostname each app's listener binds on; `apps_dir` holds
    /// the per-app `<id>/` file directories; `proxy_table` is shared with the
    /// reverse proxy.
    #[must_use]
    pub fn new(loopback: LoopbackHostname, apps_dir: PathBuf, proxy_table: ProxyTable) -> Self {
        Self {
            static_hosts: StaticHostsService::new(loopback),
            proxy_table,
            apps_dir,
        }
    }

    /// Bring `app` online: serve it on its loopback port and register it for
    /// subdomain reverse-proxy.
    ///
    /// A bind failure (the port is already taken) is logged and tolerated — the
    /// proxy registration still happens, so a forwarded (relayed) request routes
    /// even when the local listener didn't come up. A lock-poison error
    /// propagates.
    ///
    /// # Errors
    ///
    /// [`ServerError::LockPoisoned`] if a shared lock was poisoned.
    pub async fn start(&self, app: &InternalApp) -> Result<(), ServerError> {
        let service = vendor_apps_rust::setup_installed_app(&app.id, self.apps_dir.join(&app.id))
            .layer(CorsLayer::very_permissive());
        if let Err(error) = self
            .static_hosts
            .start(StaticHostJob {
                id: app.id.clone(),
                port: app.port,
                service,
            })
            .await
        {
            match error {
                // Best-effort: the loopback listener didn't come up, but the
                // reverse proxy can still route forwarded traffic once we
                // register the id below.
                ServerError::Bind { .. } => {
                    tracing::warn!(
                        %error,
                        app = %app.id,
                        "self-hosted app loopback bind failed; registering for reverse-proxy anyway",
                    );
                }
                ServerError::LockPoisoned { .. } => return Err(error),
            }
        }
        self.proxy_table.register(app.id.clone(), app.port)?;
        Ok(())
    }

    /// Take `id` offline: stop serving it locally and stop reverse-proxying it.
    ///
    /// # Errors
    ///
    /// [`ServerError::LockPoisoned`] if a shared lock was poisoned.
    pub fn stop(&self, id: &str) -> Result<(), ServerError> {
        self.static_hosts.stop(id)?;
        self.proxy_table.unregister(id)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::Write;

    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use shared_structures_rust::tunnel_service::{TunnelLiveness, TunnelService, TunnelStatus};
    use shared_structures_server_rust::TunnelSubdomainReverseProxy;
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use tokio::sync::watch;
    use tower::util::ServiceExt;

    struct StubTunnel {
        public_host: String,
    }

    #[async_trait::async_trait]
    impl TunnelService for StubTunnel {
        fn current_origin(&self) -> String {
            "http://127.0.0.1:8080".to_owned()
        }
        fn current_public_host(&self) -> Option<String> {
            Some(self.public_host.clone())
        }
        async fn try_start(&self) -> Result<String, String> {
            Err("unused".to_owned())
        }
        fn subscribe(&self) -> watch::Receiver<TunnelLiveness> {
            watch::channel(TunnelLiveness {
                settings_revision: None,
                status: TunnelStatus::Off,
                origin: self.current_origin(),
                error: None,
                dial_attempts: 0,
            })
            .1
        }
    }

    async fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    /// Create a temp `apps_dir` with `<id>/index.html`. Returns the base dir.
    fn temp_apps_dir(id: &str, index_html: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("wf-self-hosted-{}", rand::random::<u64>()));
        let app = base.join(id);
        std::fs::create_dir_all(&app).unwrap();
        std::fs::File::create(app.join("index.html"))
            .unwrap()
            .write_all(index_html.as_bytes())
            .unwrap();
        base
    }

    fn forwarded_request(host: &str) -> Request<Body> {
        Request::builder()
            .method("GET")
            .uri("/")
            .header("forwarded", format!("host={host};proto=https"))
            .body(Body::empty())
            .unwrap()
    }

    fn proxy_router(table: ProxyTable) -> Router {
        let tunnel: Arc<dyn TunnelService> = Arc::new(StubTunnel {
            public_host: "demo.example.com".to_owned(),
        });
        TunnelSubdomainReverseProxy::new(
            LoopbackHostname::new("127.0.0.1"),
            tunnel,
            Router::new().fallback(get(|| async { "FALLBACK" })),
            table,
        )
        .into_router()
    }

    async fn body_string(res: axum::response::Response) -> String {
        String::from_utf8(
            to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap()
    }

    /// Starting a self-hosted app serves it on its loopback port AND registers
    /// it so a forwarded `<id>.<public_host>` request reverse-proxies to that
    /// content; stopping it takes both away (the forwarded request falls through
    /// to the fallback). This is the seed-path regression guard and the runtime
    /// hot-swap capability in one.
    #[tokio::test]
    async fn start_then_stop_swaps_both_paths() {
        let dir = temp_apps_dir("patient-browser", "<h1>PATIENT BROWSER</h1>");
        let port = free_port().await;
        let table = ProxyTable::new();
        let service = SelfHostedAppsService::new(
            LoopbackHostname::new("127.0.0.1"),
            dir.clone(),
            table.clone(),
        );
        let app = InternalApp {
            id: "patient-browser".to_owned(),
            enabled: true,
            name: "Patient Browser".to_owned(),
            subtitle: None,
            port,
        };

        service.start(&app).await.unwrap();

        // Forwarded subdomain reverse-proxies to the served content — proves the
        // loopback listener is up (the proxy forwards to it) AND the proxy table
        // was registered.
        let res = proxy_router(table.clone())
            .oneshot(forwarded_request("patient-browser.demo.example.com"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(
            body_string(res).await.contains("PATIENT BROWSER"),
            "forwarded request should reverse-proxy to the served index",
        );

        service.stop("patient-browser").unwrap();

        // After stop the id is unregistered, so the same forwarded request
        // falls through to the fallback.
        let res = proxy_router(table.clone())
            .oneshot(forwarded_request("patient-browser.demo.example.com"))
            .await
            .unwrap();
        assert_eq!(body_string(res).await, "FALLBACK");

        std::fs::remove_dir_all(dir).ok();
    }
}
