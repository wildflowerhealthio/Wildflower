# AGENTS.md — apps/fhir-sync-pebble/fhir-sync-pebble-web

FHIR Sync for Pebble: the settings page of a Pebble watchapp that syncs the
steps, sleep and heart rate the Pebble already records to a FHIR server. It is
a SMART-on-FHIR app served from the published GitHub Pages site
(`/fhir-sync-pebble`). The Pebble phone app opens it; the user signs in to a
FHIR server, picks the patient from the server's list, and saves, which hands
the watch what its PebbleKit JS needs to write that data as Observations on the
patient's record.

`apps/importer/importer-web` is the template for the shape (`SmartAppRoot`, a relative
`base`, a build into the package's own `dist/`, a memory router carrying a
SMART-built context). What differs is below.

## Layout

- `app.tsx` — `App` is the only component that holds the fhirclient `Client`.
  It completes the handshake and turns it into two things: a router context
  (`buildSmartRouterContext`), and the `PebbleSettings.Connection` the grant
  carried (token, server).
  `SettingsApp` mounts the router over that context, so the patient search
  takes its authed runner from route context (`fhir-r4-react`'s
  `useRunAuthed`), like every other first-party SMART app's reads.
- `settings-page.tsx` — the page: `Either.all` of the connection and the
  recalled return target picks the confirmation or a refusal banner, whose
  message is an `Effect` `Match` on the refusal's tag.
- `patient-summaries-query.ts` — the `Patient` search as TanStack Query
  options and a hook, shaped like `fhir-r4-react`'s `patientsQueryOptions`. It
  goes out through the router context's `HttpClient` (the SMART HTTP layer,
  which addresses it to the granted server and adds the bearer token) and reads
  the body with the core's lenient `PatientSummary.fromSearchBundle`.
- `patient-confirmation.tsx` — lists the patients in the consent screen's
  `PatientPillPicker` (`scopes-react`), shows the picked one, and owns the
  save, which completes the settings with `PebbleSettings.withPatient`.
- `patient-details.tsx` — the picked patient's summary. Its name and the
  watch's `patientName` are one string, `fhir-r4`'s `HumanName.displayName`.
- The decisions live in the core,
  [`fhir-sync-pebble-core-js`](../AGENTS.md), whose
  namespace modules this app imports by name: `PatientSummary` (a listed
  patient, read leniently) and `PebbleSettings` (the watch's wire shape).
  The Pebble side of the hand-off is
  [`pebble-configuration`](../../../global/pebble/pebble-configuration/README.md)'s:
  `ReturnTarget` (the allow-listed `return_to` and the hand-off URL) and
  `ReturnTargetStore` (the `Store` that keeps `return_to` across the login,
  over the `sessionStorage` this app hands it, under `config.ts`'s
  `RETURN_TO_STORAGE_KEY`). The app holds no
  business logic of its own — it reads the handshake and the patients, and
  renders.

The npm package is `fhir-sync-pebble-web`; the OAuth `client_id` is
`fhir-sync-pebble` (`fhir-sync-pebble-dev` in a vite dev build), and the
published path segment is `fhir-sync-pebble`.

## Standalone only

No EHR launches it and there is no homescreen tile — no `apps-rust`
registration, production or dev. The page is only ever opened from the Pebble phone app, so
the root URL is the SMART login: `SmartAppRoot`'s standalone branch renders the
app's `AppLanding` beside the `ConnectMenu`. The OAuth callback lands back on the
same `index.html`, where `SmartAppRoot`'s launched branch mounts `App`.

## The Pebble configuration handoff

The app implements the Pebble "App Configuration (Static)" contract:

1. The phone app opens the page with `?return_to=<url>`. `main.tsx` keeps it in
   a `ReturnTargetStore` (from `pebble-configuration`) over `sessionStorage`
   before anything navigates,
   because the SMART login leaves for the server's authorize page and the
   callback comes back without it. `sessionStorage`, not `localStorage`: the
   target must outlive the round trip in this tab and nothing longer.
2. Once the handshake completes, the settings page searches the server's
   patients and lists them; the user picks the one the watch will record for,
   and the page shows who that is. Picking another is a click, not another
   sign-in.
3. Save navigates to `return_to` + `encodeURIComponent(JSON.stringify(settings))`,
   falling back to the guide's `pebblejs://close#` when the page was opened
   without one.

`PebbleSettings` (`fhir-sync-pebble-core-js`) is the wire shape the watchapp
parses — flat, with `null` for what the record lacks:

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
shows — `fhir-r4`'s `HumanName.displayName`, the name the patient goes by now
(`official` over `usual`, former and ended names passed over), rendered
`given family`, else the name's text. `patientBirthDate` is the string the
server wrote, partial dates (`1970`, `1970-05`) included. The settings are built
in two steps because the facts arrive separately: the grant gives a
`Connection` (token, server), and the save adds the patient the user picked
(`withPatient`). The watchapp decodes the shape with `PhoneSettings.decodeResponse`,
beside `PebbleSettings` in `fhir-sync-pebble-core-js`: `PebbleSettings.Schema` is
pinned to `PhoneSettings.Settings`, so the two can't change apart, and
`phone-settings.test.ts` round-trips `toJson` through the decoder.

## Traps

- **`return_to` is allow-listed.** The settings carry a live access token, so an
  arbitrary `return_to` would let a crafted link collect a token for the user's
  record. Only the `pebblejs:` scheme and loopback `http(s)` (the `pebble`
  tool's emulator configuration server) decode as a `ReturnTarget`. Anything
  else shows an error and offers no save.
- **The patient is picked on this page, not by the server.** The scopes are
  `system/`, so the grant carries no patient and the page lists every patient
  the token can search. The watch's token is just as wide: it can list and
  read every patient on the server and create Observations for any of them;
  the watch writes against the `patientId` it was handed.
- **The patient list is read leniently, not through `fhir-r4`'s `Patient`
  schema.** That schema refuses legal FHIR such as a partial `birthDate`
  (`1970`), and a strict bundle decode fails the whole list for one such
  patient. `PatientSummary.fromSearchBundle` drops only an entry it cannot read
  (no id, a mistyped field). The list is one page — `_sort=family`,
  `_count=RESOURCE_PAGE_SIZE` (200) — so a server with more patients shows the
  first page's worth.
- **Not every SMART server will grant `system/` scopes here.** Asking for
  `system/` scopes in a user's standalone `authorization_code` launch is how a
  Wildflower server works, but many third-party servers grant `system/` only
  to backend services (client credentials). On such a server the sign-in
  either fails at `/authorize` or yields a token whose `Patient` search 403s,
  and the page shows that error with nothing to pick. Say "a Wildflower
  server, or one that grants `system/` scopes to a signed-in user", never
  "any FHIR server", in user-facing copy.
- **Save waits on a pick.** Until the user has picked, they have not said who
  the watch records for. A failed search shows its error and offers no pick —
  the token the watch would get does not work either.
- **The watch's token expires.** No `offline_access`, so no refresh token: when
  the access token lapses the user reopens the settings page to reconnect.

## Scopes

`src/config.ts` requests
`openid fhirUser system/Patient.rs system/Observation.cu`: `system/` rather than
`patient/` because the page picks the patient after the grant, so there is no
patient context for a `patient/` scope to reach (the same reasoning the other
first-party clients document). That string MUST equal the `allowed_scopes` of the `fhir-sync-pebble` client
(gatekeeper migration `0017_seed_fhir_sync_pebble_client`, widened by `0018`), element for
element. Nothing spans the TS/Rust boundary to check it; the mirrors are the
doc comment in `config.ts`, the migration's header, the vector asserted in
`gatekeeper-rust`'s `db/clients.rs`, and the `fhir-sync-pebble-dev` client in
`seeding.rs`'s `seed_dev_app_clients`. Change one, change all four.

## Development

`vp run -F fhir-sync-pebble-web dev` serves on the port
`dev-app-ports.json` pins for `fhir-sync-pebble-dev` (5195), whose
debug-only client registers `http://localhost:5195/` as its redirect. Open the
root and connect; append `?return_to=http://localhost:<port>/` to try the
handoff without a phone.

`vp test` for this package needs the workspace-local binary
(`node_modules/.bin/vp`) — the global `vp`'s bundled vitest cannot resolve
jsdom.

## References

- [apps/importer/importer-web AGENTS.md](../../importer/importer-web/AGENTS.md) — the template app
- [apps/fhir-sync-pebble AGENTS.md](../AGENTS.md) —
  the core the settings, the return target and its store live in
- [slices/smart-app/AGENTS.md](../../../slices/smart-app/AGENTS.md) — the shell this
  app boots through
- [slices/emr/AGENTS.md](../../../slices/emr/AGENTS.md) — the SMART primitives
  (`useSmartHandshake`, `buildSmartRouterContext`)
- [apps/wildflower-site/wildflower-site-web README](../../wildflower-site/wildflower-site-web/README.md) — how the site is
  assembled
