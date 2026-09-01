// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers and `vi.fn()` call args are typed as `any`; the unsafe-assignment lint fires on idiomatic `mock.calls[0]` access here

import type { CancelSnifferRequestMessage } from 'browser-sniffer-core'
import { Effect, MutableHashMap, Option, Schema } from 'effect'
import { LoggingLayerTest, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import { CollectorHttpResponseKind, ScrapingPlan, type Step } from 'collector-fundamentals/model'
import { Specificity } from 'http-extraction-fundamentals'
import { AnotherResponseKind, SimpleResponseKind } from 'http-extraction-fundamentals/test-helpers'
import {
  cancelled,
  drainResults,
  makeSimpleHandler,
  noopSendMessage,
  requestError,
  responseData,
  responseFinished,
  responseStart,
  runHandlerPromise,
  runHandlerSync,
  type SimpleHandlerArgs,
  type SimpleResources,
} from './collector-bridge-message-handler.test-helpers.ts'
import * as CollectorBridgeMessageHandler from './collector-bridge-message-handler.ts'
import * as SnifferResponseTracker from './sniffer-response-tracker.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

// The lifecycle's completion coupling (`handleSniffingComplete` / `abandonAllRequestSniffing` ending the
// `results` mailbox) now lives on the `RunLifecycleState`; see `run-lifecycle-state.test.ts`.

describe('CollectorBridgeMessageHandler.make: sniffer response tracker', () => {
  describe('ResponseStart', () => {
    it('begins tracking when the URL matches some entity', () => {
      const sendMessage = vi.fn(noopSendMessage)
      const handler = makeSimpleHandler({ sendMessage })

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/42' }))
      )

      expect(sendMessage).not.toHaveBeenCalled()
      expect(MutableHashMap.keys(handler.incompleteSniffedRequests)).toContain('r1')
    })

    it('cancels via sendMessage when no entity matches', () => {
      const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
      const handler = makeSimpleHandler({ sendMessage })

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/unknown' }))
      )

      expect(sendMessage).toHaveBeenCalledOnce()
      expect(sendMessage.mock.calls[0][0]).toEqual({
        _tag: 'CancelSnifferRequest',
        id: 'r2',
      } satisfies typeof CancelSnifferRequestMessage.Type)
      expect(MutableHashMap.keys(handler.incompleteSniffedRequests)).not.toContain('r2')
    })

    it('matches against any of the configured entities', () => {
      type MultiResources = SimpleResources | { id: string }
      const sendMessage = vi.fn<SimpleHandlerArgs['sendMessage']>(() => Effect.void)
      const handler = Effect.runSync(
        CollectorBridgeMessageHandler.make<MultiResources>({
          scrapingPlan: ScrapingPlan.make<MultiResources>({
            name: 'MultiPlan',
            // Each response kind is `HttpResponseKind<X>` with `X ⊂ MultiResources`; widen
            // the array to the union so the array literal typechecks.
            responseKinds: [
              SimpleResponseKind,
              AnotherResponseKind,
            ] as readonly CollectorHttpResponseKind.CollectorHttpResponseKind<MultiResources>[],
            stepSequence: [],
          }),
          sendMessage,
          runId: 'test-run',
        })
      )

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/items/abc' }))
      )

      expect(sendMessage).not.toHaveBeenCalled()
      expect(MutableHashMap.keys(handler.incompleteSniffedRequests)).toContain('r1')
      expect(MutableHashMap.keys(handler.incompleteSniffedRequests)).toContain('r2')
    })
  })

  describe('ResponseData', () => {
    it('appends a base64-decoded chunk to a tracked response', () => {
      const handler = makeSimpleHandler()

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(handler.ResponseData(responseData('r1', '{"name":"Bob"')))
      runHandlerSync(handler.ResponseData(responseData('r1', ',"age":25}')))
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))

      const results = drainResults(handler)
      expect(results).toHaveLength(1)
      expectRightToEqual(results[0], { resources: [{ name: 'Bob', age: 25 }], diagnostics: [] })
    })

    it('emits a WARN log and no-ops for an untracked response id', async () => {
      const handler = makeSimpleHandler()

      await runHandlerPromise(
        handler.ResponseData(responseData('unknown', 'data')).pipe(
          LoggingLayerTest.expectToLog((logs) => {
            expect(logs).toEqual([
              expect.objectContaining({
                level: 'WARN',
                message: expect.stringContaining(
                  'CollectorBridgeMessageHandler.ResponseData: no tracked response for id unknown'
                ),
              }),
            ])
          }),
          Effect.scoped
        )
      )
      expect(drainResults(handler)).toHaveLength(0)
    })

    it('offers a Left(UnknownException) and drops the entry when base64 decode fails on a tracked response', () => {
      const handler = makeSimpleHandler()

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(
        handler.ResponseData({ _tag: 'ResponseData', id: 'r1', data: '!!! not base64 !!!' })
      )
      // The tracked entry is removed so a subsequent ResponseFinished
      // becomes a no-op rather than a duplicate result event.
      expect(MutableHashMap.keys(handler.incompleteSniffedRequests)).not.toContain('r1')
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))

      const results = drainResults(handler)
      expect(results).toHaveLength(1)
      expectLeftToEqual(
        results[0],
        expect.objectContaining({
          url: 'https://example.com/people/1',
          error: expect.objectContaining({ _tag: 'UnknownException' }),
        })
      )
    })
  })

  describe('ResponseFinished', () => {
    it('emits a WARN log and no-ops for an untracked response id', async () => {
      const handler = makeSimpleHandler()

      await runHandlerPromise(
        handler.ResponseFinished(responseFinished('unknown')).pipe(
          LoggingLayerTest.expectToLog((logs) => {
            expect(logs).toEqual([
              expect.objectContaining({
                level: 'WARN',
                message: expect.stringContaining(
                  'CollectorBridgeMessageHandler.ResponseFinished: no tracked response for id unknown'
                ),
              }),
            ])
          }),
          Effect.scoped
        )
      )
      expect(drainResults(handler)).toHaveLength(0)
    })

    it('offers a Right of parsed resources on a match', () => {
      const handler = makeSimpleHandler()

      const body = JSON.stringify({ name: 'Carol', age: 40 })
      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/99' }))
      )
      runHandlerSync(handler.ResponseData(responseData('r1', body)))
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))

      const results = drainResults(handler)
      expect(results).toHaveLength(1)
      // The parsed resources reflect the appended body chunks; the response
      // URL is asserted on the failure paths (which keep it on the `Left`).
      expectRightToEqual(results[0], { resources: [{ name: 'Carol', age: 40 }], diagnostics: [] })
    })

    it('removes the response after finishing so a second ResponseFinished is a no-op', async () => {
      const handler = makeSimpleHandler()

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(handler.ResponseData(responseData('r1', '{}')))
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))
      // Second finish: tracked entry is gone → log + no-op.
      await runHandlerPromise(
        handler.ResponseFinished(responseFinished('r1')).pipe(
          LoggingLayerTest.expectToLog((logs) => {
            expect(logs).toEqual([
              expect.objectContaining({
                level: 'WARN',
                message: expect.stringContaining(
                  'CollectorBridgeMessageHandler.ResponseFinished: no tracked response for id r1'
                ),
              }),
            ])
          }),
          Effect.scoped
        )
      )
      // Only the first finish should have produced a result event.
      expect(drainResults(handler)).toHaveLength(1)
    })

    it('routes to the earliest entity when several claim at the same specificity', () => {
      // `SimpleResponseKind` claims at `Specificity.PORTAL`, so a genuine tie
      // needs the overlapping kind at the same tier — then the tie breaks toward
      // list order, exactly as `Extraction.routeTo` documents.
      const OverlappingEntity: CollectorHttpResponseKind.CollectorHttpResponseKind<SimpleResources> =
        CollectorHttpResponseKind.make({
          name: 'OverlappingEntity',
          tryRecognize: (url) =>
            /\/people\//.test(url)
              ? Option.some({ specificity: Specificity.PORTAL })
              : Option.none(),
          parse: () => Effect.succeed([]),
        })

      const handler = Effect.runSync(
        CollectorBridgeMessageHandler.make<SimpleResources>({
          scrapingPlan: ScrapingPlan.make<SimpleResources>({
            name: 'OverlappingPlan',
            responseKinds: [OverlappingEntity, SimpleResponseKind],
            stepSequence: [],
          }),
          sendMessage: noopSendMessage,
          runId: 'test-run',
        })
      )

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(handler.ResponseData(responseData('r1', '{}')))
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))

      const results = drainResults(handler)
      expect(results).toHaveLength(1)
      // Overlapping wins because it's first in `responseKinds`; its parse
      // returns an empty resource list regardless of body.
      expectRightToEqual(results[0], { resources: [], diagnostics: [] })
    })

    it('handles multiple concurrent tracked responses independently', () => {
      const handler = makeSimpleHandler()

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/people/2' }))
      )
      runHandlerSync(
        handler.ResponseData(responseData('r1', JSON.stringify({ name: 'Alice', age: 30 })))
      )
      runHandlerSync(
        handler.ResponseData(responseData('r2', JSON.stringify({ name: 'Bob', age: 25 })))
      )

      runHandlerSync(handler.ResponseFinished(responseFinished('r2')))
      runHandlerSync(handler.ResponseFinished(responseFinished('r1')))

      // Result events arrive in finish order: r2 first, then r1.
      const results = drainResults(handler)
      expect(results).toHaveLength(2)
      expectRightToEqual(results[0], { resources: [{ name: 'Bob', age: 25 }], diagnostics: [] })
      expectRightToEqual(results[1], { resources: [{ name: 'Alice', age: 30 }], diagnostics: [] })
    })
  })

  describe('Cancelled', () => {
    it('offers a Left(SnifferCancelled) and drops the entry for a tracked response', () => {
      const handler = makeSimpleHandler()

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(handler.Cancelled(cancelled('r1')))

      const results = drainResults(handler)
      expect(results).toHaveLength(1)
      expectLeftToEqual(
        results[0],
        expect.objectContaining({
          url: 'https://example.com/people/1',
          error: expect.objectContaining({ _tag: 'SnifferCancelled', id: 'r1' }),
        })
      )
      expect(MutableHashMap.keys(handler.incompleteSniffedRequests)).not.toContain('r1')
    })

    it('emits a WARN log and no-ops for an unsolicited Cancelled (id not tracked)', async () => {
      const handler = makeSimpleHandler()

      await runHandlerPromise(
        handler.Cancelled(cancelled('unknown')).pipe(
          LoggingLayerTest.expectToLog((logs) => {
            expect(logs).toEqual([
              expect.objectContaining({
                level: 'WARN',
                message: expect.stringContaining(
                  'CollectorBridgeMessageHandler.Cancelled: no tracked response for id unknown'
                ),
              }),
            ])
          }),
          Effect.scoped
        )
      )
      expect(drainResults(handler)).toHaveLength(0)
    })
  })

  describe('RequestError', () => {
    it('offers a Left(UnknownException) carrying the error message', () => {
      const handler = makeSimpleHandler()

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/99' }))
      )
      runHandlerSync(
        handler.RequestError(
          requestError({
            id: 'r1',
            url: 'https://example.com/people/99',
            message: 'network down',
          })
        )
      )

      const results = drainResults(handler)
      expect(results).toHaveLength(1)
      // `UnknownException` stores the original payload on `.cause` (and a
      // mirroring `.error`); `.message` is the generic "An unknown error
      // occurred" string. Assert on `cause` so the test pins the actual
      // RequestError → UnknownException wiring, plus the folded-in `url`.
      expectLeftToEqual(
        results[0],
        expect.objectContaining({
          url: 'https://example.com/people/99',
          error: expect.objectContaining({
            _tag: 'UnknownException',
            cause: 'network down',
          }),
        })
      )
    })

    it('emits a WARN log and no-ops for an untracked response id', async () => {
      const handler = makeSimpleHandler()

      await runHandlerPromise(
        handler
          .RequestError(
            requestError({ id: 'unknown', url: 'https://example.com', message: 'oops' })
          )
          .pipe(
            LoggingLayerTest.expectToLog((logs) => {
              expect(logs).toEqual([
                expect.objectContaining({
                  level: 'WARN',
                  message: expect.stringContaining(
                    'CollectorBridgeMessageHandler.RequestError: no tracked response for id unknown'
                  ),
                }),
              ])
            }),
            Effect.scoped
          )
      )
      expect(drainResults(handler)).toHaveLength(0)
    })
  })

  describe('cancelAllRequestSniffing', () => {
    it('drops every incomplete sniffed request without publishing a result', () => {
      const handler = makeSimpleHandler()

      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
      )
      runHandlerSync(
        handler.ResponseStart(responseStart({ id: 'r2', url: 'https://example.com/people/2' }))
      )
      expect(MutableHashMap.size(handler.incompleteSniffedRequests)).toBe(2)

      runHandlerSync(handler.cancelAllRequestSniffing(noopSendMessage))

      expect(MutableHashMap.size(handler.incompleteSniffedRequests)).toBe(0)
      expect(drainResults(handler)).toHaveLength(0)
    })
  })
})

/**
 * The follow-up generation seam: on a successful parse the tracker calls the
 * pinned entity's `followUpSteps` and feeds the result to `handleGeneratedSteps`
 * — **before** dropping and offering the settled result. These build a bare
 * tracker (not the composed handler) so both hooks can be observed directly.
 */
describe('SnifferResponseTracker.make: follow-up generation', () => {
  it('generates the entity follow-up steps before offering the settled result', () => {
    // Arrange
    const calls: string[] = []
    const generated: Step.Step[] = []
    const tracker = makeBareTracker({
      responseKind: generatingEntity,
      handleGeneratedSteps: (steps) =>
        Effect.sync(() => {
          calls.push('generate')
          generated.push(...steps)
        }),
      handleNewSniffResult: () => Effect.sync(() => calls.push('offer')),
    })

    // Act
    runHandlerSync(
      tracker.handleResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
    )
    runHandlerSync(
      tracker.handleResponseData(responseData('r1', JSON.stringify({ name: 'Ada', age: 36 })))
    )
    runHandlerSync(tracker.handleResponseFinished(responseFinished('r1')))

    // Assert: generate → offer, and the response url is resolved against.
    expect(calls).toEqual(['generate', 'offer'])
    expect(generated).toEqual([openStepFor('https://example.com/people/1/child')])
  })

  it('generates nothing when the parse fails', () => {
    // Arrange: no ResponseData → empty body → `parseJson('')` fails.
    const generateSpy = vi.fn<(steps: readonly Step.Step[]) => Effect.Effect<void>>(
      () => Effect.void
    )
    const offerSpy = vi.fn(() => Effect.void)
    const tracker = makeBareTracker({
      responseKind: generatingEntity,
      handleGeneratedSteps: generateSpy,
      handleNewSniffResult: offerSpy,
    })

    // Act
    runHandlerSync(
      tracker.handleResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
    )
    runHandlerSync(tracker.handleResponseFinished(responseFinished('r1')))

    // Assert: the failure is still offered, but no follow-ups are generated.
    expect(offerSpy).toHaveBeenCalledOnce()
    expect(generateSpy).not.toHaveBeenCalled()
  })

  it('generates nothing on a RequestError', () => {
    // Arrange
    const generateSpy = vi.fn<(steps: readonly Step.Step[]) => Effect.Effect<void>>(
      () => Effect.void
    )
    const tracker = makeBareTracker({
      responseKind: generatingEntity,
      handleGeneratedSteps: generateSpy,
      handleNewSniffResult: () => Effect.void,
    })

    // Act
    runHandlerSync(
      tracker.handleResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
    )
    runHandlerSync(
      tracker.handleRequestError(
        requestError({ id: 'r1', url: 'https://example.com/people/1', message: 'boom' })
      )
    )

    // Assert
    expect(generateSpy).not.toHaveBeenCalled()
  })

  it('generates nothing on a Cancelled', () => {
    // Arrange
    const generateSpy = vi.fn<(steps: readonly Step.Step[]) => Effect.Effect<void>>(
      () => Effect.void
    )
    const tracker = makeBareTracker({
      responseKind: generatingEntity,
      handleGeneratedSteps: generateSpy,
      handleNewSniffResult: () => Effect.void,
    })

    // Act
    runHandlerSync(
      tracker.handleResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
    )
    runHandlerSync(tracker.handleCancelled(cancelled('r1')))

    // Assert
    expect(generateSpy).not.toHaveBeenCalled()
  })

  it('contains a throwing followUpSteps: WARNs, generates nothing, still offers the result', async () => {
    // Arrange: `parse` succeeds but the generator throws (a bad
    // `new URL(badHref)` on malformed scraped input).
    const generateSpy = vi.fn<(steps: readonly Step.Step[]) => Effect.Effect<void>>(
      () => Effect.void
    )
    const offerSpy = vi.fn(() => Effect.void)
    const tracker = makeBareTracker({
      responseKind: throwingEntity,
      handleGeneratedSteps: generateSpy,
      handleNewSniffResult: offerSpy,
    })

    // Act
    runHandlerSync(
      tracker.handleResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
    )
    runHandlerSync(
      tracker.handleResponseData(responseData('r1', JSON.stringify({ name: 'Ada', age: 36 })))
    )
    await runHandlerPromise(
      tracker.handleResponseFinished(responseFinished('r1')).pipe(
        LoggingLayerTest.expectToLog((logs) => {
          expect(logs).toContainEqual(
            expect.objectContaining({
              level: 'WARN',
              message: expect.stringContaining('followUpSteps threw'),
            })
          )
        }),
        Effect.scoped
      )
    )

    // Assert: the throw is contained — nothing enqueued, but the settled result
    // is still offered and the id dropped, so the run can complete (no hang).
    expect(generateSpy).not.toHaveBeenCalled()
    expect(offerSpy).toHaveBeenCalledOnce()
    expect(MutableHashMap.size(tracker.incompleteSniffedRequests)).toBe(0)
  })
})

// Helpers

/** A `Navigation`/`Open` step targeting `uri`, the shape `followUpSteps` returns. */
const openStepFor = (uri: string): Step.Step => ({
  _tag: 'Navigation',
  name: `open ${uri}`,
  action: { _tag: 'Open', source: { _tag: 'Uri', uri } },
})

/**
 * An entity that parses a JSON person and, on success, opens a `…/child` page
 * relative to the settled response's url — exercising both the `resources` and
 * `response` arguments of `followUpSteps`.
 */
const generatingEntity: CollectorHttpResponseKind.CollectorHttpResponseKind<SimpleResources> =
  CollectorHttpResponseKind.make({
    name: 'GeneratingEntity',
    tryRecognize: (url) =>
      /\/people\//.test(url) ? Option.some({ specificity: 50 }) : Option.none(),
    parse: (response) =>
      Effect.map(
        Schema.decode(Schema.parseJson(Schema.Struct({ name: Schema.String, age: Schema.Number })))(
          response.text()
        ),
        (person) => [person]
      ),
    followUpSteps: (_resources, response) => [openStepFor(`${response.url}/child`)],
  })

/**
 * An entity whose `parse` succeeds but whose `followUpSteps` throws — models a
 * generator that hits malformed scraped data. The tracker must contain the
 * throw rather than let it strand the settled request in the incomplete map.
 */
const throwingEntity: CollectorHttpResponseKind.CollectorHttpResponseKind<SimpleResources> =
  CollectorHttpResponseKind.make({
    name: 'ThrowingEntity',
    tryRecognize: (url) =>
      /\/people\//.test(url) ? Option.some({ specificity: 50 }) : Option.none(),
    parse: (response) =>
      Effect.map(
        Schema.decode(Schema.parseJson(Schema.Struct({ name: Schema.String, age: Schema.Number })))(
          response.text()
        ),
        (person) => [person]
      ),
    followUpSteps: () => {
      throw new Error('boom: malformed href')
    },
  })

/** Build a bare tracker with stubbed lifecycle hooks so both seams are observable. */
const makeBareTracker = (options: {
  readonly responseKind: CollectorHttpResponseKind.CollectorHttpResponseKind<SimpleResources>
  readonly handleGeneratedSteps: (steps: readonly Step.Step[]) => Effect.Effect<void>
  readonly handleNewSniffResult: () => Effect.Effect<void>
}): SnifferResponseTracker.SnifferResponseTracker<SimpleResources> =>
  Effect.runSync(
    SnifferResponseTracker.make<SimpleResources>({
      matchResponseKind: (url) =>
        Option.isSome(options.responseKind.tryRecognize(url))
          ? Option.some(options.responseKind)
          : Option.none(),
      sendMessage: noopSendMessage,
      handleNewSniffResult: options.handleNewSniffResult,
      handleGeneratedSteps: options.handleGeneratedSteps,
    })
  )

describe('CollectorBridgeMessageHandler.make: captureProvenance', () => {
  type Hook = NonNullable<ScrapingPlan.ScrapingPlan<SimpleResources>['captureProvenance']>

  const planWith = (
    captureProvenance: Hook,
    responseKind: CollectorHttpResponseKind.CollectorHttpResponseKind<SimpleResources> = SimpleResponseKind
  ): ScrapingPlan.ScrapingPlan<SimpleResources> =>
    ScrapingPlan.make<SimpleResources>({
      name: 'CapturePlan',
      responseKinds: [responseKind],
      stepSequence: [],
      captureProvenance,
    })

  /** A hook that link-annotates the parse output and mints one diagnostic. */
  const annotatingHook: Hook = (runId, _response, produced) =>
    Effect.succeed({
      resources: produced.map((person) => ({ ...person, name: `${person.name}@${runId}` })),
      diagnostics: [{ name: 'trace', age: 0 }],
    })

  const settle = (
    handler: ReturnType<typeof makeSimpleHandler>,
    options: { readonly id?: string; readonly body?: string } = {}
  ): void => {
    const id = options.id ?? 'r1'
    runHandlerSync(
      handler.ResponseStart(responseStart({ id, url: 'https://example.com/people/1' }))
    )
    runHandlerSync(
      handler.ResponseData(responseData(id, options.body ?? '{"name":"Bob","age":25}'))
    )
    runHandlerSync(handler.ResponseFinished(responseFinished(id)))
  }

  it('invokes the hook with the run id, the response, and the parse output', () => {
    const hook = vi.fn(annotatingHook)
    const handler = makeSimpleHandler({ scrapingPlan: planWith(hook), runId: 'run-77' })

    settle(handler)

    expect(hook).toHaveBeenCalledOnce()
    const [runId, response, produced] = hook.mock.calls[0] ?? []
    expect(runId).toBe('run-77')
    expect(response?.url).toBe('https://example.com/people/1')
    expect(produced).toEqual([{ name: 'Bob', age: 25 }])
    expectRightToEqual(drainResults(handler)[0], {
      resources: [{ name: 'Bob@run-77', age: 25 }],
      diagnostics: [{ name: 'trace', age: 0 }],
    })
  })

  it('shares one run id across every settled response in a run', () => {
    const hook = vi.fn(annotatingHook)
    const handler = makeSimpleHandler({ scrapingPlan: planWith(hook), runId: 'run-a' })

    settle(handler, { id: 'r1' })
    settle(handler, { id: 'r2' })

    expect(hook.mock.calls.map(([runId]) => runId)).toEqual(['run-a', 'run-a'])
  })

  it('never invokes the hook for a failed parse', () => {
    const hook = vi.fn(annotatingHook)
    const handler = makeSimpleHandler({ scrapingPlan: planWith(hook) })

    settle(handler, { body: 'not json' })

    expect(hook).not.toHaveBeenCalled()
    expect(drainResults(handler)[0]?._tag).toBe('Left')
  })

  it('never invokes the hook for an empty parse — the line between provenance and recording', () => {
    const emptyEntity: CollectorHttpResponseKind.CollectorHttpResponseKind<SimpleResources> =
      CollectorHttpResponseKind.make({
        name: 'EmptyEntity',
        tryRecognize: (url) =>
          /\/people\//.test(url) ? Option.some({ specificity: 50 }) : Option.none(),
        parse: () => Effect.succeed([]),
      })
    const hook = vi.fn(annotatingHook)
    const handler = makeSimpleHandler({ scrapingPlan: planWith(hook, emptyEntity) })

    settle(handler)

    expect(hook).not.toHaveBeenCalled()
    expectRightToEqual(drainResults(handler)[0], { resources: [], diagnostics: [] })
  })

  describe('when the hook does not succeed', () => {
    /**
     * A failure, a synchronous throw, and a mid-effect defect all reach the
     * same guard: the run must survive all three with the parse output intact.
     */
    const brokenHooks: readonly (readonly [string, Hook])[] = [
      ['fails with its own error', () => Effect.fail({ _tag: 'TraceWriteFailed' })],
      [
        'throws synchronously',
        () => {
          throw new Error('capture blew up')
        },
      ],
      ['dies mid-effect', () => Effect.die(new Error('capture died'))],
    ]

    for (const [description, hook] of brokenHooks) {
      it(`keeps the parse output, adds no diagnostics, and WARNs when the hook ${description}`, async () => {
        const handler = makeSimpleHandler({ scrapingPlan: planWith(hook) })

        runHandlerSync(
          handler.ResponseStart(responseStart({ id: 'r1', url: 'https://example.com/people/1' }))
        )
        runHandlerSync(handler.ResponseData(responseData('r1', '{"name":"Bob","age":25}')))
        await runHandlerPromise(
          handler.ResponseFinished(responseFinished('r1')).pipe(
            LoggingLayerTest.expectToLog((logs) => {
              const warnings = logs.filter((log) => log.level === 'WARN')
              expect(warnings).toHaveLength(1)
              // Names the response URL, so a warning in a busy run is attributable.
              expect(warnings[0]?.message).toContain('capturing provenance for')
              expect(warnings[0]?.message).toContain('https://example.com/people/1')
            }),
            Effect.scoped
          )
        )

        expectRightToEqual(drainResults(handler)[0], {
          resources: [{ name: 'Bob', age: 25 }],
          diagnostics: [],
        })
      })
    }
  })

  it('feeds followUpSteps the raw parse output, never the hook-rewritten batch', () => {
    const followUpSteps = vi.fn((resources: readonly SimpleResources[]): readonly Step.Step[] =>
      resources.map((person) => ({
        _tag: 'Navigation',
        name: `open ${person.name}`,
        action: {
          _tag: 'Open',
          source: { _tag: 'Uri', uri: `https://example.com/${person.name}` },
        },
      }))
    )
    const generatingPersonEntity: CollectorHttpResponseKind.CollectorHttpResponseKind<SimpleResources> =
      CollectorHttpResponseKind.make({
        name: 'GeneratingPersonEntity',
        tryRecognize: (url) =>
          /\/people\//.test(url) ? Option.some({ specificity: 50 }) : Option.none(),
        parse: (response) =>
          Effect.map(
            Schema.decode(
              Schema.parseJson(Schema.Struct({ name: Schema.String, age: Schema.Number }))
            )(response.text()),
            (person) => [person]
          ),
        followUpSteps,
      })
    const handler = makeSimpleHandler({
      scrapingPlan: planWith(annotatingHook, generatingPersonEntity),
    })

    settle(handler)

    expect(followUpSteps).toHaveBeenCalledOnce()
    // The raw parse output — not the hook's rewritten resources, and never a
    // diagnostic — so a generator that opens a link per produced resource does
    // not also fire for a provenance record.
    expect(followUpSteps.mock.calls[0]?.[0]).toEqual([{ name: 'Bob', age: 25 }])
  })
})
