//! The Tauri host's [`gatekeeper_rust::SelfHostedRedirectResolver`].
//!
//! A self-hosted SMART app registers an **app-relative** redirect URI (a
//! leading-`/` path) instead of an absolute one, because its origin varies by
//! launch — `http://127.0.0.1:<port>/` on the device,
//! `https://<subdomain>.<public_host>/` through the tunnel — and the tunnel host
//! isn't known when the app's OAuth client is seeded. At `/authorize` gatekeeper
//! resolves that relative entry against the app's own origin, and this seam
//! supplies the missing piece: the app's `{port, subdomain}`, looked up by its
//! `client_id` (a self-hosted app's OAuth `client_id` equals its app id).
//!
//! It reads the apps store directly. The gatekeeper slice owns the trait; the
//! apps slice owns the topology; the host is the only place that depends on both,
//! so the adapter lives here rather than in either slice.

use apps_rust::{AppConfiguration, AppsStore, SqliteAppsStore};
use gatekeeper_rust::{SelfHostedRedirectResolver, SelfHostedRedirectTopology};
use tauri_plugin_log::log;

/// Resolves a `client_id` to a self-hosted app's redirect topology by reading
/// the apps store. Holds its own [`SqliteAppsStore`] over the shared pool (cheap
/// — the pool is an `Arc`), built early so it is ready before the gatekeeper
/// state it is wired into.
pub struct AppsStoreRedirectResolver {
    store: SqliteAppsStore,
}

impl AppsStoreRedirectResolver {
    pub fn new(store: SqliteAppsStore) -> Self {
        Self { store }
    }
}

impl SelfHostedRedirectResolver for AppsStoreRedirectResolver {
    /// The topology for `client_id`, or `None` when it isn't a self-hosted app
    /// (a system/cloud app, an unknown id, or a store read error). `None` means
    /// an app-relative redirect entry resolves to nothing and matches no request
    /// — the safe, fail-closed outcome, so a read error can only ever *reject* a
    /// launch, never widen the allowlist.
    fn resolve(&self, client_id: &str) -> Option<SelfHostedRedirectTopology> {
        match self.store.find_app(client_id) {
            Ok(Some((_, AppConfiguration::SelfHosted(config)))) => {
                Some(SelfHostedRedirectTopology {
                    port: config.port,
                    subdomain: config.subdomain,
                })
            }
            Ok(_) => None,
            Err(error) => {
                log::warn!(
                    "[authorize] self-hosted redirect resolve failed for {client_id}: {error} \
                     — treating as no app-relative redirect"
                );
                None
            }
        }
    }
}
