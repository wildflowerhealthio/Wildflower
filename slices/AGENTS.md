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

Slices may also carry slice-specific packages (e.g. `collector-fundamentals`, `fhir-r4-client-collector`, `fhir-r4` / `fhir-r4-react` under `emr`). A few slices are Rust-only with no `-core` (`persistence`, `wildflower-server`).

Current slices: `anonymizer`, `apps`, `background-server-service`, `branding`, `browser-sniffer`, `collector`, `databases`, `emr`, `file-formats`, `gatekeeper`, `har-recorder`, `health-viewer`, `http-extraction`, `importer`, `medication`, `navigation`, `persistence`, `request-log`, `scopes`, `servers`, `shared-structures`, `smart-app`, `synthetic-data`, `telemetry`, `tunnel`, `web-trace`, `wildflower-server`. Verify with `ls slices/` — this list can go stale.

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

FHIR Sync for Pebble is not a slice: the watchapp, its settings page and their
pure core live together in `apps/fhir-sync-pebble` — see
[apps/fhir-sync-pebble/AGENTS.md](../apps/fhir-sync-pebble/AGENTS.md). Its
`fhir-sync-pebble-core-js` is the patients the page lists, the settings the
watch receives, and the phone's decoding of the watch's data, as pure
functions.

WatchLifts is not a slice either: the watchapp, its settings page and their
pure core live together in `apps/watch-lifts` — see
[apps/watch-lifts/AGENTS.md](../apps/watch-lifts/AGENTS.md). Its
`watch-lifts-core-js` is the exercises, people and default weights the watch
mirrors, the weights as the page edits them, and the phone's decoding, storage
and message to the watch, as pure functions.

`request-log` keeps each forwarded request the server served: through the
tunnel, or relayed by a front run on this machine. Its `request-log-rust` owns the `logged_requests` table in `wildflower.sqlite`:
the server's forwarded-request layer reports each request on
`RequestLog::forwarded_request_tx`, a writer task records them in batches,
trimmed to a row cap per caller class, and a sweep drops rows past 30
days. It serves the log at
`GET /requests` and `GET /requests/callers`, gated by `wildflower/RequestLog.r`.
`request-log-core` is that API as an `HttpApi` and its client;
`request-log-react` is the `/settings/requests` page: the recent-activity card,
the filtered log and its CSV export.

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
`synthetic-data-core` assembles their importer output as a `Snapshot`: its
entries' files and an `index.json` header, and reads them back;
`synthetic-data-react` loads a published snapshot into a FHIR server, mounted
by `apps/synthetic-data-app`.
The stories themselves live in `wildflowerhealthio/synthetic-data`.

Lifting is not a slice either: a person's strength-training plan, its screens
and the SMART app around them live together in `apps/lifting` — see
[apps/lifting/AGENTS.md](../apps/lifting/AGENTS.md). Its `lifting-core-js` is
the plan as FHIR R4 resources (a `PlanDefinition`, the `ServiceRequest` the
lifter works at per exercise, a `Procedure` per workout and an `Observation`
per set) and the increment / hold / deload decision over completed workouts,
as pure functions; its `lifting-react` renders the planned workout, the
submitted workout's outcome, starting a program, the plan editor and the
workout history over that core.

`wildflower-server` is the server the Tauri host runs: `wildflower-server-rust`'s
`set_up` composes every server slice into one API, binds the loopback port and
opens the tunnel listener, and `WildflowerServer::serve` serves the API on both
until its shutdown token is cancelled — see
[wildflower-server/AGENTS.md](./wildflower-server/AGENTS.md). It has no `tauri`
dependency; the host passes its native adapters in as trait objects, and
watches the server through host-owned observer channels.

`background-server-service` is the server-status wire, kept for the web app
to read a server's status over a future websocket — see
[background-server-service/AGENTS.md](./background-server-service/AGENTS.md).
`background-server-service-rust` is its serde mirror with golden tests. The
TS side lives with the launcher in `apps/launcher`, not in this slice:
[`wildflower-server-core-js`](../apps/launcher/wildflower-server-core-js/AGENTS.md)
is the wire's TS schema, and
[`wildflower-server-react`](../apps/launcher/wildflower-server-react/AGENTS.md)
the banner and `/settings/server` page that render a status snapshot. Nothing
sends or answers the wire today.

`servers` is the install's list of servers — see
[servers/AGENTS.md](./servers/AGENTS.md). `servers-rust` holds a
`ServerRecord` per server, identified by its domain
(`<tunnel name>.<relay domain>`), in `<data root>/servers.json` behind the
`ServerRegistry` port; the file is versioned, replaced atomically, and the
only place a server's tunnel token is written in full. It also enrols a
server: for a Wildflower relay, official or self-hosted, its
`GET /rathole` is fetched and checked, and a `GET /me` signed with the token
confirms the tunnel before the record is written; a rathole server, with
no Wildflower relay site, is entered as its settings, which get the same
checks. A relay's identity (its dial address and noise key) is pinned when
the server is added, and re-entering a token refuses a relay that presents
another. Each server runs as a `ServerUnit`, one unit on the Tauri host's
unit runner (`global/tauri-unit-runner`), keyed by its domain: the host
pushes every record with its run policy and a factory that builds a fresh
unit for each run, and the unit reports its health as its detail.
`servers-rust` also decides what the host notifies: the per-caller request
notifications and each new stop of a server's run. `servers-tauri-rust` is
the host side: it pushes the servers to `TauriUnitRunner`, emits each server's
status to the base as the `server-status` event, posts the notifications,
and holds the base's commands (list, add, re-enter credentials, set the run
policy, update, remove), which write the registry and then push. See the
[Server Runs Explanation](./servers/docs/Server%20Runs%20Explanation.md). The base itself, the UI the Tauri host's webview mounts in
place of the launcher, is `servers-react`'s `BaseRoot`: its own telemetry
consent, then the server list and Host Settings, which reach the host
only through `servers-core`'s Tauri commands (plain `invoke`, answers
decoded by Effect Schema) and the `server-status` event, never the
effect-messaging bridge.

`smart-app` is the Wildflower chrome a first-party SMART app boots through (`SmartAppRoot`, the launch-page entry, `ConnectMenu`) — see [smart-app/AGENTS.md](./smart-app/AGENTS.md). It joins `emr`'s SMART primitives to `branding`'s chrome, so neither of those depends on the other.

`web-trace` records a browsing session as FHIR `DocumentReference`s and exports a redacting HAR — see [web-trace/AGENTS.md](./web-trace/AGENTS.md). Its `web-trace-core` sits below both a collector and a React app (`web-trace-react`, the on-device viewer), which is why it is a slice of its own rather than a package inside either. The collector that consumes it, [`web-trace-collector`](./collector/web-trace-collector/AGENTS.md), lives in the `collector` slice — a `*-client-collector` belongs where the descriptor seam is, not next to the codec it imports.

## Rules

- **`<name>-core` is the pure layer** — no DOM, no Node `fs`, no platform-specific imports
- **Platform adapters depend on `-core`, never the reverse**
- **Compose `HttpApi` groups across slices via the phantom-id bridge pattern** — see [HttpApi Composition How-To](../docs/Effect/HttpApi%20Composition%20How-To.md)
- **Don't use `topLevel: true` on multiple `HttpApiGroup`s under the same `HttpApi`** — name collision in the generated client. See [HttpApi Composition How-To](../docs/Effect/HttpApi%20Composition%20How-To.md).
- **In a `<name>-react` route file, annotate `useRouteContext`'s `select`.** A slice type-checks both standalone (`vp run --filter <slice> check`) and mounted under `apps/launcher/launcher-web`. Standalone there is no registered Router, so `RegisteredRouter` falls back to `AnyRouter` and a bare `Route.useRouteContext()` / `useRouteContext()` widens to `any` (`no-unsafe-assignment` under oxlint). Fix without a cast: give the slice its own structural `RouterContext` (`BaseRouterContext.RouterContextWith<…>`, re-declared per slice — never imported from the app), and read context through an annotated select, e.g. `useRouteContext({ from: '__root__', select: (context: RouterContext) => context.runAuthed })`. `Route.useParams()` needs no annotation (params come from the route's own path). See `slices/collector/collector-react/src/queries/use-run-authed.ts` for the pattern.

## References

- [HttpApi Composition How-To](../docs/Effect/HttpApi%20Composition%20How-To.md) — Phantom-id bridge, `*ApiHandlersFor<ParentId>()`, `topLevel` collision
- [Effect Patterns Reference](../docs/Effect/Patterns%20Reference.md) — Tag/Layer wiring used inside slice cores
- [Bridge Explanation](../docs/Messaging/Bridge%20Explanation.md) — The webview ↔ host bridge slices declare messages on (`<name>-core/src/bridge.ts`); see the [Wire Pinning How-To](../docs/Messaging/Wire%20Pinning%20How-To.md) when a message crosses TS ⇄ Rust
- [Learnings Inbox](../docs/Agents/Learnings%20Inbox.md) — Slice-specific vp-pack gotchas not yet promoted
