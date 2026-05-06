import { Effect } from 'effect'
import type { UnknownException } from 'effect/Cause'

const computeCodeChallenge = (
  codeVerifier: string
): Effect.Effect<string, UnknownException, never> =>
  Effect.tryPromise(async () => {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  })

export { computeCodeChallenge }
