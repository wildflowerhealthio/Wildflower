//! The persisted tunnel settings: host intent plus relay connection details.
//!
//! This is the single source of truth (stored in SQLite). The relay fields
//! start empty — there is no env-var seeding and no settings UI yet; they are
//! set through the API. Until they are all present the tunnel is "not
//! configured" and a start request reports that rather than connecting.

/// The full settings row. Relay fields are `Option` because they are unset on
/// a fresh install.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TunnelSettings {
    /// Host intent: the subdomain this install is provisioned under.
    pub subdomain: Option<String>,
    /// Host intent: the root domain the relay edge serves the subdomain on.
    pub root_domain: Option<String>,
    /// On/off intent. Persisted so the tunnel auto-resumes after a restart.
    pub requested_running: bool,
    /// Relay control address, e.g. `relay.example.com:2333`.
    pub relay_remote_addr: Option<String>,
    /// Shared/default token authenticating this client to the relay.
    pub relay_token: Option<String>,
    /// The relay's noise public key (base64).
    pub relay_public_key: Option<String>,
    /// rathole service name; must match a `[server.services.<name>]` on the
    /// relay. Falls back to `subdomain` when unset.
    pub service_name: Option<String>,
}

/// A fully-specified relay connection — produced only when every field the
/// rathole client needs is present.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayConnection {
    pub remote_addr: String,
    pub token: String,
    pub public_key: String,
    pub service_name: String,
}

impl TunnelSettings {
    /// The relay connection the rathole client should dial, or `None` when the
    /// relay isn't fully configured yet. `service_name` falls back to the
    /// provisioned `subdomain`.
    pub fn relay_connection(&self) -> Option<RelayConnection> {
        let remote_addr = non_empty(self.relay_remote_addr.as_deref())?;
        let token = non_empty(self.relay_token.as_deref())?;
        let public_key = non_empty(self.relay_public_key.as_deref())?;
        let service_name = non_empty(self.service_name.as_deref())
            .or_else(|| non_empty(self.subdomain.as_deref()))?;
        Some(RelayConnection {
            remote_addr,
            token,
            public_key,
            service_name,
        })
    }
}

/// `Some(owned)` only for a present, non-empty string — treats `Some("")` like
/// `None` so a blanked-out setting counts as unconfigured.
fn non_empty(value: Option<&str>) -> Option<String> {
    match value {
        Some(s) if !s.is_empty() => Some(s.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_connection_is_none_until_all_fields_present() {
        let mut s = TunnelSettings {
            relay_remote_addr: Some("relay:2333".into()),
            relay_token: Some("tok".into()),
            ..Default::default()
        };
        assert_eq!(s.relay_connection(), None, "missing public key");
        s.relay_public_key = Some("key".into());
        // service_name falls back to subdomain; both unset -> still None
        assert_eq!(s.relay_connection(), None, "no service name or subdomain");
        s.subdomain = Some("dev1".into());
        assert_eq!(
            s.relay_connection().map(|r| r.service_name),
            Some("dev1".to_string()),
            "service_name falls back to subdomain"
        );
    }

    #[test]
    fn blank_strings_count_as_unconfigured() {
        let s = TunnelSettings {
            relay_remote_addr: Some(String::new()),
            relay_token: Some("tok".into()),
            relay_public_key: Some("key".into()),
            subdomain: Some("dev1".into()),
            ..Default::default()
        };
        assert_eq!(s.relay_connection(), None);
    }
}
