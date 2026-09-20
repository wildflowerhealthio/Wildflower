# Apple Release Signing Explanation

Why the macOS and iOS halves of `tauri-release-publish.yml` are configured so
differently, and why both failed in ways that named the wrong cause.

There are three channels, not two, and they look like one problem — Apple
credentials in GitHub secrets — while sharing almost nothing. Each uses a
different certificate kind, different tools, and a different mechanism for
reaching the build. Treating them as one thing is what produced the misleading
errors described below.

| Channel               | Certificate                                         | Ships as             |
| --------------------- | --------------------------------------------------- | -------------------- |
| macOS direct download | Developer ID Application                            | notarized `.app`/dmg |
| macOS TestFlight      | Apple Distribution **+** Mac Installer Distribution | sandboxed `.pkg`     |
| iOS TestFlight        | Apple Distribution                                  | `.ipa`               |

The two macOS rows are the pair most easily confused: same platform, same
runner, entirely different credentials, and a Developer ID certificate offered
to the App Store is rejected only after upload.

## macOS: the bundler resolves an identity, `notarytool` checks credentials

The macOS bundle needs a **Developer ID Application** certificate. Any other
kind either only runs on Macs registered to the team or is rejected outright by
notarization. `APPLE_SIGNING_IDENTITY` names it, and the Tauri bundler resolves
that name by substring against `security find-identity -v -p codesigning` — but
only at the very end of the universal compile, so a mismatch costs a full build
before it is reported.

`scripts/checks/apple-signing-preflight.sh` runs first and reproduces that
lookup against a throwaway keychain holding only `APPLE_CERTIFICATE`, printing
the certificate names the `.p12` actually contains.

### Classify before blaming a secret

The preflight also validates the notarization credentials with `xcrun notarytool
history`. This check was previously written as `notarytool history … --page-size
0`. No such option exists, so notarytool exited on a _usage_ error without ever
contacting Apple — and the check reported `Notarization credentials are invalid
… Generate a new app-specific password`. The step could not pass regardless of
whether the secrets were good, and it sent people to rotate a working password.

A validation step must therefore establish _why_ a tool failed before naming a
cause. When writing such a classifier for notarytool specifically, note that it
answers a bad flag by printing its full usage — which includes `[--password
<password>]`. A classifier that searches for credential keywords first will
read every usage error as an authentication failure, so usage patterns must be
tested first. The preflight distinguishes usage, auth, network and unknown, and
treats a network failure as a warning rather than burning a release on a blip.

## iOS: Tauri owns signing, and only reads three variables

iOS signing is not configured in the repository at all. The Tauri CLI does it,
and reads exactly three environment variables in `signing_from_env()`:

| Variable                   | Holds                                      |
| -------------------------- | ------------------------------------------ |
| `IOS_CERTIFICATE`          | base64 of the Apple Distribution `.p12`    |
| `IOS_CERTIFICATE_PASSWORD` | the password used to export that `.p12`    |
| `IOS_MOBILE_PROVISION`     | base64 of the App Store `.mobileprovision` |

Only when all three are present does `synchronize_project_config()` rewrite the
generated Xcode project with `CODE_SIGN_STYLE=Manual` plus the matching
`CODE_SIGN_IDENTITY`, `PROVISIONING_PROFILE_SPECIFIER` and `DEVELOPMENT_TEAM`.

Miss any one of them and the project keeps the template's
`CODE_SIGN_STYLE=Automatic`. Automatic signing resolves profiles through a
signed-in Xcode account, which no CI runner has, so the build fails with:

```text
error: No Accounts: Add a new account in Accounts settings.
error: No profiles for '<bundle id>' were found: Xcode couldn't find any
iOS App Development provisioning profiles matching '<bundle id>'.
```

Neither line mentions an environment variable, and the second is actively
misleading: it asks for a _development_ profile during an App Store build,
because that is what automatic signing falls back to looking for. The fix is
never to supply a development profile — it is to supply the three variables so
manual signing takes over.

Two consequences follow, and both cost time before they were understood:

- **Installing certificates into your own keychain accomplishes nothing.** Tauri
  creates its own via `tauri_macos_sign::Keychain::with_certificate`. A
  hand-rolled `security import` step is dead weight, and its apparent success
  disguises the fact that the build never received any signing input.
- **Committing signing settings under `src-tauri/gen/apple` accomplishes
  nothing.** The Xcode project is regenerated on every build. Settings such as
  `CODE_SIGN_IDENTITY` and `DEVELOPMENT_TEAM` committed into `project.pbxproj`
  are overwritten before they are ever read. Configure through the environment.

Note also that the repository variable is named `IOS_PROVISIONING_PROFILE`,
which is not a name Tauri reads; the workflow maps it to `IOS_MOBILE_PROVISION`.

`scripts/checks/apple-ios-signing-preflight.sh` validates all of this before the
build: the certificate kind, the profile's kind, team, bundle identifier and
expiry, and that the profile actually lists the certificate it is paired with —
a pair that is individually valid but unrelated is the failure mode that reads
as "no signing certificate" with nothing explaining why.

## macOS TestFlight is a separate channel from the notarized build

TestFlight for macOS means Mac App Store distribution, which differs from the
Developer ID build in three ways that are not negotiable.

**Two certificates, not one.** An Apple Distribution certificate signs the
`.app`; a Mac Installer Distribution certificate signs the `.pkg` that
`productbuild` wraps it in. Neither substitutes for the other, and neither is
the Developer ID certificate the GitHub Release build uses. Because an
installer certificate carries no codesigning policy, `security find-identity -p
codesigning` cannot see it at all — the preflight resolves it under `-p basic`,
or it would report a valid certificate as missing.

**The App Sandbox is mandatory.** `com.apple.security.app-sandbox` is required
for App Store distribution, and it changes how the host runs:

- the loopback listener in `src/lib.rs` needs `com.apple.security.network.server`
  — loopback is not exempt from the sandbox
- the tunnel client, its `/health` probe and the collectors need
  `com.apple.security.network.client`
- the importer's file picker needs `com.apple.security.files.user-selected.read-write`
- the data directory moves to `~/Library/Containers/<identifier>/Data/`, so a
  sandboxed build does not see a non-sandboxed one's databases

That last point is why the entitlements live in `Entitlements.appstore.plist`
and are applied through `tauri.appstore.conf.json`, an overlay passed as
`tauri build --config`, rather than in `tauri.conf.json`. Putting them in the
default config would sandbox the Developer ID build too, silently relocating
the data directory of every direct-download install.

The team identifier is written literally into that plist rather than read from
`APPLE_TEAM_ID`. Entitlements are baked into the signature at build time and
cannot read the environment; a team id is not a secret, and is readable in any
signed binary Apple distributes.

**The profile is embedded, not installed.** `bundle.macOS.files` copies the
profile to `Contents/embedded.provisionprofile` inside the bundle. The workflow
writes it from `MACOS_PROVISIONING_PROFILE` at build time and it is gitignored,
which also keeps it out of the Developer ID build, where it does not belong.

Upload is `xcrun altool --upload-app --type macos` against the `.pkg` — the
same tool as iOS with a different `--type` and a different artifact.

## See Also

- [CI Build Cache Explanation](./CI%20Build%20Cache%20Explanation.md) — the cache keys these release jobs share
- `scripts/checks/apple-signing-preflight.sh` — the macOS check
- `scripts/checks/apple-ios-signing-preflight.sh` — the iOS check
- `scripts/checks/apple-macos-appstore-preflight.sh` — the macOS TestFlight check
- `scripts/checks/apple-signing-lib.sh` — certificate and profile classification shared by both
