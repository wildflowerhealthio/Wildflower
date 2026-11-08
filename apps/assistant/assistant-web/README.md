# assistant-web

The first-party Assistant SMART-on-FHIR app: a chat with Claude over a
patient's record, using the user's own Anthropic API key. One HTML entry,
`index.html`: the app root, which starts a SMART launch its URL carries (an
EHR's `iss` and `launch`, or a lone `iss`), completes the handshake and renders
the app when a callback is in the URL, and shows the standalone connect menu,
where the user picks a FHIR server, on a bare visit.

The page settles on a patient and, under it, mounts the chat
(`assistant-react`'s `AssistantChat`) about that patient's record.

## Boot structure

The entry runs on `smart-app-react`, the chrome every first-party SMART app
boots through (see [slices/smart-app-react/AGENTS.md](../../../slices/smart-app-react/AGENTS.md)),
exactly as `apps/plots/plots-web` does.

`src/main.tsx` is the `index.html` entry: it imports the design-system
stylesheet module (`react-tundraish/styles`), completes a GitHub Pages 404
redirect, wires the OS colour-scheme listener, and renders `<AppRoot />` inside
`<StrictMode>`.

`src/app-root.tsx` exports `AppRoot`: `<SmartAppRoot app="assistant"
registration={smartRegistration} telemetry={smartAppTelemetry}>` around
`<App />`. `SmartAppRoot` shows the telemetry consent dialog first, then
starts a launch the URL carries under a loading line or renders one of the
other two branches (`smartAppTelemetry` in `src/config.ts` names the app's
Sentry project through the `VITE_SENTRY_DSN_ASSISTANT_WEB` build variable; see
`.env.example`), owns the single `QueryClientProvider`, and branches, latched
on mount, on whether a SMART callback is in the URL — the slim `BrandBar`
above `<App />` when launched, the full Wildflower chrome with
`APP_DESCRIPTIONS.assistant`'s `AppLanding` beside `ConnectMenu` on a bare
visit. The package exports `AppRoot` via the `source` condition for future
aggregator-shell composition.

## The page

- **Patient** (`src/app.tsx`'s `App`, over `smart-app-react`'s
  `usePatientChoice`). The URL's `?patient=`, else the launch's
  patient (`connection.launchPatientId`). With neither, the page is `smart-app-react`'s
  `PatientPicker` ("All patients" first, then name and birth date per row from
  `fetchPatientPage`, a "More patients" button while the server has more);
  choosing writes `?patient=<id>`, or `?patient=*` for All patients, to the
  URL. Under the title, `PatientChoiceLine` names the choice —
  `Name · born YYYY-MM-DD` from one `fetchPatient` read, or "All patients" —
  with a "Change patient" link back to the picker.
- **Body**, under the chosen patient: `AssistantChat`, keyed per choice. For
  one patient it waits for the `Patient` read the choice line makes
  (`patientQuery`, one cache entry for both) and passes the `Patient`
  record, whose name and birth date the system prompt states; for All
  patients it mounts at once.

## Where the bundle is served

`vp build` writes this package's default `dist/`, and that build is served in
one place: **the published site**, at
<https://assistant.wildflowerhealth.io/>.
`.github/workflows/deploy-pages-site.yml` publishes `dist/` to the root of the
`gh-pages` branch of `wildflowerhealthio/assistant-web`, which Pages serves at
that origin ([apps/wildflower-site AGENTS.md](../../wildflower-site/AGENTS.md)), and
each pull request that changes it previews the same build under
`https://assistant.wildflowerhealth.io/pr-<n>/`.
The published page launches standalone against any SMART server, such as the
[SMART Health IT sandbox](https://launch.smarthealthit.org/). Nothing ships on
device.

## Registration

`src/config.ts`'s `clientId` is the `assistant` tile's client,
`9883d102933b1561e343cae5fd9f26eb`, in a production build and the
`assistant-dev` tile's, `17613ed083c9fded0178ed0c5ebf7cfe`, under the vite
dev server (random ids, not the tile ids). Each must equal the `client_id` of
the app row it is launched through — a launch checks the caller's grant against
that client's scopes, and `/authorize` matches the redirect against that
client's registered URIs — and its scope string, `ASSISTANT_SCOPE`
(`launch openid fhirUser system/*.cruds`), must equal the client's allowed
scopes; `authorization-server-rust`'s `seeding.rs` test reads `config.ts` to
hold both clients to it. The scope asks for everything; the Owner narrows it
on the consent prompt, and the grant, not the string, decides what the agent
can do.

- **`assistant`** is a row (apps migration `0026_seed_assistant_app`)
  launching `https://assistant.wildflowerhealth.io/?launch={launch}&iss={origin}`.
  Its public OAuth client (the authorization server migration
  `0051_seed_assistant_client`) redirects to
  `https://assistant.wildflowerhealth.io/`, with the data apps' refresh
  policy: a week idle, 30 days at most, outliving the browser session.
- **`assistant-dev`** is seeded in debug builds only, at runtime rather
  than by a migration: a row on the dev server's port
  (`apps-rust/src/dev_seed.rs`) and its client, redirecting to
  `http://localhost:<port>/` (`authorization-server-rust/src/seeding.rs`).

The App Catalog (`app-catalog-web/public/apps.json`) and the marketing site's
`suggested_apps.json` publish the same client registration.

## Running locally

```bash
vp run -F @wildflowerhealthio/assistant-web dev     # strictPort, from dev-app-ports.json
```

**Standalone**: open the printed `http://localhost:<port>/`, pick a server on the
connect menu (the SMART Health IT sandbox works), sign in, and choose a patient
(or All patients) in the app.

**From a Wildflower host**: debug builds of the host seed an
`assistant-dev` row on that port plus its own OAuth client
(`apps-rust`'s `seed_dev_apps` / `authorization-server-rust`'s `seed_dev_app_clients`),
so the homescreen carries a "Wildflower Assistant (Dev)" tile that launches
whatever is serving that port — the vite dev server when it is up, nothing
when it is down. A launch with a patient in context opens on that patient. The
port has a single source, `dev-app-ports.json`: `vite.config.ts` reads it
through the shared `devAppServer` helper in the root `vite.config.base.ts` and
`apps-rust` embeds it, so the dev server and the row cannot drift.

The seed only ever writes rows it owns. If an app you uploaded already holds the
`assistant-dev` id, the seed logs a warning and leaves it untouched
rather than adopting it — you get no dev tile until that app is renamed.
