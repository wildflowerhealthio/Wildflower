//! Builds the rathole config from the environment on every start.
//!
//! The config is rendered as rathole TOML in memory and parsed with rathole's
//! own parser. It holds the control address, the noise transport, pattern
//! and key, and for each tunnel in `WILDFLOWER_RELAY_TUNNELS` a rathole
//! service `[server.services.<tunnel name>]`: TCP with the tunnel's own
//! `token`. A service has no `bind_addr`,
//! since the front hands rathole its visitors. There is no `default_token`,
//! so a device needs its own token to connect.

use anyhow::Context;
use toml::{Table, Value};

use crate::settings::ControlSettings;

/// The rathole server TOML for `control`.
///
/// # Errors
///
/// Returns an error if the table cannot be serialised as TOML.
pub fn render(control: &ControlSettings) -> anyhow::Result<String> {
    let mut services = Table::new();
    for tunnel in &control.tunnels {
        let mut entry = Table::new();
        entry.insert("type".into(), Value::String("tcp".into()));
        entry.insert(
            "token".into(),
            Value::String(tunnel.token.expose().to_owned()),
        );
        services.insert(tunnel.name.clone(), Value::Table(entry));
    }

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
    // rathole requires the table even when there are no tunnels.
    server.insert("services".into(), Value::Table(services));

    let mut root = Table::new();
    root.insert("server".into(), Value::Table(server));
    Ok(toml::to_string(&root)?)
}

/// Render the config for `control` and parse it with rathole's own parser.
/// The relay runs on the result.
///
/// # Errors
///
/// Returns an error if the result is not a valid rathole server config.
pub fn build(control: &ControlSettings) -> anyhow::Result<rathole::Config> {
    let config = render(control)?
        .parse::<rathole::Config>()
        .and_then(|config| {
            anyhow::ensure!(config.server.is_some(), "no [server] section");
            Ok(config)
        })
        .context("the rendered relay config was rejected")?;
    tracing::info!(
        tunnels = control.tunnels.len(),
        "relay config built from the environment"
    );
    Ok(config)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
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

    fn parse(text: &str) -> rathole::Config {
        text.parse()
            .expect("rendered config must parse with rathole")
    }

    /// Golden check on `relay.example.env`: its values give settings that
    /// render to a config rathole accepts, and the defaults it documents in
    /// comments are the real ones.
    #[test]
    fn example_env_renders_a_valid_rathole_config() {
        let example = settings(&example_env(false));
        assert_eq!(
            settings(&example_env(true)),
            example,
            "commented defaults in relay.example.env must match the code"
        );

        let server = parse(&render(&example.control).unwrap())
            .server
            .expect("[server]");
        assert!(server.default_token.is_none());
        assert!(!server.services.is_empty(), "the example lists a tunnel");
        for name in example.control.tunnel_names() {
            let service = &server.services[&name];
            assert!(service.bind_addr.is_empty());
            assert!(service.token.is_some());
        }
    }

    #[test]
    fn render_writes_each_tunnel_as_a_service_with_its_token() {
        let env = HashMap::from([
            (
                "WILDFLOWER_RELAY_DOMAIN".to_owned(),
                "relay.example.com".to_owned(),
            ),
            (
                "WILDFLOWER_RELAY_NOISE_PRIVATE_KEY".to_owned(),
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
            ),
            (
                "WILDFLOWER_RELAY_TUNNELS".to_owned(),
                "bob=t2,alice=t1".to_owned(),
            ),
        ]);
        let control = settings(&env).control;
        let server = parse(&render(&control).unwrap()).server.expect("[server]");
        assert_eq!(server.bind_addr, "0.0.0.0:2333");
        assert_eq!(server.services.len(), 2);
        assert_eq!(server.services["alice"].token.as_deref(), Some("t1"));
        assert_eq!(server.services["bob"].token.as_deref(), Some("t2"));
        // The front hands rathole its visitors, so no service binds a port.
        assert!(server
            .services
            .values()
            .all(|service| service.bind_addr.is_empty()));
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
            RouteTable::from_names(control.tunnel_names()),
        );
        let Some(Destination::Tunnel(route)) = router.resolve("bob.relay.example.com") else {
            panic!("bob routes to a tunnel");
        };
        assert!(server.services.contains_key(&route.tunnel_name));
    }

    #[test]
    fn render_with_no_tunnels_is_still_valid() {
        let env = HashMap::from([
            (
                "WILDFLOWER_RELAY_DOMAIN".to_owned(),
                "relay.example.com".to_owned(),
            ),
            (
                "WILDFLOWER_RELAY_NOISE_PRIVATE_KEY".to_owned(),
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".to_owned(),
            ),
        ]);
        let server = parse(&render(&settings(&env).control).unwrap())
            .server
            .expect("[server]");
        assert!(server.services.is_empty());
    }

    #[test]
    fn build_parses_the_render() {
        let control = settings(&example_env(false)).control;
        let built = build(&control).unwrap();
        assert!(
            built.server.is_some(),
            "the relay runs on a [server] config"
        );
        assert_eq!(built, parse(&render(&control).unwrap()));
    }
}
