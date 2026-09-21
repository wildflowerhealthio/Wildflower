# Data Directory Explanation

The host keeps everything it owns in one directory: both SQLite databases
(`wildflower.sqlite` and `health-data.sqlite`), saved HAR recordings under `saved_data/`,
uploaded and vendored self-hosted app bundles under `self-hosted-apps/`, and on
Android the materialized FHIR SearchParameter bundle under `fhir-search-params/`.
`setup()` in [`src-tauri/src/lib.rs`](./src-tauri/src/lib.rs) resolves that one
directory and threads it through `ServerRuntimeConfig.app_data_dir`; every slice
that needs a path joins onto it rather than resolving its own.

Where that directory lands is a per-platform decision, and on iOS it is a
deliberate one.

## Where it lands

| Platform             | Directory                                                                | Visible to the user?              |
| -------------------- | ------------------------------------------------------------------------ | --------------------------------- |
| iOS                  | `<container>/Documents`                                                  | yes — "On My iPhone → Wildflower" |
| macOS (Developer ID) | `~/Library/Application Support/<identifier>`                             | yes, via Finder's Go-to-Folder    |
| macOS (App Store)    | the same path inside `~/Library/Containers/<identifier>/Data/`           | same, one container deeper        |
| Windows / Linux      | Tauri's `app_data_dir()` — `{FOLDERID_RoamingAppData}`, `$XDG_DATA_HOME` | yes                               |
| Android              | `activity.dataDir` — `/data/user/0/<package>`                            | no — app-private internal storage |

Everything but iOS takes Tauri's `app_data_dir()` unchanged. The macOS App Store
row is not a choice we made — the App Sandbox relocates it, which is why the
entitlements are confined to an overlay config rather than the default one (see
the [Apple Release Signing Explanation](../../docs/Rust/Apple%20Release%20Signing%20Explanation.md)).

## Why iOS uses `Documents`

Tauri's `app_data_dir()` on iOS resolves to
`<container>/Library/Application Support/<identifier>`, which iOS never exposes
to anything outside the app. `<container>/Documents` is the only part of an iOS
container the system will show, so pointing the data directory there is what
makes a **Wildflower** folder appear under "On My iPhone" in the Files app,
alongside the ones Pages, Preview and Firefox get. A user can copy a database
off the device, back it up, or drop a file in, without the app having to grow a
transfer feature for it.

Two things have to be true for that folder to appear, and neither works alone:

1. The data has to be in `Documents`. `resolve_data_dir` in `src-tauri/src/lib.rs`
   borrows the app handle and asks its path resolver for `document_dir()` on iOS,
   `app_data_dir()` everywhere else. The arm is chosen with `cfg`, so only the
   platform's own candidate is ever resolved — `document_dir()` fails outright on
   a desktop that has no such user directory, and a platform that never reads it
   must not be able to fail startup on it.
2. The bundle has to opt in, with `UIFileSharingEnabled` in the iOS `Info.plist`.
   Without the key, `Documents` is still where the data lives — it is simply
   invisible, and the change looks like it did nothing. A unit test
   (`both_ios_plists_declare_file_sharing`) holds the key in both plists, since
   losing it from either would quietly undo half the feature.

The key lives in [`src-tauri/Info.ios.plist`](./src-tauri/Info.ios.plist) rather
than only in the generated `gen/apple/wildflower-tauri_iOS/Info.plist`:
`tauri ios build` merges `Info.ios.plist` over the generated plist on every build
(last writer wins), so that copy survives a regenerated Xcode project. The
generated plist carries the key too — it is committed, and it is what an
Xcode-opened build of `gen/apple/wildflower-tauri.xcodeproj` reads directly,
without the merge step.

Nothing migrates. An install that already holds databases under
`Library/Application Support` keeps them there, untouched and unread, and comes
up with an empty `Documents` — worth knowing when a TestFlight build suddenly
looks like a fresh one.

The folder is named after the target's `PRODUCT_NAME` (`Wildflower`), not the
app's `productName` (`Wildflower Host`).

`UIFileSharingEnabled` exposes the directory; it does not make the app a document
browser. `LSSupportsOpeningDocumentsInPlace`, the key that lets _other_ apps edit
files there in place, is deliberately not set — nothing here is a document meant
to be edited by another app, and a live SQLite database least of all.

## Android is still private

Android keeps `app_data_dir()`, which is app-private internal storage and shows
up in no file browser. The analogous move would be `document_dir()`
(`getExternalFilesDir(DIRECTORY_DOCUMENTS)` →
`/sdcard/Android/data/<package>/files/Documents`), but Android 11+ blocks the
stock Files app and third-party file managers from `Android/data`, so that path
is browsable only over USB/MTP or `adb` — it would move the databases onto
FUSE-emulated external storage without actually making them visible on the
device. A folder the user can reach on-device needs a custom `DocumentsProvider`,
which is a separate piece of work.

## Related

- [Apple Release Signing Explanation](../../docs/Rust/Apple%20Release%20Signing%20Explanation.md) — the certificates, entitlements and sandbox behind the macOS/iOS builds
- [Shared Diesel Pool Explanation](../../docs/Persistence/Shared%20Diesel%20Pool%20Explanation.md) — what opens the databases this directory holds
