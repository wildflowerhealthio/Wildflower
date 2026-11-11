import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Inspectable, Layer, Option, Redacted } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as ApiKey from './api-key.ts'
import type * as BrowserStorage from './browser-storage.ts'
import { memoryStorage, refusingStorage } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

/** A key as pasted: some non-blank text, perhaps with whitespace around it. */
const pastedKeyArb = fc
  .tuple(
    fc.stringMatching(/^\s{0,3}$/),
    fc.string({ minLength: 1 }).filter((key) => key.trim() === key && key !== ''),
    fc.stringMatching(/^\s{0,3}$/)
  )
  .map(([before, key, after]) => ({ pasted: `${before}${key}${after}`, key }))

const keyOf = (input: string): ApiKey.Type =>
  Option.getOrThrowWith(ApiKey.fromInput(input), () => new Error(`Not a key: ${input}`))

/** `effect` against the key kept in `storage`. */
const keptIn = <A, E>(
  storage: Layer.Layer<BrowserStorage.Local | BrowserStorage.Session>,
  effect: Effect.Effect<A, E, ApiKey.Store>
): Effect.Effect<A, E> => effect.pipe(Effect.provide(Layer.provide(ApiKey.layer, storage)))

describe('ApiKey', () => {
  it('should read back the trimmed key it wrote', () => {
    fc.assert(
      fc.property(pastedKeyArb, ({ pasted, key }) => {
        const storage = memoryStorage()

        Effect.runSync(keptIn(storage.layer, ApiKey.write(keyOf(pasted))))
        const kept = Effect.runSync(keptIn(storage.layer, ApiKey.read))

        expect(Option.map(kept, Redacted.value)).toEqual(Option.some(key))
        expect(Effect.runSync(storage.local.get(ApiKey.STORAGE_KEY))).toEqual(
          Option.some(JSON.stringify(key))
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse input that is only whitespace', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\s*$/), (blank) => {
        expect(ApiKey.fromInput(blank)).toEqual(Option.none())
      }),
      { numRuns: RUNS }
    )
  })

  it('should read no key once it is forgotten', () => {
    const { layer } = memoryStorage()
    Effect.runSync(keptIn(layer, ApiKey.write(keyOf('sk-ant-kept'))))

    Effect.runSync(keptIn(layer, ApiKey.forget))

    expect(Effect.runSync(keptIn(layer, ApiKey.read))).toEqual(Option.none())
  })

  it('should read no key where what is kept is not one', () => {
    const storage = memoryStorage()
    Effect.runSync(storage.local.set(ApiKey.STORAGE_KEY, '"   "'))

    expect(Effect.runSync(keptIn(storage.layer, ApiKey.read))).toEqual(Option.none())
  })

  it('should fail the read when the browser refuses it, never reading as no key', () => {
    expect(Effect.runSync(Effect.flip(keptIn(refusingStorage, ApiKey.read)))).toMatchObject({
      _tag: 'SystemError',
      reason: 'PermissionDenied',
      method: 'get',
    })
  })

  it('should fail naming the write when the browser refuses it', () => {
    const failure = Effect.runSync(
      Effect.flip(keptIn(refusingStorage, ApiKey.write(keyOf('sk-ant-new'))))
    )

    expect(failure).toMatchObject({
      _tag: 'SystemError',
      method: 'set',
      pathOrDescriptor: ApiKey.STORAGE_KEY,
    })
  })

  it('should print as redacted, never as the key', () => {
    expect(Inspectable.format(keyOf('sk-ant-secret'))).not.toContain('sk-ant-secret')
    expect(JSON.stringify({ key: keyOf('sk-ant-secret') })).not.toContain('sk-ant-secret')
  })
})
