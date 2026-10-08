//! A server's certificate history: every certificate its runs deployed, in
//! the order they first did, kept in `history.json` in its `certificates/`
//! folder beside rustls-acme's cache, so deleting the server deletes it.
//!
//! The file is a JSON array of [`CertificateHistoryEntry`]s. Each change
//! writes the whole array to `.history.json.tmp` beside it and fsyncs it,
//! then renames it over `history.json` and fsyncs the folder, as
//! `servers.json` is replaced: a crash before the rename leaves the previous
//! file whole.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;

use crate::CertificateHistoryEntry;

/// The history's file name in a server's `certificates/` folder.
const HISTORY_FILE_NAME: &str = "history.json";

/// The certificates the server whose certificates are cached in
/// `certificate_dir` has deployed, oldest first; none when it has no history
/// yet.
///
/// # Errors
///
/// Returns an error if the file exists but can't be read, or isn't a
/// history.
pub fn read_certificate_history(
    certificate_dir: &Path,
) -> io::Result<Vec<CertificateHistoryEntry>> {
    match fs::read(certificate_dir.join(HISTORY_FILE_NAME)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::from),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

/// Append `entry` to the history in `certificate_dir`, unless it records the
/// certificate already. Answers whether it was appended.
///
/// # Errors
///
/// Returns an error if the history can't be read or replaced; it is left as
/// it was.
pub(crate) fn record_in_certificate_history(
    certificate_dir: &Path,
    entry: CertificateHistoryEntry,
) -> io::Result<bool> {
    let mut history = read_certificate_history(certificate_dir)?;
    if !entry.is_new_to(&history) {
        return Ok(false);
    }
    history.push(entry);
    let bytes = serde_json::to_vec_pretty(&history)?;
    let temp_path = certificate_dir.join(format!(".{HISTORY_FILE_NAME}.tmp"));
    let written = File::create(&temp_path).and_then(|mut file| {
        file.write_all(&bytes)?;
        file.sync_all()
    });
    if let Err(error) =
        written.and_then(|()| fs::rename(&temp_path, certificate_dir.join(HISTORY_FILE_NAME)))
    {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    sync_directory(certificate_dir)?;
    Ok(true)
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

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;
    use crate::CertificateAuthority;

    fn entry(fingerprint: &str, day: u32) -> CertificateHistoryEntry {
        CertificateHistoryEntry {
            deployed_at: Utc.with_ymd_and_hms(2026, 1, day, 0, 0, 0).unwrap(),
            issuer: CertificateAuthority::LetsEncryptStaging,
            fingerprint: fingerprint.to_owned(),
            not_before: Utc.with_ymd_and_hms(2026, 1, day, 0, 0, 0).unwrap(),
            not_after: Utc.with_ymd_and_hms(2026, 4, day, 0, 0, 0).unwrap(),
        }
    }

    #[test]
    fn a_server_with_no_history_file_has_deployed_nothing() {
        let certificate_dir = tempfile::tempdir().unwrap();
        assert!(read_certificate_history(certificate_dir.path())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn each_new_certificate_is_appended_once() {
        let certificate_dir = tempfile::tempdir().unwrap();
        let dir = certificate_dir.path();

        assert!(record_in_certificate_history(dir, entry("a", 1)).unwrap());
        assert!(
            !record_in_certificate_history(dir, entry("a", 2)).unwrap(),
            "deploying the cached certificate again at the next start"
        );
        assert!(record_in_certificate_history(dir, entry("b", 3)).unwrap());
        assert!(
            !record_in_certificate_history(dir, entry("a", 4)).unwrap(),
            "deploying the cached certificate again after its successor's store failed"
        );

        assert_eq!(
            read_certificate_history(dir).unwrap(),
            vec![entry("a", 1), entry("b", 3)]
        );
        assert!(!dir.join(".history.json.tmp").exists());
    }

    #[test]
    fn the_history_is_written_camel_case() {
        let certificate_dir = tempfile::tempdir().unwrap();
        record_in_certificate_history(certificate_dir.path(), entry("a", 1)).unwrap();
        let written: serde_json::Value = serde_json::from_slice(
            &fs::read(certificate_dir.path().join(HISTORY_FILE_NAME)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            written,
            serde_json::json!([{
                "deployedAt": "2026-01-01T00:00:00Z",
                "issuer": "letsEncryptStaging",
                "fingerprint": "a",
                "notBefore": "2026-01-01T00:00:00Z",
                "notAfter": "2026-04-01T00:00:00Z",
            }])
        );
    }
}
