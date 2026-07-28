import { Effect } from 'effect'
import * as fc from 'fast-check'
import { LoggingLayerTest, numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, vi, type Mock } from 'vite-plus/test'

import { withDiagnosticResources, type PersistResources } from './diagnostic-resources.ts'
import type { PersistFailure } from './resource-persistence-runtime.ts'

/**
 * A resource is a `label`/`id` pair plus the one bit the wrapper partitions on,
 * so a failure record can be built from a resource without a codec.
 */
interface TestResource {
  readonly label: string
  readonly id: string
  readonly diagnostic: boolean
}

const isDiagnostic = (resource: TestResource): boolean => resource.diagnostic

const resourceArb: fc.Arbitrary<TestResource> = fc.record({
  label: fc.constantFrom('Patient', 'Observation', 'DocumentReference'),
  id: fc.string({ minLength: 1 }),
  diagnostic: fc.boolean(),
})

const failureFor = (resource: TestResource): PersistFailure => ({
  failed: { label: resource.label, id: resource.id },
  cause: new Error(`could not write ${resource.id}`),
})

/**
 * The injected sink, recording every batch it was handed.
 *
 * @param failing - Resources this sink reports as {@link PersistFailure}s;
 * everything else is written successfully
 */
const spySink = (
  failing: (resource: TestResource) => boolean = () => false
): Mock<PersistResources<TestResource, never>> =>
  vi.fn<PersistResources<TestResource, never>>((resources) =>
    Effect.succeed(resources.filter(failing).map(failureFor))
  )

const clinical = (id: string): TestResource => ({ label: 'Patient', id, diagnostic: false })
const trace = (id: string): TestResource => ({ label: 'DocumentReference', id, diagnostic: true })

describe('withDiagnosticResources', () => {
  it('writes the primary resources before the diagnostic ones', async () => {
    const sink = spySink()

    await Effect.runPromise(
      withDiagnosticResources(
        sink,
        isDiagnostic
      )([trace('t1'), clinical('c1'), trace('t2'), clinical('c2')])
    )

    expect(sink.mock.calls.map(([batch]) => batch)).toEqual([
      // Primary first, so a diagnostic write can never delay or displace the
      // collector's real output. Order within each partition is preserved.
      [clinical('c1'), clinical('c2')],
      [trace('t1'), trace('t2')],
    ])
  })

  it('returns only the primary failures', async () => {
    const sink = spySink(() => true)

    const failures = await Effect.runPromise(
      withDiagnosticResources(sink, isDiagnostic)([clinical('c1'), trace('t1')])
    )

    expect(failures).toEqual([failureFor(clinical('c1'))])
  })

  it('WARNs one line per failed diagnostic write, naming its label and id', async () => {
    const sink = spySink((resource) => resource.diagnostic)

    const failures = await Effect.runPromise(
      withDiagnosticResources(
        sink,
        isDiagnostic
      )([clinical('c1'), trace('t1'), trace('t2')]).pipe(
        LoggingLayerTest.expectToLog((logs) => {
          const warnings = logs.filter((log) => log.level === 'WARN')
          expect(warnings).toHaveLength(2)
          expect(warnings[0]?.message).toContain('DocumentReference')
          expect(warnings[0]?.message).toContain('t1')
          expect(warnings[1]?.message).toContain('t2')
        }),
        Effect.scoped
      )
    )

    // A failed diagnostic write is logged only — the run stays clean, which is
    // what keeps a successful clinical import from reporting as `partial`.
    expect(failures).toEqual([])
  })

  it('makes no write for a partition that is empty', async () => {
    const allPrimary = spySink()
    const allDiagnostic = spySink()
    const empty = spySink()

    await Effect.runPromise(
      withDiagnosticResources(allPrimary, isDiagnostic)([clinical('c1'), clinical('c2')])
    )
    await Effect.runPromise(
      withDiagnosticResources(allDiagnostic, isDiagnostic)([trace('t1'), trace('t2')])
    )
    await Effect.runPromise(withDiagnosticResources(empty, isDiagnostic)([]))

    // An empty-array round trip per batch is a real cost at import volumes.
    expect(allPrimary).toHaveBeenCalledExactlyOnceWith([clinical('c1'), clinical('c2')])
    expect(allDiagnostic).toHaveBeenCalledExactlyOnceWith([trace('t1'), trace('t2')])
    expect(empty).not.toHaveBeenCalled()
  })

  it('property: the two partitions concatenated are the batch, in order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(resourceArb), async (resources) => {
        const sink = spySink()

        await Effect.runPromise(withDiagnosticResources(sink, isDiagnostic)(resources))

        const written = sink.mock.calls.flatMap(([batch]) => [...batch])
        // Nothing lost, nothing duplicated, nothing reordered within a partition.
        expect(written.filter((r) => !r.diagnostic)).toEqual(resources.filter((r) => !r.diagnostic))
        expect(written.filter((r) => r.diagnostic)).toEqual(resources.filter((r) => r.diagnostic))
        expect(sink).toHaveBeenCalledTimes(
          (resources.some((r) => !r.diagnostic) ? 1 : 0) + (resources.some(isDiagnostic) ? 1 : 0)
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('property: every primary failure, and no diagnostic failure, is returned', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(resourceArb), async (resources) => {
        // Everything the sink is handed fails, so the filter is the only thing
        // that can decide what comes back.
        const sink = spySink(() => true)

        // The capturing logger keeps the per-diagnostic WARNs off the console
        // across the property's runs; this test is about the return value.
        const failures = await Effect.runPromise(
          Effect.provide(
            withDiagnosticResources(sink, isDiagnostic)(resources),
            LoggingLayerTest.make().layer
          )
        )

        expect(failures).toEqual(resources.filter((r) => !r.diagnostic).map(failureFor))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
