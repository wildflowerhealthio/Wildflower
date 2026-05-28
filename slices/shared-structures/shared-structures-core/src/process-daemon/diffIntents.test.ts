/**
 * Truth-table tests for `diffIntents` — the snapshot → intent
 * transitional fold. Property tests cover the invariants ("an active
 * → inactive transition emits Stop", "the daemon never emits NoOp
 * downstream", etc.) while the example tests pin specific transitions.
 */
import { Chunk, Data, Effect, Stream } from 'effect'
import fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { diffIntents } from './diffIntents.ts'
import type { Intent, ControlSnapshot } from './types.ts'

interface FakeConfig {
  readonly id: string
}
const cfg = (id: string): FakeConfig => Data.struct({ id })

const collect = <Config>(
  snapshots: ReadonlyArray<ControlSnapshot<Config>>
): Effect.Effect<ReadonlyArray<Intent<Config>>> =>
  Stream.runCollect(diffIntents(Stream.fromIterable(snapshots))).pipe(
    Effect.map((chunk) => Chunk.toReadonlyArray(chunk))
  )

const snapshot = <Config>(
  requestedRunning: boolean,
  config: Config | null
): ControlSnapshot<Config> => ({
  requestedRunning,
  config,
})

describe('diffIntents', () => {
  it('emits no intent for an initial inactive snapshot', async () => {
    const intents = await Effect.runPromise(collect([snapshot(false, null)]))
    expect(intents).toEqual([])
  })

  it('emits StartOrReconfigure on an initial active snapshot', async () => {
    const intents = await Effect.runPromise(collect([snapshot(true, cfg('a'))]))
    expect(intents).toEqual([{ _tag: 'StartOrReconfigure', config: cfg('a') }])
  })

  it('emits StartOrReconfigure on each config change while requestedRunning stays true', async () => {
    const intents = await Effect.runPromise(
      collect([snapshot(true, cfg('a')), snapshot(true, cfg('b')), snapshot(true, cfg('c'))])
    )
    expect(intents).toEqual([
      { _tag: 'StartOrReconfigure', config: cfg('a') },
      { _tag: 'StartOrReconfigure', config: cfg('b') },
      { _tag: 'StartOrReconfigure', config: cfg('c') },
    ])
  })

  it('emits Stop when active → inactive', async () => {
    const intents = await Effect.runPromise(
      collect([snapshot(true, cfg('a')), snapshot(false, cfg('a'))])
    )
    expect(intents).toEqual([{ _tag: 'StartOrReconfigure', config: cfg('a') }, { _tag: 'Stop' }])
  })

  it('emits Stop when config becomes null (e.g. tunnel partial config cleared)', async () => {
    const intents = await Effect.runPromise(
      collect([snapshot(true, cfg('a')), snapshot(true, null)])
    )
    expect(intents).toEqual([{ _tag: 'StartOrReconfigure', config: cfg('a') }, { _tag: 'Stop' }])
  })

  it('emits no intent when transitioning inactive → inactive (no work to do)', async () => {
    const intents = await Effect.runPromise(
      collect([snapshot(false, null), snapshot(false, cfg('a'))])
    )
    expect(intents).toEqual([])
  })

  it('treats requestedRunning=true with config=null as inactive (parking)', async () => {
    const intents = await Effect.runPromise(
      collect([snapshot(true, null), snapshot(true, cfg('a'))])
    )
    // The first emit is "parked" (no transition). The second is the
    // start once the config landed.
    expect(intents).toEqual([{ _tag: 'StartOrReconfigure', config: cfg('a') }])
  })

  it('properly handles an off → on → off → on cycle', async () => {
    const intents = await Effect.runPromise(
      collect([
        snapshot(false, null),
        snapshot(true, cfg('a')),
        snapshot(false, cfg('a')),
        snapshot(true, cfg('b')),
      ])
    )
    expect(intents).toEqual([
      { _tag: 'StartOrReconfigure', config: cfg('a') },
      { _tag: 'Stop' },
      { _tag: 'StartOrReconfigure', config: cfg('b') },
    ])
  })

  // -------------------------------------------------------------------------
  // Properties
  // -------------------------------------------------------------------------

  const arbConfig = fc.string({ minLength: 1, maxLength: 8 }).map(cfg)
  const arbSnapshot: fc.Arbitrary<ControlSnapshot<FakeConfig>> = fc.oneof(
    fc.record({ requestedRunning: fc.constant(false), config: fc.constant(null) }),
    fc.record({ requestedRunning: fc.constant(false), config: arbConfig }),
    fc.record({ requestedRunning: fc.constant(true), config: fc.constant(null) }),
    fc.record({ requestedRunning: fc.constant(true), config: arbConfig })
  )

  it('emits at most one intent per input snapshot', () =>
    fc.assert(
      fc.asyncProperty(fc.array(arbSnapshot, { minLength: 0, maxLength: 8 }), async (snapshots) => {
        const intents = await Effect.runPromise(collect(snapshots))
        expect(intents.length).toBeLessThanOrEqual(snapshots.length)
      }),
      { numRuns: numRunsFor(100) }
    ))

  it('never emits two consecutive Stop intents (each Stop must be preceded by a Start)', () =>
    fc.assert(
      fc.asyncProperty(fc.array(arbSnapshot, { minLength: 0, maxLength: 8 }), async (snapshots) => {
        const intents = await Effect.runPromise(collect(snapshots))
        for (let i = 1; i < intents.length; i++) {
          if (intents[i]._tag === 'Stop' && intents[i - 1]._tag === 'Stop') {
            throw new Error(`consecutive Stops at index ${String(i)}`)
          }
        }
      }),
      { numRuns: numRunsFor(100) }
    ))

  it('the first emitted intent is always StartOrReconfigure (initial inactive is filtered)', () =>
    fc.assert(
      fc.asyncProperty(fc.array(arbSnapshot, { minLength: 0, maxLength: 8 }), async (snapshots) => {
        const intents = await Effect.runPromise(collect(snapshots))
        if (intents.length === 0) return
        expect(intents[0]._tag).toBe('StartOrReconfigure')
      }),
      { numRuns: numRunsFor(100) }
    ))

  it('every Stop is preceded by a StartOrReconfigure with no intervening Stop', () =>
    fc.assert(
      fc.asyncProperty(fc.array(arbSnapshot, { minLength: 0, maxLength: 8 }), async (snapshots) => {
        const intents = await Effect.runPromise(collect(snapshots))
        intents.forEach((intent, i) => {
          if (intent._tag !== 'Stop') return
          // Walk back from i-1 looking for the most recent
          // StartOrReconfigure. The loop must find one before hitting
          // another Stop or the start of the array.
          let foundStart = false
          for (let j = i - 1; j >= 0; j--) {
            const prior = intents[j]
            if (prior._tag === 'Stop') {
              throw new Error(
                `Stop at index ${String(i)} preceded by another Stop at ${String(j)} with no Start between`
              )
            }
            if (prior._tag === 'StartOrReconfigure') {
              foundStart = true
              break
            }
          }
          if (!foundStart) {
            throw new Error(`Stop at index ${String(i)} has no preceding StartOrReconfigure`)
          }
        })
      }),
      { numRuns: numRunsFor(100) }
    ))
})
