//! The persisted tunnel settings: the public host the relay edge serves this
//! device at, the on/off intent, and the write-only relay connection details.
//!
//! This is the single source of truth (stored in SQLite). `public_host` is
//! shown to the user; the relay fields are set through the API but never
//! returned on the wire. Until every relay field is present the tunnel is "not
//! configured" and a start request reports that rather than connecting.
//!
//! `revision` is a monotonically increasing version bumped on every accepted
//! write; it is the optimistic-concurrency token a PUT must match (and the key
//! that decides which tunnel run is live).

/// The full settings row. Relay fields are `Option` because they are unset on a
/// fresh install.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TunnelSettings {
    /// Optimistic-concurrency version, bumped on each accepted write.
    pub revision: i64,
    /// The full public hostname the relay edge serves this device at, e.g.
    /// `dev1.example.com`. Drives `servedOrigin`; shown to the user.
    pub public_host: Option<String>,
    /// On/off intent. Persisted so the tunnel auto-resumes after a restart.
    pub requested_running: bool,
    /// Relay control address, e.g. `relay.example.com:2333`. Write-only.
    pub relay_remote_addr: Option<String>,
    /// Shared/default token authenticating this client to the relay. Write-only.
    pub relay_token: Option<String>,
    /// The relay's noise public key (base64). Write-only.
    pub relay_public_key: Option<String>,
    /// rathole service name; must match a `[server.services.<name>]` on the
    /// relay. Write-only.
    pub service_name: Option<String>,
}

/// A fully-specified relay connection — produced only when every field the
/// rathole client needs is present. Also the shape a PUT sets the relay block
/// to (all four together, or none).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayConnection {
    pub remote_addr: String,
    pub token: String,
    pub public_key: String,
    pub service_name: String,
}

impl TunnelSettings {
    /// The relay connection the rathole client should dial, or `None` when the
    /// relay isn't fully configured yet.
    pub fn relay_connection(&self) -> Option<RelayConnection> {
        Some(RelayConnection {
            remote_addr: non_empty(self.relay_remote_addr.as_deref())?,
            token: non_empty(self.relay_token.as_deref())?,
            public_key: non_empty(self.relay_public_key.as_deref())?,
            service_name: non_empty(self.service_name.as_deref())?,
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
            relay_public_key: Some("key".into()),
            ..Default::default()
        };
        assert_eq!(s.relay_connection(), None, "missing service name");
        s.service_name = Some("dev1".into());
        assert_eq!(
            s.relay_connection().map(|r| r.service_name),
            Some("dev1".to_string())
        );
    }

    #[test]
    fn blank_strings_count_as_unconfigured() {
        let s = TunnelSettings {
            relay_remote_addr: Some(String::new()),
            relay_token: Some("tok".into()),
            relay_public_key: Some("key".into()),
            service_name: Some("dev1".into()),
            ..Default::default()
        };
        assert_eq!(s.relay_connection(), None);
    }
}
