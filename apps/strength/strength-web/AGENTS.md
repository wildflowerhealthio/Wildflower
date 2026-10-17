# AGENTS.md — apps/strength/strength-web

Strength, a SMART-on-FHIR strength-training app published to
<https://strength.wildflowerhealth.io/> (package `strength-web`), launched
from the `strength-dev` tile under the vite dev server. See [README.md](./README.md)
for the boot structure, the reads, the tabs, the writes and the scopes.

`apps/plots/plots-web` is the template: the same one HTML entry, relative
`base`, build into the package's own `dist/`, `SmartAppRoot` shell with its own
Sentry DSN, and read-status lines.

## Layout

`src/` keeps the entry and the root at its top: `main.tsx` (the `index.html`
entry), `config.ts`,
`app-root.tsx` (the package export), `app.tsx`, the router (`router.ts`, and
`router-context.ts` with `useStrengthContext`, the one hook the routes read
it through), and the app-wide `clock.ts` and `smart-client.ts`. Everything else is a folder per
screen or concern:

- `routes/` — the TanStack file routes (the tree is generated into the
  git-ignored `src/routeTree.gen.ts`). `__root.tsx` is the patient picker or
  the page (the patient line over `RouteTabs`), with the not-found card
  (`-strength-not-found.tsx`) for a path no tab names; `-chosen-patient.ts`
  reads whose record the address bar names and opens the picker;
  `index.tsx` redirects `/` to the chosen patient's first tab; and
  `-lifter-tab.tsx`'s `LifterTab` is one lifter's training record read,
  under Today and Plan. Each tab is a folder, `today/`, `plan/`,
  `history/`: its `route.tsx`, the `-`-prefixed files only it uses (Today's
  `-workout-due.tsx` and the write it builds,
  `-submitted-workout-resources.ts`; Plan's `-plan-editor.tsx`), and its
  `-route.test.tsx`.
- `start-program/` — `StartProgram`, the start of a training plan definition
  the Today and Plan tabs share, with what it writes
  (`training-plan-definition-change-resources.ts`) and the current loads it
  suggests (`current-loads.ts`).
- `record/` — the lifter's record and its reads: `training-record.ts`
  (`readTrainingRecord`), `workout-history.ts` (`readWorkoutHistory`), the
  paging and decoding both share (`read-every-page.ts`), `UnreadableCounts`,
  and the notices that say what could not be read (`TrainingRecordNotices`,
  `UnreadableNotice`).
- `session/` — `StrengthSession` (one launch, for one lifter: what every
  write takes) and the write hooks every screen writes through
  (`use-strength-write.ts`).
- `ids/` — the ids the app mints: `mintResourceId`,
  `exerciseSetObservationIdOf`, `workoutIdMinter`,
  `serviceRequestIdMinter` and `strongLiftsPlanDefinitionIdMinter`, one per
  file.

One component per file, named after it in kebab-case (a route's component
lives in its `route.tsx`). A styled component has
its own CSS module beside it, BEM-named as `strength-react`'s are: the block is
the file's name, read as `styles['block__element']`. Tests sit beside what
they cover.

## Rules

- **Compose; decide nothing.** The app wires `strength-core-js` and
  `strength-react` together and owns only the SMART shell, the reads, the ids,
  the clock and the writes; the patient is `smart-app-react`'s
  (`useRoutedPatientPicker` and `useRoutedPatientChoice` over `?patient=`,
  `PatientPicker`, `PatientChoiceLine`). The day due, the
  progression, what a submission or a start writes, and every check on a
  training plan definition or a starting load are core's
  (`PlannedWorkout.make` / `submit`,
  `ExerciseRequest.changeTrainingPlanDefinition`); every value is read with
  core's getters.
- **Pass the narrowed FHIR resource.** Reads decode into
  `TrainingPlanDefinition.Type`, `ExerciseRequest.Type`,
  `WorkoutProcedure.Type` and `ExerciseSetObservation.Type`, and those are
  what the screens take and the writes send — never a copy of their fields.
- **Count what does not read.** A page entry that does not decode, and a
  resource core's `Schema` refuses, are counted per type
  (`UnreadableCounts`) and said in a banner. Retracted `Observation`s are
  filtered before decoding and not counted.
- **A write needs a lifter.** Only a chosen patient gets a
  `StrengthSession`, and every screen that writes takes one, so "All patients"
  cannot reach a write: it reads unscoped (History) and `LifterTab` shows a
  "Choose a patient to train" card in place of Today and Plan. Queries sit under
  `strengthKeyOf` of the patient scope (`null` for All patients).
- **Route only after the handshake, once.** The app root is the OAuth
  redirect target, so `App` builds the router (`StrengthRouter`) under
  `smart-app-react`'s `SmartHandshakeGate`, by when fhirclient has taken
  `code` and `state` out of the URL: nothing the router does may rewrite a
  URL the token exchange still reads. It runs over the `SmartAppPage`
  `main.tsx` opens (`openSmartAppPage`: the window's history, the served
  directory as basepath), and is built once for the visit, its context
  fixed (client, `runAuthed`, the StrongLifts template ids); see "Routing a SMART app" in
  [slices/smart-app-react/AGENTS.md](../../../slices/smart-app-react/AGENTS.md).
- **The patient is the URL's.** `?patient=` is a root search param, read as
  a string (`parsePlainSearch`, so `1.50` stays `1.50`) and the only one
  kept across navigations. A choice navigates to `/`, which opens the
  choice's first tab (Today for a lifter, History for All patients), so a
  patient change is a navigation in the same router. The open picker is the
  URL's too (`?picking-patient=`, never kept): Back closes it, and Back from a
  choice returns through the picker to the patient before.
- **Every write is one batch, to minted ids, and refetches when it settles.**
  `useStrengthWrite` writes through `persistBatchBundleOrFail` and invalidates
  the lifter's queries on success and failure alike; `useStrengthWriting`
  disables every screen while any write is pending (`src/session/`). A retry
  reuses what the first attempt fixed (`WorkoutAttempt`, `StartAttempt`), so
  its ids match.
- **Set ids sort in set order.** `exerciseSetObservationIdOf` zero-pads the
  set index and keeps the id within FHIR's grammar; change it only with its
  property tests.
- **Scopes match the clients.** `STRENGTH_SCOPE` is the one string both
  launches request — `system/` only, no `launch/patient`; the `strength` and
  `strength-dev` tiles' OAuth clients' `allowed_scopes` must equal it
  (authorization server migrations `0019_seed_lifting_app_client`,
  `0020_first_party_apps_pick_the_patient` and
  `0025_rekey_lifting_app_clients`, and `STRENGTH_DEV_SCOPES` in
  `authorization-server-rust/src/seeding.rs`, whose test reads `src/config.ts`). A
  change here is a new authorization server migration and a dev-scope edit too.

## Testing

- The screens are driven end to end through the app's router
  (`StrengthRouter`) over an in-memory FHIR server: the real
  `fhir-r4-react/smart` readers over a stub client that
  answers searches from the store, and the real `buildSmartRouterContext` and
  `persistBatchBundleOrFail` over a stub transport that applies batches to it
  (`fake-fhir-server.test-helpers.ts`, which also answers reads of one
  resource, such as the lifter's `Patient`). Seeded records are built through
  `strength-core-js`'s `make`s and `PlannedWorkout.submit`, and what lands is
  decoded back through core's schemas (`strength-app.test-helpers.ts`, whose
  `mountStrengthApp` opens the page at a route). Each tab's test sits in its
  route folder (`routes/today/-route.test.tsx`, …) and each other feature's
  in its folder (`record/training-record.test.tsx`,
  `session/use-strength-write.test.tsx`, …); `routes/-root.test.tsx` drives
  every tab to check the scopes cover each read and write, where the bare
  app path opens, `?patient=` read as a string and kept alone across tabs,
  the not-found card, and All patients' read-only tabs; `app.test.tsx` drives
  `App` over a stubbed handshake — the picker, a pick, the launch's patient,
  a change (to All patients opening History, in the same router) and Back
  from it. `RouteTabs`'s browser APIs are stubbed with `react-tundraish`'s
  `stubRouteTabsBrowserApis`.
- `ids/*.test.ts` — property tests: set ids are FHIR ids and sort in set
  order, long exercise ids stay apart, and a minter names one resource with
  one id on every call.
- `app-root-routing.test.tsx` — the real root, app and router over the
  address bar, with fhirclient stubbed: a launch URL still launches, at the
  root or a tab, and the callback URL is left alone until the exchange
  completes, then the page opens on Today.
- `app-root.test.tsx` — that `AppRoot` mounts the shared shell as Strength
  (the landing `h1` is `APP_DESCRIPTIONS.strength.name`), reporting to its own
  Sentry project; the shell itself is tested in `smart-app-react`.
- `main.test.tsx` — the Pages 404 redirect is completed before anything reads
  the URL.

## References

- [apps/strength/AGENTS.md](../AGENTS.md) — the Strength packages this
  app composes.
- [apps/plots/plots-web/README.md](../../plots/plots-web/README.md) — the template.
- [slices/fhir/AGENTS.md](../../../slices/fhir/AGENTS.md) — `fhir-r4-react/smart`'s
  paged reads.
- [apps/AGENTS.md](../../AGENTS.md) — the rules every app follows.
