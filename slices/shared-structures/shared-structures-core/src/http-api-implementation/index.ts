import type { HttpApiGroup } from '@effect/platform'
import type { Layer } from 'effect'

/**
 * Phantom-id bridge for cross-`HttpApi` composition.
 *
 * Takes a built handlers `Layer` keyed on a child `HttpApi`'s `ApiId` and
 * returns a curried `<ParentId>()` factory yielding the same Layer
 * re-typed under any parent `ApiId`. Every composable slice exports its
 * `<Name>ApiHandlersFor` helper as `apiHandlersFor(<Name>ApiHandlersLive)`,
 * so the one sanctioned `as unknown as ...` cast lives here rather than
 * in every slice.
 *
 * @typeParam ChildId - The child `HttpApi`'s `ApiId`. Inferred from the
 *   input Layer.
 * @typeParam Names - Union of group names the child Layer satisfies.
 *   Inferred from the input Layer.
 * @typeParam E - Error channel of the input Layer.
 * @typeParam R - Requirements channel of the input Layer.
 * @param handlers - The merged Layer of every group handler, keyed on the
 *   child `ApiId` (typically `<Name>ApiHandlersLive`).
 * @returns A factory `<ParentId>()` that returns the same Layer re-typed
 *   under the caller-supplied parent `ApiId`.
 *
 * @remarks
 * `HttpApiGroup.ApiGroup<ApiId, Name>` is a structural marker with no
 * runtime presence — `HttpApiBuilder.group` only registers routes on the
 * shared Router; nothing reads `apiId`. So a Layer built against a child
 * `HttpApi` is sound to satisfy the same group requirement under any
 * consumer's parent `ApiId`. This module is the one place that bridge
 * lives.
 *
 * See [HttpApi Composition How-To](../../../../docs/Effect/HttpApi%20Composition%20How-To.md)
 * for the broader pattern and why the cast is safe.
 */
const apiHandlersFor =
  <ChildId extends string, const Names extends readonly string[], E, R>(
    handlers: Layer.Layer<
      { [K in Names[number]]: HttpApiGroup.ApiGroup<ChildId, K> }[Names[number]],
      E,
      R
    >
  ) =>
  <ParentId extends string>(): Layer.Layer<
    { [K in Names[number]]: HttpApiGroup.ApiGroup<ParentId, K> }[Names[number]],
    E,
    R
  > =>
    // The phantom-id bridge: `ApiGroup<ApiId, Name>` is a structural marker
    // with no runtime presence (HttpApiBuilder.group only registers routes on
    // the shared Router; nothing reads `apiId`), so a Layer built against
    // the child HttpApi is sound to satisfy the same group requirement under
    // any consumer's parent ApiId. This cast is the one place that bridge
    // lives.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    handlers as unknown as Layer.Layer<
      { [K in Names[number]]: HttpApiGroup.ApiGroup<ParentId, K> }[Names[number]],
      E,
      R
    >

export { apiHandlersFor }
