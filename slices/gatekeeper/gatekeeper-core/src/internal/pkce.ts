/**
 * The ambient-`crypto` reading of the PKCE challenge.
 *
 * There is one S256 implementation in this package — `smart-client/pkce.ts`'s
 * {@link codeChallengeS256}, which takes its digest source as an argument so it
 * can be tested against a refusing `crypto.subtle`. This wrapper binds that
 * argument to the global Web Crypto and keeps the `UnknownException` error type
 * its existing callers expect.
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
