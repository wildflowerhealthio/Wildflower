import { Cause, Effect } from 'effect'
import * as EntityDefinition from './entity-definition.ts'
import type { RemoteResponse } from './response.ts'

/**
 * Turn the response an entity decoded, and the resources it produced, into the
 * batch `parse` hands back — the seam a collector uses to record where a
 * resource came from.
 *
 * @typeParam TResources - The wrapped entity's resource type
 * @param response - The settled response the inner `parse` just decoded
 * @param produced - The non-empty resource array that `parse` returned
 * @returns The batch the wrapped `parse` yields — conventionally `produced`
 * plus whatever provenance record the collector mints
 *
 * @remarks
 * The error channel is `unknown` on purpose: a capture is a diagnostic, and
 * {@link withCapturedSource} swallows whatever it fails with, so a collector is
 * free to fail with its own error type without widening the entity's
 * `ParseError`-only channel.
 */
type CaptureSource<TResources> = (
  response: RemoteResponse,
  produced: readonly TResources[]
) => Effect.Effect<readonly TResources[], unknown>

/**
 * Per-wrapper map from the array `parse` returned to the array the *inner*
 * entity produced, so `followUpSteps` can be replayed against the inner
 * resources rather than the capture's additions.
 *
 * @remarks
 * The handler calls `followUpSteps(parsed, response)` with exactly the array
 * `parse` resolved to, and nothing else correlates the two calls — `parse` is
 * an `Effect` run per settled response, with several in flight at once, so a
 * "last parse" closure variable would race. Keying on the returned array's
 * identity is the one correlation the handler contract guarantees. `WeakMap`
 * (rather than a `Map`) keeps the entry alive only as long as the handler holds
 * the batch, and the key is always an array, so it works for a `TResources`
 * that is a primitive.
 */
type InnerResourcesByParsed<TResources> = WeakMap<object, readonly TResources[]>

/**
 * Wrap an {@link EntityDefinition.EntityDefinition} so every non-empty parse
 * also runs `capture`, letting a collector record the raw source each resource
 * came from without the entity's decode knowing anything about it.
 *
 * @typeParam TResources - The wrapped entity's resource type; the capture must
 * produce the same type, so the wrapper is a drop-in for the entity it wraps
 * @param entity - The entity to wrap; its `name`, `isFoundAt`, and
 * `followUpSteps` pass through unchanged
 * @param capture - Given the settled response and the resources the inner
 * `parse` produced, returns the batch `parse` resolves to
 * @returns A frozen entity with the same `name` / `isFoundAt` /
 * `followUpSteps` behaviour and a capturing `parse`
 *
 * @remarks
 * The pairing of "a response" with "the resources it produced" exists only
 * inside `parse` — the response tracker discards the {@link RemoteResponse} as
 * soon as the parse settles — which is why the seam is a combinator over the
 * entity rather than a hook on the handler.
 *
 * Four rules make the wrapper safe to apply to any entity:
 *
 * - **A failing `parse` propagates untouched and `capture` never runs.** There
 *   is no response→resource pairing to record when nothing was decoded.
 * - **An empty parse returns empty and `capture` never runs.** A response that
 *   produced no resource is not captured. This is what separates deliberate
 *   provenance collection from bulk recording: a recorder claims every response
 *   including the ones that decode to nothing, and it should be written as its
 *   own entity, not as a capture.
 * - **A failing `capture` cannot fail the run or change what the entity
 *   produced.** Both a failure and a *defect* (a `capture` that throws
 *   synchronously or dies mid-effect) are caught, `Effect.logWarning`-ed with
 *   the entity name and the response URL, and the inner `produced` array is
 *   returned unchanged. A diagnostic must never take a run down, so the
 *   wrapper's error channel stays `ParseError`-only.
 * - **`followUpSteps` sees the inner entity's resources, not the capture's.** A
 *   generator that opens a link per produced resource must not also fire for a
 *   provenance record. The wrapper replays the inner resources via
 *   {@link InnerResourcesByParsed}; a batch it has no record of (nothing the
 *   handler does produces one) passes through as given. "Absent stays absent" —
 *   an inner entity without `followUpSteps` yields a wrapper without one, since
 *   the handler branches on `!== undefined`.
 *
 * @example
 * ```ts
 * const CapturingPatientEntity = withCapturedSource(PatientEntity, (response, produced) =>
 *   Effect.map(traceDocumentFor(response, produced), (trace) => [...produced, trace])
 * )
 * ```
 */
const withCapturedSource = <TResources>(
  entity: EntityDefinition.EntityDefinition<TResources>,
  capture: CaptureSource<TResources>
): EntityDefinition.EntityDefinition<TResources> => {
  const innerResourcesByParsed: InnerResourcesByParsed<TResources> = new WeakMap()
  // Bound once here rather than read off `entity` inside the wrapper: it is a
  // method for covariance (see `EntityDefinition`), it is `this`-free, and
  // binding it up front is what makes "absent stays absent" a single check.
  // oxlint-disable-next-line typescript-eslint/unbound-method -- pure, this-free method; the copy is safe
  const innerFollowUpSteps = entity.followUpSteps
  return EntityDefinition.make({
    name: entity.name,
    isFoundAt: entity.isFoundAt,
    parse: (response) =>
      Effect.flatMap(entity.parse(response), (produced) =>
        produced.length === 0
          ? Effect.succeed(produced)
          : // `Effect.suspend` so a `capture` that throws *while being called*
            // becomes a defect inside the effect `catchAllCause` guards, rather
            // than a throw escaping this continuation.
            Effect.suspend(() => capture(response, produced)).pipe(
              Effect.map((captured) => {
                innerResourcesByParsed.set(captured, produced)
                return captured
              }),
              Effect.catchAllCause((cause) =>
                Effect.as(
                  Effect.logWarning(
                    `withCapturedSource(${entity.name}): capturing the source of ${response.url} failed; keeping the parsed resources (${Cause.pretty(cause)})`
                  ),
                  produced
                )
              )
            )
      ),
    followUpSteps:
      innerFollowUpSteps === undefined
        ? undefined
        : (resources, response) =>
            innerFollowUpSteps(innerResourcesByParsed.get(resources) ?? resources, response),
  })
}

export { withCapturedSource }
export type { CaptureSource }
