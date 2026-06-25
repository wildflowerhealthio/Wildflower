//! The builder: collect routes, bind their loopback listeners, and produce the
//! forwarded-subdomain dispatch layer.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use shared_structures_rust::tunnel_service::TunnelService;

use crate::binding::bind_and_serve;
use crate::dispatch::{maybe_dispatch_to_subdomain, SubdomainDispatchState};

/// One router to be served on a dedicated loopback `port` AND reachable
/// remotely at `<id>.<public_host>` through the tunnel.
pub struct TunneledRoute {
    /// Stable id — the leftmost subdomain label a forwarded request must carry
    /// to reach this router.
    pub id: String,
    /// The router serving this app's content. Cloned: one clone serves the
    /// loopback listener, the other backs forwarded-subdomain dispatch.
    pub router: Router,
    /// The loopback TCP port the listener binds.
    pub port: u16,
}

/// Collect [`TunneledRoute`]s, then [`build`](Self::build) to bind each on its
/// loopback listener and get a [`SubdomainDispatch`] that wraps the API router.
pub struct TunneledRouterBuilder {
    loopback_hostname: String,
    tunnel: Arc<dyn TunnelService>,
    routes: Vec<TunneledRoute>,
}

impl TunneledRouterBuilder {
    /// Start a builder. `loopback_hostname` is the host each route's listener
    /// binds on (e.g. `127.0.0.1`); `tunnel` is read at request time for the
    /// live public host.
    pub fn new(loopback_hostname: impl Into<String>, tunnel: Arc<dyn TunnelService>) -> Self {
        Self {
            loopback_hostname: loopback_hostname.into(),
            tunnel,
            routes: Vec::new(),
        }
    }

    /// Register one route.
    #[must_use]
    pub fn route(mut self, route: TunneledRoute) -> Self {
        self.routes.push(route);
        self
    }

    /// Bind every route's loopback listener (best-effort — a bind failure is
    /// logged and skipped) and register all routers for forwarded-subdomain
    /// dispatch. A route whose listener failed to bind STILL participates in
    /// dispatch, so remote (relayed) traffic for it keeps working.
    pub async fn build(self) -> SubdomainDispatch {
        let mut routers = HashMap::with_capacity(self.routes.len());
        for route in self.routes {
            bind_and_serve(
                &self.loopback_hostname,
                route.port,
                &route.id,
                route.router.clone(),
            )
            .await;
            routers.insert(route.id, route.router);
        }
        SubdomainDispatch {
            state: Arc::new(SubdomainDispatchState::new(routers, self.tunnel)),
        }
    }
}

/// The built dispatch handle. [`wrap`](Self::wrap) an API router so a forwarded
/// request whose `Forwarded` host is `<id>.<public_host>` is dispatched to the
/// registered route; everything else runs the wrapped router.
pub struct SubdomainDispatch {
    state: Arc<SubdomainDispatchState>,
}

impl SubdomainDispatch {
    /// Wrap `api` with the forwarded-subdomain dispatch middleware as the
    /// outermost layer (it runs before the wrapped router). Returns the wrapped
    /// router for the caller to serve.
    #[must_use]
    pub fn wrap(self, api: Router) -> Router {
        api.layer(axum::middleware::from_fn_with_state(
            self.state,
            maybe_dispatch_to_subdomain,
        ))
    }
}
