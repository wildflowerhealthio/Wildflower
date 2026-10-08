//! [`JsonServerRegistry`]: the [`ServerRegistry`] kept in
//! `<data root>/servers.json`.
//!
//! The file is `{"version": 2, "servers": [...]}`, each server's fields in
//! camelCase. Its version is read before anything else. A version 1 file is
//! migrated as it is read (see [`migrate_version_1`]) and written as version
//! 2 by the next change; any other version but [`FORMAT_VERSION`] is
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
use rathole_settings_rust::{
    NoisePattern, PublicRatholeSettings, RelayDomain, Transport, TunnelName,
};
use serde::{Deserialize, Serialize};
use unit_runner::RunPolicy;
use url::Url;

use crate::domain::{CertificateAuthority, RegistryError, RelayKind, ServerRecord, TunnelToken};
use crate::ports::{NewRecord, RegistryChange, ServerRegistry};

/// The registry's file name in the data root.
pub const SERVERS_FILE_NAME: &str = "servers.json";

/// The `servers.json` format version this build writes. It reads this and
/// version 1.
const FORMAT_VERSION: u64 = 2;

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
        let parse_error = |error| RegistryError::storage("parsing servers.json", error);
        match version {
            FORMAT_VERSION => serde_json::from_slice(&bytes).map_err(parse_error),
            1 => {
                let version_1 = serde_json::from_slice(&bytes).map_err(parse_error)?;
                serde_json::from_value(migrate_version_1(version_1)?).map_err(parse_error)
            }
            version => Err(RegistryError::UnsupportedVersion { version }),
        }
    }

    /// Read the registry, apply `change` to its servers, and replace the file
    /// with the result. Returns what `change` returns.
    fn change_servers<T>(
        &self,
        change: impl FnOnce(&mut Vec<ServerRecord>) -> Result<T, RegistryError>,
    ) -> Result<T, RegistryError> {
        let _guard = self.write_lock.lock();
        let mut servers = self.read_document()?.into_records();
        let changed = change(&mut servers)?;
        self.stage(&RegistryDocument::from_records(&servers))?
            .commit()?;
        Ok(changed)
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

    fn insert(&self, new_record: NewRecord<'_>) -> Result<ServerRecord, RegistryError> {
        self.change_servers(|servers| {
            let record = new_record(servers);
            let domain = record.domain();
            if servers.iter().any(|server| server.domain() == domain) {
                return Err(RegistryError::AlreadyRegistered { domain });
            }
            servers.push(record.clone());
            Ok(record)
        })
    }

    fn modify(&self, change: RegistryChange<'_>) -> Result<(), RegistryError> {
        self.change_servers(|servers| change(servers))
    }

    fn remove(&self, domain: &str) -> Result<(), RegistryError> {
        self.change_servers(|servers| {
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

/// A version 1 `servers.json` `document` as version 2. Version 1 stored
/// whether a server's certificates came from Let's Encrypt's staging CA as
/// `stagingCertificates`; each becomes the server's `certificateAuthority`,
/// `true` [`CertificateAuthority::LetsEncryptStaging`] and `false`
/// [`CertificateAuthority::LetsEncrypt`], so every server keeps its CA.
/// Nothing else changed.
///
/// # Errors
///
/// [`RegistryError::Storage`] if the document has no list of servers, or a
/// server has no boolean `stagingCertificates`.
fn migrate_version_1(mut document: serde_json::Value) -> Result<serde_json::Value, RegistryError> {
    const CONTEXT: &str = "migrating servers.json from version 1";
    let servers = document
        .get_mut("servers")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| RegistryError::storage(CONTEXT, "it has no list of servers"))?;
    for server in servers {
        let staging_certificates = server
            .as_object_mut()
            .and_then(|server| server.remove("stagingCertificates"))
            .and_then(|staging_certificates| staging_certificates.as_bool())
            .ok_or_else(|| {
                RegistryError::storage(CONTEXT, "a server has no boolean stagingCertificates")
            })?;
        let certificate_authority = if staging_certificates {
            CertificateAuthority::LetsEncryptStaging
        } else {
            CertificateAuthority::LetsEncrypt
        };
        server["certificateAuthority"] = serde_json::to_value(certificate_authority)
            .map_err(|error| RegistryError::storage(CONTEXT, error))?;
    }
    document["version"] = FORMAT_VERSION.into();
    Ok(document)
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
            servers: records.iter().cloned().map(StoredServer).collect(),
        }
    }

    fn into_records(self) -> Vec<ServerRecord> {
        self.servers.into_iter().map(|server| server.0).collect()
    }
}

/// A [`ServerRecord`] as `servers.json` stores it: the one place its token
/// is written in full.
#[derive(Serialize, Deserialize)]
#[serde(transparent)]
struct StoredServer(#[serde(with = "StoredServerFields")] ServerRecord);

/// [`ServerRecord`]'s fields as `servers.json` names them, in camelCase,
/// with the token in full. A `remote` mirror rather than serde attributes on
/// the record itself, so the record's own `Serialize` keeps redacting the
/// token; the compiler checks the fields match the record's.
#[derive(Serialize, Deserialize)]
#[serde(remote = "ServerRecord", rename_all = "camelCase", deny_unknown_fields)]
struct StoredServerFields {
    relay: RelayKind,
    tunnel_name: TunnelName,
    #[serde(with = "exposed_token")]
    token: TunnelToken,
    #[serde(with = "StoredPublicSettings")]
    public_settings: PublicRatholeSettings,
    launcher_url: Url,
    certificate_authority: CertificateAuthority,
    run_policy: RunPolicy,
}

/// [`PublicRatholeSettings`]' fields as `servers.json` names them, in
/// camelCase. A `remote` mirror because the type itself is the relay's
/// `GET /rathole` wire shape, which is snake_case and served by the relay;
/// the compiler checks the fields match it. Reading decodes the domain as a
/// [`RelayDomain`], since it ends the server's folder name, so a file whose
/// domain could walk out of `servers/` is refused, as one with a bad tunnel
/// name is.
#[derive(Serialize, Deserialize)]
#[serde(
    remote = "PublicRatholeSettings",
    rename_all = "camelCase",
    deny_unknown_fields
)]
struct StoredPublicSettings {
    remote_addr: String,
    transport: Transport,
    noise_pattern: NoisePattern,
    public_key: String,
    #[serde(deserialize_with = "relay_domain")]
    domain: String,
}

/// A stored domain, decoded as a [`RelayDomain`].
fn relay_domain<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    RelayDomain::deserialize(deserializer).map(String::from)
}

/// The token as `servers.json` holds it: in full, unlike its own
/// `Serialize`.
mod exposed_token {
    use serde::{Deserialize, Deserializer, Serializer};

    use crate::domain::TunnelToken;

    pub(super) fn serialize<S: Serializer>(
        token: &TunnelToken,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(token.expose())
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<TunnelToken, D::Error> {
        String::deserialize(deserializer).map(TunnelToken::new)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::fixtures::{official_record, self_hosted_record, TOKEN};

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
        registry
            .insert(Box::new(|_| official_record("ruth")))
            .unwrap();
        registry
            .insert(Box::new(|_| self_hosted_record("lab")))
            .unwrap();

        let reopened = JsonServerRegistry::in_data_root(data_root.path());
        assert_eq!(
            reopened.read_all().unwrap(),
            vec![official_record("ruth"), self_hosted_record("lab")]
        );
    }

    #[test]
    fn the_file_holds_the_token_in_full() {
        let (data_root, registry) = registry();
        registry
            .insert(Box::new(|_| official_record("ruth")))
            .unwrap();
        assert!(file_text(&data_root).contains(TOKEN));
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let (data_root, registry) = registry();
        registry
            .insert(Box::new(|_| official_record("ruth")))
            .unwrap();
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

        registry
            .insert(Box::new(|_| official_record("ruth")))
            .unwrap();

        let metadata = fs::metadata(data_root.path().join(SERVERS_FILE_NAME)).unwrap();
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    }

    /// A version 2 `servers.json` holding `official_record(tunnel_name)`,
    /// written by hand rather than by the adapter.
    fn version_2_file(tunnel_name: &str) -> String {
        format!(
            r#"{{
              "version": 2,
              "servers": [{{
                "relay": {{"kind": "wildflowerOfficial"}},
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
                "certificateAuthority": "letsEncrypt",
                "runPolicy": {{"kind": "off"}}
              }}]
            }}"#
        )
    }

    /// A version 1 `servers.json` holding `official_record("ruth")`, its CA
    /// stored as version 1 stores it, as `stagingCertificates`.
    fn version_1_file(staging_certificates: bool) -> String {
        format!(
            r#"{{
              "version": 1,
              "servers": [{{
                "relay": {{"kind": "wildflowerOfficial"}},
                "tunnelName": "ruth",
                "token": "{TOKEN}",
                "publicSettings": {{
                  "remoteAddr": "relay.wildflowerhealth.io:2333",
                  "transport": "noise",
                  "noisePattern": "Noise_NK_25519_ChaChaPoly_BLAKE2s",
                  "publicKey": "24cva5FBfzidZjaSQl4dyqGfuzDspKWe+koxXAVIQkM=",
                  "domain": "relay.wildflowerhealth.io"
                }},
                "launcherUrl": "https://wildflowerhealth.io/app",
                "stagingCertificates": {staging_certificates},
                "runPolicy": {{"kind": "off"}}
              }}]
            }}"#
        )
    }

    #[test]
    fn reads_the_version_2_format() {
        let (data_root, registry) = registry();
        fs::write(
            data_root.path().join(SERVERS_FILE_NAME),
            version_2_file("ruth"),
        )
        .unwrap();
        assert_eq!(registry.read_all().unwrap(), vec![official_record("ruth")]);
    }

    #[test]
    fn writes_the_version_2_format() {
        let (data_root, registry) = registry();
        registry
            .insert(Box::new(|_| official_record("ruth")))
            .unwrap();
        let written: serde_json::Value = serde_json::from_str(&file_text(&data_root)).unwrap();
        let by_hand: serde_json::Value = serde_json::from_str(&version_2_file("ruth")).unwrap();
        assert_eq!(written, by_hand);
    }

    /// Each server in a version 1 file keeps the CA its `stagingCertificates`
    /// named; reading leaves the file as it was.
    #[test]
    fn a_version_1_file_is_read_with_each_server_s_certificate_authority() {
        let (data_root, registry) = registry();
        for (staging_certificates, certificate_authority) in [
            (true, CertificateAuthority::LetsEncryptStaging),
            (false, CertificateAuthority::LetsEncrypt),
        ] {
            let version_1 = version_1_file(staging_certificates);
            fs::write(data_root.path().join(SERVERS_FILE_NAME), &version_1).unwrap();

            assert_eq!(
                registry.read_all().unwrap(),
                vec![ServerRecord {
                    certificate_authority,
                    ..official_record("ruth")
                }],
                "stagingCertificates: {staging_certificates}"
            );
            assert_eq!(file_text(&data_root), version_1);
        }
    }

    /// The next change to a version 1 file writes it as version 2.
    #[test]
    fn a_version_1_file_is_written_as_version_2_by_the_next_change() {
        let (data_root, registry) = registry();
        fs::write(
            data_root.path().join(SERVERS_FILE_NAME),
            version_1_file(false),
        )
        .unwrap();

        registry.modify(Box::new(|_| Ok(()))).unwrap();

        let written: serde_json::Value = serde_json::from_str(&file_text(&data_root)).unwrap();
        let version_2: serde_json::Value = serde_json::from_str(&version_2_file("ruth")).unwrap();
        assert_eq!(written, version_2);
    }

    #[test]
    fn a_version_1_server_with_no_staging_flag_is_refused() {
        let (data_root, registry) = registry();
        for staging_certificates in [r#""stagingCertificates": "yes","#, ""] {
            let file = version_1_file(false)
                .replace(r#""stagingCertificates": false,"#, staging_certificates);
            assert_ne!(file, version_1_file(false));
            fs::write(data_root.path().join(SERVERS_FILE_NAME), file).unwrap();
            assert!(
                matches!(registry.read_all(), Err(RegistryError::Storage { .. })),
                "{staging_certificates:?}"
            );
        }
    }

    #[test]
    fn a_snake_case_file_is_refused() {
        let (data_root, registry) = registry();
        let snake_case = version_2_file("ruth")
            .replace("tunnelName", "tunnel_name")
            .replace("publicSettings", "public_settings");
        fs::write(data_root.path().join(SERVERS_FILE_NAME), snake_case).unwrap();
        assert!(matches!(
            registry.read_all(),
            Err(RegistryError::Storage { .. })
        ));
    }

    #[test]
    fn a_rathole_relay_round_trips_with_no_settings_of_its_own() {
        let (data_root, registry) = registry();
        let mut rathole = self_hosted_record("lab");
        rathole.relay = RelayKind::Rathole;
        registry.insert(Box::new(|_| rathole.clone())).unwrap();
        let written: serde_json::Value = serde_json::from_str(&file_text(&data_root)).unwrap();
        assert_eq!(
            written["servers"][0]["relay"],
            serde_json::json!({"kind": "rathole"})
        );
        assert_eq!(registry.read_all().unwrap(), vec![rathole]);
    }

    #[test]
    fn a_new_record_is_built_from_the_servers_registered_and_returned() {
        let (_data_root, registry) = registry();
        registry
            .insert(Box::new(|_| official_record("ruth")))
            .unwrap();
        let inserted = registry
            .insert(Box::new(|registered| {
                assert_eq!(registered, [official_record("ruth")]);
                self_hosted_record("lab")
            }))
            .unwrap();
        assert_eq!(inserted, self_hosted_record("lab"));
        assert_eq!(
            registry.read_all().unwrap(),
            vec![official_record("ruth"), self_hosted_record("lab")]
        );
    }

    #[test]
    fn each_server_s_run_policy_round_trips_through_the_file() {
        use chrono::TimeZone;

        let (data_root, registry) = registry();
        let until = RunPolicy::Until {
            at: chrono::Utc
                .with_ymd_and_hms(2026, 10, 6, 17, 42, 0)
                .unwrap(),
        };
        let records: Vec<ServerRecord> = [
            ("ruth", until),
            ("lab", RunPolicy::Off),
            ("demo", RunPolicy::WhileOpen),
            ("clinic", RunPolicy::Always),
        ]
        .into_iter()
        .map(|(tunnel_name, run_policy)| ServerRecord {
            run_policy,
            ..official_record(tunnel_name)
        })
        .collect();
        for record in &records {
            registry.insert(Box::new(|_| record.clone())).unwrap();
        }

        let written: serde_json::Value = serde_json::from_str(&file_text(&data_root)).unwrap();
        let written_policies: Vec<&serde_json::Value> = written["servers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|server| &server["runPolicy"])
            .collect();
        assert_eq!(
            written_policies,
            [
                &serde_json::json!({"kind": "until", "at": "2026-10-06T17:42:00Z"}),
                &serde_json::json!({"kind": "off"}),
                &serde_json::json!({"kind": "whileOpen"}),
                &serde_json::json!({"kind": "always"}),
            ]
        );
        assert_eq!(
            JsonServerRegistry::in_data_root(data_root.path())
                .read_all()
                .unwrap(),
            records
        );
    }

    /// The tunnel name becomes the server's folder name, so one read from the
    /// file is checked as strictly as one entered by hand.
    #[test]
    fn a_stored_tunnel_name_that_is_not_a_dns_label_is_refused() {
        let (data_root, registry) = registry();
        for tunnel_name in ["Ruth", "ru.th", "..", "admin"] {
            fs::write(
                data_root.path().join(SERVERS_FILE_NAME),
                version_2_file(tunnel_name),
            )
            .unwrap();
            assert!(
                matches!(registry.read_all(), Err(RegistryError::Storage { .. })),
                "{tunnel_name}"
            );
        }
    }

    /// The relay domain ends the server's folder name too, so a stored one
    /// that could walk out of `servers/` is refused.
    #[test]
    fn a_stored_domain_that_is_not_a_dns_name_is_refused() {
        let (data_root, registry) = registry();
        for domain in ["x/../../..", "..", "Relay.example.com", ""] {
            let file = version_2_file("ruth").replace(
                r#""domain": "relay.wildflowerhealth.io""#,
                &format!(r#""domain": "{domain}""#),
            );
            assert_ne!(file, version_2_file("ruth"));
            fs::write(data_root.path().join(SERVERS_FILE_NAME), file).unwrap();
            assert!(
                matches!(registry.read_all(), Err(RegistryError::Storage { .. })),
                "{domain:?}"
            );
        }
    }

    /// The stored settings are `PublicRatholeSettings`' own fields, renamed
    /// to camelCase, and read back as they were.
    #[test]
    fn stored_settings_are_the_rathole_settings_in_camel_case() {
        #[derive(Serialize, Deserialize)]
        #[serde(transparent)]
        struct Stored(#[serde(with = "StoredPublicSettings")] PublicRatholeSettings);

        let public_settings = official_record("ruth").public_settings;
        let stored = serde_json::to_value(Stored(public_settings.clone())).unwrap();
        let wire = serde_json::to_value(&public_settings).unwrap();
        let camel_case = |snake_case: &str| {
            let mut parts = snake_case.split('_');
            let first = parts.next().unwrap().to_owned();
            parts.fold(first, |name, part| {
                name + &part[..1].to_uppercase() + &part[1..]
            })
        };
        let renamed: serde_json::Map<String, serde_json::Value> = wire
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, value)| (camel_case(name), value.clone()))
            .collect();
        assert_eq!(stored, serde_json::Value::Object(renamed));
        assert_eq!(
            serde_json::from_value::<Stored>(stored).unwrap().0,
            public_settings
        );
    }

    #[test]
    fn an_unknown_version_is_rejected_and_left_in_place() {
        let (data_root, registry) = registry();
        let future = r#"{"version": 3, "servers": [], "profiles": []}"#;
        fs::write(data_root.path().join(SERVERS_FILE_NAME), future).unwrap();

        assert!(matches!(
            registry.read_all(),
            Err(RegistryError::UnsupportedVersion { version: 3 })
        ));
        assert!(matches!(
            registry.insert(Box::new(|_| official_record("ruth"))),
            Err(RegistryError::UnsupportedVersion { version: 3 })
        ));
        assert_eq!(file_text(&data_root), future);
    }

    #[test]
    fn a_crash_before_the_rename_leaves_the_previous_file() {
        let (data_root, registry) = registry();
        registry
            .insert(Box::new(|_| official_record("ruth")))
            .unwrap();
        let before = file_text(&data_root);

        let staged = registry
            .stage(&RegistryDocument::from_records(&[self_hosted_record(
                "lab",
            )]))
            .unwrap();
        assert!(staged.temp_path.exists());
        // The process dies here: the staged file is never committed.
        drop(staged);

        assert_eq!(file_text(&data_root), before);
        assert_eq!(registry.read_all().unwrap(), vec![official_record("ruth")]);

        // The next change writes over the leftover temporary file.
        registry
            .insert(Box::new(|_| self_hosted_record("lab")))
            .unwrap();
        assert_eq!(
            registry.read_all().unwrap(),
            vec![official_record("ruth"), self_hosted_record("lab")]
        );
    }

    #[test]
    fn a_committed_stage_replaces_the_file() {
        let (data_root, registry) = registry();
        registry
            .insert(Box::new(|_| official_record("ruth")))
            .unwrap();

        let staged = registry
            .stage(&RegistryDocument::from_records(&[self_hosted_record(
                "lab",
            )]))
            .unwrap();
        let temp_path = staged.temp_path.clone();
        staged.commit().unwrap();

        assert!(!temp_path.exists());
        assert_eq!(
            registry.read_all().unwrap(),
            vec![self_hosted_record("lab")]
        );
        assert!(!file_text(&data_root).contains("ruth"));
    }

    #[test]
    fn inserting_a_registered_domain_is_refused() {
        let (_data_root, registry) = registry();
        registry
            .insert(Box::new(|_| official_record("ruth")))
            .unwrap();
        let mut same_domain = official_record("ruth");
        same_domain.certificate_authority = CertificateAuthority::LetsEncryptStaging;

        assert!(matches!(
            registry.insert(Box::new(|_| same_domain)),
            Err(RegistryError::AlreadyRegistered { domain }) if domain == "ruth.relay.wildflowerhealth.io"
        ));
        assert_eq!(registry.read_all().unwrap(), vec![official_record("ruth")]);
    }

    #[test]
    fn modify_keeps_what_the_change_leaves() {
        let (_data_root, registry) = registry();
        registry
            .insert(Box::new(|_| official_record("ruth")))
            .unwrap();
        registry
            .insert(Box::new(|_| self_hosted_record("lab")))
            .unwrap();
        let mut updated = official_record("ruth");
        updated.certificate_authority = CertificateAuthority::LetsEncryptStaging;
        updated.launcher_url = Url::parse("http://localhost:5200/").unwrap();

        registry
            .modify(Box::new(|servers| {
                servers[0].certificate_authority = CertificateAuthority::LetsEncryptStaging;
                servers[0].launcher_url = Url::parse("http://localhost:5200/").unwrap();
                Ok(())
            }))
            .unwrap();

        assert_eq!(
            registry.read_all().unwrap(),
            vec![updated, self_hosted_record("lab")]
        );
    }

    #[test]
    fn a_refused_modify_writes_nothing() {
        let (data_root, registry) = registry();
        registry
            .insert(Box::new(|_| official_record("ruth")))
            .unwrap();
        let before = file_text(&data_root);

        let refused = registry.modify(Box::new(|servers| {
            servers[0].certificate_authority = CertificateAuthority::LetsEncryptStaging;
            Err(RegistryError::NotRegistered {
                domain: "lab.relay.example.com".to_owned(),
            })
        }));

        assert!(matches!(refused, Err(RegistryError::NotRegistered { .. })));
        assert_eq!(file_text(&data_root), before);
    }

    #[test]
    fn remove_drops_only_the_named_server() {
        let (_data_root, registry) = registry();
        registry
            .insert(Box::new(|_| official_record("ruth")))
            .unwrap();
        registry
            .insert(Box::new(|_| self_hosted_record("lab")))
            .unwrap();

        registry.remove("ruth.relay.wildflowerhealth.io").unwrap();

        assert_eq!(
            registry.read_all().unwrap(),
            vec![self_hosted_record("lab")]
        );
        assert!(matches!(
            registry.remove("ruth.relay.wildflowerhealth.io"),
            Err(RegistryError::NotRegistered { .. })
        ));
    }
}
