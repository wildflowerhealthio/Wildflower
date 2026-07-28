# Testing Reference

Vitest across all packages. Property-based testing is the default approach.

## Test Runners

| Runner             | Where it runs | How to invoke                                                                                                 |
| ------------------ | ------------- | ------------------------------------------------------------------------------------------------------------- |
| Vitest (via Vite+) | Every package | `vp test` (Vitest projects mode wired in root `vite.config.ts`; works from the root or any package directory) |

`vp run test:all` runs the full Vitest pass; `vp run ready` includes it. For iterative work, `vp run test:changed` runs the same suites but scales `fast-check` `numRuns` down (× 0.2, floored at 10) for packages unchanged vs `origin/main` and their unaffected dependers — see [Property Testing Reference](./Property%20Testing%20Reference.md) for the `numRunsFor` helper.

## When to Use Each Approach

| Approach                                                   | Use When                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| [Property testing](./Property%20Testing%20Reference.md)    | Arbitraries, verified mocks, MECE assertions, algebraic properties |
| [Unit testing](./Unit%20Testing%20How-To.md)               | Testing pure domain logic, schemas, helpers, and Effect-TS code    |
| [React testing](./React%20Testing%20Reference.md)          | Testing React components, hooks, and UI behavior                   |
| [Integration testing](./Integration%20Testing%20How-To.md) | Testing code that calls external HTTP APIs (FHIR, OAuth, etc.)     |

## Key Principles

- **Property-based first**: Default to `fast-check` properties with `Arbitrary.make(Schema)` for data generation. Use example-based tests only for regressions and documentation.
- **MECE structure**: Tests should be Mutually Exclusive and Completely Exhaustive.
- **Concise and high-value**: A single powerful property test beats ten trivial example tests.
- **Colocate tests**: Place `*.test.ts` files next to the source files they test.

## Tests Must Be Able to Fail

A test that cannot fail is worse than no test — it reports green while the behaviour it names is unverified. Each of these anti-patterns shipped in real PRs and was caught only in review. Before writing an assertion, ask: _what change to the subject would make this fail?_ If the honest answer is "none," rewrite it.

### Don't guard drift with a hardcoded copy of the thing you're guarding

A cross-boundary parity test (e.g. a TS↔Rust allowlist, an OpenAPI snapshot, two sides of a shared enum) must derive **both** sides from a single source and compare them. Asserting a constant against a hand-copied literal of that same constant pins the literal and can never catch drift — when one side changes, the copy is updated in the same commit and the test stays green.

Real case (PR #239): a `NATIVE_WEBVIEW_DATA_PLANE_TAGS` "drift test" compared the exported list against an inline literal duplicate. It could only ever fail if someone edited the test. Fix: read both sides from their real definitions (import the TS export; parse/emit the Rust side) and assert equality — see the OpenAPI spec-drift harnesses for the shape.

### Don't stub the exact behaviour under test

Never mock the specific thing the test claims to verify. If a test asserts "the client rejects a bare 204," stubbing the transport to resolve deletes the assertion's teeth.

Real case (PR #258): a test stubbed `runAuthed` to resolve successfully, hiding that the real `HttpApiClient` **rejects** a 204 the endpoint actually returns. The test passed; production threw. Mock the collaborators around the subject, not the subject's own decision.

### Round-trip wire boundaries with unhappy shapes and exact status codes

A schema change on either side of an HTTP or FFI boundary needs a test where the **producer serializes** and the **consumer decodes** the same bytes, exercising:

- **Exact status codes** — 200 vs 204 vs 404 are different contracts; assert the specific code, not just "ok".
- **Empty-string vs absent** — an optional field omitted, present-and-empty, and present-and-populated are three cases.
- **Read/write optionality symmetry** — a field optional on write but required on read (or vice versa) is a decode failure waiting to happen.

Two concrete failures: PR #258 (endpoint returns 204, client decoded assuming 200) and PR #241 (a single empty `subtitle` broke decode of the **whole array** — Effect array decode is all-or-nothing, so one malformed element fails every element). Generate the unhappy shapes; a happy-path-only round-trip proves nothing about the boundary.

### Security-critical and lifecycle branches need direct coverage

New auth gates, token/consent checks, teardown/finalizer paths, and other security- or lifecycle-critical branches require a test that drives **that branch directly** — reviewers cite the CLAUDE.md rule ("New security-critical / lifecycle branches require direct coverage"). Incidental coverage through a happy-path test does not count.

## Testing Effect Logging

To assert on `Effect.logWarning`/`Effect.log` output, swap the default logger with a capturing one via `Logger.replace(Logger.defaultLogger, ...)` and provide it as a layer — this is the canonical pattern. `vi.spyOn(console, 'warn')` silently catches nothing, because once a layer overrides the logger, Effect's backend is no longer `console.warn`. The replacement propagates through `FiberRef` into forked dispatch fibers automatically, so there's no runtime-boundary seam to manage.

```typescript
const captureLogs = (sink: { level: string; message: unknown }[]): Layer.Layer<never> =>
  Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ logLevel, message }) => {
      sink.push({ level: logLevel.label, message })
    })
  )
```

Provide `captureLogs(sink)` to the program under test and assert on `sink`. Lift the minimum level (`Logger.withMinimumLogLevel(EffectLogLevel.All)`) when you need `DEBUG` to surface. Generic capture helpers live in `kitchen-sink/test`; see [`effect-messaging-core/src/logging.test.ts`](../../global/effect-messaging/effect-messaging-core/src/logging.test.ts).

## Slice-Level Bridge Tests: Test the Slice's Own Contract

When auditing a slice's `*-bridge.test.ts`, keep tests that exercise contracts **unique to the slice**; drop tests that re-verify library primitives or re-assert invariants already covered one layer down.

- **Keep** — cross-side alignment through the test adapter (`Bridge.Host.send(...)` then `Schema.decodeSync(Bridge.Web.InboundSchemas.X)(sent[0])`), and slice-specific encoding behaviour (e.g. an aggregator honoring a `hostOptionsShape: { initialPath }` through its wiring) that the parent package can't cover.
- **Drop** — per-schema round-trips of `Schema.parseJson(Schema.TaggedStruct(...))` (that's a library primitive tested in `effect-messaging-core`), and shape assertions like `Object.keys(Host.OutboundSchemas)` / `HandlerTag.key === '...'` that duplicate parent-package tests.

A real `navigation-bridge.test.ts` sat at 16 tests / 151 lines where only the last two earned their keep. Spend the freed budget on slice-unique behaviour instead.

## Workspace Resolution During `vp test`

Two settings must be set on **every package** (not just root) for tests to see source rather than stale `dist/`:

- **`resolve.conditions: ['source']`** in each package's `vite.config.ts`. Vitest `test.projects` mode does **not** inherit root `resolve` config — each project loads its own `vite.config.ts` independently. Without this per-package setting, sibling-package tests load each other's prebuilt `dist/`, masking source edits.
- **`customConditions: ['source']`** in each package's `tsconfig.json` `compilerOptions` (alongside `moduleResolution`). This is the TS-side mirror: vite's `resolve.conditions` covers runtime resolution, tsconfig's `customConditions` covers type resolution. Without it, type-checking follows the `default` (dist) export and shows stale types during edits.

Set both, on every package, and on root (for `vp dev`/`vp build` from root context).

### New kitchen-sink subpaths need a built dist before `vp check`

Slice `tsconfig.json` files `include: ["src"]` only. `vp check` still type-checks `tests/**/*.test.ts`, but tests sit outside `include` and so don't inherit `customConditions: ['source']` — an import like `import { x } from 'kitchen-sink/schema'` resolves against the `default` (dist) path, not source. If the new subpath hasn't been built, the test sees the import as `any` and everything downstream collapses (`Property 'Service' does not exist on type ...`), even though `src/` checks pass. After adding a new subpath export to a `global/` package consumed cross-package by tests, run `vp run build` (or `vp run -F kitchen-sink build`) once before re-running `vp check`.

The same bite hits a whole freshly bootstrapped container, where nothing is built at all. A Claude PreToolUse hook ([pack-before-check-reminder.mjs](../../.claude/hooks/pack-before-check-reminder.mjs)) holds the session's first `vp check` unless a build has already run in that session — `vp build`, `vp run pack`, `vp run build` (including `-r` / `-F <pkg>`), or `vp run ready`, which packs before it tests. The hold fires at most once per session, so retrying the command proceeds when checking against the current `dist/` is what you want. Its tests are [scripts/pack-before-check-reminder.test.ts](../../scripts/pack-before-check-reminder.test.ts) — `.claude/hooks/` belongs to no workspace package, so hook tests live with the other repo-tooling tests under `scripts/`.

## Runtime Gotchas

- **Node 26's global `localStorage` shadows jsdom's.** Node 26 exposes `localStorage`/`sessionStorage` as globals but inert (they read back `undefined` without `--localstorage-file`). Vitest's jsdom environment skips keys already on `globalThis`, so it never installs jsdom's working `localStorage`, and `window.localStorage.clear()` throws `TypeError: Cannot read properties of undefined`. This passes on Node 22/24 and fails only under Node 26 (surfacing in CI, not older local runs). The fix — launching workers with `--no-experimental-webstorage` — lives in `vite.config.base.ts`'s `test.execArgv`. Every jsdom package must opt in by spreading `...base.test`: `test: { ...base.test, environment: 'jsdom', ... }`. Vitest 4 removed `poolOptions.execArgv`, and top-level `test.execArgv` is ignored on the root projects config, so a per-package spread is the only path that works — a new jsdom package that forgets `...base.test` reintroduces the failure.
