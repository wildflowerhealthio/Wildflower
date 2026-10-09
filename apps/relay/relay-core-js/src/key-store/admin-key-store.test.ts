import { createHmac } from 'node:crypto'

import { Effect, Either, Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { ADMIN_KEY_MIN_BYTES, AdminKeyStore, importAdminKey } from './admin-key-store.ts'

const encoder = new TextEncoder()

/** The HMAC of `message` under the imported `key`, base64. */
const macWith = async (key: CryptoKey, message: string): Promise<string> =>
  Buffer.from(await crypto.subtle.sign('HMAC', key, encoder.encode(message))).toString('base64')

describe('importAdminKey', () => {
  it('imports the trimmed text as a sign-only, non-extractable HMAC SHA-256 key', async () => {
    // Arrange
    const pasted = '  \tan-admin-key-of-thirty-two-bytes\n'

    // Act
    const key = await Effect.runPromise(importAdminKey(pasted))

    // Assert
    expect(key.extractable).toBe(false)
    expect(key.usages).toEqual(['sign'])
    expect(key.algorithm).toMatchObject({ name: 'HMAC', hash: { name: 'SHA-256' } })
    // Keyed by the trimmed text's UTF-8 bytes, as the relay keys its MAC.
    expect(await macWith(key, 'base')).toBe(
      createHmac('sha256', 'an-admin-key-of-thirty-two-bytes').update('base').digest('base64')
    )
  })

  it('accepts exactly the texts whose trimmed UTF-8 is at least the minimum bytes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 40 }), async (pasted) => {
        // Arrange
        const bytes = encoder.encode(pasted.trim()).byteLength

        // Act
        const imported = await Effect.runPromise(Effect.either(importAdminKey(pasted)))

        // Assert
        expect(Either.isRight(imported)).toBe(bytes >= ADMIN_KEY_MIN_BYTES)
        if (Either.isLeft(imported)) expect(imported.left._tag).toBe('AdminKeyRejected')
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('AdminKeyStore.layerMemory', () => {
  it('loads what was saved until it is cleared', async () => {
    // Arrange
    const key = await Effect.runPromise(importAdminKey('an-admin-key-of-thirty-two-bytes'))

    // Act
    const [before, saved, cleared] = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* AdminKeyStore
        const empty = yield* store.load
        yield* store.save(key)
        const stored = yield* store.load
        yield* store.clear
        return [empty, stored, yield* store.load] as const
      }).pipe(Effect.provide(AdminKeyStore.layerMemory))
    )

    // Assert
    expect(before).toEqual(Option.none())
    expect(saved).toEqual(Option.some(key))
    expect(cleared).toEqual(Option.none())
  })
})
