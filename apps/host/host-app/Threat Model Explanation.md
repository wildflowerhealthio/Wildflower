# Threat Model Explanation

What the Wildflower host app keeps on the device, which code can reach it,
and what it leaves to the platform. The general model is the
[Threat Model Explanation](../../../docs/Security/Threat%20Model%20Explanation.md);
the server it runs has its own
([Wildflower Server Threat Model](../wildflower-server/wildflower-server-rust/docs/Threat%20Model%20Explanation.md)).

## Data at rest

Everything lives under one data root, laid out in the
[Data Directory Explanation](./Data%20Directory%20Explanation.md). Nothing is
encrypted by the app: no SQLCipher, no keychain or keystore, no stronghold.
Protection is the OS sandbox plus file modes.

| File                                  | Holds                                                                                                              | Mode                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `servers/<domain>/health-data.sqlite` | Every FHIR record; HFS settings and export jobs                                                                    | default             |
| `servers/<domain>/fhir-exports/`      | Bulk-export NDJSON                                                                                                 | default             |
| `servers/<domain>/wildflower.sqlite`  | RSA signing key (private components, plaintext), grants, token hashes, browser sessions, request log, app registry | default             |
| `servers/<domain>/certificates/`      | The TLS private key (PKCS#8), chain and history                                                                    | 0700 on Unix        |
| `acme-account/`                       | The ACME account key per CA, shared by the install                                                                 | 0700 on Unix        |
| `servers.json`                        | Each server's tunnel token in plaintext, relay pin, run policy                                                     | 0600                |
| webview `localStorage`                | The telemetry consent answer                                                                                       | platform            |
| `Wildflower Recordings/` (outside)    | `.har` recordings, response bodies unanonymized                                                                    | user-visible folder |

What the platform adds, and what it does not:

- **iOS.** The data root is `Documents`, on purpose, so it shows in the Files
  app and can be copied off. That also puts the live databases, the keys and
  `servers.json` where other apps can open them in place and where device
  backups include them. No Data Protection class is set beyond the default
  (readable after first unlock).
- **Android.** App-private internal storage. The manifest sets no backup
  rules, so the platform default (backup allowed) applies.
- **macOS.** The App Store build is sandboxed; the Developer ID build is
  not. Both keep the data under the user's Library.
- **Windows and Linux.** The user account is the boundary. Windows files
  inherit the data root's ACLs.

A device compromise, a readable backup, or a copy of the `Documents` folder
is therefore a full compromise: records, the signing key, the TLS key and
the tunnel token together.

## Code that can reach the data

- **Rust.** The server, the unit runner and the Tauri commands. Only Rust
  opens the databases and key files.
- **The base webview** (label `main`, the bundled Servers and Recorder UI).
  Runs with `csp: null` and `withGlobalTauri`. Its capability grants the
  server commands (add, set credentials, list, run policy, update, remove,
  launch, open the Authorization app, open consents) and the recorder.
  Several of those sign a browser in as the Owner, so this webview is
  Owner-equivalent. It loads only the bundled bundle.
- **The native webview** (browser sniffer and Recorder). Loads any page the
  user navigates to and injects a document-start script. Remote content gets
  `event:listen`, `unlisten` and one `_tag`-allowlisted emit command, nothing
  else ([Native Webview Explanation](../tauri-plugin-native-webview/docs/Explanation.md)).
- **The in-app browser** (SFSafariViewController, Custom Tab, or the desktop
  default browser). Every launch, consent and the Authorization app open
  here. The app cannot script or read these pages, and these pages have no
  Tauri bridge ([Native Page Browser Explanation](../tauri-plugin-native-page-browser/docs/Explanation.md)).
- **No Rust telemetry.** Only the base webview runs the Sentry SDK, behind
  consent ([Telemetry Explanation](../../../slices/telemetry/docs/Telemetry%20Explanation.md)).

## The Owner's authority on the device

The host app holds no token. To act as the Owner it mints a same-device
sign-in code in process (256 random bits, hashed in memory, 60 seconds,
single use) and opens `https://<domain>/oauth/sign-in?code=…&next=…` in the
in-app browser; the server turns it into a same-device browser session
([Jargon Explanation](../../../slices/authorization/docs/Jargon%20Explanation.md#same-device-sign-in)).
Two consequences:

- The sign-in round trip leaves the device, goes to the relay and comes back
  down the tunnel. Only the device's TLS endpoint can redeem the code, and
  the code dies with the process.
- On the desktop the code is in a URL the default browser sees, which may
  keep it in history. It is spent on first use.

## The server has no local side

The server binds no port. The base, a browser on the same machine and a
remote app all reach it the same way, through the relay, and are
authenticated the same way ([Origins Explanation](../../../docs/Origins/Explanation.md)).
There is no loopback trust to exploit and no local-only endpoint.

## Threats

| Threat                                 | Outcome                                                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malware or an unlocked device          | Full compromise. Out of scope.                                                                                                                                               |
| A backup read by someone else          | Full compromise of that server's data. iOS and Android defaults include the data root.                                                                                       |
| Another iOS app opening the database   | Possible in place via Files; corruption more likely than theft, but both are possible.                                                                                       |
| A malicious page in the sniffer        | Can listen to events and emit one allowlisted message. Cannot call server commands or read files.                                                                            |
| A malicious page in the in-app browser | Ordinary web risk. It has no bridge; a stolen Owner cookie is the exposure, same as any browser.                                                                             |
| A stolen `servers.json`                | The tunnel token and relay pin. Re-token at the relay; the device's certificate stays with the device.                                                                       |
| A stolen `certificates/` folder        | With a path to the visitor's traffic, interposition for that hostname until expiry. Nothing revokes a certificate today; remove the server and re-add it to order a new key. |
| A recording shared by the user         | Unanonymized response bodies. The anonymizer is a separate, local tool ([Anonymization Explanation](../../../slices/anonymizer/docs/Anonymization%20Explanation.md)).        |

## See also

- [Store Privacy Answers Reference](./Store%20Privacy%20Answers%20Reference.md):
  what the store forms and the privacy policy say leaves the device.
- [Server Runs Explanation](../servers/docs/Server%20Runs%20Explanation.md):
  how and when the server runs, including the Android grace window.
