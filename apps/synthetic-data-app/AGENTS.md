# AGENTS.md — apps/synthetic-data-app

The Synthetic Data Loader, a SMART-on-FHIR app published to
<https://wildflowerhealth.io/synthetic-data-app/> (package
`synthetic-data-app`), with a `synthetic-data-app-dev` row in debug builds. See
[README.md](./README.md) for the boot structure, the page and how to run it.

`apps/health-viewer` is the template: the same two HTML entries, relative
`base`, build into the package's own `dist/`, and `SmartAppRoot` shell. The
router context around the slice screen is `apps/importer-web`'s, because the
screen writes through `useRunAuthed` as `importer-react` does — and so are the
`tsconfig.json` (`customConditions: ["source"]`, so the router context's
`QueryClient` is `@tanstack/react-query`'s own type) and the plain `vp build`
script.

## Rules

- **Compose; decide nothing.** The app mounts `synthetic-data-react`'s
  `SyntheticDataScreen` and owns only the SMART shell, the router context and
  the data set URL. Reading the data set, the people, the write order and
  batches, and the results are the slice's.
- **The data set URL lives in this tab's `sessionStorage`.** `main.tsx` keeps a
  bare visit's `?dataSet=` (`rememberDataSetParam`) before the SMART redirect
  drops it; the page starts from the kept URL, else `DEFAULT_DATA_SET_URL`, and
  keeps each URL the reader submits. Nothing writes the address bar.
- **The data set is read without the FHIR token.** `synthetic-data-react`
  fetches its files from the data set's own host through `globalThis.fetch`,
  with no credentials, so a `?dataSet=` naming this origin does not read it
  with its cookies. Only the FHIR writes go through the router context's HTTP
  layer, which addresses the handshake's server and carries its bearer token.
- **The scope string is the Importer's write set for the types a data set
  holds.** `config.ts`'s `SYNTHETIC_DATA_SCOPE` is pinned to the dev client's
  `SYNTHETIC_DATA_DEV_SCOPES` by `gatekeeper-rust`'s `seeding.rs` test, and
  `app.test.tsx` checks it names a `.cruds` scope for each type in
  `synthetic-data-react`'s `WRITE_ORDER`.

## Testing

- `app.test.tsx` mounts `SyntheticDataApp` over the real
  `buildSmartRouterContext`, with a recording FHIR transport and a stubbed
  `globalThis.fetch` serving a data set `DataSet.assemble` built: a load
  writes each resource to the FHIR base with the bearer token, the data set is
  read only from its own host and with no credentials, a submitted URL is read and kept, and the scope
  string covers `WRITE_ORDER`.
- `data-set-url-memory.test.ts` — the published set until one is kept, the
  last URL kept, a page's `?dataSet=` kept, and a page without one (the OAuth
  callback) leaving the kept URL alone.
- `app-root.test.tsx` — that `AppRoot` mounts the shared shell as this app
  (the landing `h1` is `APP_DESCRIPTIONS.syntheticData.name`); the shell
  itself is tested in `smart-app-react`.
- `main.test.tsx` — the Pages 404 redirect is completed before anything reads
  the URL, and a visit's `?dataSet=` is kept.

## References

- [slices/synthetic-data/synthetic-data-react/AGENTS.md](../../slices/synthetic-data/synthetic-data-react/AGENTS.md)
  — the screen this app mounts.
- [apps/health-viewer/README.md](../health-viewer/README.md) — the template.
- [apps/importer-web](../importer-web/AGENTS.md) — the router context for a
  slice that writes through `useRunAuthed`.
- [apps/AGENTS.md](../AGENTS.md) — the rules every app follows.
