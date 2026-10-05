//! Builds rathole's server config in memory from the settings and the stored
//! tunnels, on every start. Nothing is written to disk: rathole runs on the
//! built [`rathole::Config`], and a change through the admin API reaches it
//! as one service added or deleted (see
//! [`TunnelRegistry`](crate::TunnelRegistry)).
//!
//! The `[server]` table holds the control address and the noise transport,
//! pattern and key. It is rendered as TOML and parsed with rathole's own
//! parser, since rathole builds its server config no other way. Each stored
//! tunnel is a rathole service of the same name,
//! `[server.services.<tunnel name>]`, built by [`service`]: TCP with the
//! tunnel's own `token`. There is no `default_token`, so a device
//! needs its own token to connect.

use anyhow::Context;
use toml::{Table, Value};

use crate::domain::Tunnel;
use crate::settings::ControlSettings;

/// The rathole `[server]` TOML for `control`, with no services.
///
/// # Errors
///
/// Returns an error if the table cannot be serialised as TOML.
pub fn render(control: &ControlSettings) -> anyhow::Result<String> {
    let mut noise = Table::new();
    noise.insert(
        "pattern".into(),
        Value::try_from(ControlSettings::NOISE_PATTERN)?,
    );
    noise.insert(
        "local_private_key".into(),
        Value::String(control.noise_private_key.expose().to_owned()),
    );
    let mut transport = Table::new();
    transport.insert("type".into(), Value::try_from(ControlSettings::TRANSPORT)?);
    transport.insert("noise".into(), Value::Table(noise));

    let mut server = Table::new();
    server.insert(
        "bind_addr".into(),
        Value::String(control.control_addr.to_string()),
    );
    server.insert("transport".into(), Value::Table(transport));
    // rathole requires the table even when there are no services.
    server.insert("services".into(), Value::Table(Table::new()));

    let mut root = Table::new();
    root.insert("server".into(), Value::Table(server));
    Ok(toml::to_string(&root)?)
}

/// The config rathole runs on: [`render`] for `control`, parsed with
/// rathole's own parser, with a [`service`] for each of `tunnels`.
///
/// # Errors
///
/// Returns an error if the rendered `[server]` table is not a valid rathole
/// server config.
pub fn build(control: &ControlSettings, tunnels: &[Tunnel]) -> anyhow::Result<rathole::Config> {
    let mut config = render(control)?
        .parse::<rathole::Config>()
        .context("the rendered relay config was rejected")?;
    let server = config
        .server
        .as_mut()
        .context("the rendered relay config has no [server] section")?;
    server.services = tunnels
        .iter()
        .map(|tunnel| (tunnel.name.clone(), service(tunnel)))
        .collect();
    tracing::info!(tunnels = tunnels.len(), "rathole config built");
    Ok(config)
}

/// The rathole service of `tunnel`: TCP, named after the tunnel, with its
/// token.
#[must_use]
pub fn service(tunnel: &Tunnel) -> rathole::ServerServiceConfig {
    rathole::ServerServiceConfig {
        // rathole requires one, but a server run with visitor queues never
        // binds a TCP service's: the front puts its visitors into the
        // tunnel's queue. An empty address cannot be bound, so a service
        // that were ever bound would fail rather than open a port.
        bind_addr: String::new(),
        token: Some(tunnel.token.expose().into()),
        ..rathole::ServerServiceConfig::with_name(&tunnel.name)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::domain::test_fake::stored_tunnel;
    use crate::route::{Destination, RouteTable, Router};
    use crate::settings::RelaySettings;

    /// The `KEY=value` lines of `relay.example.env`, optionally including
    /// the commented-out `# KEY=default` ones.
    fn example_env(with_commented_defaults: bool) -> HashMap<String, String> {
        include_str!("../relay.example.env")
            .lines()
            .filter_map(|line| {
                let line = match line.strip_prefix("# ") {
                    Some(commented) if with_commented_defaults => commented,
                    Some(_) => return None,
                    None => line,
                };
                let (name, value) = line.split_once('=')?;
                let is_var =
                    name.starts_with("WILDFLOWER_RELAY_") && !name.contains(char::is_whitespace);
                is_var.then(|| (name.to_owned(), value.to_owned()))
            })
            .collect()
    }

    fn settings(env: &HashMap<String, String>) -> RelaySettings {
        RelaySettings::from_lookup(|name| env.get(name).cloned()).expect("example settings")
    }

    fn minimal_env() -> HashMap<String, String> {
        HashMap::from([
            (
                "WILDFLOWER_RELAY_DOMAIN".to_owned(),
                "relay.example.com".to_owned(),
            ),
            (
                "WILDFLOWER_RELAY_NOISE_PRIVATE_KEY".to_owned(),
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
            ),
        ])
    }

    /// The tunnels `names`, as stored.
    fn tunnels(names: &[&str]) -> Vec<Tunnel> {
        names
            .iter()
            .map(|name| stored_tunnel(name).tunnel)
            .collect()
    }

    /// Golden check on `relay.example.env`: its values give settings that
    /// build a config rathole accepts, and the defaults it documents in
    /// comments are the real ones.
    #[test]
    fn example_env_builds_a_valid_rathole_config() {
        let example = settings(&example_env(false));
        assert_eq!(
            settings(&example_env(true)),
            example,
            "commented defaults in relay.example.env must match the code"
        );

        let server = build(&example.control, &tunnels(&["wildflower-device-1"]))
            .unwrap()
            .server
            .expect("[server]");
        assert!(server.default_token.is_none());
        assert_eq!(server.services.len(), 1);
        let service = &server.services["wildflower-device-1"];
        assert!(service.bind_addr.is_empty());
        assert!(service.token.is_some());
    }

    #[test]
    fn build_makes_each_tunnel_a_service_with_its_token() {
        let env = minimal_env();
        let control = settings(&env).control;
        let server = build(&control, &tunnels(&["bob", "alice"]))
            .unwrap()
            .server
            .expect("[server]");
        assert_eq!(server.bind_addr, "0.0.0.0:2333");
        assert_eq!(server.services.len(), 2);
        assert_eq!(server.services["alice"].name, "alice");
        assert_eq!(
            server.services["alice"].token.as_deref(),
            Some("alice-token")
        );
        assert_eq!(server.services["bob"].token.as_deref(), Some("bob-token"));
        let noise = server.transport.noise.expect("[server.transport.noise]");
        assert!(noise.local_private_key.is_some());
        // `GET /rathole` tells clients the pattern the server runs.
        assert_eq!(
            Value::try_from(settings(&env).public_rathole_settings().noise_pattern).unwrap(),
            Value::String(noise.pattern)
        );

        // The front routes the same tunnel names to the services.
        let router = Router::new(
            "relay.example.com",
            ["relay.example.com".to_owned()],
            RouteTable::from_names(["bob".to_owned(), "alice".to_owned()]),
        );
        let Some(Destination::Tunnel(route)) = router.resolve("bob.relay.example.com") else {
            panic!("bob routes to a tunnel");
        };
        assert!(server.services.contains_key(&route.tunnel_name));
    }

    #[test]
    fn build_with_no_tunnels_is_still_valid() {
        let server = build(&settings(&minimal_env()).control, &[])
            .unwrap()
            .server
            .expect("[server]");
        assert!(server.services.is_empty());
    }

    /// A service built here is the one rathole parses from the same TOML,
    /// so services added while the relay runs match those it starts with.
    #[test]
    fn service_is_what_rathole_parses_for_the_tunnel() {
        let alice = stored_tunnel("alice").tunnel;
        let parsed: rathole::Config = "[server]\nbind_addr = \"0.0.0.0:2333\"\n\
             [server.services.alice]\ntype = \"tcp\"\nbind_addr = \"\"\ntoken = \"alice-token\"\n"
            .parse()
            .expect("rathole parses the service");
        assert_eq!(parsed.server.unwrap().services["alice"], service(&alice));
    }
}
