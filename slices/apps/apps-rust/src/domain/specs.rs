//! Write-side input specs — what each create / replace store operation needs,
//! as one struct per operation instead of loose scalar arguments. Deliberately
//! *not* the domain [`App`](super::App): a spec carries only the caller-owned
//! fields; everything the store allocates (position, slug, port) or that
//! another surface owns (`enabled`, curated by `PUT /home-screen`) is absent by
//! construction.

use super::AppUrl;

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

/// Everything `POST /apps` needs: a freshly minted id plus the content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewCloudApp {
    pub id: String,
    pub content: CloudContent,
}

/// Everything `POST /self-hosted-apps` needs. The store allocates the final
/// slug (which becomes id / subdomain / content folder), the loopback port,
/// and the display position inside its transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSelfHostedUpload {
    pub name: String,
    /// `None` means "no subtitle".
    pub subtitle: Option<String>,
    /// The slug candidate derived from the name; the store suffixes it
    /// (`-2`, `-3`, …) until unique.
    pub base_slug: String,
    /// Ports the allocation must skip (the host's own loopback API port).
    pub reserved_ports: Vec<u16>,
    /// The install-inferred SMART launch path, `None` for a root-served bundle.
    pub launch_path: Option<String>,
}
