//! Writes the rathole TOML from the environment on every start.
//!
//! The file is generated, never read back: the control address, the noise
//! transport and key, and for each tunnel in `WILDFLOWER_RELAY_TUNNELS` a
//! rathole service `[server.services.<tunnel name>]`: loopback TCP with the
//! tunnel's own `token`, on the port [`ControlSettings::tunnel_addrs`] gives
//! it. There is
//! no `default_token`, so a device needs its own token to connect.

use std::path::{Path, PathBuf};

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
    for ((name, addr), tunnel) in control.tunnel_addrs().into_iter().zip(&control.tunnels) {
        let mut entry = Table::new();
        entry.insert("type".into(), Value::String("tcp".into()));
        entry.insert("bind_addr".into(), Value::String(addr.to_string()));
        entry.insert(
            "token".into(),
            Value::String(tunnel.token.expose().to_owned()),
        );
        services.insert(name, Value::Table(entry));
    }

    let mut noise = Table::new();
    noise.insert(
        "local_private_key".into(),
        Value::String(control.noise_private_key.expose().to_owned()),
    );
    let mut transport = Table::new();
    transport.insert("type".into(), Value::String("noise".into()));
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

/// Render the config for `control` and replace the file at `path`
/// atomically: the new text goes to a temp file in the same directory, is
/// checked with rathole's own parser, and is renamed over `path`, so rathole
/// never sees a half-written file.
///
/// # Errors
///
/// Returns an error if the result is not a valid rathole config or the write
/// or rename fails.
pub async fn write_config(path: &Path, control: &ControlSettings) -> anyhow::Result<()> {
    let rendered = render(control)?;
    let temp = temp_path(path)?;
    write_private(&temp, &rendered).with_context(|| format!("writing {}", temp.display()))?;
    let checked = rathole::Config::from_file(&temp).await.and_then(|config| {
        anyhow::ensure!(config.server.is_some(), "no [server] section");
        Ok(())
    });
    let renamed = checked.and_then(|()| {
        std::fs::rename(&temp, path).with_context(|| format!("replacing {}", path.display()))
    });
    if renamed.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    renamed.context("the rendered relay config was rejected")?;
    tracing::info!(
        config = %path.display(),
        tunnels = control.tunnels.len(),
        "relay config written from the environment"
    );
    Ok(())
}

/// `.<name>.tmp` beside `path`. rathole's watcher filters events by the
/// config's file name, so writing the temp file triggers nothing; the rename
/// does.
fn temp_path(path: &Path) -> anyhow::Result<PathBuf> {
    let name = path
        .file_name()
        .context("relay config path has no file name")?
        .to_string_lossy();
    Ok(path.with_file_name(format!(".{name}.tmp")))
}

/// Create (or truncate) `path` readable by the owner only: it holds the
/// tunnel tokens and the private key.
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::route::{RouteTable, Router};
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

    async fn parse(text: &str) -> rathole::Config {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("relay.toml");
        std::fs::write(&path, text).expect("write");
        rathole::Config::from_file(&path)
            .await
            .expect("rendered config must parse with rathole")
    }

    /// Golden check on `relay.example.env`: its values give settings that
    /// render to a config rathole accepts, and the defaults it documents in
    /// comments are the real ones.
    #[tokio::test]
    async fn example_env_renders_a_valid_rathole_config() {
        let example = settings(&example_env(false));
        assert_eq!(
            settings(&example_env(true)),
            example,
            "commented defaults in relay.example.env must match the code"
        );

        let server = parse(&render(&example.control).unwrap())
            .await
            .server
            .expect("[server]");
        assert!(server.default_token.is_none());
        assert!(!server.services.is_empty(), "the example lists a tunnel");
        for (name, addr) in example.control.tunnel_addrs() {
            let service = &server.services[&name];
            assert_eq!(service.bind_addr, addr.to_string());
            assert!(service.token.is_some());
        }
    }

    #[tokio::test]
    async fn render_writes_each_tunnel_as_a_service_with_its_token_and_port() {
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
        let server = parse(&render(&control).unwrap())
            .await
            .server
            .expect("[server]");
        assert_eq!(server.bind_addr, "0.0.0.0:2333");
        assert_eq!(server.services.len(), 2);
        assert_eq!(server.services["alice"].bind_addr, "127.0.0.1:5201");
        assert_eq!(server.services["alice"].token.as_deref(), Some("t1"));
        assert_eq!(server.services["bob"].bind_addr, "127.0.0.1:5202");
        assert_eq!(server.services["bob"].token.as_deref(), Some("t2"));
        let noise = server.transport.noise.expect("[server.transport.noise]");
        assert!(noise.local_private_key.is_some());

        // The front routes the same tunnel names to the same ports.
        let router = Router::new(
            "relay.example.com",
            RouteTable::from_addrs(control.tunnel_addrs()),
        );
        assert_eq!(
            router
                .resolve("bob.relay.example.com")
                .map(|route| route.addr.to_string()),
            Some(server.services["bob"].bind_addr.clone())
        );
    }

    #[tokio::test]
    async fn render_with_no_tunnels_is_still_valid() {
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
            .await
            .server
            .expect("[server]");
        assert!(server.services.is_empty());
    }

    #[tokio::test]
    async fn write_config_replaces_the_file_privately() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("relay.toml");
        std::fs::write(&path, "stale contents from a previous run").unwrap();

        let control = settings(&example_env(false)).control;
        write_config(&path, &control).await.unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written, render(&control).unwrap());
        assert!(
            !temp_path(&path).unwrap().exists(),
            "temp file is renamed away"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
