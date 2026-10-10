# Apple Signing Sync How-To

Create or renew every certificate and provisioning profile the Tauri release signs with, and store each channel's in its GitHub Actions environment, by running [`scripts/release/apple-signing-sync.sh`](../../scripts/release/apple-signing-sync.sh) on a Mac. Run it once to set the release up, and again whenever a certificate or profile is within 30 days of expiring — re-running when nothing needs renewing changes nothing at Apple and rewrites the same credentials to GitHub.

For which channel needs which certificate, what the script relies on, and why each environment has no branch rule, see the [Apple Release Signing Explanation](./Apple%20Release%20Signing%20Explanation.md).

## One-time setup

The script runs as the team's Account Holder or an Admin, on a Mac with Xcode installed: the preflights it runs resolve identities through the keychain, which needs Apple's intermediate certificates that Xcode installs.

1. In App Store Connect → Users and Access → Integrations → Team Keys, create a key with the **Admin** role. Download `AuthKey_<key id>.p8` into the signing folder, `~/.wildflower-signing` (or the folder `WILDFLOWER_SIGNING_DIR` names), keeping that file name — the script reads the key id from it — and note the issuer id shown above the key list. Keep only the one key there; to use a key kept elsewhere, set `APP_STORE_CONNECT_ADMIN_KEY_PATH` to it.
2. Log `gh` in as someone who can administer the repository — creating an environment needs admin access:

   ```bash
   gh auth login
   ```

The signing folder is where the script keeps the private key of each certificate it makes. It is created `chmod 700`; back it up somewhere private. If it is lost, the next run makes new certificates from new keys, and the old ones stay listed at Apple until they are revoked by hand.

## Steps

1. From the repository root, see what the run would do:

   ```bash
   APP_STORE_CONNECT_ISSUER_ID=<issuer id> \
     ./scripts/release/apple-signing-sync.sh --dry-run
   ```

   A dry run lists certificates and profiles and generates any missing local key, but creates and deletes nothing at Apple and writes nothing to GitHub. A channel whose credentials already exist is exported and preflighted in full.

2. Run it for real with the same command, without `--dry-run`.
3. Read the closing table: one row per channel and certificate, with each certificate's id and expiry, the profile's expiry, and what changed. A channel whose preflight failed says `not stored`, and the preflight's output above the table names the input at fault.

## Variations

**One channel.** Pass `--channel ios`, `--channel macos-appstore` or `--channel macos-direct`; repeat the flag for more than one.

**Checking notarization too.** The macOS direct-download preflight also validates the notarization credentials when `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` are exported in the shell. Without them it warns and checks the certificate only — those credentials live at repository level and the script does not touch them.

**Renewing earlier.** `WILDFLOWER_SIGNING_RENEWAL_DAYS` (default 30) sets how close to expiry a certificate or profile is replaced.

**Developer ID refused by App Store Connect.** If App Store Connect will not create the Developer ID Application certificate with a team key, the script prints the path of the CSR it wrote and stops for it to be made by hand:

1. Open [Certificates, Identifiers & Profiles → Certificates → +](https://developer.apple.com/account/resources/certificates/add).
2. Choose **Developer ID Application** and the **G2 Sub-CA**.
3. Upload `~/.wildflower-signing/developer-id.csr.pem`.
4. Download the certificate and save it as `~/.wildflower-signing/developer-id.cer`.

Then press Enter, or re-run the script if it was not run from a terminal. Later runs pick the same certificate up until it is due for renewal; to renew it, delete the `.cer` and repeat these steps.

**At the certificate cap.** When Apple refuses a new certificate, the script lists the team's existing certificates of that kind with their ids and expiry dates. It never revokes one: revoke the one you no longer need in the portal, then re-run.

**App ID without macOS.** A Mac App Store profile needs the App ID to cover macOS. If the script reports the App ID as registered for `IOS` only, add macOS to it under Certificates, Identifiers & Profiles → Identifiers and re-run.

## After the first release on the environments

Each environment's secrets and variables take precedence over the repository-level copies of the same name. Once a release has built from the environments, delete the repository-level copies:

```bash
for name in IOS_CERTIFICATE IOS_CERTIFICATE_PASSWORD \
  MACOS_APPSTORE_CERTIFICATE MACOS_APPSTORE_CERTIFICATE_PASSWORD \
  MACOS_INSTALLER_CERTIFICATE MACOS_INSTALLER_CERTIFICATE_PASSWORD \
  APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD; do
  gh secret delete "$name"
done
for name in IOS_PROVISIONING_PROFILE MACOS_PROVISIONING_PROFILE \
  APPLE_SIGNING_IDENTITY MACOS_APPSTORE_SIGNING_IDENTITY MACOS_INSTALLER_SIGNING_IDENTITY; do
  gh variable delete "$name"
done
```

Leave `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` and the `APP_STORE_CONNECT_*` secret and variables at repository level.

## See Also

- [Apple Release Signing Explanation](./Apple%20Release%20Signing%20Explanation.md) — the three channels, the environments, and how the script decides what to reuse
- [`scripts/release/apple-signing-sync-lib.sh`](../../scripts/release/apple-signing-sync-lib.sh) — the token, JSON and reuse logic the script's tests cover
