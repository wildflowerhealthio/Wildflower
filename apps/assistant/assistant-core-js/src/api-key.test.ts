import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Inspectable, Option, Redacted } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as ApiKey from './api-key.ts'
import { blockedStoragePage, memoryStoragePage } from './test-helpers.ts'

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

describe('ApiKey', () => {
  it('should read back the trimmed key it wrote', () => {
    fc.assert(
      fc.property(pastedKeyArb, ({ pasted, key }) => {
        const page = memoryStoragePage()

        Effect.runSync(ApiKey.write(page, keyOf(pasted)))
        const kept = Effect.runSync(ApiKey.read(page))

        expect(Option.map(kept, Redacted.value)).toEqual(Option.some(key))
        expect(page.localStorage.items.get(ApiKey.STORAGE_KEY)).toBe(key)
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
    const page = memoryStoragePage()
    Effect.runSync(ApiKey.write(page, keyOf('sk-ant-kept')))

    Effect.runSync(ApiKey.forget(page))

    expect(Effect.runSync(ApiKey.read(page))).toEqual(Option.none())
  })

  it('should read no key when the browser refuses the read or the storage itself', () => {
    const refusingRead = memoryStoragePage(['getItem'])
    refusingRead.localStorage.items.set(ApiKey.STORAGE_KEY, 'sk-ant-kept')

    expect(Effect.runSync(ApiKey.read(refusingRead))).toEqual(Option.none())
    expect(Effect.runSync(ApiKey.read(blockedStoragePage()))).toEqual(Option.none())
  })

  it('should fail naming the write when the browser refuses it', () => {
    const failure = Effect.runSync(
      Effect.flip(ApiKey.write(memoryStoragePage(['setItem']), keyOf('sk-ant-new')))
    )

    expect(failure).toMatchObject({
      _tag: 'StorageBlocked',
      operation: 'write',
      key: ApiKey.STORAGE_KEY,
    })
  })

  it('should print as redacted, never as the key', () => {
    expect(Inspectable.format(keyOf('sk-ant-secret'))).not.toContain('sk-ant-secret')
    expect(JSON.stringify({ key: keyOf('sk-ant-secret') })).not.toContain('sk-ant-secret')
  })
})
