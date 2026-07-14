//! [`SelfHostedAppsService`] — the apps-slice orchestrator for locally-served
//! ("self-hosted") apps: the ones served from the user's device on a dedicated
//! loopback port and reachable remotely at `<subdomain>.<public_host>` through
//! the tunnel.
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
//! The host's startup seed drives `start` for every catalogue row; the create
//! surface (`POST /apps`, self-hosted arm) also drives `start` at runtime for a
//! freshly-installed app, and the delete surface drives `stop`, both without a
//! restart. [`apps_dir`](SelfHostedAppsService::apps_dir) exposes the root the
//! upload handler stages extracted bundles under and the delete handler removes
//! an uploaded app's folder from.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Bytes;
use shared_structures_rust::tunnel_service::TunnelService;
use shared_structures_server_rust::{ProxyTable, ServerError, StaticHostJob, StaticHostsService};
use tower_http::cors::CorsLayer;
use url::Url;

use crate::domain::{AppsError, SelfHostedAppConfiguration, SelfHostedInstaller, StagedBundle};
use crate::id_utils::mint_app_id;
use crate::install::{self, extract_zip_bundle, infer_launch_path};

/// Orchestrates the self-hosted apps' loopback listeners and reverse-proxy
/// registrations. Constructed once by the host (held in scope for the process
/// lifetime so the running listeners aren't dropped); the same instance can
/// install/uninstall apps at runtime.
pub struct SelfHostedAppsService {
    static_hosts: StaticHostsService,
    /// Shared with the host's reverse proxy — a registration here routes
    /// forwarded `<subdomain>.<public_host>` traffic to the app's loopback port.
    proxy_table: ProxyTable,
    /// The directory whose per-app `content_folder` subdirectories hold each
    /// app's served files.
    apps_dir: PathBuf,
    /// The per-request template-render inputs (loopback base URL + tunnel)
    /// threaded to every app router, so each app's committed templates can
    /// render `apiOrigin` per caller.
    template_context: self_hosted_apps_rust::SelfHostedAppContext,
}

impl SelfHostedAppsService {
    /// `loopback_base_url` (e.g. `http://127.0.0.1:8080/`) is threaded as-is to the
    /// loopback listeners and to each app router's template context (which derives
    /// the loopback `apiOrigin` per request), so the two can't drift. `apps_dir`
    /// holds the per-app `content_folder` directories; `proxy_table` is shared with
    /// the reverse proxy; `tunnel` is the other per-request template-render input.
    #[must_use]
    pub fn new(
        loopback_base_url: &Url,
        apps_dir: PathBuf,
        proxy_table: ProxyTable,
        tunnel: Arc<dyn TunnelService>,
    ) -> Self {
        Self {
            static_hosts: StaticHostsService::new(loopback_base_url.clone()),
            proxy_table,
            apps_dir,
            template_context: self_hosted_apps_rust::SelfHostedAppContext {
                loopback_base_url: loopback_base_url.clone(),
                tunnel,
            },
        }
    }

    /// The directory whose per-app `content_folder` subdirectories hold each
    /// app's served files. The upload handler stages extracted bundles under it
    /// (and renames into place); the delete handler removes an uploaded app's
    /// folder from it.
    #[must_use]
    pub fn apps_dir(&self) -> &std::path::Path {
        &self.apps_dir
    }

    /// Bring the app `id` online from its self-hosted configuration: serve it on
    /// its loopback port and register it for subdomain reverse-proxy.
    ///
    /// A bind failure (the port is already taken) is logged and tolerated — the
    /// proxy registration still happens, so a forwarded (relayed) request routes
    /// even when the local listener didn't come up. A lock-poison error
    /// propagates.
    ///
    /// # Errors
    ///
    /// [`ServerError::LockPoisoned`] if a shared lock was poisoned.
    pub async fn start(
        &self,
        id: &str,
        config: &SelfHostedAppConfiguration,
    ) -> Result<(), ServerError> {
        let service = self_hosted_apps_rust::setup_self_hosted_app(
            id,
            self.apps_dir.join(&config.content_folder),
            self.template_context.clone(),
        )
        .layer(CorsLayer::very_permissive());
        if let Err(error) = self
            .static_hosts
            .start(StaticHostJob {
                id: id.to_owned(),
                port: config.port,
                service,
            })
            .await
        {
            match error {
                // Best-effort: loopback bind failed, but the proxy registration
                // below still routes forwarded traffic.
                ServerError::Bind { .. } => {
                    tracing::warn!(
                        %error,
                        app = %id,
                        "self-hosted app loopback bind failed; registering for reverse-proxy anyway",
                    );
                }
                ServerError::LockPoisoned { .. } => return Err(error),
            }
        }
        self.proxy_table
            .register(config.subdomain.clone(), config.port)?;
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

// The service *is* the native [`SelfHostedInstaller`] — one instance serves every
// upload; the bundle rides in as a `stage` argument rather than being baked into a
// per-request installer. The action drives this to do the filesystem + listener work
// it can't (extract → move into place, unwind on a failed insert, bring the listener
// online), mapping the extractor's / service's errors onto the domain `AppsError`.
impl SelfHostedInstaller for SelfHostedAppsService {
    fn stage(&self, bundle: Bytes) -> impl Future<Output = Result<StagedBundle, AppsError>> {
        // Own the inputs so the returned future is `'static` (the extraction rides a
        // `spawn_blocking` hop that requires it). `Bytes` is passed by value from the
        // caller; `apps_dir` is cloned off `&self`.
        let apps_dir = self.apps_dir.clone();
        async move {
            // A fresh mint per upload names both the staging dir and the final serving
            // folder (the row's `content_folder`).
            let folder = mint_app_id();
            let staging = apps_dir.join(".staging").join(&folder);

            // Extract off the async runtime — zip inflate + disk writes are blocking.
            // The same blocking task infers the launch path from the extracted (and
            // hoisted) tree, so the `launch.html` probe rides the same off-runtime hop.
            let staging_for_extract = staging.clone();
            let extract = tokio::task::spawn_blocking(move || {
                extract_zip_bundle(&bundle, &staging_for_extract)
                    .map(|()| infer_launch_path(&staging_for_extract))
            })
            .await;
            let launch_path = match extract {
                Ok(Ok(path)) => path,
                Ok(Err(error)) => {
                    remove_staging(&staging);
                    return Err(map_install_error(error));
                }
                Err(join_error) => {
                    remove_staging(&staging);
                    return Err(AppsError::infrastructure(
                        "zip extraction task failed",
                        join_error,
                    ));
                }
            };

            // Move the extracted files into their serving location BEFORE the row
            // commits, so a committed row always points at present files (a crash
            // after this leaks only an unreferenced folder — no row, never served).
            let dest = apps_dir.join(&folder);
            if let Err(error) = std::fs::rename(&staging, &dest) {
                remove_staging(&staging);
                return Err(AppsError::infrastructure(
                    "failed to move the staged app into place",
                    error,
                ));
            }

            Ok(StagedBundle {
                content_folder: folder,
                launch_path,
            })
        }
    }

    fn discard(&self, content_folder: &str) {
        remove_staging(&self.apps_dir.join(content_folder));
    }

    async fn start_listener(
        &self,
        id: &str,
        config: &SelfHostedAppConfiguration,
    ) -> Result<(), AppsError> {
        // The inherent `start` swallows bind failures (the row is committed and files
        // are in place, so it comes up on the next restart); the only error it
        // propagates is a poisoned lock, where reverse-proxy registration did NOT
        // happen and won't self-heal. That's a real fault — surface it.
        self.start(id, config).await.map_err(|error| {
            AppsError::infrastructure("installed self-hosted app failed to register", error)
        })
    }

    fn stop_listener(&self, id: &str) {
        // Best-effort: the row is about to be (or has just been) deleted, so a leftover
        // listener is better tolerated-and-logged than allowed to fail the delete.
        if let Err(error) = self.stop(id) {
            tracing::warn!(%error, app = %id, "failed to stop an uploaded self-hosted app before delete");
        }
    }
}

/// Map an extraction failure to the wire error: a disk-write failure is our fault
/// (`500`), every other variant is a bad upload (`400 InvalidZip`).
fn map_install_error(error: install::InstallError) -> AppsError {
    match error {
        install::InstallError::Io(io_error) => {
            AppsError::infrastructure("zip extraction io error", io_error)
        }
        other => AppsError::InvalidZip {
            message: other.to_string(),
        },
    }
}

/// Best-effort removal of a failed install's directory (the staging dir, or the
/// already-moved serving folder when the DB insert is what failed). A cleanup failure
/// is logged, not surfaced — the request already has its real error.
fn remove_staging(dir: &Path) {
    if let Err(error) = std::fs::remove_dir_all(dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%error, path = %dir.display(), "failed to clean up a failed install's directory");
        }
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
                // The reverse proxy reads the public host off this watch, so the
                // stub must carry it here (not only via `current_public_host`).
                public_host: Some(self.public_host.clone()),
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
            Url::parse("http://127.0.0.1:8080").unwrap(),
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
            &Url::parse("http://127.0.0.1:8080").unwrap(),
            dir.clone(),
            table.clone(),
            Arc::new(StubTunnel {
                public_host: "demo.example.com".to_owned(),
            }),
        );
        let config = SelfHostedAppConfiguration {
            port,
            content_folder: "patient-browser".to_owned(),
            subdomain: "patient-browser".to_owned(),
            seeded: true,
            launch_path: None,
        };

        service.start("patient-browser", &config).await.unwrap();

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

    /// The install path end-to-end below the HTTP layer: a row inserted through
    /// `insert_self_hosted_app`, its files on disk, and `start` bring the app up
    /// so a forwarded `<slug>.<public_host>` request reverse-proxies to the
    /// uploaded `index.html`. Mirrors `start_then_stop_swaps_both_paths` but
    /// drives the real `insert_self_hosted_app` (DB-allocated port) rather than a
    /// hand-built app.
    #[tokio::test]
    async fn uploaded_app_serves_after_insert_and_start() {
        use crate::db::SqliteAppsStore;
        use crate::domain::{AppKind, AppRegistration, SelfHostedAppConfigurationPayload};
        // The port trait is in scope so the adapter's `insert_self_hosted_app`
        // method resolves.
        use crate::domain::AppsStore;

        let store = SqliteAppsStore::open_in_memory().unwrap();
        let registration = AppRegistration {
            id: "uploaded-app".to_owned(),
            kind: AppKind::SelfHosted,
            position: 0,
            on_homescreen: true,
            name: "Uploaded App".to_owned(),
            subtitle: None,
            local_only: true,
            client_id: None,
            requires_tunnel: false,
        };
        let create = SelfHostedAppConfigurationPayload {
            content_folder: "uploaded-app-folder".to_owned(),
            subdomain: "uploaded-app".to_owned(),
            launch_path: None,
        };
        let inserted = store
            .insert_self_hosted_app(&registration, &create, &[])
            .expect("inserted");
        let (registration, mut config) = inserted;
        // Bind an OS-assigned free port rather than the store's deterministic
        // 8082 — this test asserts *real serving*, so it must not race any other
        // test (here or in the handler suite) that also binds 8082.
        config.port = free_port().await;
        // Files land under `<apps_dir>/<content_folder>/index.html`.
        let dir = temp_apps_dir(&config.content_folder, "<h1>UPLOADED</h1>");

        let table = ProxyTable::new();
        let service = SelfHostedAppsService::new(
            &Url::parse("http://127.0.0.1:8080").unwrap(),
            dir.clone(),
            table.clone(),
            Arc::new(StubTunnel {
                public_host: "demo.example.com".to_owned(),
            }),
        );
        service.start(&registration.id, &config).await.unwrap();

        let res = proxy_router(table.clone())
            .oneshot(forwarded_request(&format!(
                "{}.demo.example.com",
                config.subdomain
            )))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(
            body_string(res).await.contains("UPLOADED"),
            "the uploaded app's index must serve through the subdomain proxy",
        );

        std::fs::remove_dir_all(dir).ok();
    }
}
