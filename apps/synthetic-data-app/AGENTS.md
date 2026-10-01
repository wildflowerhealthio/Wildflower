# AGENTS.md — apps/synthetic-data-app

The Synthetic Data Loader, a SMART-on-FHIR app published to
<https://wildflowerhealth.io/synthetic-data-app/> (package
`synthetic-data-app`), with a `synthetic-data-app-dev` row in debug builds. It
loads a published synthetic data snapshot — by default the one
[`wildflowerhealthio/synthetic-data`](https://github.com/wildflowerhealthio/synthetic-data)
deploys to <https://wildflowerhealthio.github.io/synthetic-data/> — into the
FHIR server it is connected to.

`apps/importer-web` is the template: the same two HTML entries, relative
`base`, build into the package's own `dist/`, `SmartAppRoot` shell, and a
memory router carrying a SMART-built context, because the slice screen reads
its authed runner from route context. Like the Importer, **this app writes.**

## Boot structure

- `src/main.tsx` — the `index.html` entry: imports `react-tundraish/styles`,
  completes a GitHub Pages 404 redirect (`restoreRedirectedUrl`), starts the
  OS colour-scheme listener and renders `<AppRoot />`.
- `src/app-root.tsx` — `AppRoot`: `SmartAppRoot` (`app="syntheticData"`, the
  standalone config and `smartAppTelemetry`) around `<App />`. The shell's telemetry consent dialog comes first: until the
  visitor answers, neither the connect menu nor the app mounts, and nothing
  loads. `smartAppTelemetry` names the app's own Sentry project through the
  `VITE_SENTRY_DSN_SYNTHETIC_DATA_APP` build variable (see `.env.example`), with
  `synthetic-data-app` as its `app` tag. A bare visit shows
  `APP_DESCRIPTIONS.syntheticData`'s landing beside the `ConnectMenu`.
- `src/launch-main.tsx` — the `launch.html` entry: `runSmartLaunchEntry`.
- `src/app.tsx` — `App` completes the handshake (`useSmartHandshake`; a
  failure goes back to the app root through `useLaunchFailureRedirect`) and
  builds the router context with `buildSmartRouterContext` over the plain
  `FetchHttpClient.layer` and the shell's `QueryClient`. `SyntheticDataApp`
  renders the title and the server it loads into, and mounts
  `synthetic-data-react`'s `SyntheticDataScreen` at
  `PUBLISHED_SNAPSHOT_ADDRESS` under a memory router.
- `src/config.ts` — the scope string, the client id, the published snapshot's
  address and the telemetry target.

## Rules

- **Compose; decide nothing.** Reading the snapshot, choosing its people,
  checking its files, the write order and the results are
  `synthetic-data-react`'s and `synthetic-data-core`'s. The app owns the SMART
  shell, the router context and the address the page starts at.
- **The scopes are create and update on the importers' types.** A snapshot is
  importer output, and the loader writes it with batch `PUT`s, so
  `SYNTHETIC_DATA_SCOPE` is `launch openid fhirUser` plus `system/<Type>.cu`
  for each type the importers write. A type the scope string leaves out is
  rejected per entry, and shows in the results.
- **`clientId` equals the app id it is launched through**
  (`synthetic-data-app`, or `synthetic-data-app-dev` in a vite dev build): the
  host's redirect resolver looks an app up by `client_id`.
- **The session never reaches the snapshot's host.** The screen fetches the
  snapshot's files itself, without credentials; the bearer token rides only on
  requests to the FHIR base.

## Registration

The production `synthetic-data-app` registry row and OAuth client are not
seeded yet. In development, debug builds of the host seed a
`synthetic-data-app-dev` **cloud** row on the port
`slices/apps/dev-app-ports.json` pins (5198) and its OAuth client
(`apps-rust`'s `seed_dev_apps`, `gatekeeper-rust`'s `seed_dev_app_clients`),
so the homescreen carries a "Synthetic Data (Dev)" tile that launches whatever
is serving that port. The dev client's scopes are
`SYNTHETIC_DATA_DEV_SCOPES`; a `seeding.rs` test reads `config.ts` and fails
unless it requests exactly them.

## Running locally

```bash
vp run -F synthetic-data-app dev     # strictPort, from slices/apps/dev-app-ports.json
```

Open the printed `http://localhost:5198/`, connect to a FHIR server (a
Wildflower host, or the SMART Health IT sandbox), and load the snapshot. To
load a snapshot built locally in the data repo, serve its `site/` folder and
enter that address.

## Testing

- `app.test.tsx` — the real `buildSmartRouterContext` over a stub transport
  and a stubbed `fetch`: the page starts at the published snapshot, its files
  are fetched without credentials or a token, every write goes to the FHIR
  base with the bearer token, in reference order, and every type written is
  one the scope string may create and update.
- `app-root.test.tsx` — `AppRoot` mounts the shell as the loader and starts
  telemetry with this app's DSN and name.
- `main.test.tsx` — the Pages 404 redirect is completed before anything reads
  the URL.

## References

- [synthetic-data-react AGENTS.md](../../slices/synthetic-data/synthetic-data-react/AGENTS.md)
  — the screen this app mounts.
- [synthetic-data-core AGENTS.md](../../slices/synthetic-data/synthetic-data-core/AGENTS.md)
  — the snapshot's files, and reading them back.
- [slices/smart-app/AGENTS.md](../../slices/smart-app/AGENTS.md) — the shell
  and the consent gate.
- [apps/importer-web AGENTS.md](../importer-web/AGENTS.md) — the template.
- [apps/AGENTS.md](../AGENTS.md) — the rules every app follows.
