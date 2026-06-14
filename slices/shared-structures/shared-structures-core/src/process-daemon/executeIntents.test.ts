/**
 * Tests for `executeIntents` — the intent → lifecycle-event stream
 * transformer. Each test feeds a deterministic Intent stream into
 * `executeIntents` paired with a stub `startProcess`, and asserts the
 * lifecycle events it produces.
 *
 * Note on test stubs: `Stream.haltWhen + Deferred.fail` does NOT
 * propagate failure to a downstream `catchAllCause` when the source is
 * blocked on an empty queue — haltWhen polls the watch-fiber's state
 * only between source emits, so a deferred-failure that lands while the
 * source is idle is never observed. Use `Stream.interruptWhenDeferred`
 * (or `Stream.interruptWhen`) for post-bind failure stubs instead.
 */
import { Cause, Chunk, Deferred, Effect, Ref, type Scope, Stream } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { executeIntents } from './executeIntents.ts'
import type { Intent, LifecycleEvent } from './types.ts'

interface FakeConfig {
  readonly id: string
}

const startProcess = (config: FakeConfig): Stream.Stream<string, string, Scope.Scope> =>
  Stream.succeed(`bound:${config.id}`)

describe('executeIntents', () => {
  it('emits Running for a successful StartOrReconfigure', async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const chunk = yield* Stream.fromIterable<Intent<FakeConfig>>([
          { _tag: 'StartOrReconfigure', config: { id: 'a' } },
        ]).pipe(executeIntents({ startProcess }), Stream.take(1), Stream.runCollect)
        return Chunk.toReadonlyArray(chunk)
      })
    )
    expect(events.map((e) => e._tag)).toEqual(['Running'])
    expect(events[0]).toMatchObject({ _tag: 'Running', config: { id: 'a' }, status: 'bound:a' })
  })

  it('emits Idle on a Stop intent', async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const chunk = yield* Stream.fromIterable<Intent<FakeConfig>>([{ _tag: 'Stop' }]).pipe(
          executeIntents({ startProcess }),
          Stream.runCollect
        )
        return Chunk.toReadonlyArray(chunk)
      })
    )
    expect(events.map((e) => e._tag)).toEqual(['Idle'])
  })

  it('emits Failed when the underlying start stream fails before emitting', async () => {
    const failing = (): Stream.Stream<string, string, Scope.Scope> => Stream.fail<string>('boom')
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const chunk = yield* Stream.fromIterable<Intent<FakeConfig>>([
          { _tag: 'StartOrReconfigure', config: { id: 'x' } },
        ]).pipe(executeIntents({ startProcess: failing }), Stream.runCollect)
        return Chunk.toReadonlyArray(chunk)
      })
    )
    expect(events.map((e) => e._tag)).toEqual(['Failed'])
  })

  it('emits Running then Failed when the tail fails post-bind', async () => {
    const headThenFail = (config: FakeConfig): Stream.Stream<string, string, Scope.Scope> =>
      Stream.concat(Stream.succeed(`bound:${config.id}`), Stream.fail('crash'))

    const events = await Effect.runPromise(
      Stream.fromIterable<Intent<FakeConfig>>([
        { _tag: 'StartOrReconfigure', config: { id: 'a' } },
      ]).pipe(executeIntents({ startProcess: headThenFail }), Stream.take(2), Stream.runCollect)
    )
    const arr = Chunk.toReadonlyArray(events)
    expect(arr.map((e: LifecycleEvent<FakeConfig, string, string>) => e._tag)).toEqual([
      'Running',
      'Failed',
    ])
  })

  it('on supersede: first scope finalizer fires, no Failed emitted, events are Running(a) then Running(b)', async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const finalizerCalls = yield* Ref.make<ReadonlyArray<string>>([])
        // A two-emit-then-block stream for the first config: emit bind
        // signal, then sit idle waiting on a deferred that never fires.
        // The supersede must interrupt it and run the finalizer.
        const firstBlocker = yield* Deferred.make<never, never>()
        const longRunning = (config: FakeConfig): Stream.Stream<string, string, Scope.Scope> =>
          Stream.acquireRelease(Effect.succeed(`scope-of-${config.id}`), (id) =>
            Ref.update(finalizerCalls, (xs) => [...xs, id])
          ).pipe(
            Stream.flatMap(() =>
              Stream.concat(
                Stream.succeed(`bound:${config.id}`),
                Stream.fromEffect(Deferred.await(firstBlocker))
              )
            )
          )

        // Drive two intents with a small gap so the supersede happens
        // after the first Running has been emitted.
        const intents = Stream.concat(
          Stream.succeed<Intent<FakeConfig>>({ _tag: 'StartOrReconfigure', config: { id: 'a' } }),
          Stream.fromEffect(
            Effect.delay(
              Effect.succeed<Intent<FakeConfig>>({
                _tag: 'StartOrReconfigure',
                config: { id: 'b' },
              }),
              '20 millis'
            )
          )
        )

        const collected = yield* intents.pipe(
          executeIntents({ startProcess: longRunning }),
          Stream.take(2),
          Stream.runCollect
        )

        // Give finalizers a tick to settle after the consumer halts.
        yield* Effect.sleep('20 millis')
        const calls = yield* Ref.get(finalizerCalls)
        return { events: Chunk.toReadonlyArray(collected), finalizers: calls }
      })
    )
    expect(events.events.map((e) => e._tag)).toEqual(['Running', 'Running'])
    expect(events.events[0]).toMatchObject({ status: 'bound:a' })
    expect(events.events[1]).toMatchObject({ status: 'bound:b' })
    // The first scope's finalizer must have fired.
    expect(events.finalizers).toContain('scope-of-a')
  })

  // -------------------------------------------------------------------------
  // Properties
  // -------------------------------------------------------------------------

  const arbConfig: fc.Arbitrary<FakeConfig> = fc
    .string({ minLength: 1, maxLength: 4 })
    .map((id) => ({ id }))
  const arbIntent: fc.Arbitrary<Intent<FakeConfig>> = fc.oneof(
    arbConfig.map((config) => ({ _tag: 'StartOrReconfigure' as const, config })),
    fc.constant({ _tag: 'Stop' as const })
  )

  it('never emits a Failed whose cause is interrupted-only (supersedes are silent)', () =>
    fc.assert(
      fc.asyncProperty(fc.array(arbIntent, { minLength: 1, maxLength: 6 }), async (intents) => {
        // A startProcess that emits the bind signal then waits forever
        // — so every active intent is mid-tail when the next intent
        // supersedes it. That maximizes interrupt-cause exposure.
        const blocker = (config: FakeConfig): Stream.Stream<string, string, Scope.Scope> =>
          Stream.concat(Stream.succeed(`bound:${config.id}`), Stream.never)

        const events = await Effect.runPromise(
          Effect.gen(function* () {
            // Pace the intents so each one has time to bind before the
            // next supersedes — otherwise the consumer side could
            // collapse multiple supersedes into a single observable
            // interrupt.
            const paced = Stream.fromIterable(intents).pipe(
              Stream.mapEffect((i) => Effect.delay(Effect.succeed(i), '5 millis'))
            )
            // Take at most one event per intent (Running or Idle), then
            // halt — we're checking what reaches the consumer, not
            // exercising infinite tails.
            const chunk = yield* paced.pipe(
              executeIntents({ startProcess: blocker }),
              Stream.take(intents.length),
              Stream.runCollect
            )
            return Chunk.toReadonlyArray(chunk)
          })
        )

        for (const event of events) {
          if (event._tag === 'Failed') {
            // If a Failed slips through, it must NOT be interrupted-only.
            expect(Cause.isInterruptedOnly(event.cause)).toBe(false)
          }
        }
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    ))
})
