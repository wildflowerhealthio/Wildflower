/**
 * Tests for `expectStreamStart` — the bind-signal triage utility used by
 * `executeIntents`. Stubs the input stream via `Stream.succeed` /
 * `Stream.fail` / `Stream.empty` and asserts the typed `StreamStartResult`.
 */
import { Cause, Chunk, Effect, Exit, Scope, Stream } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { expectStreamStart } from './expect-stream-start.ts'

describe('expectStreamStart', () => {
  it('returns Started{head, tail} on a stream that emits at least one value', async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Effect.acquireRelease(Scope.make(), (s) => Scope.close(s, Exit.void))
        const peelResult = yield* expectStreamStart(Stream.fromIterable([1, 2, 3]), scope)
        const tail =
          peelResult._tag === 'Started'
            ? yield* Stream.runCollect(peelResult.statusStream)
            : Chunk.empty<number>()
        return { peelResult, tail }
      }).pipe(Effect.scoped)
    )
    expect(observed.peelResult._tag).toBe('Started')
    if (observed.peelResult._tag !== 'Started') return
    expect(observed.peelResult.status).toBe(1)
    expect([...observed.tail]).toEqual([2, 3])
  })

  it('returns Failed on a stream that fails before emitting', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Effect.acquireRelease(Scope.make(), (s) => Scope.close(s, Exit.void))
        return yield* expectStreamStart(Stream.fail('boom'), scope)
      }).pipe(Effect.scoped)
    )
    expect(result._tag).toBe('Failed')
  })

  it('returns Failed with a defect cause when the stream completes without emitting', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Effect.acquireRelease(Scope.make(), (s) => Scope.close(s, Exit.void))
        return yield* expectStreamStart(Stream.empty, scope)
      }).pipe(Effect.scoped)
    )
    expect(result._tag).toBe('Failed')
    if (result._tag !== 'Failed') return
    expect(Cause.isDieType(result.cause)).toBe(true)
    expect(Cause.pretty(result.cause)).toMatch(/ended without emitting/)
  })
})
