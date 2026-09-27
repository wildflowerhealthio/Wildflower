# AGENTS.md — apps/fhir-sync-pebble-web

FHIR Sync for Pebble: the settings page of a Pebble watchapp that syncs the
steps, sleep and heart rate the Pebble already records to any FHIR server. It is
a SMART-on-FHIR app served from the published GitHub Pages site
(`/fhir-sync-pebble`). The Pebble phone app opens it; the user signs in to a
FHIR server, confirms the patient, and saves, which hands the watch what its
PebbleKit JS needs to write that data as Observations on the patient's record.

`apps/importer-web` is the template for the shape (`SmartAppRoot`, a relative
`base`, a build into the package's own `dist/`, a memory router carrying a
SMART-built context). What differs is below.

## Layout

- `app.tsx` — `App` is the only component that holds the fhirclient `Client`.
  It completes the handshake and turns it into two things: a router context
  (`buildSmartRouterContext`), and the `PebbleSettings.Connection` the grant
  carried (patient id, token, server).
  `SettingsApp` mounts the router over that context, so the patient read goes
  through `fhir-r4-react`'s `usePatientQuery` (route context → typed FHIR client
  → the SMART HTTP layer), like every other self-hosted SMART app's reads.
- `settings-page.tsx` — the page: `Either.all` of the connection and the
  recalled return target picks the confirmation or a refusal banner, whose
  message is an `Effect` `Match` on the refusal's tag.
- `patient-confirmation.tsx` — reads the patient and owns the save, which
  completes the settings with `PebbleSettings.withPatient`.
- `patient-details.tsx` — the patient summary; `patient-name.ts` — the display
  name the summary and the watch share.
- Namespace modules, imported as `* as Name`: `PebbleSettings`
  (`pebble-settings.ts`, the watch's wire shape), `ReturnTarget`
  (`return-target.ts`, the allow-listed `return_to` and the hand-off URL), and
  `ReturnTargetStore` (`return-target-store.ts`, the `Store` interface that
  keeps `return_to` across the login, with a Web Storage implementation).

The npm package is `fhir-sync-pebble-web`; the OAuth `client_id` is
`fhir-sync-pebble` (`fhir-sync-pebble-dev` in a vite dev build), and the
published path segment is `fhir-sync-pebble`.

## Standalone only

There is no `launch.html` and no homescreen tile — no `apps-rust` registration,
production or dev. The page is only ever opened from the Pebble phone app, so
the root URL is the SMART login: `SmartAppRoot`'s standalone branch renders the
app's `AppLanding` beside the `ConnectMenu`. The OAuth callback lands back on the
same `index.html`, where `SmartAppRoot`'s launched branch mounts `App`.

## The Pebble configuration handoff

The app implements the Pebble "App Configuration (Static)" contract:

1. The phone app opens the page with `?return_to=<url>`. `main.tsx` keeps it in
   a `ReturnTargetStore` over `sessionStorage` before anything navigates,
   because the SMART login leaves for the server's authorize page and the
   callback comes back without it. `sessionStorage`, not `localStorage`: the
   target must outlive the round trip in this tab and nothing longer.
2. Once the handshake completes, the settings page reads the patient back and
   shows who the watch will record for.
3. Save navigates to `return_to` + `encodeURIComponent(JSON.stringify(settings))`,
   falling back to the guide's `pebblejs://close#` when the page was opened
   without one.

`PebbleSettings` is the wire shape the watchapp parses — flat, with `null`
for what the record lacks:

```json
{
  "patientId": "ada",
  "patientName": "Ada Lovelace",
  "patientBirthDate": "1815-12-10",
  "accessToken": "…",
  "fhirBaseUrl": "https://fhir.example/r4"
}
```

`patientName` and `patientBirthDate` are for the watch to show the patient for
confirmation on-device; `patientName` is the same string the settings page
shows (`given family`, else the name's text). The settings are built in two
steps because the facts arrive separately: the grant gives a `Connection`, and
the save adds the patient the page read (`withPatient`). Change the shape
together with the watchapp's `webviewclosed` handler.

## Traps

- **`return_to` is allow-listed.** The settings carry a live access token, so an
  arbitrary `return_to` would let a crafted link collect a token for the user's
  record. Only the `pebblejs:` scheme and loopback `http(s)` (the `pebble`
  tool's emulator configuration server) decode as a `ReturnTarget`. Anything
  else shows an error and offers no save.
- **The patient is picked by the server, not this page.** `launch/patient` asks
  the consent screen to pick one, and `patient/` scopes reach only that one, so
  there is nothing here to list. "Choose a different patient" links back to the
  app root to sign in again; `return_to` survives in session storage.
- **Save waits on the patient read.** Until the server has answered, the user
  has not seen who they are connecting the watch to; a failed read means the
  token the watch would get does not work either.
- **The watch's token expires.** No `offline_access`, so no refresh token: when
  the access token lapses the user reopens the settings page to reconnect.

## Scopes

`src/config.ts` requests
`launch/patient openid fhirUser patient/Patient.r patient/Observation.c`. That
string MUST equal the `allowed_scopes` of the `fhir-sync-pebble` client
(gatekeeper migration `0017_seed_fhir_sync_pebble_client`), element for
element. Nothing spans the TS/Rust boundary to check it; the mirrors are the
doc comment in `config.ts`, the migration's header, the vector asserted in
`gatekeeper-rust`'s `db/clients.rs`, and the `fhir-sync-pebble-dev` client in
`seeding.rs`'s `seed_dev_app_clients`. Change one, change all four.

## Development

`vp run -F fhir-sync-pebble-web dev` serves on the port
`slices/apps/dev-app-ports.json` pins for `fhir-sync-pebble-dev` (5195), whose
debug-only client registers `http://localhost:5195/` as its redirect. Open the
root and connect; append `?return_to=http://localhost:<port>/` to try the
handoff without a phone.

`vp test` for this package needs the workspace-local binary
(`node_modules/.bin/vp`) — the global `vp`'s bundled vitest cannot resolve
jsdom.

## References

- [apps/importer-web AGENTS.md](../importer-web/AGENTS.md) — the template app
- [slices/smart-app/AGENTS.md](../../slices/smart-app/AGENTS.md) — the shell this
  app boots through
- [slices/emr/AGENTS.md](../../slices/emr/AGENTS.md) — the SMART primitives
  (`useSmartHandshake`, `fetchPatient`)
- [apps/github-pages README](../github-pages/README.md) — how the site is
  assembled
