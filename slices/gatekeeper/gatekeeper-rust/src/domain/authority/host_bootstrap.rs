//! [`HostBootstrap`] — the authority behind the host's own owner token, minted
//! at boot (and re-minted hourly) from configuration with no approving human.
//! This is the one source of token authority outside the delegation chain, so it
//! is a named type with a single construction site (`seeding`, enforced by the
//! guard test in the parent module) rather than an implicit branch in the
//! minter.

use super::mint_authority::{sealed, MintAuthority};

/// Proof that a token is the host's own owner token. Carries the first-party
/// `client_id` and the host's configured grant (both sourced from
/// `tauri-shared-config.json` on the live app), which the minter records
/// verbatim and marks with the `wf_owner` claim.
pub(crate) struct HostBootstrap {
    client_id: String,
    scopes: Vec<String>,
}

impl HostBootstrap {
    /// The host's own authority: `first_party_client_id` holding the configured
    /// `granted_scopes`. Only `seeding` may call this.
    pub(crate) fn for_host(first_party_client_id: &str, granted_scopes: &[String]) -> Self {
        HostBootstrap {
            client_id: first_party_client_id.to_owned(),
            scopes: granted_scopes.to_vec(),
        }
    }
}

impl sealed::Sealed for HostBootstrap {}

impl MintAuthority for HostBootstrap {
    fn client_id(&self) -> &str {
        &self.client_id
    }

    fn scopes(&self) -> &[String] {
        &self.scopes
    }

    fn patient(&self) -> Option<&str> {
        None
    }

    fn is_host_owner(&self) -> bool {
        true
    }
}
