# AGENTS.md — slices/

Vertical product slices. Each slice owns a feature end-to-end (HTTP API, store, UI adapters) and is layered into a pure core plus optional platform adapters.

## Slice Layout

Every slice is a `<name>-core` (usually) plus optional platform adapters. The suffix names the target:

```text
slices/<name>/
├── <name>-core            # Pure logic: schemas, HttpApi definitions, business rules (no DOM/fs/platform imports)
├── <name>-react           # Browser UI adapter — the dominant web adapter
├── <name>-rust            # Native/server Rust adapter
├── <name>-tauri           # Tauri host adapter (TS side)
├── <name>-tauri-rust      # Tauri host adapter (Rust side)
├── <name>-node            # Node.js adapter
└── <name>-web             # Browser (non-React) adapter — currently only telemetry
```

Slices may also carry slice-specific packages (e.g. `collector-fundamentals`, `fhir-r4-client-collector`, `fhir-r4` / `fhir-r4-react` under `emr`). A few slices are Rust-only with no `-core` (`persistence`).

Current slices: `anonymizer`, `apps`, `branding`, `browser-sniffer`, `collector`, `databases`, `emr`, `file-formats`, `fhir-sync-pebble`, `gatekeeper`, `har-recorder`, `health-viewer`, `http-extraction`, `importer`, `medication`, `navigation`, `persistence`, `scopes`, `shared-structures`, `smart-app`, `synthetic-data`, `telemetry`, `tunnel`, `watch-lifts`, `web-trace`. Verify with `ls slices/` — this list can go stale.

`http-extraction` owns the abstract fundamentals of extracting entities from HTTP traffic (`HttpResponseKind` / `Extraction` / `UrlMatch` / `Specificity`) plus per-source packages (`fhir-r4-source`, `web-trace-source`) — see [http-extraction/AGENTS.md](./http-extraction/AGENTS.md). Two slices build on it and neither owns it: `collector` runs the vocabulary live against a sniffer webview, and `importer` — the user-facing app flow plus per-file-format import pipelines — runs it over uploaded `.har` archives, previewing extracted FHIR resources it can then opt-in persist — see [importer/AGENTS.md](./importer/AGENTS.md).

`medication` owns a patient's medication list end-to-end — see [medication/AGENTS.md](./medication/AGENTS.md). Its `medication-core` holds the shared name-matching fundamentals (the minimal `Medication` type, name normalization, containment scoring) plus, behind the `medication-core/fhir` subpath, the FHIR R4 `MedicationRequest` adapters that build those values; two features build on it, neither owning the base: `medication-sponsorship-*` matches against patient-support program lists, and `medication-interaction-*` against the DDInter drug-interaction database.

`health-viewer` plots a patient's own observations and medications on one time
axis — see [health-viewer/AGENTS.md](./health-viewer/AGENTS.md). Like
`http-extraction`, it layers a domain-free vocabulary under per-domain packages:
`health-viewer-fundamentals` holds the plot vocabulary and chart math (point and
level series, value axes, the crosshair), `health-viewer-observations` reads FHIR
`Observation`s into it, `health-viewer-medications` reads `medication-core`'s
dose regimens into it, and `health-viewer-core` assembles the sources with the
catalogue, range presets and the URL codec a shared link round-trips through —
all pure functions, property-tested without a DOM. `health-viewer-react` draws
the fundamentals' series with Observable Plot, importing no domain package.

`fhir-sync-pebble` holds what the Pebble watchapp's settings page decides — see
[fhir-sync-pebble/AGENTS.md](./fhir-sync-pebble/AGENTS.md). Its
`fhir-sync-pebble-core` is the patients the page lists, the settings the watch
receives, the allow-listed
`return_to` they are handed back through, and the store that keeps it across
the SMART login, as pure functions; `apps/fhir-sync-pebble-web` is the page
that runs them.

`watch-lifts` holds what the WatchLifts Pebble watchapp's settings page edits
— see [watch-lifts/AGENTS.md](./watch-lifts/AGENTS.md). Its `watch-lifts-core`
is the exercises, people and default weights the watch mirrors, the weights
as the page edits them, and the phone's decoding, storage and message to the
watch, as pure functions; `apps/watch-lifts-web` is the page.

`synthetic-data` is tooling for synthetic health data — see
[synthetic-data/AGENTS.md](./synthetic-data/AGENTS.md). Like `health-viewer`, it
layers a source-free base under per-source packages:
`synthetic-data-fundamentals` holds three roles as sub-entries: the story model
(`/story`: people, prescriptions, lab draws, every date relative to one as-of
date), deterministic values (`/seeding`, hashed with `kitchen-sink`'s FNV-1a and
`fmix64` over `fhir-r4`'s id fold), and Chrome capture defaults (`/chrome-har`,
on `http-archive`'s format and DevTools vocabulary); a
source's generator is a `synthetic-data-<source>` package on top of it that
writes a story as the files that source produces, proven through the real
importer (`synthetic-data-rexall-be-well` writes a letsbewell.ca session HAR,
`synthetic-data-shoppers-drugmart` a mypharmacy.shoppersdrugmart.ca one, and
`synthetic-data-lifelabs` the resources a LifeLabs report imports as, and
`synthetic-data-fhir-sync-pebble` the Observations a Pebble watch syncs, and
`synthetic-data-dicom` a de-identified image re-identified as a person);
`synthetic-data-core` lays their importer output out as a data set's files and
`index.json`.
The stories themselves live in `wildflowerhealthio/synthetic-data`.

`smart-app` is the Wildflower chrome a self-hosted SMART app boots through (`SmartAppRoot`, the launch-page entry, `ConnectMenu`) — see [smart-app/AGENTS.md](./smart-app/AGENTS.md). It joins `emr`'s SMART primitives to `branding`'s chrome, so neither of those depends on the other.

`web-trace` records a browsing session as FHIR `DocumentReference`s and exports a redacting HAR — see [web-trace/AGENTS.md](./web-trace/AGENTS.md). Its `web-trace-core` sits below both a collector and a React app (`web-trace-react`, the on-device viewer), which is why it is a slice of its own rather than a package inside either. The collector that consumes it, [`web-trace-collector`](./collector/web-trace-collector/AGENTS.md), lives in the `collector` slice — a `*-client-collector` belongs where the descriptor seam is, not next to the codec it imports.

## Rules

- **`<name>-core` is the pure layer** — no DOM, no Node `fs`, no platform-specific imports
- **Platform adapters depend on `-core`, never the reverse**
- **Compose `HttpApi` groups across slices via the phantom-id bridge pattern** — see [HttpApi Composition How-To](../docs/Effect/HttpApi%20Composition%20How-To.md)
- **Don't use `topLevel: true` on multiple `HttpApiGroup`s under the same `HttpApi`** — name collision in the generated client. See [HttpApi Composition How-To](../docs/Effect/HttpApi%20Composition%20How-To.md).
- **In a `<name>-react` route file, annotate `useRouteContext`'s `select`.** A slice type-checks both standalone (`vp run --filter <slice> check`) and mounted under `apps/wildflower-react`. Standalone there is no registered Router, so `RegisteredRouter` falls back to `AnyRouter` and a bare `Route.useRouteContext()` / `useRouteContext()` widens to `any` (`no-unsafe-assignment` under oxlint). Fix without a cast: give the slice its own structural `RouterContext` (`BaseRouterContext.RouterContextWith<…>`, re-declared per slice — never imported from the app), and read context through an annotated select, e.g. `useRouteContext({ from: '__root__', select: (context: RouterContext) => context.runAuthed })`. `Route.useParams()` needs no annotation (params come from the route's own path). See `slices/collector/collector-react/src/queries/use-run-authed.ts` for the pattern.

## References

- [HttpApi Composition How-To](../docs/Effect/HttpApi%20Composition%20How-To.md) — Phantom-id bridge, `*ApiHandlersFor<ParentId>()`, `topLevel` collision
- [Effect Patterns Reference](../docs/Effect/Patterns%20Reference.md) — Tag/Layer wiring used inside slice cores
- [Bridge Explanation](../docs/Messaging/Bridge%20Explanation.md) — The webview ↔ host bridge slices declare messages on (`<name>-core/src/bridge.ts`); see the [Wire Pinning How-To](../docs/Messaging/Wire%20Pinning%20How-To.md) when a message crosses TS ⇄ Rust
- [Learnings Inbox](../docs/Agents/Learnings%20Inbox.md) — Slice-specific vp-pack gotchas not yet promoted
