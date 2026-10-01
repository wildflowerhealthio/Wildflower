//! HFS behind a lock, rebuilt with a new `base_url` on demand.
//!
//! HFS writes one fixed `ServerConfig::base_url` into every URL it emits — the
//! search Bundle's `self`/`next`/`first` links, each `entry.fullUrl`, the
//! `Location` of a create — and never reads `Forwarded`/`Host` to vary it
//! ("Forwarding headers never override it", helios-rest's README). A client
//! that pages by following `next` therefore lands on whatever origin that base
//! names, so the host points it at the public origin remote clients reach the
//! FHIR server through, falling back to loopback while there is none.
//!
//! The host can change that origin at runtime, while HFS reads `base_url` once,
//! when its router is built. So [`setup_fhir_r4`](crate::setup_fhir_r4) serves
//! HFS through a router that forwards each request to the *current* HFS build,
//! and [`SwappableHfs::set_base_url`] rebuilds HFS over the same backend with
//! the new `base_url` and swaps it in. A request already in flight finishes on
//! the build it started on. Search `_cursor` tokens carry only sort values and a
//! resource id, never the base, so a page cursor issued by one build resumes on
//! the next.

use std::convert::Infallible;
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use anyhow::bail;
use axum::body::Body;
use axum::http::Request;
use axum::Router;
use helios_auth::AuthConfig;
use helios_persistence::backends::sqlite::SqliteBackend;
use helios_rest::{create_app_with_auth, AuthMiddlewareState, ServerConfig};
use tower::ServiceExt;
use url::Url;

use crate::FHIR_R4_PATH;

/// What it takes to build HFS's router again: everything but the base URL is
/// fixed at boot. The backend clone shares the boot-time connection pool, and
/// the auth state (with its JWKS cache) is shared rather than rebuilt.
struct HfsBuilder {
    backend: SqliteBackend,
    server_config: ServerConfig,
    auth_config: AuthConfig,
    auth_state: Option<Arc<AuthMiddlewareState>>,
}

impl HfsBuilder {
    fn build(&self, base: &Url) -> Router {
        let server_config = ServerConfig {
            base_url: base.to_string(),
            ..self.server_config.clone()
        };
        create_app_with_auth(
            self.backend.clone(),
            server_config,
            self.auth_config.clone(),
            self.auth_state.clone(),
            // Audit middleware: we don't write FHIR audit events from inside
            // emr-rust today; the gatekeeper gating layer above us handles
            // owner/admin access auditing separately.
            None,
        )
    }
}

/// The running HFS, swappable for a build with a different `base_url`. Cheap to
/// clone; every clone drives the same HFS build. See the [module docs](self).
#[derive(Clone)]
pub struct SwappableHfs {
    inner: Arc<Inner>,
}

struct Inner {
    builder: HfsBuilder,
    loopback_base: Url,
    /// The current build's `base_url`. Held for the whole of a
    /// [`SwappableHfs::set_base_url`], so concurrent calls rebuild one
    /// at a time and the base always names the build in `router`.
    base: Mutex<Url>,
    router: RwLock<Router>,
}

impl SwappableHfs {
    /// Build HFS with the loopback FHIR base as its `base_url`.
    pub(crate) fn new(
        backend: SqliteBackend,
        server_config: ServerConfig,
        auth_config: AuthConfig,
        auth_state: Option<Arc<AuthMiddlewareState>>,
        loopback_origin: &Url,
    ) -> Self {
        let builder = HfsBuilder {
            backend,
            server_config,
            auth_config,
            auth_state,
        };
        let loopback_base = fhir_base(loopback_origin);
        let router = builder.build(&loopback_base);
        Self {
            inner: Arc::new(Inner {
                builder,
                base: Mutex::new(loopback_base.clone()),
                loopback_base,
                router: RwLock::new(router),
            }),
        }
    }

    /// Set HFS's `base_url` to `{origin}/fhir-r4`, or to the loopback FHIR base
    /// when `origin` is `None`. A no-op when that is already the `base_url`;
    /// otherwise HFS is rebuilt with the new one and swapped in.
    ///
    /// # Errors
    ///
    /// Returns an error, leaving the current `base_url` in place, if `origin`
    /// isn't an `http`/`https` URL with a host and no credentials — HFS refuses
    /// such a base.
    pub fn set_base_url(&self, origin: Option<&Url>) -> anyhow::Result<()> {
        let next_base = match origin {
            Some(origin) => {
                if !matches!(origin.scheme(), "http" | "https") {
                    bail!("origin {origin} must use the http or https scheme");
                }
                if origin.host().is_none() {
                    bail!("origin {origin} must include a host");
                }
                if !origin.username().is_empty() || origin.password().is_some() {
                    bail!("origin must not include user information");
                }
                fhir_base(origin)
            }
            None => self.inner.loopback_base.clone(),
        };

        let mut base = self
            .inner
            .base
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if *base == next_base {
            return Ok(());
        }
        let router = self.inner.builder.build(&next_base);
        *self
            .inner
            .router
            .write()
            .unwrap_or_else(PoisonError::into_inner) = router;
        tracing::info!(base = %next_base, "emr: HFS rebuilt with a new base_url");
        *base = next_base;
        Ok(())
    }

    /// A router that serves each request with the current HFS build.
    pub(crate) fn router(&self) -> Router {
        let inner = Arc::clone(&self.inner);
        Router::new().fallback_service(tower::service_fn(move |request: Request<Body>| {
            let router = inner
                .router
                .read()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            async move {
                let response = match router.oneshot(request).await {
                    Ok(response) => response,
                    Err(infallible) => match infallible {},
                };
                Ok::<_, Infallible>(response)
            }
        }))
    }
}

/// The FHIR base for an origin: `{origin}/fhir-r4`.
fn fhir_base(origin: &Url) -> Url {
    let mut base = origin.clone();
    base.set_path(FHIR_R4_PATH);
    base.set_query(None);
    base.set_fragment(None);
    base
}
