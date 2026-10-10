# Android Signing Sync How-To

Set the host's Android app up on Google Play, create the upload key its bundles are signed with, and store that key and the Play service account's key in the `android-play` GitHub Actions environment by running [`scripts/release/android-signing-sync.sh`](../../scripts/release/android-signing-sync.sh). Run the script once to set the release up, and again whenever the service account key is rotated — re-running it reuses the upload key and rewrites the same values to GitHub.

For what the two keys are, how the upload key reaches the build, and what the environment holds, see the [Android Release Signing Explanation](./Android%20Release%20Signing%20Explanation.md).

## One-time setup

The Play Developer API can neither create an app nor upload its first bundle, and it authenticates as a service account that Play Console has to be told about. These steps happen once, by someone who owns the Play Console developer account.

1. In [Play Console](https://play.google.com/console), choose **Create app**, name it Wildflower Host, and answer the declarations. The package name is fixed by the first bundle uploaded: `io.wildflowerhealth.hostapp`, the `identifier` in `apps/host/host-app/src-tauri/tauri.conf.json`.
2. In the [Google Cloud console](https://console.cloud.google.com), in a project of your choosing, enable the **Google Play Android Developer API**.
3. In the same project, under IAM & Admin → Service Accounts, create a service account. It needs no Google Cloud roles. Under its **Keys** tab, add a JSON key, and save the download as `~/.wildflower-signing/play-service-account.json` (or the folder `WILDFLOWER_SIGNING_DIR` names).
4. Back in Play Console, under **Users and permissions**, invite the service account's email address — the `client_email` in the JSON key. Under **App permissions**, add Wildflower Host with **Release apps to testing tracks**, and send the invitation. A service account needs no email confirmation.
5. Log `gh` in as someone who can administer the repository — creating an environment needs admin access:

   ```bash
   gh auth login
   ```

The script needs a JDK's `keytool`, `openssl` and `python3`, on Linux or macOS. The signing folder is where it keeps the upload key. It is created `chmod 700`; back it up somewhere private. If the key is lost, Play refuses every bundle until Google resets the upload key, which is the variation below.

## Steps

1. From the repository root, see what the run would do:

   ```bash
   ./scripts/release/android-signing-sync.sh --dry-run
   ```

   A dry run generates the upload key if the signing folder has none and runs the preflight over the key and the service account key, but writes nothing to GitHub.

2. Run it for real with the same command, without `--dry-run`. It creates `android-play` with a `main`-only branch rule if it is missing, and sets its four secrets and variables.
3. Upload the first bundle by hand. Only the first one: every later bundle can come through the API. Build it signed with the upload key from `apps/host/host-app`, on a machine with the Android SDK and NDK, a JDK 17 and the Rust Android targets:

   ```bash
   cat > src-tauri/gen/android/keystore.properties <<EOF
   storeFile=$HOME/.wildflower-signing/android-upload.jks
   keyAlias=upload
   password=$(cat ~/.wildflower-signing/android-upload.password)
   EOF
   vp run tauri android build --aab --target aarch64 armv7
   ```

   Delete `keystore.properties` afterwards, so local release builds go back to being unsigned.

4. In Play Console, open **Test and release → Testing → Internal testing**, create a release, and upload `src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab`. When asked how to sign the app, keep the Google-generated app signing key: that enrols the app in Play App Signing, with the key that signed this bundle as its upload key.
5. Compare the upload key Play registered — **Test and release → App integrity → App signing**, "Upload key certificate" — against the SHA-256 fingerprint the script's preflight printed. They must match.
6. On the internal testing track's **Testers** tab, add the testers' email list.

## Variations

**First bundle from CI.** Instead of building the first bundle locally, run **Deploy Android to Google Play** for a release tag from the Actions tab (or `gh workflow run deploy-android-play.yml -f tag=v<version>`). It attaches the signed bundle, `wildflower-host-<version>.aab`, to the tag's GitHub Release before it tries Play, and that first Play upload fails because the app has no bundle yet. Download the bundle from the release and continue from step 4. Play then has that version code, so the next deploy needs the next release.

**A service account key kept elsewhere.** Pass `--service-account <key.json>`.

**Rotating the service account key.** Add a new JSON key to the service account in Google Cloud, re-run the script with it, then delete the old key there. The upload key is reused, so nothing else changes.

**Another machine.** Copy `android-upload.jks`, `android-upload.password` and `android-upload.pem` from the backup into its signing folder before running the script, or it generates a new upload key that Play refuses.

**Lost or leaked upload key.** Move the three `android-upload.*` files out of the signing folder and run the script with `--dry-run`, which generates a new key without storing it. In Play Console, under **App integrity → App signing**, request an upload key reset and attach the new `android-upload.pem`. Once Google confirms the reset, run the script for real to store the new key.

## See Also

- [Android Release Signing Explanation](./Android%20Release%20Signing%20Explanation.md) — the upload and app signing keys, `keystore.properties`, and the environment
- [Apple Signing Sync How-To](./Apple%20Signing%20Sync%20How-To.md) — the same job for the macOS and iOS channels
- [`scripts/checks/android-play-preflight.sh`](../../scripts/checks/android-play-preflight.sh) — the check the script runs before storing anything
- [`.github/workflows/deploy-android-play.yml`](../../.github/workflows/deploy-android-play.yml) — the deploy that reads the environment
