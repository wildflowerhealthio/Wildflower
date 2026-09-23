//! [`HostOwnerEntitlement`] — what the host's own owner token may claim. The
//! token is minted at boot (and re-minted hourly) from configuration with no
//! approving human. This is the one source of token authority outside the
//! delegation chain, so it is a named type with a single construction site
//! (`seeding`, enforced by the guard test in the parent module) rather than an
//! implicit branch in the minter.

/// Proof that a token is the host's own owner token. Carries the first-party
/// `client_id` and the host's configured grant (both sourced from
/// `tauri-shared-config.json` on the live app), which the minter records
/// verbatim and marks with the `wf_owner` claim.
pub(crate) struct HostOwnerEntitlement {
    client_id: String,
    scopes: Vec<String>,
}

impl HostOwnerEntitlement {
    /// The host's own authority: `first_party_client_id` holding the configured
    /// `host_owner_scopes`. Only `seeding` may call this.
    pub(crate) fn for_host(first_party_client_id: &str, host_owner_scopes: &[String]) -> Self {
        HostOwnerEntitlement {
            client_id: first_party_client_id.to_owned(),
            scopes: host_owner_scopes.to_vec(),
        }
    }

    /// The first-party `client_id` the token is issued to.
    pub(super) fn client_id(&self) -> &str {
        &self.client_id
    }

    /// The configured grant, recorded verbatim.
    pub(super) fn token_scopes(&self) -> &[String] {
        &self.scopes
    }
}
