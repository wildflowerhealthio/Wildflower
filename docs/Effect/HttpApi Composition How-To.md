# HttpApi Composition How-To

How to expose a slice's `HttpApi` so other slices and apps can compose it into a larger API. For Effect-TS conventions used inside the handlers themselves, see [Effect Patterns Reference](./Patterns%20Reference.md).

## Goal

Each slice owns an `HttpApi` definition (in `<name>-core/src/http-api-definition/`) and a Layer that handles every group on it (in `<name>-core/src/http-api-implementation/`). A parent — typically a host app like `wildflower-node` — composes multiple slice APIs into one root `HttpApi` and serves them under a single Router.

The wiring needs two things:

1. The slice exposes its handlers in a form the parent can drop into any `HttpApi.make('AnythingElse')` without rebuilding the Layers.
2. The parent's type system has to accept those handlers under the parent's own `ApiId`.

`HttpApiBuilder.group(api, name, handlers)` returns `Layer.Layer<HttpApiGroup.ApiGroup<ApiId, Name>, ...>` — a marker keyed on the **child** API's `ApiId`. The parent expects markers keyed on its own `ApiId`. That's the gap the phantom-id bridge closes.

## The phantom-id bridge pattern

`HttpApiGroup.ApiGroup<ApiId, Name>` is a structural type marker only — it has no runtime presence. `HttpApiBuilder.group` only registers routes on the shared Router; nothing reads `apiId` at runtime. So a Layer built against a child `HttpApi` is sound to satisfy a parent `HttpApi`'s group requirement via a single, well-commented cast.

The convention: every slice that wants to be composable exports an `<Name>ApiHandlersFor<ParentId>()` helper that performs the cast in one place.

### Producer side (slice core)

In `slices/<name>/<name>-core/src/http-api-implementation/index.ts`:

```ts
import { type HttpApiGroup, HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import { AppsApi } from '../http-api-definition/index.ts'
import * as Apps from './apps.ts'
import * as Server from './server.ts'

const AppsApiHandlersLive = Layer.mergeAll(Server.layer, Apps.layer)

const AppsApiLive = HttpApiBuilder.api(AppsApi).pipe(Layer.provide(AppsApiHandlersLive))

type AppsGroupNames = 'server' | 'apps'

const AppsApiHandlersFor = <ParentId extends string>(): Layer.Layer<
  HttpApiGroup.ApiGroup<ParentId, AppsGroupNames>,
  never,
  TunnelControl | AppsStore
> =>
  // The phantom-id bridge: `ApiGroup<ApiId, Name>` is a structural marker
  // with no runtime presence (HttpApiBuilder.group only registers routes on
  // the shared Router; nothing reads `apiId`), so a Layer built against
  // AppsApi is sound to satisfy the same group requirement under any
  // consumer's parent ApiId. This cast is the one place that bridge lives.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  AppsApiHandlersLive as unknown as Layer.Layer<
    HttpApiGroup.ApiGroup<ParentId, AppsGroupNames>,
    never,
    TunnelControl | AppsStore
  >

export { AppsApi, AppsApiHandlersLive, AppsApiHandlersFor, AppsApiLive }
```

What each export is for:

- **`<Name>Api`** — the `HttpApi` definition. Re-exported so consumers can `.add(group)` it into a parent `HttpApi`.
- **`<Name>ApiHandlersLive`** — the merged Layer of every group handler, keyed on the child `ApiId`. Used internally and by the standalone `*Live` Layer.
- **`<Name>ApiLive`** — a self-contained `HttpApiBuilder.api(...)` Layer for running the slice as its own HTTP server (tests, dev, single-slice apps).
- **`<Name>ApiHandlersFor<ParentId>()`** — the phantom-id-cast version, for use when composing into a parent `HttpApi`.

### Naming conventions

| Symbol                  | Convention                                                           |
| ----------------------- | -------------------------------------------------------------------- |
| The Api                 | `<SliceName>Api` (PascalCase)                                        |
| Group-name union        | `<SliceName>GroupNames` (string-literal union of every group's name) |
| Standalone Layer        | `<SliceName>ApiLive`                                                 |
| Internal handlers Layer | `<SliceName>ApiHandlersLive`                                         |
| Cross-slice helper      | `<SliceName>ApiHandlersFor`                                          |

### Required comment + lint disable

The cast must be surrounded by:

1. A comment explaining the bridge. New slices may shorten to `// See shared-structures-core's apiHandlersFor: the phantom-id bridge lets a Layer built against <ChildApi> satisfy a parent ApiId's group requirement.` — shared-structures-core's [`apiHandlersFor`](../../slices/shared-structures/shared-structures-core/src/http-api-implementation/index.ts) carries the canonical long-form explanation.
2. `// oxlint-disable-next-line typescript/no-unsafe-type-assertion` immediately above the `as unknown as ...` line, scoped to that single line.

This is the one sanctioned `as unknown as` cast in slice code. See the [no-`any`/`@ts-ignore`/unsafe-cast rule](../../AGENTS.md) in the root AGENTS.md for the broader policy.

## Consumer side (parent app)

The host app combines slice `Api` definitions into one root `HttpApi`, then provides the merged Layer of every slice's `*ApiHandlersFor<ParentId>()`:

```ts
import { HttpApi } from '@effect/platform'
import { Layer } from 'effect'
import { AppsApi, AppsApiHandlersFor } from '@wildflower/apps-core'
import { AuthApi, AuthApiHandlersFor } from '@wildflower/gatekeeper-core'

const WildflowerNodeApi = HttpApi.make('WildflowerNodeApi').addHttpApi(AuthApi).addHttpApi(AppsApi)

const WildflowerNodeApiHandlersLive = Layer.mergeAll(
  AuthApiHandlersFor<'WildflowerNodeApi'>(),
  AppsApiHandlersFor<'WildflowerNodeApi'>()
)

const WildflowerNodeApiLive = HttpApiBuilder.api(WildflowerNodeApi).pipe(
  Layer.provide(WildflowerNodeApiHandlersLive)
)
```

The `<'WildflowerNodeApi'>` type argument is what fixes the `ParentId` phantom — there's no runtime cost.

## Avoid: multiple `topLevel: true` groups under one HttpApi

`HttpApiClient.make(Api, ...)` hoists every endpoint of any group built with `{ topLevel: true }` to the client root. If two such groups define endpoints with the same name (e.g., `Patient` and `Observation` both expose `Collection` and `Create`), they collide — the inferred client type is effectively `{ Collection: ..., Create: ... }` with last-added winning. Neither `client.Patient.Collection()` nor `client.Collection()` will distinguish which resource you meant.

Three workable options:

1. **Drop `topLevel: true`** on all groups under a multi-group Api. The client will then expose `client.Patient.Collection()` etc., which is what you usually want anyway.
2. **Address each resource with its own `HttpApiClient`** against a single-group `HttpApi`. Use this when you genuinely want flat client surfaces and the resources live behind separate `HttpApi`s.
3. **Fall back to raw `fetch('/fhir-r4/Patient')`** for the affected resources. Lowest-friction escape hatch when neither of the above fits.

`{ topLevel: true }` is designed for single-group APIs. If you find yourself reaching for it on a multi-group composition, that's a smell — the `HttpApi` should probably be split, or `topLevel` should come off.

## See Also

- [Effect Patterns Reference](./Patterns%20Reference.md) — Tag/Layer wiring used inside the handler implementations
- [slices/AGENTS.md](../../slices/AGENTS.md) — Slice layering rules
- [Learnings Inbox](../Agents/Learnings%20Inbox.md) — Where these patterns were originally captured before promotion to this doc
