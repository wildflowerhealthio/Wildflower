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
//! [`launch_url`](Self::launch_url) / [`subdomain_url`](Self::subdomain_url) /
//! [`render_launch`](Self::render_launch). The editor wire shape
//! ([`SelfHostedAppDetail`](crate::http::wire_representations::SelfHostedAppDetail))
//! is built from the pair at the HTTP seam.
//!
//! This module also owns the self-hosted write-side input specs the
//! [`AppsStore`](super::AppsStore) speaks — [`NewSelfHostedUpload`] (a create spec)
//! and [`UploadInsertError`] (the granular reason an upload insert wrote nothing).

use std::collections::HashSet;

use super::{AppKind, CommonAppConfig};

/// The DNS label length cap a self-hosted slug (its id and subdomain) must stay
/// within — RFC 1035's 63-octet label limit.
const MAX_SLUG_LEN: usize = 63;

/// The attempt-`N` slug candidate: the base itself first (`attempt == 1`), then
/// `{base}-{attempt}`, kept a valid DNS label (≤ [`MAX_SLUG_LEN`] chars, no trailing
/// `-`) — the suffix is budgeted first and the base truncated to fit. The base is
/// `slugify` output (ASCII), so char truncation is byte truncation.
fn slug_candidate(base: &str, attempt: u32) -> String {
    if attempt == 1 {
        return base.to_owned();
    }
    let suffix = format!("-{attempt}");
    let budget = MAX_SLUG_LEN - suffix.len();
    let mut head: String = base.chars().take(budget).collect();
    while head.ends_with('-') {
        head.pop();
    }
    format!("{head}{suffix}")
}

/// Pick the first slug candidate (`base`, then `base-2`, `base-3`, … up to
/// `max_attempts`) that collides with neither `taken_ids` (the global app-id space)
/// nor `taken_subdomains`. `None` when the whole budget is exhausted — the caller
/// maps that to [`UploadInsertError::SlugSpaceExhausted`].
///
/// Pure: the store implementation reads the taken sets **inside the insert
/// transaction** and hands them here, so the choice can't race a concurrent insert
/// while the suffixing logic itself is a plain, database-free function.
#[must_use]
pub(crate) fn choose_self_hosted_slug(
    base: &str,
    taken_ids: &HashSet<String>,
    taken_subdomains: &HashSet<String>,
    max_attempts: u32,
) -> Option<String> {
    (1..=max_attempts)
        .map(|attempt| slug_candidate(base, attempt))
        .find(|candidate| {
            !taken_ids.contains(candidate.as_str())
                && !taken_subdomains.contains(candidate.as_str())
        })
}

/// The **lowest** loopback port in `min..=max` that is neither already `taken` nor
/// in `reserved` (the host's own loopback port). Lowest-free (not `max + 1`) reuses
/// released ports to keep origins stable across reinstall. `None` when the range is
/// exhausted — the caller maps that to [`UploadInsertError::PortSpaceExhausted`].
///
/// Pure, for the same reason as [`choose_self_hosted_slug`]: the store reads the
/// live port set in-transaction and passes it in.
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
    /// Render the loopback launch target `http://{host}:{port}/`. `host` is the
    /// loopback hostname the host binds on. The path is the bare root: each
    /// self-hosted app gets its own origin and is served from `/` on it.
    #[must_use]
    pub fn launch_url(&self, host: &str) -> String {
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
    /// loopback [`Self::launch_url`] or the [`Self::subdomain_url`] the handler
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

/// Everything `POST /self-hosted-apps` needs to install a self-hosted upload. The
/// store allocates the final slug (which becomes id / subdomain) and the loopback
/// port inside its transaction; the display position is appended there too.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSelfHostedUpload {
    pub name: String,
    /// `None` means "no subtitle".
    pub subtitle: Option<String>,
    /// The slug candidate derived from the name; the store suffixes it
    /// (`-2`, `-3`, …) until unique, keeping every candidate a valid DNS label.
    pub base_slug: String,
    /// The on-disk folder (under the apps root) already holding the extracted
    /// files — the upload's staging mint id, recorded verbatim. Deliberately NOT
    /// the slug; see the content-folder section of
    /// `docs/Apps/Store and Install Explanation.md`.
    pub content_folder: String,
    /// Ports the allocation must skip (the host's own loopback API port).
    pub reserved_ports: Vec<u16>,
    /// The install-inferred SMART launch path, `None` for a root-served bundle.
    pub launch_path: Option<String>,
}

/// Why [`insert_self_hosted_app`](super::AppsStore::insert_self_hosted_app)
/// allocated nothing (the transaction was dropped unwritten). Distinguished so
/// the [`create_self_hosted_app`](super::actions) action can answer accurately: a
/// slug clash is a name problem the caller can retry differently, an exhausted port
/// space is a server resource fault no rename fixes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadInsertError {
    /// No unique slug was found within the suffix-attempt budget.
    SlugSpaceExhausted,
    /// Every loopback port in the upload range is taken or reserved.
    PortSpaceExhausted,
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
        let base = config.launch_url("127.0.0.1");
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
        let base = config.launch_url("127.0.0.1");
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

    fn slug_set(slugs: &[&str]) -> HashSet<String> {
        slugs.iter().map(|s| (*s).to_owned()).collect()
    }

    /// The base slug is used verbatim when free; a collision (in ids or subdomains)
    /// bumps to the next `-N` suffix.
    #[test]
    fn choose_slug_uses_base_then_suffixes_on_collision() {
        let empty = HashSet::new();
        assert_eq!(
            choose_self_hosted_slug("my-app", &empty, &empty, 50).as_deref(),
            Some("my-app"),
        );
        assert_eq!(
            choose_self_hosted_slug("my-app", &slug_set(&["my-app"]), &empty, 50).as_deref(),
            Some("my-app-2"),
            "an id collision suffixes",
        );
        assert_eq!(
            choose_self_hosted_slug("my-app", &empty, &slug_set(&["my-app", "my-app-2"]), 50)
                .as_deref(),
            Some("my-app-3"),
            "a subdomain collision suffixes too",
        );
    }

    /// A suffixed candidate stays within the DNS label limit — the base is truncated
    /// to make room for `-N`.
    #[test]
    fn choose_slug_keeps_a_suffixed_candidate_a_valid_dns_label() {
        let base = "a".repeat(MAX_SLUG_LEN);
        let taken = slug_set(&[&base]);
        let empty = HashSet::new();
        let chosen = choose_self_hosted_slug(&base, &taken, &empty, 50).expect("a free slug");
        assert!(
            chosen.len() <= MAX_SLUG_LEN,
            "{chosen} ({} chars)",
            chosen.len()
        );
        assert!(chosen.ends_with("-2"));
    }

    /// Exhausting the attempt budget yields `None`.
    #[test]
    fn choose_slug_reports_exhaustion() {
        let taken = slug_set(&["x", "x-2", "x-3"]);
        let empty = HashSet::new();
        assert_eq!(choose_self_hosted_slug("x", &taken, &empty, 3), None);
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
