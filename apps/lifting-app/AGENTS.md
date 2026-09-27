# AGENTS.md — apps/lifting-app

Lifting, a **cloud** SMART-on-FHIR app for a strength-training plan and the
sessions lifted against it. It mounts
[`lifting-react`](../../slices/lifting/AGENTS.md)'s four screens under a
**Today | Progress | Plan | History** header toggle (`react-tundraish`'s
`SegmentedToggle`) — `TodayView`, `ProgressionReview`, `PlanEditor` and
`HistoryView` — and holds no lifting logic of its own: which workout is due,
whether a lift succeeded and where its load goes next all come from
`lifting-core`, and every FHIR mapping from `lifting-core/fhir`. The app owns
the tabstrip, the reads, the three writes, and the notices for records it
cannot use. The unselected screen is unmounted, not hidden.

`apps/importer-web` is the template for this shape (two HTML entries, a
relative `base`, a build into the package's own `dist/`, `SmartAppRoot`, a
standalone `ConnectMenu` beside the EHR launch, and writes through
`buildSmartRouterContext`'s `runAuthed`). **One thing is deliberately
different: there is no router** — see below.

The npm package is `wildflower-lifting` (the `wildflower-importer` /
`wildflower-web-trace` convention). The app id and the OAuth `client_id` are
both `lifting-app` — also the published path segment (`SECTION_PATHS.lifting`
in `branding-core`). The debug-only dev row is `lifting-app-dev`.

## Boot and branding

Both entries run on `smart-app-react`, the chrome every self-hosted SMART app
boots through (see [slices/smart-app/AGENTS.md](../../slices/smart-app/AGENTS.md)).
`main.tsx` imports `react-tundraish/styles`, completes a GitHub Pages 404
redirect, calls `addOsColorSchemeListener()`, and renders `<AppRoot />`.
`launch-main.tsx` imports the same module and makes one
`runSmartLaunchEntry({ launch: smartConfig, loadingMessage: 'Launching Lifting…' })`
call. `AppRoot` (`app-root.tsx`, also the package's `source`-only `"."`
export) is `<SmartAppRoot app="lifting" standalone={standaloneSmartConfig}>`
around `<App />`: launched, it renders `BrandBar` + `App`; not launched, the
shared landing — `SiteHeader`, `AppLanding` with `APP_DESCRIPTIONS.lifting`
(`branding-core`), `ConnectMenu`, `SiteFooter`. The chrome gate and its latch
are the shell's, tested in `smart-app-react`.

## Why this app has no router

`apps/importer-web` builds a TanStack router for one reason: `importer-react`
reads its authed runner out of route context (`fhir-r4-react`'s
`useRunAuthed`). `lifting-react`'s screens take plain props and callbacks and
never read route context, so `App` calls `buildSmartRouterContext` — the one
shared, auth-critical function that prefixes the FHIR base and attaches the
bearer token — and hands the `runAuthed` it returns straight to `LiftingApp`.
Do not copy that wiring into the app; do not add a router to reach it.

## Reads and writes

- **Patient.** `client.patient.id` from the handshake's fhirclient `Client`.
  A launch with no patient in context stops at a "Lifting needs a patient"
  gate and reads nothing — a plan is always someone's.
- **Reads** go through the fhirclient `Client` and `fhir-r4-react/smart`'s
  page readers — `fetchCarePlanPage` (active plans in the lifting
  `category`, `LIFTING_PLAN_CATEGORY_TOKEN`, so another feature's care plans
  never read as unreadable lifting plans), `fetchGoalPage` (every goal of the
  patient; a plan's goals are found by reference, so no filter is needed), and
  `fetchObservationBasedOnPage` (`based-on=CarePlan/<id>`) — each through
  `fetchAllResourcePages`, every page to the last: the due workout and each
  progression decision are made over the whole history. `lifting-record.ts`
  reads them through `planFromFhir` / `attemptFromFhir`. `planFromFhir`
  returns a `StoredPlan` — the plan, its `CarePlan` id, each exercise's `Goal`
  id and `created` — and `lifting-core`'s `currentPlanOf` picks the plan
  followed (latest `created`; none ranks last; ties keep the server's order).
  Unreadable plans, other readable plans, retracted and
  unreadable attempts, and entries that did not decode are each counted and
  shown in a `PartialBanner` — nothing disappears silently.
- **Writes** are three TanStack mutations — save plan (`planToFhir`: the
  `CarePlan` and a `Goal` per exercise), log session (`attemptToFhir` per
  attempt), apply progression (`progressionGoalsToFhir`: only the `Goal`s whose
  load moved) — each one batch `Bundle` through `runAuthed` +
  `fhir-r4/clients`' `persistBatchBundle`. Any non-2xx entry fails the
  mutation (`WritesRejected`, naming each rejected entry's target and status)
  and is shown in the view that made it. While any write is pending, every
  view is disabled. No optimistic cache edits.
- **A batch lands entry by entry**, so a failed write may still have changed
  the record. Every mutation therefore refetches in `onSettled` — failure as
  well as success — and stays pending until the refetch lands. The ids a
  write goes under (`PlanWriteIds`, `SessionWriteIds` in `lifting-record.ts`)
  are made once, when the view hands its value back, kept for a retry of the
  same save or session, and dropped only when it lands whole — so a retry
  completes a partly landed write in place instead of duplicating it (a
  partly landed first save would otherwise leave an unreadable `CarePlan`
  active for good). Ids are minted with `nanoid`; an edit reuses the stored
  `CarePlan` id, `created` and each exercise's `Goal` id.

## EHR launch and standalone launch

- **EHR launch** — the homescreen tile opens `launch.html`, which starts the
  SMART authorize redirect against the FHIR base the host names
  (`iss={origin}/fhir-r4`). `index.html` is the redirect target.
- **Standalone launch** — a visitor lands on `index.html` directly and picks a
  FHIR server from `ConnectMenu`. The standalone scopes add `launch/patient`,
  so the server asks which patient's plan to open.

Both run through the one registered client (`lifting-app`, or
`lifting-app-dev` in a vite dev build), whose redirect URI is the app root.

## Scopes: this app writes, and the two sides must match exactly

`src/config.ts` requests:

```text
launch openid fhirUser system/Patient.rs system/CarePlan.cruds
system/Goal.cruds system/Observation.cruds
```

(and `launch/patient` on the standalone launch). `.cruds` because every write
is a `PUT /{type}/{id}` batch entry (update-as-create); `create` and `delete`
are granted so a server that gates update-as-create on `create` accepts it.
`system/` rather than `patient/`, as every other first-party app's client
requests (`apps/importer-web/src/config.ts`, `apps/medications-app`); the app
scopes every search with `patient=<id>` itself. How the server evaluates scopes
is in the [emr-rust Capability
Statement](../../slices/emr/emr-rust/docs/Capability%20Statement.md).

**The pin.** The `allowed_scopes` array the gatekeeper seeds for the
`lifting-app` client (and the `lifting-app-dev` dev client), in the follow-up
registration change, MUST equal the union of the two launches' scopes — the
set above plus `launch/patient` — element for element: a scope the app
requests but the client is not allowed fails the authorize step. Nothing checks this across the TS/Rust boundary: the
doc comment in `src/config.ts`, the seed's own comment and this file carry it.
Change one, change all. Do not add a parity test that hand-copies the list a
third time — that is the self-referential drift guard
[Review Standards](../../docs/Agents/Review%20Standards%20Reference.md) names.

## Traps

- **Plain `FetchHttpClient.layer`, not `telemetry-react`'s
  `webHttpClientLayer`.** The app talks to exactly one host, the FHIR server
  the handshake named. `app.tsx` is the only file that names the real
  transport; `LiftingApp` takes `runAuthed` as a prop so `app.test.tsx` can
  build it over a stub.
- **`build` is `vp build`, with no `tsc` step.** The tsconfig sets
  `customConditions: ["source"]` (as `apps/importer-web` does) so the
  `QueryClient` handed to `buildSmartRouterContext` is the same type the
  slice declares; a package-local `tsc` under that condition re-typechecks
  other packages' sources under this app's options. `vp check` is the gate.
- **The tabstrip state lives in `LiftingApp`.** Tabs unmount their screens,
  so `TodayView`'s tapped sets and `PlanEditor`'s draft reset on a switch; do
  not lift screen state into the app to preserve it. A successful save lands
  on Today, a logged session on Progress.
- **Rewrite through the stored ids.** An edit reuses `StoredPlan.carePlanId`
  and each exercise's `goalIdByExerciseId` entry, and keeps the stored
  `created`; a progression writes only the moved goals under their stored ids
  (a moved goal with no stored id fails the write as `StoredGoalMissing`).
  Minting fresh ids on an edit would leave the old plan active beside the new
  one.
- **An exercise removed in an edit leaves its `Goal` active.** The rewritten
  `CarePlan` no longer references it, so the app never reads it again, but
  nothing cancels it on the server.
- **A partly landed session moves Today on.** If some of a session's
  observations land and others are rejected, the refetched attempts make the
  next workout due; the error names what did not land, but Today no longer
  offers that workout to retry.
- **`vp test` for this package needs the workspace-local binary**
  (`node_modules/.bin/vp`).

## Registration

The identities are load-bearing: `clientId` in `src/config.ts` must equal the
app registration id, and the published path segment must match
`SECTION_PATHS.lifting`.

- **Dev server** — `vp run -F wildflower-lifting dev` holds the port
  `slices/apps/dev-app-ports.json` pins for `lifting-app-dev` (`5198`).
- **Published site** — `apps/github-pages` stages this build at
  `/lifting-app`.
- **Seeded rows** — the `lifting-app` cloud app row, its OAuth client with the
  scopes above, and the debug-only `lifting-app-dev` row and client land in the
  follow-up registration change (`apps-rust` / `gatekeeper-rust` migrations and
  dev seeds). Until then no homescreen tile launches this app.

## Testing

- The page readers' queries and paging — `fhir-r4-react`'s
  `care-plans.test.ts`, `goals.test.ts`, `observations.test.ts`,
  `resource-page.test.ts` (`fetchAllResourcePages`).
- Plan choice and the progression write — `lifting-core`'s
  `stored-plan.test.ts`.
- The auth wiring — `fhir-r4-react`'s `self-hosted-runtime.test.ts`.
- The screens and the lifting decisions — `lifting-react` and `lifting-core`.
- `app-root.test.tsx` — the landing `h1` is `APP_DESCRIPTIONS.lifting.name`.
- `main.test.tsx` — the 404-redirect restore.
- `app.test.tsx` — the whole tree over an in-memory FHIR server: real page
  readers over a stub fhirclient `Client`, the real `buildSmartRouterContext`
  and `persistBatchBundle` over a stub transport, the real `lifting-core/fhir`
  adapters; only `useSmartHandshake` and `useLaunchFailureRedirect` are
  stubbed. It pins the no-patient gate, that a
  saved plan's `CarePlan` + `Goal`s read back through `planFromFhir` to the
  plan and an edit reuses the stored ids, that a logged session's
  `Observation`s read back through `attemptFromFhir` to what was performed,
  that a progression rewrites only the moved goals in place, that every write
  is addressed to the FHIR base with the bearer token, that a rejected write
  is shown with each rejected entry's target and status and a retry writes the
  same ids, that a partly rejected first save completes on retry into one
  plan, that a partly rejected session shows what landed, that every view is
  disabled while a write is in flight, that a failed read shows an error,
  that another feature's care plans are not read, that the flow searches and
  writes only the types `config.ts`'s scopes grant, that the most recently
  created of two readable plans is followed, and the unreadable-plan and
  unreadable/retracted-attempt notices.

## References

- [lifting slice AGENTS.md](../../slices/lifting/AGENTS.md) — the domain,
  adapters and screens this app composes.
- [emr slice AGENTS.md](../../slices/emr/AGENTS.md) — `fhir-r4-react/smart`,
  the page readers and the auth-critical runtime.
- [apps/importer-web AGENTS.md](../importer-web/AGENTS.md) — the writing SMART
  app this one is shaped like.
- [apps/AGENTS.md](../AGENTS.md) — the rules every app follows.
