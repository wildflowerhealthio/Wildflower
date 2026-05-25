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
2. **`git diff main <source-commit> -- slices/<slice>/`** _before_ copying. Main has already absorbed earlier PRs from this wave (e.g. #58 `HostMessagingProvider`, #60 `LocalClientToken`); reading the diff this way exposes the truly-new files instead of regressing main. Look for three buckets:
   - **Pure additions** on the source commit → copy as-is (e.g. new test files, `host-receiver-layer.ts`, `use-host-binding.ts`).
   - **Files where main is ahead** → keep main's version (it's the result of review). The source commit may pre-date a split/rename — don't reintroduce a merged file.
   - **Files where main and the source disagree** → judgment call; prefer main unless the source has a real new behaviour main doesn't.
3. Copy the pure-addition files from the source commit using `git show <source-commit>:<path>`. Source commits used so far: `ruthmarks/add-wildflower-expo` (navigation-expo), `70479f8` ad-hoc tip (gatekeeper-expo).
4. Run `vp install` in the worktree (auto-runs from `wf-worktree.sh new`).
5. **Run `vp run pack`.** Workspace packages declare `exports['.'].default = "./dist/index.js"`; jest's resolver follows `exports` first and can't find the dep until each package's `dist/` exists. The main checkout already has built `dist/`s — fresh worktrees don't, hence the extra step.
6. Run `vp check` (workspace-wide) and `cd slices/<slice>/<slice>-expo && vp run jest`. Also run `vp test` on `<slice>-core` and `<slice>-react` if you added tests there.
7. Patch only the things check/jest surfaces. Do **not** preemptively rewrite to `makeBridgeDispatcher` — `HostBinding` is fine.
8. Commit, push, open a PR titled `feat(<slice>-expo): port from add-wildflower-expo`.

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
| `HostBinding.BindingSend` import fails                                                                             | Not exported on main. Inside `useMemo(() => ({ ... }), [...])` returning `HostBinding.HostBinding<typeof Bridge>`, drop the annotation on the `send` parameter — contextual typing from the field declaration narrows it to the correct `BridgeTransport.MessageSender<[B], 'Host'>` shape. Only escalate if the inference doesn't kick in.            |

## Open items (filled in as the wave progresses)

| Slice             | Owner             | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `navigation-expo` | `ruthmarks` (PR1) | **Done** — see PR. `Log` handler signature changed from `(log: string)` to `({ level, payload })` to match `NavigationBridge`'s actual schema. New `LogLevel` / `LogMessage` types exported from `'navigation-expo'`. 12/12 jests pass.                                                                                                                                                                                                                                  |
| `gatekeeper-expo` | `ruthmarks` (PR2) | **Done.** Source = `70479f8` (not `add-wildflower-expo`). Main already had `LocalClientToken` (PR #60), `use-gatekeeper-host-messaging` (PR #58), the split `wait-for-host-token-ref.ts`, and the `writeToken`-via-`Effect.sync` wrapper in `web-bridge.ts` — those were kept. New on main: `host-receiver-layer.{ts,test.ts}`, `use-host-binding.ts`, `tests/bridge.test.ts`, `GatekeeperBridgeExpo` namespace export. 6/6 jest + 95/95 vitest + 9/9 react vitest pass. |
| `apps-expo`       | TBD               | not started                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `collector-expo`  | TBD               | not started                                                                                                                                                                                                                                                                                                                                                                                                                                                              |


## Cumulative findings (read before starting the next slice)

- **Build before jest in fresh worktrees.** The first-time miss above is the biggest time-sink.
- **Trust `<slice>-core` over branch handlers.** Whenever a `<slice>-expo` handler in the branch destructures a key the core schema doesn't have, the schema wins. The branch's `-expo` packages never type-checked, so they're not authoritative — they're _candidates_.
- **Tests using `Effect.logDebug`** must lift `minimumLogLevel`. Worth adding a tiny helper if multiple slices need it; for now each slice can inline `Logger.withMinimumLogLevel(LogLevel.All)` per the recipe above.
- **`vp check --fix`** is safe to run after copying — the branch's formatter settings drift slightly from main's.
- **Diff main vs source first** (recipe step 2). As the wave progresses, more of each branch's content has already been merged in pieces. For gatekeeper-expo the whole `gatekeeper-react/` directory was already ahead of `70479f8`; only the `-expo` adapter files were truly new. Skipping the diff would have regressed `wait-for-host-token-ref.ts` and `use-gatekeeper-host-messaging.ts`.
- **`HostBinding.BindingSend` doesn't exist on main.** Drop the type annotation on the `send` callback inside `useMemo` — contextual typing from the returned `HostBinding.HostBinding<typeof Bridge>` gives `send` the correct shape (see fix-up table).
- **Source commits diverge per slice.** `navigation-expo` came from `ruthmarks/add-wildflower-expo`; `gatekeeper-expo` from `70479f8` (an ad-hoc tip on a different lineage). Confirm the source commit with the user before assuming the recipe's default.
- **`Log` is now its own `LogBridge` in `effect-messaging-core`.** Per-slice `Log` schemas and `Log:` handlers have been removed from `NavigationBridge` / `BrowserSnifferBridge` (collector never had its own). The injected sniffer's `{_tag:'Log',level,payload}` wire shape is unchanged — `BrowserSnifferWebView` now adds `LogBridge` to its internal transport tuple so those messages land on the shared bridge. Apps add `LogBridge` to their transport bridges and use `LogBridge.installConsoleInterceptor` on the web side; the host gets `useLogHostBinding()` from `effect-messaging-expo`. Future `-expo` slices should NOT add a `Log` to their bridge — wire `useLogHostBinding()` alongside instead.
