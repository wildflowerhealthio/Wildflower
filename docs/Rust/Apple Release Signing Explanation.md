# Apple Release Signing Explanation

Why the macOS and iOS halves of `tauri-release-publish.yml` are configured so
differently, and why both failed in ways that named the wrong cause.

The two platforms look like one problem — Apple credentials in GitHub secrets —
but nothing is shared between them. They use different certificate kinds,
different tools, and different mechanisms for reaching the build. Treating
them as one thing is what produced the misleading errors described below.

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
0`. No such option exists, so notarytool exited on a *usage* error without ever
contacting Apple — and the check reported `Notarization credentials are invalid
… Generate a new app-specific password`. The step could not pass regardless of
whether the secrets were good, and it sent people to rotate a working password.

A validation step must therefore establish *why* a tool failed before naming a
cause. When writing such a classifier for notarytool specifically, note that it
answers a bad flag by printing its full usage — which includes `[--password
<password>]`. A classifier that searches for credential keywords first will
read every usage error as an authentication failure, so usage patterns must be
tested first. The preflight distinguishes usage, auth, network and unknown, and
treats a network failure as a warning rather than burning a release on a blip.

## iOS: Tauri owns signing, and only reads three variables

iOS signing is not configured in the repository at all. The Tauri CLI does it,
and reads exactly three environment variables in `signing_from_env()`:

| Variable                   | Holds                                        |
| -------------------------- | -------------------------------------------- |
| `IOS_CERTIFICATE`          | base64 of the Apple Distribution `.p12`      |
| `IOS_CERTIFICATE_PASSWORD` | the password used to export that `.p12`      |
| `IOS_MOBILE_PROVISION`     | base64 of the App Store `.mobileprovision`   |

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
misleading: it asks for a *development* profile during an App Store build,
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

## See Also

- [CI Build Cache Explanation](./CI%20Build%20Cache%20Explanation.md) — the cache keys these release jobs share
- `scripts/checks/apple-signing-preflight.sh` — the macOS check
- `scripts/checks/apple-ios-signing-preflight.sh` — the iOS check
