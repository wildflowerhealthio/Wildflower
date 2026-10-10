# Android Release Signing Explanation

How the Android build of the host is signed for Google Play, and why there are
two keys when the build only ever handles one.

## Two keys: the upload key and the app signing key

Google Play installs an app on a device only if it is signed by the app's
**app signing key**, and every update must be signed by the same one. Under
Play App Signing — the default for every new app, and the only option for an
app published as an Android App Bundle (`.aab`) — Google holds that key. Nothing
in this repository ever sees it. Google signs every APK it generates from an
uploaded bundle with it.

What the release does hold is the **upload key**. It signs the bundle on its way
to Play, and Play accepts a bundle only if its upload key is the one registered
for the app. The two differ in what losing them costs:

| Key             | Held by                                        | If it is lost or leaks                                      |
| --------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| App signing key | Google                                         | Not possible from here                                      |
| Upload key      | The signing folder, and the `android-play` env | Request an upload key reset in Play Console; Google re-keys |

The first bundle uploaded to a new app decides the upload key: Play registers
whatever key signed it. Every later bundle, by hand or from CI, must be signed
with that same key until Google resets it.

## How the key reaches the build

`tauri android build` drives Gradle through the committed project in
`apps/host/host-app/src-tauri/gen/android`. Unlike most of what Tauri
generates, `app/build.gradle.kts` is not rewritten on a build, so the signing
configuration lives there, in the shape
[Tauri's Android signing guide](https://v2.tauri.app/distribute/sign/android/)
uses: a `keystore.properties` file beside the Gradle project, holding

| Key         | Holds                                              |
| ----------- | -------------------------------------------------- |
| `storeFile` | the absolute path of the keystore                  |
| `keyAlias`  | the upload key's alias in it                       |
| `password`  | the password of the keystore, and of the key in it |

When the file exists, the `release` build type is signed with it. When it does
not, the release build is left unsigned. That is the case on every machine
without the upload key, so a local `tauri android build` keeps working with
nothing set up, and `keystore.properties` is gitignored in that folder.

The single password is the format's, not a shortcut. keytool's default
keystore type, PKCS12, has one password for the store and every key in it. An
older JKS keystore can give a key a password of its own, which
`keystore.properties` has no way to express: the store opens and signing then
fails at the very end of the build. The file is also a Java properties file, in
which a backslash starts an escape, so a password containing one reaches Gradle
as a different password.

## The service account

Uploads go through the Google Play Developer API, which authenticates as a
Google Cloud **service account** using its JSON key. A service account has no
access to Play until it is invited in Play Console's Users and permissions like
a person, with permission to release the app to testing tracks. Being a valid
key in Google Cloud says nothing about that grant.

Neither the app itself nor its first bundle can be created through the API:
both are done by hand in Play Console, once — see the
[Android Signing Sync How-To](./Android%20Signing%20Sync%20How-To.md).

## The `android-play` environment

The upload key and the service account key are stored in one GitHub Actions
environment, `android-play`:

| Kind     | Name                               | Holds                                                    |
| -------- | ---------------------------------- | -------------------------------------------------------- |
| Secret   | `ANDROID_UPLOAD_KEYSTORE`          | base64 of the keystore file                              |
| Secret   | `ANDROID_UPLOAD_KEYSTORE_PASSWORD` | the keystore's one password                              |
| Variable | `ANDROID_UPLOAD_KEY_ALIAS`         | the upload key's alias, `upload`                         |
| Secret   | `PLAY_SERVICE_ACCOUNT_JSON`        | the service account's JSON key, as downloaded, unencoded |

Only a job that declares the environment can read them, and it may deploy
from `main` only. Every deploy is meant to run from `main`, so the branch rule
costs nothing there, and it keeps a workflow dispatched from any other branch
away from the key. The Apple environments cannot have such a rule, because the
publish they serve runs on a pull request's merge ref — see
[Each channel's credentials live in their own environment](./Apple%20Release%20Signing%20Explanation.md#each-channels-credentials-live-in-their-own-environment).

`scripts/release/android-signing-sync.sh` is the only writer of the
environment. What it relies on:

- **One persistent upload key**, `android-upload.jks` in the signing folder
  shared with the Apple script (`~/.wildflower-signing`), with its password in
  `android-upload.password` and its certificate in `android-upload.pem`. The
  script generates the keystore when there is none and otherwise always reuses
  it: once Play has registered an upload key, a new one is refused. Generating
  a fresh key where an old one is merely missing from the folder would make
  every later upload fail until Google reset the key, so the script warns
  whenever it generates one. The certificate is what an upload key reset in
  Play Console asks for.
- **The service account key stays where it was downloaded.** The script reads
  it from `--service-account` or `play-service-account.json` in the signing
  folder, and it leaves the machine only as the `PLAY_SERVICE_ACCOUNT_JSON`
  secret.
- **The environment is created once.** When `android-play` is missing it is
  created with its `main`-only branch rule; when it exists it is left as it is,
  since creating it again would reset any protection rules set by hand since.

## How a release reaches Google Play

`.github/workflows/deploy-android-play.yml` builds and uploads the bundle. It
runs when Tauri Release — Publish completes successfully for a merged
`release/v<version>` pull request, so Android ships only once every other
platform of the release has built, and it can be dispatched by hand with a
`tag`.

**Which tag.** The `workflow_run` event that starts it says which Publish run
finished, not which tag that run pushed. Publish tags the version in
`tauri.conf.json` at the merged commit, so the deploy reads the same file at
the run's head commit — the release branch's tip, which carries the same
`tauri.conf.json` whichever way the pull request was merged. A release pull
request closed without merging completes a Publish run too, one that skipped
tagging; there is no tag, and the deploy stops there with a notice. A Publish
that was itself dispatched — a re-trigger or a tag rebuild — does not start a
deploy; dispatch the deploy for its tag instead.

**Which version Play sees.** `tauri android build` writes
`gen/android/app/tauri.properties`, which `build.gradle.kts` reads, from the
`version` in `tauri.conf.json`:

| Gradle property | Value                                                         |
| --------------- | ------------------------------------------------------------- |
| `versionName`   | the version as written, e.g. `0.4.0`                          |
| `versionCode`   | `major * 1000000 + minor * 1000 + patch`, e.g. `4000` (0.4.0) |

`bundle.android.versionCode` in the Tauri config would override the second,
and `bundle.android.autoIncrementVersionCode` would replace it with a counter;
neither is set. The formula has two consequences:

- **A prerelease spends its release's version code.** The suffix is dropped,
  so `0.4.0-beta.1` and `0.4.0` are both `4000`, and Play accepts each version
  code once per app. A Publish run for a prerelease is therefore skipped, and
  a dispatch for one refused, as the Pebble app store upload skips them for
  the same reason.
- **Minor and patch stay below 1000**, or one version's code runs into the
  next's.

Play refusing a version code it has been sent before also decides what a
re-run does: the bundle is rebuilt and replaces the GitHub Release's copy, and
the Play upload fails with Play's own reason.

**Where it lands.** The bundle is uploaded to the `internal` testing track as
a **draft** release, which a person rolls out to the track's testers from Play
Console. Draft is also the only status the API accepts until the app has been
published once. R8's `mapping.txt` goes with it, so Play can deobfuscate crash
reports. The bundle is attached to the tag's GitHub Release first, before the
Play upload, so it is there even when that upload fails.

**What it builds.** One bundle for `aarch64` and `armv7`, the ABIs phones run;
Play splits it per device. The Android SDK comes with the runner image, and
the NDK is pinned to the version the Tauri CLI would install for itself, since
the image's NDKs change with it and the CLI otherwise picks the newest it
finds.

## The preflight

`scripts/checks/android-play-preflight.sh` checks the four values together, in
seconds, and names the one at fault: that the keystore is base64 of a keystore,
that the password opens it, that the alias exists and holds a private key
rather than a lone certificate, that the same password opens the key, that the
upload certificate has not expired, and that the JSON is a service account key
with a `client_email`. Gradle's own failures for most of these arrive at the
end of the build and name neither the input nor the cause.

A wrong password and a file that is not a keystore at all have different fixes,
so the preflight classifies keytool's refusal before blaming either. keytool
words a wrong password differently by keystore type — "keystore password was
incorrect" for PKCS12, "Keystore was tampered with, or password was incorrect"
for JKS — and `keytool_failure_kind` maps each spelling to one answer.

It also prints the upload certificate's SHA-256 fingerprint. Play Console shows
the fingerprint of the upload key it expects on the app's App signing page,
and the two matching is the only check of the key that can be made without an
upload.

The deploy runs it as soon as the JDK it needs is set up, before anything
compiles. The sync script runs the same preflight against what it is about to
store, and stores nothing when it fails.

## See Also

- [Android Signing Sync How-To](./Android%20Signing%20Sync%20How-To.md) — the one-time Play Console setup, and creating and storing the upload key
- [Apple Release Signing Explanation](./Apple%20Release%20Signing%20Explanation.md) — the macOS and iOS channels of the same release
- [CI Build Cache Explanation](./CI%20Build%20Cache%20Explanation.md) — the `release-android` cache key the deploy uses
- `.github/workflows/deploy-android-play.yml` — the build and upload
- `apps/host/host-app/src-tauri/gen/android/app/build.gradle.kts` — the `release` signing configuration
- `scripts/checks/android-play-preflight.sh` — the check, and its tests beside it
- `scripts/release/android-signing-sync.sh` — creates the upload key and fills the environment
