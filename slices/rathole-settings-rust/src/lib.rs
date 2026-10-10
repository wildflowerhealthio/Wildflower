//! `rathole-settings-rust` — what the relay's `GET /rathole` returns, the
//! tunnel name a device adds to it, and what its signed `GET /me` returns.
//!
//! `wildflower-relay` serves [`PublicRatholeSettings`] at
//! `https://<domain>/rathole` without authentication: everything public a
//! rathole client needs to dial the relay. A device adds only its
//! [`TunnelName`], which is its rathole service name, and that tunnel's
//! token. Its public host is `<tunnel name>.<domain>`. Both ends check a
//! tunnel name with the same [`TunnelName::parse`]. A request signed with
//! the token gets the tunnel's [`TunnelHost`] from `GET /me`.
//!
//! Both ends also check a dial address with the same [`parse_public_addr`].
//! A device decodes the relay's domain, which ends each of its servers'
//! domains and folder names, as a [`RelayDomain`].
//!
//! With the `proxy-header` feature, [`proxy_header`](mod@proxy_header) builds
//! the PROXY protocol v2 header the relay writes ahead of each visitor's bytes.
//!
//! [`Transport`] and [`NoisePattern`] each have one value, the one the relay
//! and the device's rathole are both built for. The relay renders its rathole
//! server TOML from the same values, and a response naming anything else
//! fails to deserialize instead of becoming a client config the device
//! cannot run.

#[cfg(feature = "proxy-header")]
pub mod proxy_header;
mod public_addr;
mod relay_domain;
mod tunnel_name;

use serde::{Deserialize, Serialize};

pub use public_addr::{parse_public_addr, InvalidPublicAddr};
pub use relay_domain::{is_dns_name, InvalidRelayDomain, RelayDomain};
pub use tunnel_name::{is_dns_label, InvalidTunnelName, TunnelName, ADMIN_KEY_ID};

/// The relay's public rathole settings, as `GET /rathole` serves them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicRatholeSettings {
    /// `[client] remote_addr`: the `host:port` devices' rathole clients dial.
    pub remote_addr: String,
    /// `[client.transport] type`.
    pub transport: Transport,
    /// `[client.transport.noise] pattern`.
    pub noise_pattern: NoisePattern,
    /// `[client.transport.noise] remote_public_key`: the relay's X25519
    /// public key, base64, as `rathole --genkey` prints it.
    pub public_key: String,
    /// The relay's own hostname; each tunnel is reached at
    /// `<tunnel name>.<domain>`.
    pub domain: String,
}

/// What the relay's signed `GET /me` returns: the tunnel that signed, and
/// the hostname visitors reach it at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TunnelHost {
    /// Decoded as a [`TunnelName`], so a `/me` naming anything else fails to
    /// deserialize.
    pub tunnel_name: TunnelName,
    /// `<tunnel name>.<domain>`.
    pub public_host: String,
}

/// A rathole transport (`[client.transport] type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    /// The Noise protocol framework, keyed by the relay's static key.
    Noise,
}

/// A Noise protocol name (`[client.transport.noise] pattern`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NoisePattern {
    /// rathole's default: the client knows the relay's static public key and
    /// has none of its own.
    #[serde(rename = "Noise_NK_25519_ChaChaPoly_BLAKE2s")]
    Nk25519ChaChaPolyBlake2s,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example() -> PublicRatholeSettings {
        PublicRatholeSettings {
            remote_addr: "relay.wildflowerhealth.io:2333".to_owned(),
            transport: Transport::Noise,
            noise_pattern: NoisePattern::Nk25519ChaChaPolyBlake2s,
            public_key: "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=".to_owned(),
            domain: "relay.wildflowerhealth.io".to_owned(),
        }
    }

    const EXAMPLE_JSON: &str = r#"{"remote_addr":"relay.wildflowerhealth.io:2333","transport":"noise","noise_pattern":"Noise_NK_25519_ChaChaPoly_BLAKE2s","public_key":"24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=","domain":"relay.wildflowerhealth.io"}"#;

    #[test]
    fn serializes_to_the_documented_wire_shape() {
        assert_eq!(serde_json::to_string(&example()).unwrap(), EXAMPLE_JSON);
    }

    #[test]
    fn deserializes_the_documented_wire_shape() {
        let settings: PublicRatholeSettings = serde_json::from_str(EXAMPLE_JSON).unwrap();
        assert_eq!(settings, example());
    }

    #[test]
    fn a_tunnel_host_decodes_its_name_as_a_tunnel_name() {
        let tunnel_host: TunnelHost = serde_json::from_str(
            r#"{"tunnel_name":"ruth","public_host":"ruth.relay.example.com"}"#,
        )
        .unwrap();
        assert_eq!(tunnel_host.tunnel_name, TunnelName::parse("ruth").unwrap());
        for name in ["Ruth", "admin", "ru.th"] {
            let json = format!(r#"{{"tunnel_name":"{name}","public_host":"x"}}"#);
            assert!(serde_json::from_str::<TunnelHost>(&json).is_err(), "{json}");
        }
    }

    #[test]
    fn rejects_a_transport_or_pattern_the_device_cannot_run() {
        for (from, to) in [
            (r#""transport":"noise""#, r#""transport":"tls""#),
            (
                "Noise_NK_25519_ChaChaPoly_BLAKE2s",
                "Noise_KK_25519_ChaChaPoly_BLAKE2s",
            ),
        ] {
            let json = EXAMPLE_JSON.replace(from, to);
            assert_ne!(json, EXAMPLE_JSON);
            assert!(
                serde_json::from_str::<PublicRatholeSettings>(&json).is_err(),
                "{json}"
            );
        }
    }
}
