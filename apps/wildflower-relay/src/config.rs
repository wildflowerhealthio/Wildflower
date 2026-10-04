//! Writes the rathole TOML from the environment at startup.
//!
//! The file has two owners. The `[server]` base keys (control address, noise
//! transport and key) come from [`ControlSettings`] and are rewritten on every
//! start; `default_token` is the relay's too and is always removed, so no
//! service can connect without a token of its own. The `[server.services.*]`
//! tables belong to enrolment, which appends a service per device with its
//! own `token`, and are kept as they are, along with any other key the
//! environment does not own. Services listed in `WILDFLOWER_RELAY_SERVICES`
//! are written too, for hosts whose disk does not persist: each replaces a
//! file entry of the same label and gets the next loopback port from
//! `WILDFLOWER_RELAY_SERVICE_PORT_BASE` (in label order) that no file-only
//! service already uses.
//!
//! rathole rejects the whole file if any service has no `token` (and there is
//! no `default_token` to fall back on). At startup that is an error naming
//! the services, rather than dropping them; on a later reload rathole and the
//! route watcher both keep their previous config and log the error. The relay rewrites
//! the file only here, before rathole and the route watcher start: changing
//! the base keys under a running rathole would make it restart every tunnel.
//! The file is machine-owned, so comments in it are not preserved.

use std::collections::HashSet;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

use anyhow::Context;
use toml::{Table, Value};

use crate::settings::ControlSettings;

/// Merge the env-owned keys into `existing` (the current file's text, if
/// any) and return the new file's text.
///
/// # Errors
///
/// Returns an error if `existing` is not TOML, has a non-table where a table
/// is expected (`[server]`, `[server.transport]`, ...), or has a service
/// without its own `token`.
pub fn render(existing: Option<&str>, control: &ControlSettings) -> anyhow::Result<String> {
    let mut root: Table = match existing {
        Some(text) => text
            .parse()
            .context("existing relay config is not valid TOML")?,
        None => Table::new(),
    };
    let server = table_at(&mut root, "server")?;
    server.insert(
        "bind_addr".to_owned(),
        Value::String(control.control_addr.to_string()),
    );
    server.remove("default_token");
    // rathole requires the table even when no device is enrolled yet.
    let services = table_at(server, "services")?;
    merge_env_services(services, control)?;
    let tokenless: Vec<&str> = services
        .iter()
        .filter(|(_, service)| {
            service
                .get("token")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
        })
        .map(|(name, _)| name.as_str())
        .collect();
    anyhow::ensure!(
        tokenless.is_empty(),
        "services without their own `token`: {} (there is no default token; \
         enrolment writes one per service)",
        tokenless.join(", ")
    );
    let transport = table_at(server, "transport")?;
    transport.insert("type".to_owned(), Value::String("noise".to_owned()));
    table_at(transport, "noise")?.insert(
        "local_private_key".to_owned(),
        Value::String(control.noise_private_key.expose().to_owned()),
    );
    Ok(toml::to_string(&root)?)
}

/// Write each env service into `services` as a loopback TCP service,
/// replacing a file entry with the same label. Ports count up from the base
/// in label order, skipping any port a file-only service binds.
fn merge_env_services(services: &mut Table, control: &ControlSettings) -> anyhow::Result<()> {
    let from_env = |name: &str| control.services.iter().any(|s| s.label == name);
    let taken: HashSet<u16> = services
        .iter()
        .filter(|(name, _)| !from_env(name))
        .filter_map(|(_, service)| {
            let addr: SocketAddr = service.get("bind_addr")?.as_str()?.parse().ok()?;
            Some(addr.port())
        })
        .collect();
    let mut ports = (control.service_port_base..=u16::MAX).filter(|port| !taken.contains(port));
    for service in &control.services {
        let port = ports.next().with_context(|| {
            format!(
                "no free loopback port for service {:?} from {} up",
                service.label, control.service_port_base
            )
        })?;
        let mut table = Table::new();
        table.insert("type".to_owned(), Value::String("tcp".to_owned()));
        table.insert(
            "bind_addr".to_owned(),
            Value::String(SocketAddr::from((Ipv4Addr::LOCALHOST, port)).to_string()),
        );
        table.insert(
            "token".to_owned(),
            Value::String(service.token.expose().to_owned()),
        );
        services.insert(service.label.clone(), Value::Table(table));
    }
    Ok(())
}

/// The table at `key` in `parent`, created empty if absent.
fn table_at<'a>(parent: &'a mut Table, key: &str) -> anyhow::Result<&'a mut Table> {
    parent
        .entry(key)
        .or_insert_with(|| Value::Table(Table::new()))
        .as_table_mut()
        .with_context(|| format!("`{key}` in the relay config must be a table"))
}

/// Render the config at `path` from `control` and replace the file
/// atomically: the new text goes to a temp file in the same directory, is
/// checked with rathole's own parser, and is renamed over `path`, so a
/// watcher never sees a half-written file. An unchanged file is not
/// rewritten.
///
/// # Errors
///
/// Returns an error if the existing file cannot be read or merged, the
/// result is not a valid rathole config, or the write or rename fails.
pub async fn write_config(path: &Path, control: &ControlSettings) -> anyhow::Result<()> {
    let existing = match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    let rendered = render(existing.as_deref(), control)
        .with_context(|| format!("merging settings into {}", path.display()))?;
    if existing.as_deref() == Some(rendered.as_str()) {
        return Ok(());
    }

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
    tracing::info!(config = %path.display(), "relay config written from the environment");
    Ok(())
}

/// `.<name>.tmp` beside `path`. rathole's watcher filters events by the
/// config's file name and the route watcher only looks at the config itself,
/// so writing the temp file triggers nothing; the rename does.
fn temp_path(path: &Path) -> anyhow::Result<PathBuf> {
    let name = path
        .file_name()
        .context("relay config path has no file name")?
        .to_string_lossy();
    Ok(path.with_file_name(format!(".{name}.tmp")))
}

/// Create (or truncate) `path` readable by the owner only: it holds the
/// service tokens and the private key.
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
    use super::*;
    use crate::route::{RouteTable, Router};
    use crate::settings::{EnvService, Secret};

    fn control() -> ControlSettings {
        ControlSettings {
            control_addr: "0.0.0.0:2333".parse().unwrap(),
            // 32 zero bytes, valid base64; any key parses.
            noise_private_key: Secret::new("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
            services: Vec::new(),
            service_port_base: 5201,
        }
    }

    /// `control()` with env services, given already sorted by label as
    /// settings parsing leaves them.
    fn with_services(services: &[(&str, &str)]) -> ControlSettings {
        ControlSettings {
            services: services
                .iter()
                .map(|&(label, token)| EnvService {
                    label: label.to_owned(),
                    token: Secret::new(token),
                })
                .collect(),
            ..control()
        }
    }

    async fn parse(text: &str) -> rathole::Config {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("relay.toml");
        std::fs::write(&path, text).expect("write");
        rathole::Config::from_file(&path)
            .await
            .expect("rendered config must parse with rathole")
    }

    #[tokio::test]
    async fn render_without_a_file_is_a_server_with_no_services() {
        let text = render(None, &control()).unwrap();
        let server = parse(&text).await.server.expect("[server]");
        assert_eq!(server.bind_addr, "0.0.0.0:2333");
        assert_eq!(server.default_token, None);
        assert!(server.services.is_empty());
        let noise = server.transport.noise.expect("[server.transport.noise]");
        assert_eq!(
            noise.local_private_key.as_deref(),
            Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
        );
    }

    #[tokio::test]
    async fn render_replaces_env_keys_and_keeps_services() {
        let existing = r#"
[server]
bind_addr = "0.0.0.0:9999"
default_token = "old-token"
heartbeat_interval = 10

[server.transport]
type = "tcp"

[server.services.abc]
bind_addr = "127.0.0.1:5201"
token = "device-token"

[server.services.def]
type = "tcp"
bind_addr = "127.0.0.1:5202"
token = "other-token"
"#;
        let text = render(Some(existing), &control()).unwrap();
        assert!(!text.contains("old-token"), "default_token is removed");
        let server = parse(&text).await.server.expect("[server]");
        assert_eq!(server.bind_addr, "0.0.0.0:2333");
        assert_eq!(server.default_token, None);
        assert_eq!(
            server.heartbeat_interval, 10,
            "keys the env does not own stay"
        );
        assert_eq!(server.services.len(), 2);
        assert_eq!(server.services["abc"].bind_addr, "127.0.0.1:5201");
        assert_eq!(
            server.services["abc"].token.as_deref(),
            Some("device-token")
        );
        assert_eq!(server.services["def"].token.as_deref(), Some("other-token"));
    }

    #[tokio::test]
    async fn env_services_get_ports_in_label_order_skipping_file_ports() {
        let existing = r#"
[server]
bind_addr = "0.0.0.0:2333"

[server.services.enrolled]
bind_addr = "127.0.0.1:5202"
token = "enrolled-token"
"#;
        let control = with_services(&[("alice", "t1"), ("bob", "t2"), ("carol", "t3")]);
        let text = render(Some(existing), &control).unwrap();
        assert_eq!(
            render(Some(existing), &control).unwrap(),
            text,
            "deterministic"
        );
        let server = parse(&text).await.server.expect("[server]");
        let bind = |label: &str| server.services[label].bind_addr.clone();
        assert_eq!(bind("alice"), "127.0.0.1:5201");
        assert_eq!(bind("enrolled"), "127.0.0.1:5202", "file-only service kept");
        assert_eq!(bind("bob"), "127.0.0.1:5203");
        assert_eq!(bind("carol"), "127.0.0.1:5204");
        assert_eq!(
            server.services["enrolled"].token.as_deref(),
            Some("enrolled-token")
        );
        assert_eq!(server.services["bob"].token.as_deref(), Some("t2"));
    }

    #[tokio::test]
    async fn env_service_replaces_a_file_entry_with_the_same_label() {
        let existing = r#"
[server]
bind_addr = "0.0.0.0:2333"

[server.services.alice]
bind_addr = "127.0.0.1:9000"
token = "file-token"
nodelay = true
"#;
        let text = render(Some(existing), &with_services(&[("alice", "env-token")])).unwrap();
        assert!(!text.contains("file-token"));
        let server = parse(&text).await.server.expect("[server]");
        let alice = &server.services["alice"];
        assert_eq!(alice.bind_addr, "127.0.0.1:5201");
        assert_eq!(alice.token.as_deref(), Some("env-token"));
        assert_eq!(alice.nodelay, None, "the whole table is replaced");
    }

    #[tokio::test]
    async fn rendered_env_services_route() {
        let control = with_services(&[("alice", "t1"), ("bob", "t2")]);
        let config = parse(&render(None, &control).unwrap()).await;
        let router = Router::new("relay.example.com", RouteTable::from_config(&config));
        assert_eq!(
            router
                .resolve("bob.relay.example.com")
                .map(|route| route.addr.to_string()),
            Some("127.0.0.1:5202".to_owned())
        );
        assert!(router.resolve("alice.relay.example.com").is_some());
    }

    #[test]
    fn render_names_services_without_a_token() {
        let existing = r#"
[server]
bind_addr = "0.0.0.0:2333"
default_token = "old-token"

[server.services.has]
bind_addr = "127.0.0.1:5201"
token = "t"

[server.services.missing]
bind_addr = "127.0.0.1:5202"

[server.services.empty]
bind_addr = "127.0.0.1:5203"
token = ""
"#;
        let err = format!("{:#}", render(Some(existing), &control()).unwrap_err());
        assert!(err.contains("empty, missing"), "{err}");
        assert!(!err.contains("has"), "{err}");
    }

    #[tokio::test]
    async fn render_keeps_the_example_service() {
        let text = render(Some(include_str!("../relay.example.toml")), &control()).unwrap();
        let server = parse(&text).await.server.expect("[server]");
        assert_eq!(
            server.services["wildflower-device-1"].bind_addr,
            "127.0.0.1:5201"
        );
    }

    #[test]
    fn render_rejects_non_toml_and_non_table_server() {
        assert!(render(Some("not = [toml"), &control()).is_err());
        assert!(render(Some("server = 1"), &control()).is_err());
    }

    #[tokio::test]
    async fn write_config_creates_then_preserves_services() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("relay.toml");

        write_config(&path, &control()).await.unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        assert!(parse(&first).await.server.unwrap().services.is_empty());

        // Enrolment appends a service; a restart with a new control address
        // keeps it.
        let mut table: Table = first.parse().unwrap();
        let mut service = Table::new();
        service.insert("bind_addr".into(), Value::String("127.0.0.1:5201".into()));
        service.insert("token".into(), Value::String("device-token".into()));
        table["server"]["services"]
            .as_table_mut()
            .unwrap()
            .insert("abc".into(), Value::Table(service));
        std::fs::write(&path, toml::to_string(&table).unwrap()).unwrap();

        let moved = ControlSettings {
            control_addr: "0.0.0.0:2444".parse().unwrap(),
            ..control()
        };
        write_config(&path, &moved).await.unwrap();
        let server = parse(&std::fs::read_to_string(&path).unwrap())
            .await
            .server
            .unwrap();
        assert_eq!(server.bind_addr, "0.0.0.0:2444");
        assert_eq!(
            server.services["abc"].token.as_deref(),
            Some("device-token")
        );
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

    #[tokio::test]
    async fn write_config_leaves_an_invalid_file_untouched() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("relay.toml");
        std::fs::write(&path, "not = [toml").unwrap();
        assert!(write_config(&path, &control()).await.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not = [toml");
    }
}
