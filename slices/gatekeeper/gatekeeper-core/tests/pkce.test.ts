import { Effect } from 'effect'
import * as fc from 'fast-check'
import { expect, test } from 'vite-plus/test'
import { computeCodeChallenge } from '../src/internal/pkce.ts'

// RFC 7636 §A.1 known-answer: a fixed code_verifier maps to a known
// code_challenge under S256.
const KAT_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const KAT_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

test('computeCodeChallenge matches RFC 7636 §A.1 known-answer', async () => {
  const challenge = await Effect.runPromise(computeCodeChallenge(KAT_VERIFIER))
  expect(challenge).toBe(KAT_CHALLENGE)
})

test('computeCodeChallenge produces base64url output (no +, /, =)', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc
        .string({
          minLength: 43,
          maxLength: 128,
          unit: fc.constantFrom(
            ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'.split('')
          ),
        })
        .filter((s) => /^[A-Za-z0-9\-_.~]+$/.test(s)),
      async (verifier) => {
        const challenge = await Effect.runPromise(computeCodeChallenge(verifier))
        expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(challenge).not.toContain('=')
      }
    ),
    { numRuns: 50 }
  )
})

test('computeCodeChallenge is deterministic', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({
        minLength: 43,
        maxLength: 128,
      }),
      async (verifier) => {
        const a = await Effect.runPromise(computeCodeChallenge(verifier))
        const b = await Effect.runPromise(computeCodeChallenge(verifier))
        expect(a).toBe(b)
      }
    ),
    { numRuns: 25 }
  )
})

test('computeCodeChallenge produces a 43-character output for any input', async () => {
  // SHA-256 → 32 bytes → base64url(32 bytes) without padding = 43 chars.
  await fc.assert(
    fc.asyncProperty(fc.string({ minLength: 43, maxLength: 128 }), async (verifier) => {
      const challenge = await Effect.runPromise(computeCodeChallenge(verifier))
      expect(challenge).toHaveLength(43)
    }),
    { numRuns: 25 }
  )
})
