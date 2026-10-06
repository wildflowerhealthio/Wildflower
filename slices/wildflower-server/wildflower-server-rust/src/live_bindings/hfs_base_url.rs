//! Points HFS's `base_url` at the server's public host.
//!
//! HFS writes `base_url` into every URL it emits (Bundle links, `fullUrl`s,
//! `Location`s), and remote clients follow those links through the tunnel, so
//! `base_url` is `https://{public_host}/fhir-r4`. [`point_hfs_at_public_host`]
//! sets it once before serving: the public host comes from the server's
//! record, which doesn't change while the server runs. See
//! `docs/Origins/Explanation.md`.

use anyhow::Context;
use emr_rust::SwappableHfs;

/// Set HFS's `base_url` from the server's public host: `https://{public_host}`.
///
/// # Errors
///
/// Returns an error, leaving `base_url` unchanged, if `public_host` doesn't
/// name an origin (see [`tunnel_rust::public_origin_url`]) or HFS refuses it.
pub(crate) fn point_hfs_at_public_host(
    hfs: &SwappableHfs,
    public_host: &str,
) -> anyhow::Result<()> {
    let origin = tunnel_rust::public_origin_url(public_host)
        .context("the server's public host can't be FHIR's base URL")?;
    hfs.set_base_url(Some(&origin))
}
