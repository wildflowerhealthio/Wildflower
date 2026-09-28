# App Store Release Explanation

How Tauri Release — Publish gets `apps/watch-lifts` and `apps/fhir-sync-pebble`
into the Pebble app store, why every release arrives there unpublished, and the
one secret it needs. The build that produces the `.pbw`s is described in the
[watch-lifts README](../../apps/watch-lifts/README.md#releases).

## What the job does

`publish-pebble-appstore` in `tauri-release-publish.yml` runs once per app after
`build-pebble`. It takes the `.pbw` that job attached to the GitHub Release,
from its `pebble-<app>` workflow artifact, and hands it to
`scripts/ci/pebble-appstore-upload.sh`, which:

1. reads the app's UUID and version out of the `.pbw`'s `appinfo.json`, and
   stops if the version is not the release's;
2. exchanges the refresh token for a Firebase ID token;
3. asks the store's `/api/v1/developer/me` which store app ID belongs to that
   UUID, and stops if none does;
4. posts the `.pbw`, the version and the release notes to that app's
   `/api/dashboard/apps/<app id>/releases`, with `isPublished=false`.

The release then waits in the store dashboard, at
<https://appstore-api.repebble.com/dashboard>, until someone publishes it. That
is deliberate: CI uploads, a person approves.

The job is skipped for a prerelease. `pebble build` takes no prerelease suffix,
so `1.2.3-beta.1` and `1.2.3-beta.2` both build as `1.2.3`, and each would add
another store release of 1.2.3 ahead of the real one. Without the
`PEBBLE_APPSTORE_REFRESH_TOKEN` secret it passes with a notice rather than
failing, so the rest of the release is unaffected.

The release notes are the GitHub Release's body — the release's section of
`apps/wildflower-tauri/CHANGELOG.md` — sent as they are, in the plain form
field `pebble publish --release-notes` fills, so the Markdown bullets arrive as
`-` lines. pebble-tool puts no length limit on them.

## Why not `pebble publish`

pebble-tool's `pebble publish` does the same four steps, and takes an ID token
for CI through `--firebase-id-token` or `PEBBLE_FIREBASE_ID_TOKEN`. Four things
in pebble-tool 5.0.40's `commands/publish.py` rule it out here:

- **It publishes immediately.** `--is-published` is documented as defaulting to
  false, but `_upload_release` and `_create_app` send `isPublished: "true"`
  whatever the flag says. The script sends the field itself, as `false`.
- **It creates what it doesn't find.** A token with no linked developer account
  gets one made (`/api/v1/developer/create`), and a UUID with no listing gets a
  new app, which `--non-interactive` fills from flags and a generated icon. A
  store listing is a public page; CI should not be the thing that makes one.
- **It always builds.** It runs `pebble build` itself and uploads that, not the
  `.pbw` already on the GitHub Release.
- **It boots an emulator.** With `--non-interactive` and no `--screenshots` it
  captures GIFs from the emulator for every platform by default. The repository
  has no screenshots to pass instead.

Talking to the same endpoints with `curl` keeps the upload to exactly what
`pebble publish` sends for an existing app, with `isPublished=false`, no
screenshots and `replaceScreenshots=false`, so the listing's existing
screenshots stay.

## The refresh token

The store authenticates with a Firebase ID token, which expires an hour after it
is issued. A secret holding one would be dead by the next release, so the
secret holds the Firebase **refresh token** instead, and the script swaps it for
a fresh ID token on every run: a `POST` to
`https://securetoken.googleapis.com/v1/token` with
`grant_type=refresh_token`. That is the call pebble-tool makes to renew its own
login (`FirebaseAccount._refresh_id_token` in `firebase_account.py`), using
pebble-tool's Firebase web API key, which is public in its source and
authorizes nothing by itself.

pebble-tool cannot do this headless on its own. `pebble publish` uses an ID
token as given and never refreshes one. `pebble login --id-token <token>
--refresh-token <token>` looks as if it would store both, but the login command
handles `--id-token` through `login_with_token`, which saves the refresh token
as `null` — so that login is dead within the hour too.

The script keeps both tokens out of the log and off `curl`'s command line: the
refresh token is a repository secret, which Actions already redacts, and the
ID token is registered with `::add-mask::` as soon as it arrives. Both reach
`curl` through files, since a process's arguments are readable by anything else
on the runner.

### Setting the secret

Use the Pebble account that owns both apps' store listings.

1. Log in with pebble-tool, which opens a browser: `pebble login`.
2. pebble-tool keeps the login in `firebase_oauth_storage.json`, in the
   `oauth_firebase` folder of its data directory:
   - macOS: `~/Library/Application Support/Pebble SDK/oauth_firebase/`
   - Linux: `~/.local/share/pebble-sdk/oauth_firebase/` (under
     `$XDG_DATA_HOME` if set, or `~/.pebble-sdk/` if that older directory
     exists)
3. Its `refresh_token` field is the secret. Pipe it straight into the
   repository secret so it never appears on screen:

   ```bash
   jq -r .refresh_token \
     ~/Library/Application\ Support/Pebble\ SDK/oauth_firebase/firebase_oauth_storage.json |
     gh secret set PEBBLE_APPSTORE_REFRESH_TOKEN
   ```

A Firebase refresh token has no expiry date. It stops working when Firebase
revokes the account's sessions — a password change, for instance, or the
account being disabled — and the job then fails with the error Firebase gave
(`TOKEN_EXPIRED`, `INVALID_REFRESH_TOKEN`, `USER_DISABLED`). Repeat the steps
above to replace it. `pebble logout` deletes the local file without revoking
anything, and using the same token on your machine and in CI is fine.

## The first upload is by hand

CI only adds releases to a listing that exists. If the store has no app with the
`.pbw`'s UUID under the account, or the account has no developer profile, the
job fails and says so, without uploading anything. Create the listing yourself,
then re-run the failed jobs.

`pebble publish`, run interactively from the app's directory, does it: it asks
for the description, category, icons and screenshots a new listing needs.
Remember that pebble-tool 5.0.40 publishes that first release at once, whatever
`--is-published` says. It asks for an 80×80 `iconSmall` and a 144×144
`iconLarge`; `apps/fhir-sync-pebble/appstore/` has a 144×144
`appstore_large.png`, but its `appstore_small.png` is 48×48. Once the listing
exists, every later release comes through CI.

## Re-runs and rebuilds

Each run adds a release; the job cannot see what the store already has. Re-running
a successful upload, or a tag rebuild that includes `pebble`, leaves a second
unpublished release of the same version in the dashboard, unless the store
refuses the duplicate, which fails the job with its reason. Delete the one you
don't want.

## See Also

- [watch-lifts README](../../apps/watch-lifts/README.md#releases) — where the
  apps' version comes from and the `.pbw`s on the GitHub Release
- [CI Build Cache Explanation](./CI%20Build%20Cache%20Explanation.md) — the
  Pebble SDK install the build job uses
- [Apple Release Signing Explanation](../Rust/Apple%20Release%20Signing%20Explanation.md)
  — the TestFlight channels the same workflow uploads to
- `scripts/ci/pebble-appstore-upload.sh` — the upload, and its tests beside it
