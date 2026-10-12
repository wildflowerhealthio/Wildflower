//! Where recordings are saved: `Wildflower Recordings`, in a folder the user
//! can browse and the Importer's file picker can reach.
//!
//! The choice is a pure function of the platform and the directories it
//! resolves, so it is tested here; `recorder-tauri` resolves the directories
//! through Tauri's path API and creates the folder.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The recordings folder's name, inside the platform's base directory.
pub const RECORDINGS_DIR_NAME: &str = "Wildflower Recordings";

/// The platforms whose recordings folder differs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    /// macOS, Windows and Linux.
    Desktop,
    Android,
    Ios,
}

impl Platform {
    /// The platform this build runs on.
    pub const CURRENT: Platform = if cfg!(target_os = "ios") {
        Platform::Ios
    } else if cfg!(target_os = "android") {
        Platform::Android
    } else {
        Platform::Desktop
    };

    /// Where this platform's recordings folder may go, the first choice first.
    ///
    /// - Desktop: the user's Documents folder.
    /// - Android: the shared Documents folder, which the Files app and the
    ///   system file picker show, and which the app can write any file into
    ///   without a storage permission from Android 11 on. On an older Android,
    ///   where it can't, the app's own Documents folder in its external
    ///   storage, which a computer sees over USB.
    /// - iOS: the app's Documents folder, which the Files app shows under the
    ///   app's name (the bundle sets `UIFileSharingEnabled` and
    ///   `LSSupportsOpeningDocumentsInPlace`).
    pub fn recordings_locations(self) -> &'static [RecordingsLocation] {
        match self {
            Platform::Desktop => &[RecordingsLocation::UserDocuments],
            Platform::Android => &[
                RecordingsLocation::SharedDocuments,
                RecordingsLocation::AppExternalDocuments,
            ],
            Platform::Ios => &[RecordingsLocation::AppDocuments],
        }
    }

    /// Whether the platform's file manager can show a saved file selected in
    /// its folder. Only the desktop ones can.
    pub fn reveals_files(self) -> bool {
        matches!(self, Platform::Desktop)
    }
}

/// A place the recordings folder can go, named for the directory it sits in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordingsLocation {
    /// The user's Documents folder: Tauri's `document_dir` on the desktop.
    UserDocuments,
    /// Android's shared `Documents` folder, in the shared-storage root that
    /// Tauri's `home_dir` resolves to there.
    SharedDocuments,
    /// The app's own Documents folder in its external storage,
    /// `Android/data/<package>/files/Documents`: Tauri's `document_dir` on
    /// Android.
    AppExternalDocuments,
    /// The app's Documents folder: Tauri's `document_dir` on iOS.
    AppDocuments,
}

impl RecordingsLocation {
    /// The recordings folder at this location, given the directory Tauri
    /// resolves for it.
    pub fn recordings_dir(self, resolved_dir: &Path) -> PathBuf {
        match self {
            RecordingsLocation::SharedDocuments => {
                resolved_dir.join("Documents").join(RECORDINGS_DIR_NAME)
            }
            RecordingsLocation::UserDocuments
            | RecordingsLocation::AppExternalDocuments
            | RecordingsLocation::AppDocuments => resolved_dir.join(RECORDINGS_DIR_NAME),
        }
    }
}

/// The recordings folder as the Recorder page shows it: `recorder_save_folder`'s
/// answer.
///
/// Wire: `{"path":"/…/Wildflower Recordings","revealsFiles":true}`, pinned by
/// `recorder-wire-golden.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFolder {
    /// The folder's absolute path.
    pub path: String,
    /// Whether the page can offer Show file: [`Platform::reveals_files`].
    pub reveals_files: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The folder each platform saves to by default, from the directories its
    /// first location resolves to.
    fn first_choice(platform: Platform, resolved_dir: &str) -> PathBuf {
        platform.recordings_locations()[0].recordings_dir(Path::new(resolved_dir))
    }

    #[test]
    fn the_desktop_saves_to_documents() {
        assert_eq!(
            first_choice(Platform::Desktop, "/home/ada/Documents"),
            PathBuf::from("/home/ada/Documents/Wildflower Recordings")
        );
        assert_eq!(
            Platform::Desktop.recordings_locations(),
            [RecordingsLocation::UserDocuments]
        );
    }

    #[test]
    fn android_saves_to_the_shared_documents_then_its_own() {
        assert_eq!(
            first_choice(Platform::Android, "/storage/emulated/0"),
            PathBuf::from("/storage/emulated/0/Documents/Wildflower Recordings")
        );
        let fallback = Platform::Android.recordings_locations()[1];
        assert_eq!(
            fallback.recordings_dir(Path::new(
                "/storage/emulated/0/Android/data/io.wildflowerhealth.hostapp/files/Documents"
            )),
            PathBuf::from(
                "/storage/emulated/0/Android/data/io.wildflowerhealth.hostapp/files/Documents/Wildflower Recordings"
            )
        );
        assert_eq!(Platform::Android.recordings_locations().len(), 2);
    }

    #[test]
    fn ios_saves_to_the_app_documents() {
        assert_eq!(
            first_choice(
                Platform::Ios,
                "/var/mobile/Containers/Data/Application/ABC/Documents"
            ),
            PathBuf::from(
                "/var/mobile/Containers/Data/Application/ABC/Documents/Wildflower Recordings"
            )
        );
        assert_eq!(
            Platform::Ios.recordings_locations(),
            [RecordingsLocation::AppDocuments]
        );
    }

    #[test]
    fn only_the_desktop_reveals_files() {
        assert!(Platform::Desktop.reveals_files());
        assert!(!Platform::Android.reveals_files());
        assert!(!Platform::Ios.reveals_files());
    }

    /// The page decodes the same golden answer, so the two can't drift.
    #[test]
    fn the_save_folder_matches_the_golden_file() {
        let golden: Value =
            serde_json::from_str(include_str!("../../recorder-wire-golden.json")).expect("golden");
        let answer = &golden["commands"]["recorder_save_folder"];
        let decoded: SaveFolder =
            serde_json::from_value(answer.clone()).expect("SaveFolder decodes");
        assert_eq!(serde_json::to_value(&decoded).expect("serialize"), *answer);
    }
}
