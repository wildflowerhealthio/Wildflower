import { Effect, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { LoggingLayerTest, numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import { makeRemoteResponse } from '../test-helpers.ts'
import { withCapturedSource, type CaptureSource } from './captured-source.ts'
import * as EntityDefinition from './entity-definition.ts'
import type { RemoteResponse } from './response.ts'
import type * as Step from './step.ts'

/**
 * The resources under test are opaque strings: nothing here reads them, so the
 * assertions can only be about provenance (which array reached which callback)
 * rather than about content.
 */
const INNER_RESOURCES: readonly string[] = ['patient-1', 'patient-2']

/** The record a `capture` appends — the stand-in for a provenance document. */
const CAPTURED = 'captured-source'

const response = makeRemoteResponse({ url: 'https://example.com/people/1' })

/** An entity whose `parse` resolves to `resources`, with no follow-ups. */
const entityProducing = (resources: readonly string[]): EntityDefinition.EntityDefinition<string> =>
  EntityDefinition.make<string>({
    name: 'InnerEntity',
    isFoundAt: (url) => url.includes('/people/'),
    parse: () => Effect.succeed(resources),
  })

/** An entity whose `parse` fails, so there is no response→resource pairing. */
const failingEntity: EntityDefinition.EntityDefinition<string> = EntityDefinition.make<string>({
  name: 'InnerEntity',
  isFoundAt: (url) => url.includes('/people/'),
  parse: () =>
    Effect.fail(new ParseResult.ParseError({ issue: new ParseResult.Type(Schema.String.ast, 1) })),
})

/** An `Open` step per resource — the generator shape the wrapper must not skew. */
const openStepPerResource = (
  resources: readonly string[],
  from: RemoteResponse
): readonly Step.Step[] =>
  resources.map((resource) => ({
    _tag: 'Navigation',
    name: `open ${resource}`,
    action: { _tag: 'Open', source: { _tag: 'Uri', uri: `${from.url}/${resource}` } },
  }))

/** A `capture` that appends {@link CAPTURED} to whatever the entity produced. */
const appendCapture: CaptureSource<string> = (_response, produced) =>
  Effect.succeed([...produced, CAPTURED])

describe('withCapturedSource', () => {
  it('delegates name and isFoundAt to the inner entity', () => {
    const wrapped = withCapturedSource(entityProducing(INNER_RESOURCES), appendCapture)

    expect(wrapped.name).toBe('InnerEntity')
    expect(wrapped.isFoundAt('https://example.com/people/1')).toBe(true)
    expect(wrapped.isFoundAt('https://example.com/items/1')).toBe(false)
  })

  it('is frozen, like any EntityDefinition.make result', () => {
    expect(
      Object.isFrozen(withCapturedSource(entityProducing(INNER_RESOURCES), appendCapture))
    ).toBe(true)
  })

  it('propagates a failing inner parse and never runs capture', async () => {
    const capture = vi.fn(appendCapture)
    const wrapped = withCapturedSource(failingEntity, capture)

    const result = await Effect.runPromise(Effect.either(wrapped.parse(response)))

    expect(result._tag).toBe('Left')
    expect(capture).not.toHaveBeenCalled()
  })

  it('returns empty and never runs capture when the inner parse produced nothing', async () => {
    const capture = vi.fn(appendCapture)
    const wrapped = withCapturedSource(entityProducing([]), capture)

    expect(await Effect.runPromise(wrapped.parse(response))).toEqual([])
    expect(capture).not.toHaveBeenCalled()
  })

  it('returns what capture produced, from the response and the inner resources', async () => {
    const capture = vi.fn(appendCapture)
    const wrapped = withCapturedSource(entityProducing(INNER_RESOURCES), capture)

    const parsed = await Effect.runPromise(wrapped.parse(response))

    expect(parsed).toEqual([...INNER_RESOURCES, CAPTURED])
    expect(capture).toHaveBeenCalledOnce()
    // Provenance: the capture saw the *same* response and resource array the
    // inner entity was handed, not a copy the wrapper synthesized.
    expect(capture.mock.calls[0]?.[0]).toBe(response)
    expect(capture.mock.calls[0]?.[1]).toBe(INNER_RESOURCES)
  })

  it('property: capture runs exactly when the inner parse produced a resource', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string()), async (produced) => {
        const capture = vi.fn(appendCapture)
        const wrapped = withCapturedSource(entityProducing(produced), capture)

        const parsed = await Effect.runPromise(wrapped.parse(response))

        if (produced.length === 0) {
          expect(capture).not.toHaveBeenCalled()
          expect(parsed).toEqual([])
        } else {
          expect(capture).toHaveBeenCalledOnce()
          expect(parsed).toEqual([...produced, CAPTURED])
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  describe('when capture does not succeed', () => {
    /**
     * A failure, a synchronous throw, and a mid-effect defect all reach the same
     * guard: the run must survive all three with the entity's own output intact.
     */
    const brokenCaptures: readonly (readonly [string, CaptureSource<string>])[] = [
      ['fails with its own error', () => Effect.fail({ _tag: 'TraceWriteFailed' })],
      [
        'throws synchronously',
        () => {
          throw new Error('capture blew up')
        },
      ],
      ['dies mid-effect', () => Effect.die(new Error('capture died'))],
    ]

    for (const [description, capture] of brokenCaptures) {
      it(`returns the inner resources and WARNs when capture ${description}`, async () => {
        const wrapped = withCapturedSource(entityProducing(INNER_RESOURCES), capture)

        const parsed = await Effect.runPromise(
          wrapped.parse(response).pipe(
            LoggingLayerTest.expectToLog((logs) => {
              const warnings = logs.filter((log) => log.level === 'WARN')
              expect(warnings).toHaveLength(1)
              // Names the entity and the response URL, so a warning in a
              // multi-entity run is attributable.
              expect(warnings[0]?.message).toContain('withCapturedSource(InnerEntity)')
              expect(warnings[0]?.message).toContain('https://example.com/people/1')
            }),
            Effect.scoped
          )
        )

        // The entity's own output is untouched — the capture is a diagnostic.
        expect(parsed).toBe(INNER_RESOURCES)
      })
    }
  })

  describe('followUpSteps', () => {
    it('stays absent when the inner entity has none', () => {
      const wrapped = withCapturedSource(entityProducing(INNER_RESOURCES), appendCapture)

      // Compared rather than passed to `toBeUndefined`, which would reference
      // the (declared-as-a-method) property unbound. This is the exact check
      // the handler makes before generating follow-ups.
      expect(wrapped.followUpSteps === undefined).toBe(true)
    })

    it('receives the inner resources, not the capture additions', async () => {
      const followUpSteps = vi.fn(openStepPerResource)
      const wrapped = withCapturedSource(
        EntityDefinition.make<string>({
          name: 'InnerEntity',
          isFoundAt: () => true,
          parse: () => Effect.succeed(INNER_RESOURCES),
          followUpSteps,
        }),
        appendCapture
      )

      // The handler calls `followUpSteps` with exactly the array `parse`
      // resolved to; replay that contract here.
      const parsed = await Effect.runPromise(wrapped.parse(response))
      const steps = wrapped.followUpSteps?.(parsed, response)

      expect(followUpSteps).toHaveBeenCalledWith(INNER_RESOURCES, response)
      // One step per *produced* resource — the provenance record generates none.
      expect(steps).toHaveLength(INNER_RESOURCES.length)
    })

    it('receives the inner resources even when capture failed', async () => {
      const followUpSteps = vi.fn(openStepPerResource)
      const wrapped = withCapturedSource(
        EntityDefinition.make<string>({
          name: 'InnerEntity',
          isFoundAt: () => true,
          parse: () => Effect.succeed(INNER_RESOURCES),
          followUpSteps,
        }),
        () => Effect.fail('nope')
      )

      const parsed = await Effect.runPromise(wrapped.parse(response))
      wrapped.followUpSteps?.(parsed, response)

      expect(followUpSteps).toHaveBeenCalledWith(INNER_RESOURCES, response)
    })

    it("property: generates exactly the inner entity's steps for any produced batch", async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(fc.string(), { minLength: 1 }), async (produced) => {
          const wrapped = withCapturedSource(
            EntityDefinition.make<string>({
              name: 'InnerEntity',
              isFoundAt: () => true,
              parse: () => Effect.succeed(produced),
              followUpSteps: openStepPerResource,
            }),
            appendCapture
          )

          const parsed = await Effect.runPromise(wrapped.parse(response))

          expect(wrapped.followUpSteps?.(parsed, response)).toEqual(
            openStepPerResource(produced, response)
          )
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})
