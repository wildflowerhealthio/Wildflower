# medications-app

The first-party Medications SMART-on-FHIR app: two HTML entries, `launch.html`
(the EHR launch endpoint that starts the OAuth2 authorize redirect) and
`index.html` (the app root — the redirect target that completes the handshake
and renders the app when a callback is in the URL, and the standalone connect
menu, where the user picks a FHIR server, on a bare visit).

## Where the bundle is served

Both places come from the same build output (`outDir`
`slices/apps/self-hosted-apps/medication`, which cannot move — see the comment in
`vite.config.ts`):

- **On the published site**, at
  [`/medications-app`](https://wildflowerhealth.io/medications-app) —
  `github-pages` copies that directory into the Pages artifact
  ([../github-pages/README.md](../github-pages/README.md)). This is the
  **production** launch target: the `medications-app` registry row is a _cloud_
  row pointing at that URL.
- **On device**, as the fallback content of the debug-only `medications-app-dev`
  self-hosted row, for when the vite dev server is not running.

## Registration

The app row and its OAuth client are seeded by migrations that must stay in
lockstep — an app registration whose `client_id` has no registered client cannot
launch:

- `slices/apps/apps-rust/migrations/0003_seed_wildflower_medication_app/` (the
  original self-hosted seed) and `0005_first_party_apps_to_cloud/` (the rename to
  `medications-app` + the flip to a cloud row served from the published site)
- `slices/gatekeeper/gatekeeper-rust/migrations/0004_seed_wildflower_medication_client/`
  and `0006_rename_first_party_app_clients/`

`src/config.ts`'s `clientId` must equal the app id it is launched through, for
both the production and the dev registration — the host's redirect resolver looks
an app up by `client_id`, so the app-relative redirect only resolves when the two
are equal.

## Running the dev server

```bash
vp run -F medications-app dev     # strictPort, from slices/apps/dev-app-ports.json
```

Debug builds of the host additionally seed a `medications-app-dev` **self-hosted**
row on that port plus its own OAuth client (`apps-rust`'s `seed_dev_apps` /
`gatekeeper-rust`'s `seed_dev_app_clients`), so the homescreen carries a
"Medications (Dev)" tile that launches whatever is serving that port — the vite
dev server when it is up, otherwise the host's copy of the vendored build. The
port has a single source, `slices/apps/dev-app-ports.json`: the vite config reads
it and `apps-rust` embeds it, so the dev server and the row cannot drift.

The seed only ever writes rows it owns. If an app you uploaded already holds the
`medications-app-dev` id, the seed logs a warning and leaves it untouched rather
than adopting it — you get no dev tile until that app is renamed.
