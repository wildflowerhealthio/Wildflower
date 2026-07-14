//! [`SelfHostedAppConfiguration`] — the `self_hosted_app_configurations` payload
//! for a self-hosted app: web assets served from the device on a dedicated,
//! isolated loopback origin (and remotely at `<subdomain>.<public_host>`). Just the
//! per-kind data (`port`, `content_folder`, `subdomain`, `seeded`, `launch_path`);
//! the shared catalogue facts + placement live on the paired
//! [`AppRegistration`](super::AppRegistration), and a whole self-hosted app is the
//! `(AppRegistration, SelfHostedAppConfiguration)` pair.
//!
//! Rows come from two sources: the migration seed (`seeded = true`, protected from
//! delete/edit) and runtime uploads (`seeded = false`, removable) — the
//! [`CommonAppConfig`] impl. The launch URL is rendered on demand via
//! [`local_launch_url`](SelfHostedAppConfiguration::local_launch_url) /
//! [`subdomain_url`](SelfHostedAppConfiguration::subdomain_url) /
//! [`render_launch`](SelfHostedAppConfiguration::render_launch).
//! The editor wire shape
//! ([`SelfHostedAppDetail`](crate::http::wire_representations::SelfHostedAppDetail))
//! is built from the pair at the HTTP seam.
//!
//! A create supplies only the caller-known config fields as a
//! [`CreateSelfHostedAppConfigurationPayload`]; the store allocates the loopback
//! `port` and always writes `seeded = false`, then hands back the full
//! configuration.
//!
//! The self-hosted insert maps its own failures onto [`AppsError`](super::AppsError)
//! directly — a taken id is a `400 InvalidName`, an exhausted port space a `500` —
//! so there's no granular typed insert-error here (unlike cloud's `CloudInsertError`).

use std::collections::HashSet;

use super::{AppKind, CommonAppConfig};

/// The **lowest** loopback port in `min..=max` that is neither already `taken` nor
/// in `reserved` (the host's own loopback port). Lowest-free (not `max + 1`) reuses
/// released ports to keep origins stable across reinstall. `None` when the range is
/// exhausted — the store maps that to a logged
/// [`AppsError::Infrastructure`](super::AppsError::Infrastructure).
///
/// Pure: the store reads the live port set **inside the insert transaction** and
/// passes it in, so the choice can't race a concurrent insert while the lowest-free
/// logic itself stays a plain, database-free (unit-tested) function.
#[must_use]
pub(crate) fn lowest_free_port(
    taken: &HashSet<u16>,
    reserved: &[u16],
    min: u16,
    max: u16,
) -> Option<u16> {
    (min..=max).find(|candidate| !taken.contains(candidate) && !reserved.contains(candidate))
}

/// The `self_hosted_app_configurations` payload — the loopback binding and
/// launch-render inputs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfHostedAppConfiguration {
    /// The loopback TCP port the host binds this app on, combined with the
    /// loopback hostname at read time into the `http://{host}:{port}/` launch
    /// target. The column keeps the port stable across reinstalls — see the
    /// port-allocation section of `docs/Apps/Store and Install Explanation.md`.
    pub port: u16,
    /// The on-disk subdirectory (under the host's `self-hosted-apps/` dir) whose
    /// files this app serves. Explicit rather than derived from the app id.
    pub content_folder: String,
    /// The public subdomain label this app is reachable at remotely, rendered as
    /// `https://{subdomain}.{public_host}/` by [`Self::subdomain_url`] and used as
    /// the reverse-proxy routing key.
    pub subdomain: String,
    /// `true` for a migration-seeded app (delete/edit refused with
    /// `409 AppNotEditable`), `false` for one uploaded at runtime (removable).
    pub seeded: bool,
    /// The origin-relative launch path inferred at install (see
    /// `crate::install::infer_launch_path`), or `None` for a root-served
    /// (`index.html`) bundle. When present it's a SMART launcher template with the
    /// same `{origin}` / `{launch}` placeholders the cloud `url` uses, substituted
    /// per request by [`Self::render_launch`].
    pub launch_path: Option<String>,
}

impl CommonAppConfig for SelfHostedAppConfiguration {
    const KIND: AppKind = AppKind::SelfHosted;

    /// Only an uploaded (non-seeded) self-hosted app is removable; a
    /// migration-seeded one is protected.
    fn is_removable(&self) -> bool {
        !self.seeded
    }
}

impl SelfHostedAppConfiguration {
    /// Render the loopback launch target `http://{host}:{port}/` — the local
    /// (device) origin, distinct from the `https://…` forwarded
    /// [`subdomain_url`](Self::subdomain_url). `host` is the loopback hostname the
    /// host binds on. The path is the bare root: each self-hosted app gets its own
    /// origin and is served from `/` on it.
    #[must_use]
    pub fn local_launch_url(&self, host: &str) -> String {
        format!("http://{host}:{port}/", host = host, port = self.port)
    }

    /// Render the public subdomain launch target
    /// `https://{subdomain}.{public_host}/` — the URL a forwarded (remote) caller
    /// can actually reach. Delegates to the shared
    /// [`shared_structures_rust::subdomain_host::subdomain_url`] so the host's
    /// subdomain reverse proxy and this redirect can't drift on the
    /// `<subdomain>.<public_host>` shape.
    #[must_use]
    pub fn subdomain_url(&self, public_host: &str) -> String {
        shared_structures_rust::subdomain_host::subdomain_url(&self.subdomain, public_host)
    }

    /// Render the concrete launch target for a request.
    ///
    /// `app_base` is this app's own launch origin *with* trailing slash (the
    /// loopback [`Self::local_launch_url`] or the [`Self::subdomain_url`] the handler
    /// resolves from the request). `served_origin` substitutes `{origin}` — the
    /// FHIR `iss` target, a *different* origin from `app_base` — and `launch_nonce`
    /// substitutes `{launch}`. With no [`Self::launch_path`] the target is the bare
    /// `app_base` (the app's root → `index.html`).
    #[must_use]
    pub fn render_launch(&self, app_base: &str, served_origin: &str, launch_nonce: &str) -> String {
        let Some(template) = &self.launch_path else {
            return app_base.to_owned();
        };
        // `app_base` keeps its trailing `/`; the template is a root-absolute
        // path (`/launch.html…`). Drop the duplicate separator before joining.
        let base = app_base.strip_suffix('/').unwrap_or(app_base);
        format!("{base}{template}")
            .replace("{origin}", served_origin)
            .replace("{launch}", launch_nonce)
    }
}

/// The caller-supplied half of a self-hosted write — the
/// `self_hosted_app_configurations` fields an insert / content replace provides, minus
/// what the store owns (the loopback `port`, allocated in-txn; `seeded`, always
/// `false` for an upload; `position`, on the paired registration). Paired with an
/// [`AppRegistration`](super::AppRegistration) it is the registration + payload split
/// the store's [`insert_self_hosted_app`](super::AppsStore::insert_self_hosted_app)
/// and [`replace_self_hosted_app`](super::AppsStore::replace_self_hosted_app) both
/// speak, rather than a full configuration carrying store-owned placeholders.
///
/// **Insert** uses every field (id verbatim, `port` / `position` allocated, `seeded =
/// false`). **Replace** writes only [`launch_path`](Self::launch_path) — the
/// `content_folder` / `subdomain` are fixed at install and ignored on a replace, so a
/// caller fills them from the current configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfHostedAppConfigurationPayload {
    /// The on-disk subdirectory the staged bundle was moved into (under the host's
    /// `self-hosted-apps/` dir). Set at install; ignored on a replace.
    pub content_folder: String,
    /// The public subdomain label this app is reachable at remotely — the app's
    /// slug, equal to its id. Set at install; ignored on a replace.
    pub subdomain: String,
    /// The inferred origin-relative SMART launch path, or `None` for a root-served
    /// (`index.html`) bundle. The one field a content replace edits.
    pub launch_path: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configuration(launch_path: Option<&str>, seeded: bool) -> SelfHostedAppConfiguration {
        SelfHostedAppConfiguration {
            port: 8082,
            content_folder: "zip-app".to_owned(),
            subdomain: "zip-app".to_owned(),
            seeded,
            launch_path: launch_path.map(str::to_owned),
        }
    }

    /// With no launcher the target is the bare origin — the app's root, which
    /// ServeDir resolves to `index.html`.
    #[test]
    fn render_launch_without_template_is_the_bare_origin() {
        let config = configuration(None, false);
        let base = config.local_launch_url("127.0.0.1");
        assert_eq!(
            config.render_launch(&base, "http://127.0.0.1:8080", "NONCE"),
            "http://127.0.0.1:8082/",
        );
    }

    /// A `launch.html` launcher hangs its path off the app's own loopback origin
    /// while `{origin}` (the `iss` target) resolves to the *host's* API origin —
    /// two different origins — and `{launch}` gets the nonce.
    #[test]
    fn render_launch_loopback_spans_app_and_api_origins() {
        let config = configuration(
            Some("/launch.html?launch={launch}&iss={origin}/fhir-r4"),
            false,
        );
        let base = config.local_launch_url("127.0.0.1");
        assert_eq!(
            config.render_launch(&base, "http://127.0.0.1:8080", "NONCE"),
            "http://127.0.0.1:8082/launch.html?launch=NONCE&iss=http://127.0.0.1:8080/fhir-r4",
        );
    }

    /// The forwarded path: the launcher hangs off the app's subdomain origin,
    /// `{origin}` off the public host.
    #[test]
    fn render_launch_forwarded_uses_subdomain_and_public_host() {
        let config = configuration(
            Some("/launch.html?launch={launch}&iss={origin}/fhir-r4"),
            false,
        );
        let base = config.subdomain_url("demo.example.com");
        assert_eq!(
            config.render_launch(&base, "https://demo.example.com", "N"),
            "https://zip-app.demo.example.com/launch.html?launch=N&iss=https://demo.example.com/fhir-r4",
        );
    }

    /// `is_removable` is exactly "not seeded".
    #[test]
    fn removable_is_not_seeded() {
        assert!(
            configuration(None, false).is_removable(),
            "an uploaded app is removable"
        );
        assert!(
            !configuration(Some("/launch.html"), true).is_removable(),
            "a seeded app is protected"
        );
    }

    /// The lowest free port is chosen, taken and reserved ports are skipped, and an
    /// exhausted range is `None`.
    #[test]
    fn lowest_free_port_skips_taken_and_reserved() {
        let taken: HashSet<u16> = [8082, 8083].into_iter().collect();
        assert_eq!(
            lowest_free_port(&taken, &[8084], 8082, u16::MAX),
            Some(8085),
            "8082/8083 taken, 8084 reserved → 8085",
        );
        assert_eq!(
            lowest_free_port(&taken, &[8084], 8082, 8084),
            None,
            "every port in a tiny range is taken or reserved",
        );
        assert_eq!(
            lowest_free_port(&HashSet::new(), &[], 8082, u16::MAX),
            Some(8082),
            "an empty registry allocates the floor",
        );
    }
}
