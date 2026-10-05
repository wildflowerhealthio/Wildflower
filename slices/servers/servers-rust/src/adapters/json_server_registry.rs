//! [`JsonServerRegistry`]: the [`ServerRegistry`] kept in
//! `<data root>/servers.json`.
//!
//! The file is `{"version": 1, "servers": [...]}`, each server's fields in
//! camelCase. Its version is read before
//! anything else, and a version other than [`FORMAT_VERSION`] is
//! [`RegistryError::UnsupportedVersion`]: the registry neither reads nor
//! overwrites a file it doesn't understand. A missing file is an empty
//! registry.
//!
//! Every change rewrites the whole file through a [`StagedRegistryFile`]: the
//! new document is written to `.servers.json.tmp` beside it and fsynced, then
//! renamed over `servers.json`, and the directory fsynced. A crash before the
//! rename leaves the previous file whole.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use rathole_settings_rust::{NoisePattern, PublicRatholeSettings, Transport, TunnelName};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::domain::{RegistryError, Relay, ServerRecord, TunnelToken};
use crate::ports::ServerRegistry;

/// The registry's file name in the data root.
pub const SERVERS_FILE_NAME: &str = "servers.json";

/// The `servers.json` format version this build reads and writes.
const FORMAT_VERSION: u64 = 1;

/// The [`ServerRegistry`] over `<data root>/servers.json`.
pub struct JsonServerRegistry {
    data_root: PathBuf,
    path: PathBuf,
    /// Held across each read-modify-write, so two changes in this process
    /// can't each write over the other's.
    write_lock: Mutex<()>,
}

impl JsonServerRegistry {
    /// The registry in `data_root`. Nothing is read or created until it's
    /// used.
    #[must_use]
    pub fn in_data_root(data_root: &Path) -> Self {
        Self {
            data_root: data_root.to_owned(),
            path: data_root.join(SERVERS_FILE_NAME),
            write_lock: Mutex::new(()),
        }
    }

    fn read_document(&self) -> Result<RegistryDocument, RegistryError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(RegistryDocument::empty())
            }
            Err(error) => return Err(RegistryError::storage("reading servers.json", error)),
        };
        let VersionProbe { version } = serde_json::from_slice(&bytes)
            .map_err(|error| RegistryError::storage("reading servers.json's version", error))?;
        if version != FORMAT_VERSION {
            return Err(RegistryError::UnsupportedVersion { version });
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| RegistryError::storage("parsing servers.json", error))
    }

    /// Read the registry, apply `change` to its servers, and replace the file
    /// with the result.
    fn modify(
        &self,
        change: impl FnOnce(&mut Vec<ServerRecord>) -> Result<(), RegistryError>,
    ) -> Result<(), RegistryError> {
        let _guard = self.write_lock.lock();
        let mut servers = self.read_document()?.into_records();
        change(&mut servers)?;
        self.stage(&RegistryDocument::from_records(&servers))?
            .commit()
    }

    /// Write `document` to the temporary file and fsync it, without touching
    /// `servers.json`.
    fn stage(&self, document: &RegistryDocument) -> Result<StagedRegistryFile, RegistryError> {
        let bytes = serde_json::to_vec_pretty(document)
            .map_err(|error| RegistryError::storage("serialising servers.json", error))?;
        fs::create_dir_all(&self.data_root)
            .map_err(|error| RegistryError::storage("creating the data root", error))?;
        let temp_path = self.data_root.join(format!(".{SERVERS_FILE_NAME}.tmp"));
        write_private(&temp_path, &bytes).map_err(|error| {
            let _ = fs::remove_file(&temp_path);
            RegistryError::storage("writing the new servers.json", error)
        })?;
        Ok(StagedRegistryFile {
            temp_path,
            data_root: self.data_root.clone(),
            path: self.path.clone(),
        })
    }
}

impl ServerRegistry for JsonServerRegistry {
    fn read_all(&self) -> Result<Vec<ServerRecord>, RegistryError> {
        Ok(self.read_document()?.into_records())
    }

    fn insert(&self, record: ServerRecord) -> Result<(), RegistryError> {
        self.modify(|servers| {
            let domain = record.domain();
            if servers.iter().any(|server| server.domain() == domain) {
                return Err(RegistryError::AlreadyRegistered { domain });
            }
            servers.push(record);
            Ok(())
        })
    }

    fn update(&self, record: ServerRecord) -> Result<(), RegistryError> {
        self.modify(|servers| {
            let domain = record.domain();
            let registered = servers
                .iter_mut()
                .find(|server| server.domain() == domain)
                .ok_or(RegistryError::NotRegistered { domain })?;
            *registered = record;
            Ok(())
        })
    }

    fn remove(&self, domain: &str) -> Result<(), RegistryError> {
        self.modify(|servers| {
            let position = servers
                .iter()
                .position(|server| server.domain() == domain)
                .ok_or_else(|| RegistryError::NotRegistered {
                    domain: domain.to_owned(),
                })?;
            servers.remove(position);
            Ok(())
        })
    }
}

/// A new `servers.json`, written and fsynced beside the live one but not yet
/// in its place.
#[must_use = "the registry is unchanged until the staged file is committed"]
struct StagedRegistryFile {
    temp_path: PathBuf,
    data_root: PathBuf,
    path: PathBuf,
}

impl StagedRegistryFile {
    /// Rename the staged file over `servers.json` and fsync the directory, so
    /// the rename itself survives a crash.
    fn commit(self) -> Result<(), RegistryError> {
        if let Err(error) = fs::rename(&self.temp_path, &self.path) {
            let _ = fs::remove_file(&self.temp_path);
            return Err(RegistryError::storage("replacing servers.json", error));
        }
        sync_directory(&self.data_root)
            .map_err(|error| RegistryError::storage("syncing the data root", error))
    }
}

/// Create or truncate `path`, readable by the owner only since it holds
/// tunnel tokens, write `bytes` and fsync. A leftover file at `path` is
/// narrowed to the owner too, since `mode` only applies to a file it creates.
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    #[cfg(unix)]
    file.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> io::Result<()> {
    File::open(directory)?.sync_all()
}

/// Windows can't open a directory as a file to fsync it; the rename is as
/// durable as the filesystem makes it.
#[cfg(not(unix))]
fn sync_directory(_directory: &Path) -> io::Result<()> {
    Ok(())
}

/// Only the version, read first so an unknown version is reported as such
/// instead of as whatever its fields fail to parse as.
#[derive(Deserialize)]
struct VersionProbe {
    version: u64,
}

/// `servers.json` as stored.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryDocument {
    version: u64,
    servers: Vec<StoredServer>,
}

impl RegistryDocument {
    fn empty() -> Self {
        Self {
            version: FORMAT_VERSION,
            servers: Vec::new(),
        }
    }

    fn from_records(records: &[ServerRecord]) -> Self {
        Self {
            version: FORMAT_VERSION,
            servers: records.iter().map(StoredServer::from_record).collect(),
        }
    }

    fn into_records(self) -> Vec<ServerRecord> {
        self.servers
            .into_iter()
            .map(StoredServer::into_record)
            .collect()
    }
}

/// A [`ServerRecord`] as `servers.json` stores it, in camelCase: the one
/// place its token is written in full.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredServer {
    relay: Relay,
    tunnel_name: TunnelName,
    token: String,
    public_settings: StoredPublicSettings,
    launcher_url: Url,
    staging_certificates: bool,
}

impl StoredServer {
    fn from_record(record: &ServerRecord) -> Self {
        let ServerRecord {
            relay,
            tunnel_name,
            token,
            public_settings,
            launcher_url,
            staging_certificates,
        } = record;
        Self {
            relay: relay.clone(),
            tunnel_name: tunnel_name.clone(),
            token: token.expose().to_owned(),
            public_settings: StoredPublicSettings::from_settings(public_settings),
            launcher_url: launcher_url.clone(),
            staging_certificates: *staging_certificates,
        }
    }

    fn into_record(self) -> ServerRecord {
        let Self {
            relay,
            tunnel_name,
            token,
            public_settings,
            launcher_url,
            staging_certificates,
        } = self;
        ServerRecord {
            relay,
            tunnel_name,
            token: TunnelToken::new(token),
            public_settings: public_settings.into_settings(),
            launcher_url,
            staging_certificates,
        }
    }
}

/// A record's [`PublicRatholeSettings`] as `servers.json` stores them, in
/// camelCase; the relay's `GET /rathole` serves the same fields in its own
/// snake_case wire shape.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredPublicSettings {
    remote_addr: String,
    transport: Transport,
    noise_pattern: NoisePattern,
    public_key: String,
    domain: String,
}

impl StoredPublicSettings {
    fn from_settings(public_settings: &PublicRatholeSettings) -> Self {
        let PublicRatholeSettings {
            remote_addr,
            transport,
            noise_pattern,
            public_key,
            domain,
        } = public_settings.clone();
        Self {
            remote_addr,
            transport,
            noise_pattern,
            public_key,
            domain,
        }
    }

    fn into_settings(self) -> PublicRatholeSettings {
        let Self {
            remote_addr,
            transport,
            noise_pattern,
            public_key,
            domain,
        } = self;
        PublicRatholeSettings {
            remote_addr,
            transport,
            noise_pattern,
            public_key,
            domain,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::fixtures::{custom_record, wildflower_record, TOKEN};

    fn registry() -> (tempfile::TempDir, JsonServerRegistry) {
        let data_root = tempfile::tempdir().unwrap();
        let registry = JsonServerRegistry::in_data_root(data_root.path());
        (data_root, registry)
    }

    fn file_text(data_root: &tempfile::TempDir) -> String {
        fs::read_to_string(data_root.path().join(SERVERS_FILE_NAME)).unwrap()
    }

    #[test]
    fn a_missing_file_is_an_empty_registry() {
        let (data_root, registry) = registry();
        assert_eq!(registry.read_all().unwrap(), Vec::new());
        assert!(!data_root.path().join(SERVERS_FILE_NAME).exists());
    }

    #[test]
    fn records_round_trip_through_the_file() {
        let (data_root, registry) = registry();
        registry.insert(wildflower_record("ruth")).unwrap();
        registry.insert(custom_record("lab")).unwrap();

        let reopened = JsonServerRegistry::in_data_root(data_root.path());
        assert_eq!(
            reopened.read_all().unwrap(),
            vec![wildflower_record("ruth"), custom_record("lab")]
        );
    }

    #[test]
    fn the_file_holds_the_token_in_full() {
        let (data_root, registry) = registry();
        registry.insert(wildflower_record("ruth")).unwrap();
        assert!(file_text(&data_root).contains(TOKEN));
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let (data_root, registry) = registry();
        registry.insert(wildflower_record("ruth")).unwrap();
        let metadata = fs::metadata(data_root.path().join(SERVERS_FILE_NAME)).unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn a_leftover_readable_temporary_file_is_narrowed_to_its_owner() {
        use std::os::unix::fs::PermissionsExt;

        let (data_root, registry) = registry();
        let temp_path = data_root.path().join(format!(".{SERVERS_FILE_NAME}.tmp"));
        fs::write(&temp_path, "").unwrap();
        fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o644)).unwrap();

        registry.insert(wildflower_record("ruth")).unwrap();

        let metadata = fs::metadata(data_root.path().join(SERVERS_FILE_NAME)).unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    }

    /// A version 1 `servers.json` holding `wildflower_record(tunnel_name)`,
    /// written by hand rather than by the adapter.
    fn version_1_file(tunnel_name: &str) -> String {
        format!(
            r#"{{
              "version": 1,
              "servers": [{{
                "relay": {{"kind": "wildflower"}},
                "tunnelName": "{tunnel_name}",
                "token": "{TOKEN}",
                "publicSettings": {{
                  "remoteAddr": "relay.wildflowerhealth.io:2333",
                  "transport": "noise",
                  "noisePattern": "Noise_NK_25519_ChaChaPoly_BLAKE2s",
                  "publicKey": "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=",
                  "domain": "relay.wildflowerhealth.io"
                }},
                "launcherUrl": "https://wildflowerhealth.io/app",
                "stagingCertificates": false
              }}]
            }}"#
        )
    }

    #[test]
    fn reads_the_version_1_format() {
        let (data_root, registry) = registry();
        fs::write(
            data_root.path().join(SERVERS_FILE_NAME),
            version_1_file("ruth"),
        )
        .unwrap();
        assert_eq!(
            registry.read_all().unwrap(),
            vec![wildflower_record("ruth")]
        );
    }

    #[test]
    fn writes_the_version_1_format() {
        let (data_root, registry) = registry();
        registry.insert(wildflower_record("ruth")).unwrap();
        let written: serde_json::Value = serde_json::from_str(&file_text(&data_root)).unwrap();
        let by_hand: serde_json::Value = serde_json::from_str(&version_1_file("ruth")).unwrap();
        assert_eq!(written, by_hand);
    }

    #[test]
    fn a_snake_case_file_is_refused() {
        let (data_root, registry) = registry();
        let snake_case = version_1_file("ruth")
            .replace("tunnelName", "tunnel_name")
            .replace("publicSettings", "public_settings");
        fs::write(data_root.path().join(SERVERS_FILE_NAME), snake_case).unwrap();
        assert!(matches!(
            registry.read_all(),
            Err(RegistryError::Storage { .. })
        ));
    }

    #[test]
    fn a_manual_relay_round_trips_with_no_settings_of_its_own() {
        let (data_root, registry) = registry();
        let mut manual = custom_record("lab");
        manual.relay = Relay::Manual;
        registry.insert(manual.clone()).unwrap();
        let written: serde_json::Value = serde_json::from_str(&file_text(&data_root)).unwrap();
        assert_eq!(
            written["servers"][0]["relay"],
            serde_json::json!({"kind": "manual"})
        );
        assert_eq!(registry.read_all().unwrap(), vec![manual]);
    }

    /// The tunnel name becomes the server's folder name, so one read from the
    /// file is checked as strictly as one entered by hand.
    #[test]
    fn a_stored_tunnel_name_that_is_not_a_dns_label_is_refused() {
        let (data_root, registry) = registry();
        for tunnel_name in ["Ruth", "ru.th", "..", "admin"] {
            fs::write(
                data_root.path().join(SERVERS_FILE_NAME),
                version_1_file(tunnel_name),
            )
            .unwrap();
            assert!(
                matches!(registry.read_all(), Err(RegistryError::Storage { .. })),
                "{tunnel_name}"
            );
        }
    }

    #[test]
    fn an_unknown_version_is_rejected_and_left_in_place() {
        let (data_root, registry) = registry();
        let future = r#"{"version": 2, "servers": [], "profiles": []}"#;
        fs::write(data_root.path().join(SERVERS_FILE_NAME), future).unwrap();

        assert!(matches!(
            registry.read_all(),
            Err(RegistryError::UnsupportedVersion { version: 2 })
        ));
        assert!(matches!(
            registry.insert(wildflower_record("ruth")),
            Err(RegistryError::UnsupportedVersion { version: 2 })
        ));
        assert_eq!(file_text(&data_root), future);
    }

    #[test]
    fn a_crash_before_the_rename_leaves_the_previous_file() {
        let (data_root, registry) = registry();
        registry.insert(wildflower_record("ruth")).unwrap();
        let before = file_text(&data_root);

        let staged = registry
            .stage(&RegistryDocument::from_records(&[custom_record("lab")]))
            .unwrap();
        assert!(staged.temp_path.exists());
        // The process dies here: the staged file is never committed.
        drop(staged);

        assert_eq!(file_text(&data_root), before);
        assert_eq!(
            registry.read_all().unwrap(),
            vec![wildflower_record("ruth")]
        );

        // The next change writes over the leftover temporary file.
        registry.insert(custom_record("lab")).unwrap();
        assert_eq!(
            registry.read_all().unwrap(),
            vec![wildflower_record("ruth"), custom_record("lab")]
        );
    }

    #[test]
    fn a_committed_stage_replaces_the_file() {
        let (data_root, registry) = registry();
        registry.insert(wildflower_record("ruth")).unwrap();

        let staged = registry
            .stage(&RegistryDocument::from_records(&[custom_record("lab")]))
            .unwrap();
        let temp_path = staged.temp_path.clone();
        staged.commit().unwrap();

        assert!(!temp_path.exists());
        assert_eq!(registry.read_all().unwrap(), vec![custom_record("lab")]);
        assert!(!file_text(&data_root).contains("ruth"));
    }

    #[test]
    fn inserting_a_registered_domain_is_refused() {
        let (_data_root, registry) = registry();
        registry.insert(wildflower_record("ruth")).unwrap();
        let mut same_domain = wildflower_record("ruth");
        same_domain.staging_certificates = true;

        assert!(matches!(
            registry.insert(same_domain),
            Err(RegistryError::AlreadyRegistered { domain }) if domain == "ruth.relay.wildflowerhealth.io"
        ));
        assert_eq!(
            registry.read_all().unwrap(),
            vec![wildflower_record("ruth")]
        );
    }

    #[test]
    fn update_replaces_the_record_with_the_same_domain() {
        let (_data_root, registry) = registry();
        registry.insert(wildflower_record("ruth")).unwrap();
        registry.insert(custom_record("lab")).unwrap();
        let mut updated = wildflower_record("ruth");
        updated.staging_certificates = true;
        updated.launcher_url = Url::parse("http://localhost:5200/").unwrap();

        registry.update(updated.clone()).unwrap();

        assert_eq!(
            registry.read_all().unwrap(),
            vec![updated, custom_record("lab")]
        );
    }

    #[test]
    fn update_of_an_unregistered_domain_is_refused() {
        let (_data_root, registry) = registry();
        assert!(matches!(
            registry.update(wildflower_record("ruth")),
            Err(RegistryError::NotRegistered { domain }) if domain == "ruth.relay.wildflowerhealth.io"
        ));
        assert_eq!(registry.read_all().unwrap(), Vec::new());
    }

    #[test]
    fn remove_drops_only_the_named_server() {
        let (_data_root, registry) = registry();
        registry.insert(wildflower_record("ruth")).unwrap();
        registry.insert(custom_record("lab")).unwrap();

        registry.remove("ruth.relay.wildflowerhealth.io").unwrap();

        assert_eq!(registry.read_all().unwrap(), vec![custom_record("lab")]);
        assert!(matches!(
            registry.remove("ruth.relay.wildflowerhealth.io"),
            Err(RegistryError::NotRegistered { .. })
        ));
    }
}
