import { Effect, Either } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  base64UrlEncode,
  codeChallengeS256,
  createCodeVerifier,
  createState,
  randomBase64Url,
} from './pkce.ts'

/** The real Web Crypto, which is what the browser passes in production. */
const webCrypto = globalThis.crypto

/** A `getRandomValues` that fills with `bytes`, cycling if it runs short. */
const fixedBytes = (
  bytes: readonly number[]
): { getRandomValues: <T extends Uint8Array>(a: T) => T } => ({
  getRandomValues: <T extends Uint8Array>(array: T): T => {
    for (let index = 0; index < array.length; index++)
      array[index] = bytes[index % bytes.length] ?? 0
    return array
  },
})

describe('base64UrlEncode', () => {
  it('encodes bytes without the characters base64url forbids', () => {
    // Arrange / Act
    const encoded = base64UrlEncode(new Uint8Array([251, 255, 190, 0]))

    // Assert
    expect(encoded).toBe('-_--AA')
  })

  it('never emits +, / or = padding, whatever the bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array(), (bytes) => {
        // Act
        const encoded = base64UrlEncode(bytes)

        // Assert
        expect(encoded).not.toMatch(/[+/=]/)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('randomBase64Url', () => {
  it('encodes exactly the bytes the source produced', () => {
    // Arrange
    const source = fixedBytes([1, 2, 3])

    // Act / Assert
    expect(randomBase64Url(3, source)).toBe(base64UrlEncode(new Uint8Array([1, 2, 3])))
  })
})

describe('createCodeVerifier', () => {
  it('produces a 43-character verifier, the minimum RFC 7636 §4.1 allows', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1 }), (bytes) => {
        // Act
        const verifier = createCodeVerifier(fixedBytes([...bytes]))

        // Assert
        expect(verifier).toHaveLength(43)
        expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('produces a different verifier for different random bytes', () => {
    // Arrange / Act
    const first = createCodeVerifier(fixedBytes([1]))
    const second = createCodeVerifier(fixedBytes([2]))

    // Assert
    expect(first).not.toBe(second)
  })
})

describe('createState', () => {
  it('produces a base64url state from the random source', () => {
    // Act
    const state = createState(webCrypto)

    // Assert
    expect(state).toHaveLength(22)
    expect(state).toMatch(/^[A-Za-z0-9\-_]+$/)
  })
})

describe('codeChallengeS256', () => {
  it('matches the known answer in RFC 7636 §A.1', async () => {
    // Arrange
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'

    // Act
    const challenge = await Effect.runPromise(codeChallengeS256(verifier, webCrypto.subtle))

    // Assert
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('always produces a 43-character base64url challenge, the shape /oauth/authorize validates', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 43, maxLength: 128 }), async (verifier) => {
        // Act
        const challenge = await Effect.runPromise(codeChallengeS256(verifier, webCrypto.subtle))

        // Assert
        expect(challenge).toHaveLength(43)
        expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('is deterministic, so the verifier stashed before the redirect still redeems the code', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (verifier) => {
        // Act
        const first = await Effect.runPromise(codeChallengeS256(verifier, webCrypto.subtle))
        const second = await Effect.runPromise(codeChallengeS256(verifier, webCrypto.subtle))

        // Assert
        expect(first).toBe(second)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('codeChallengeS256 when Web Crypto refuses', () => {
  it('fails with PkceUnavailable rather than rejecting', async () => {
    // Arrange — an insecure origin is the realistic cause: `crypto.subtle` is
    // absent, so the digest never resolves.
    const refusingSubtle = {
      digest: (): Promise<ArrayBuffer> => Promise.reject(new Error('crypto.subtle is undefined')),
    }

    // Act
    const result = await Effect.runPromise(
      Effect.either(codeChallengeS256('a-verifier', refusingSubtle))
    )

    // Assert
    if (Either.isRight(result)) throw new Error('expected the digest failure to surface')
    expect(result.left._tag).toBe('PkceUnavailable')
    expect(result.left.reason).toContain('PKCE challenge')
  })
})
