# Data Directory Explanation

The host keeps everything it owns under one directory, the data root:

```text
<data root>/
  servers.json            the install's servers
  saved_data/             saved HAR recordings, shared by every server
  fhir-search-params/     Android only: the materialized FHIR SearchParameter bundle
  servers/<domain>/       one folder per server, named by its domain
    wildflower.sqlite
    health-data.sqlite
```

What belongs to the install sits in the data root, and the install's ACME
account joins it with #893. What belongs to one server sits in that server's
folder, `<data root>/servers/<domain>/` (`ServerRecord::server_dir` in
`servers-rust`), so servers never share a database.

`setup()` in [`src-tauri/src/lib.rs`](./src-tauri/src/lib.rs) resolves the data
root and hands it to the slices that keep install-wide files, among them
`servers-tauri`, which reads `servers.json` and pushes every server to the
unit runner with its run policy (see the servers package group's
[Server Runs Explanation](../servers/docs/Server%20Runs%20Explanation.md)).
Each run of a server gets its folder as `ServerRuntimeConfig.server_dir`, and
the server creates the folder, applies scheduled database deletions in it, and
opens both databases there; the data-management screen (`/databases`) exports
and deletes that server's databases only. The base's `server_remove` takes
the server off `TauriUnitRunner`, waiting for its run to end, then deletes its
whole folder and then its record. A `servers.json` that can't be read is
logged, and no server runs; the base's `servers_list` answers with the error,
which the base shows. Every slice that needs a path joins onto the data root or
the server's folder rather than resolving its own.

## `servers.json`

`servers-rust`'s `JsonServerRegistry` owns the file. It holds the install's
configuration only, never whether a server is up:

```json
{
  "version": 2,
  "servers": [
    {
      "relay": { "kind": "wildflowerOfficial" },
      "tunnelName": "ruth",
      "token": "<the tunnel's token>",
      "publicSettings": {
        "remoteAddr": "relay.wildflowerhealth.io:2333",
        "transport": "noise",
        "noisePattern": "Noise_NK_25519_ChaChaPoly_BLAKE2s",
        "publicKey": "<the relay's noise key>",
        "domain": "relay.wildflowerhealth.io"
      },
      "launcherUrl": "https://wildflowerhealth.io/launcher",
      "certificateAuthority": "letsEncrypt",
      "runPolicy": { "kind": "whileOpen" }
    }
  ]
}
```

`runPolicy` is when the user wants the server run, in the unit runner's own
shape, which the host pushes to `TauriUnitRunner` unchanged:
`{"kind": "off"}`, `{"kind": "whileOpen"}`,
`{"kind": "until", "at": "<RFC 3339>"}` or `{"kind": "always"}`. A new server
gets `whileOpen` when no other server's policy wants it running, and `off`
otherwise. An `until` whose `at` has passed stays in the file and no longer
wants its server running.

`certificateAuthority` is the ACME CA the server's certificates are ordered
from: `"letsEncryptStaging"` or `"letsEncrypt"`.

Where the data root lands is a per-platform decision, and on iOS it is a
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
the [Apple Release Signing Explanation](../../../docs/Rust/Apple%20Release%20Signing%20Explanation.md)).

## Why iOS uses `Documents`

Tauri's `app_data_dir()` on iOS resolves to
`<container>/Library/Application Support/<identifier>`, which iOS never exposes
to anything outside the app. `<container>/Documents` is the only part of an iOS
container the system will show, so pointing the data directory there is what
makes a **Wildflower** folder appear under "On My iPhone" in the Files app,
alongside the ones Pages, Preview and Firefox get. A user can copy a database
off the device, back it up, or drop a file in, without the app having to grow a
transfer feature for it.

Three things have to be true for that folder to appear, and none works alone:

1. The data has to be in `Documents`. `resolve_data_dir` in `src-tauri/src/lib.rs`
   borrows the app handle and asks its path resolver for `document_dir()` on iOS,
   `app_data_dir()` everywhere else. The arm is chosen with `cfg`, so only the
   platform's own candidate is ever resolved — `document_dir()` fails outright on
   a desktop that has no such user directory, and a platform that never reads it
   must not be able to fail startup on it.
2. The bundle has to opt in, with `UIFileSharingEnabled`.
3. The bundle has to opt in **again**, with `LSSupportsOpeningDocumentsInPlace`.

The third is the one that catches people. `UIFileSharingEnabled` on its own
exposes `Documents` to Finder/iTunes file sharing over a cable and nothing more;
the **on-device** Files app lists a folder under "On My iPhone" only when the
bundle also declares `LSSupportsOpeningDocumentsInPlace`. With either key
missing, `Documents` is still where the data lives — it is simply invisible on
the device, which is indistinguishable from the data directory pointing
somewhere else entirely.

`LSSupportsOpeningDocumentsInPlace` is what makes the folder a real document
container: other apps open and save files inside it in place rather than taking a
copy, and that includes the live SQLite databases. Opening a `.sqlite` in place
from another app while the host holds it open is a corruption risk and is not a
supported workflow — the key admits it, it does not invite it. The visibility is
worth that: the point of the folder is that a user can copy a database off the
device or drop a file in without the app carrying a transfer feature.

Both keys live in [`src-tauri/Info.ios.plist`](./src-tauri/Info.ios.plist) rather
than only in the generated `gen/apple/host-app_iOS/Info.plist`:
`tauri ios build` merges `Info.ios.plist` over the generated plist on every build
(last writer wins), so that copy survives a regenerated Xcode project. The
generated plist carries them too — it is committed, and it is what an
Xcode-opened build of `gen/apple/host-app.xcodeproj` reads directly,
without the merge step.

Three unit tests hold that arrangement together.
`both_ios_plists_declare_files_app_keys` pins both keys, as `true`, in both iOS
plists. `apple_plists_declare_local_network_access` does the same for the network
keys below. `overlay_keys_reach_the_generated_ios_plist` is the general guard:
rather than pinning a list, it reads every key the overlays declare — with the
value each one carries — and requires the generated plist to declare the same
pair, so neither a key added to an overlay later nor a reworded string can drift
out of the copy an Xcode build reads.

Nothing migrates. An install that already holds databases under
`Library/Application Support` keeps them there, untouched and unread, and comes
up with an empty `Documents` — worth knowing when a TestFlight build suddenly
looks like a fresh one.

The folder is named after the target's `PRODUCT_NAME` (`Wildflower`), not the
app's `productName` (`Wildflower Host`).

## Apple plist layering

There are three plists in play, and which one reaches which bundle is not
guessable from the filenames. The Tauri CLI's own config schema
(`node_modules/@tauri-apps/cli/config.schema.json`, under `bundle.macOS.infoPlist`
and `bundle.iOS.infoPlist`) is the authority:

| File                                | Merged into                    |
| ----------------------------------- | ------------------------------ |
| `src-tauri/Info.plist`              | macOS **and** iOS              |
| `src-tauri/Info.ios.plist`          | iOS only                       |
| `gen/apple/host-app_iOS/Info.plist` | nothing — it _is_ the iOS base |

So a key both Apple platforms need goes in `Info.plist`; a key only iPhones care
about goes in `Info.ios.plist`. Either way the generated plist needs its own copy,
because an Xcode-opened build never runs the merge. There is no
`Info.macos.plist` — the CLI does not look for one.

The Files-app pair above is iOS-only. The network pair below is shared.

## Reaching the network at all

Two more keys sit in [`src-tauri/Info.plist`](./src-tauri/Info.plist):

- **`NSLocalNetworkUsageDescription`** — the string the system shows in its
  local-network permission prompt, required on macOS 15+ and iOS 14+ for any
  connection off the loopback interface. The `dev:ios` script serves the UI from a
  LAN address, and the apps launch flow opens apps that may live on the same
  network. Without the key the OS denies the connection outright, and
  never prompts — so the failure looks like a broken dev server rather than a
  missing plist entry.
- **`NSAppTransportSecurity`** — App Transport Security blocks cleartext HTTP by
  default, and the host serves and loads a lot of it. The exemptions are scoped
  rather than blanket: `NSAllowsLocalNetworking` for the LAN dev server,
  `NSAllowsArbitraryLoadsInWebContent` because `resolve_http_url` admits plain
  `http` before handing a URL to the native-webview plugin, and an
  `NSExceptionDomains` entry for `localhost` (loopback is not covered by
  `NSAllowsLocalNetworking`, and stating it here keeps it even if the merge
  replaces Tauri's own `bundle.macOS.exceptionDomain` default wholesale).

  `NSAllowsArbitraryLoads`, the blanket switch, is deliberately absent, and the
  test asserts its absence in all three plists. It is the key Apple asks for
  written justification about at App Store review, and the scoped keys above
  take precedence over it on the deployment targets here (iOS 14, macOS 10.13),
  so setting it would buy nothing and cost a review conversation.

  ATS reaches only what goes through CFNetwork/`URLSession` — the web views and
  the WebKit content above. It has no say over the Rust side: `reqwest` here is
  built `default-features = false` with `rustls-tls`, so the rathole tunnel
  client, the reachability monitor's `/health` probe and the collectors'
  upstream fetches open their own sockets and speak their own TLS. Whatever those are allowed to
  reach is a question for that code, not for this plist.

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

- [Apple Release Signing Explanation](../../../docs/Rust/Apple%20Release%20Signing%20Explanation.md) — the certificates, entitlements and sandbox behind the macOS/iOS builds
- [Shared Diesel Pool Explanation](../../../docs/Persistence/Shared%20Diesel%20Pool%20Explanation.md) — what opens the databases this directory holds
