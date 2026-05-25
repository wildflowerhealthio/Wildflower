# Effect Messaging Migration How-To Guide

Scratch doc for the wave of agents bringing `slices/*/<slice>-expo` packages
from `ruthmarks/add-wildflower-expo` into `main`. **Delete after the
migration wave lands.**

## Premise

The revert commit on the branch (`6f71f65`) claimed main "supersedes
`HostBinding` with `makeBridgeDispatcher` / `makeMessageSenderPipe`."
**That is wrong.** Main keeps `HostBinding` (in `effect-messaging-core`)
and uses it from `effect-messaging-expo/BridgedWebView`. Both patterns
coexist on main:

| Layer                 | Pattern on main                                                                       |
| --------------------- | ------------------------------------------------------------------------------------- |
| Host shell wiring     | `HostBinding<B>` tuple → `BridgedWebView bindings={…}` (still the contract)           |
| In-tree dispatch      | `makeBridgeDispatcher` (slice provider + `useAsMessageHandlers` + `useMessageSender`) |
| Pipe across providers | `makeMessageSenderPipe` (registers a transport sender into a React context)           |

So `use<Slice>HostBinding` hooks on the branch translate **almost 1:1** onto
main. Don't rewrite them.

## What the branch had vs. what main has

| `effect-messaging-core` symbol  | Branch (post-revert)                     | Main                                                                            | Migration impact                                                                          |
| ------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `HostBinding` namespace         | **deleted**                              | exported (`aggregate`, `callTransportReady`, `HostBinding<B>`, `Any`)           | None — branch's slice files already import the right symbol; the import resolves on main. |
| `BareSender`                    | type alias inside `transport-adapter.ts` | `Context.Tag` class in its own `bare-sender.ts` + `BareSenderService` interface | None for slices; only matters if you mock the transport.                                  |
| `Bridge.UrlParamableMessage`    | tag keys could be `undefined`            | `-?` modifier strips `undefined`                                                | Stricter — `initialMessages` literals still type-check.                                   |
| `BridgeTransport.MessageSender` | `out` variance on `Bridges`              | invariant                                                                       | Cosmetic.                                                                                 |

`fc.webPath()` already exists at `global/effect-messaging/effect-messaging-react/src/test-utils/test-arbitraries.ts` on main with no drift. Tests using it work as-is.

## Migration recipe (per `-expo` slice)

1. Create a new worktree via `.devcontainer/wf-worktree.sh new ruthmarks/migrate-<slice>-expo main`.
2. Copy `slices/<slice>/<slice>-expo/{src/*, package.json, vite.config.ts, jest.config.cjs, babel.config.cjs, tsconfig.json}` straight from `ruthmarks/add-wildflower-expo` using `git show ruthmarks/add-wildflower-expo:<path>`.
3. Run `vp install` in the worktree (auto-runs from `wf-worktree.sh new`).
4. **Run `vp run pack`.** Workspace packages declare `exports['.'].default = "./dist/index.js"`; jest's resolver follows `exports` first and can't find the dep until each package's `dist/` exists. The main checkout already has built `dist/`s — fresh worktrees don't, hence the extra step.
5. Run `vp check` (workspace-wide) and `cd slices/<slice>/<slice>-expo && vp run jest`.
6. Patch only the things check/jest surfaces. Do **not** preemptively rewrite to `makeBridgeDispatcher` — `HostBinding` is fine.
7. Commit, push, open a PR titled `feat(<slice>-expo): port from add-wildflower-expo`.

## Likely fix-up spots when validation fails

| Symptom                                                                                                            | Likely cause                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Import of `BareSender` from `effect-messaging-core` fails                                                          | Branch re-exported `type BareSender` from `transport-adapter.ts`; main exports the Context.Tag class. Use `BareSenderService` / `BareSenderFunction` from `'effect-messaging-core'` (re-exported via `./bare-sender.ts`).                                                                                                                              |
| `OriginFromServedOrigin` missing                                                                                   | **Rename, not missing.** The branch's `apps/wildflower-expo/src/daemons/http-server.ts` references the pre-merge name; the symbol shipped to main as `OriginFromTunnelStore`, still exported from `tunnel-core/contexts`. `s/OriginFromServedOrigin/OriginFromTunnelStore/` when porting wildflower-expo. (The branch never type-checked this import.) |
| `vp check` complains about missing slice-`expo` peer dep                                                           | Add `<slice>-expo` to the consuming package's `dependencies` and rerun `vp install`.                                                                                                                                                                                                                                                                   |
| Jest can't resolve `effect-messaging-core`                                                                         | The slice's `jest.config.cjs` likely mirrors `effect-messaging-expo`'s — confirm `transformIgnorePatterns` excludes the workspace package and that `babel-preset-expo` is installed at the slice level.                                                                                                                                                |
| Type error on `HostBinding.HostBinding<typeof X>` not assignable to `HostBinding.Any` in caller                    | Expected variance pinch — see the cast in `apps/wildflower-expo/src/components/app-shell-webview.tsx` on the branch (and the upcoming main caller). Cast site lives in the caller, not the slice.                                                                                                                                                      |
| Handler destructures a key (`{ log }`, `{ token }`, etc.) that doesn't exist on the bridge's `Schema.TaggedStruct` | The branch-only `-expo` packages **never type-checked** (revert commit: "~64 type errors all isolated to these branch-only expo files"). Treat the destructure as wrong — re-check the `<bridge>-core` schema and align. For `navigation-core`'s `Log` the wire shape is `{ level, payload: readonly unknown[] }`, not `{ log: string }`.              |
| Default-fallback log helpers seem silent at DEBUG / TRACE under jest                                               | Effect's default `minimumLogLevel` is INFO. Wrap the test's `Effect.runPromise` with `Logger.withMinimumLogLevel(LogLevel.All)` before asserting the captured sink.                                                                                                                                                                                    |

## Open items (filled in as the wave progresses)

| Slice             | Owner             | Status                                                                                                                                                                                                                                  |
| ----------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigation-expo` | `ruthmarks` (PR1) | **Done** — see PR. `Log` handler signature changed from `(log: string)` to `({ level, payload })` to match `NavigationBridge`'s actual schema. New `LogLevel` / `LogMessage` types exported from `'navigation-expo'`. 12/12 jests pass. |
| `gatekeeper-expo` | next              | Not started — wait for navigation PR to land, then branch off it.                                                                                                                                                                       |
| `apps-expo`       | TBD               | not started                                                                                                                                                                                                                             |
| `collector-expo`  | TBD               | not started                                                                                                                                                                                                                             |

## Cumulative findings (read before starting the next slice)

- **Build before jest in fresh worktrees.** The first-time miss above is the biggest time-sink.
- **Trust `<slice>-core` over branch handlers.** Whenever a `<slice>-expo` handler in the branch destructures a key the core schema doesn't have, the schema wins. The branch's `-expo` packages never type-checked, so they're not authoritative — they're _candidates_.
- **Tests using `Effect.logDebug`** must lift `minimumLogLevel`. Worth adding a tiny helper if multiple slices need it; for now each slice can inline `Logger.withMinimumLogLevel(LogLevel.All)` per the recipe above.
- **`vp check --fix`** is safe to run after copying — the branch's formatter settings drift slightly from main's.
