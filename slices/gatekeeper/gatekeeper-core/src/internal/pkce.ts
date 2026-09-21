/**
 * {@link codeChallengeS256} — the package's one S256 implementation — bound to
 * the ambient Web Crypto, keeping the `UnknownException` error type this
 * wrapper's callers expect.
 */

import { Effect } from 'effect'
import { UnknownException } from 'effect/Cause'

import { codeChallengeS256 } from '../smart-client/pkce.ts'

const computeCodeChallenge = (
  codeVerifier: string
): Effect.Effect<string, UnknownException, never> =>
  codeChallengeS256(codeVerifier, crypto.subtle).pipe(
    Effect.mapError((error) => new UnknownException(error, 'Failed to compute code challenge'))
  )

export { computeCodeChallenge }
