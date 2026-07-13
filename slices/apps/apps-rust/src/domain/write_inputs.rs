//! Write-side input specs — what each create / replace persistence operation
//! needs, as one struct per operation instead of loose scalar arguments. They're
//! domain value objects the [`AppsStore`](crate::domain::AppsStore) port speaks
//! (the `SQLite` adapter's query bodies in [`crate::db`] consume them); a handler
//! builds one and hands it to an [`action`](crate::domain::actions). Deliberately
//! *not* the domain [`App`](crate::domain::App): a spec carries only the
//! caller-owned fields; everything the store allocates (position, slug, port) or
//! that another surface owns (`enabled`, curated by `PUT /home-screen`) is absent
//! by construction.

use crate::domain::AppUrl;

/// The editable content of a cloud app — what `PUT /apps/{id}` replaces and
/// what `POST /apps` supplies at create. Excludes `enabled` (homescreen-owned)
/// and `id` (minted at create, immutable after).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudContent {
    pub name: String,
    /// `None` means "no subtitle".
    pub subtitle: Option<String>,
    /// The launch URL template, already through the write-side [`AppUrl`]
    /// validator.
    pub url: AppUrl,
    pub requires_tunnel: bool,
}

/// Everything `POST /apps` needs to create a cloud app: a freshly minted id plus
/// the content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewCloudApp {
    pub id: String,
    pub content: CloudContent,
}

/// Everything `POST /apps` needs to install a self-hosted upload. The store
/// allocates the final slug (which becomes id / subdomain) and the loopback port
/// inside its transaction; the display position is appended there too.
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

/// Why [`insert_self_hosted_app`](crate::domain::AppsStore::insert_self_hosted_app)
/// allocated nothing (the transaction was dropped unwritten). Distinguished so
/// the [`create_self_hosted_app`](crate::domain::actions) action can answer
/// accurately: a slug clash is a name problem the
/// caller can retry differently, an exhausted port space is a server resource
/// fault no rename fixes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadInsertError {
    /// No unique slug was found within the suffix-attempt budget.
    SlugSpaceExhausted,
    /// Every loopback port in the upload range is taken or reserved.
    PortSpaceExhausted,
}
