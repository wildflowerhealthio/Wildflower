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
import { Chunk, Effect, type Scope, Stream } from 'effect'
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
        ]).pipe(
          executeIntents<FakeConfig, string, string>({ startProcess }),
          Stream.take(1),
          Stream.runCollect
        )
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
          executeIntents<FakeConfig, string, string>({ startProcess }),
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
        ]).pipe(
          executeIntents<FakeConfig, string, string>({ startProcess: failing }),
          Stream.runCollect
        )
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
      ]).pipe(
        executeIntents<FakeConfig, string, string>({ startProcess: headThenFail }),
        Stream.take(2),
        Stream.runCollect
      )
    )
    const arr = Chunk.toReadonlyArray(events)
    expect(arr.map((e: LifecycleEvent<FakeConfig, string, string>) => e._tag)).toEqual([
      'Running',
      'Failed',
    ])
  })
})
