import { Effect } from 'effect'
import { UnknownException } from 'effect/Cause'

const computeCodeChallenge = (
  codeVerifier: string
): Effect.Effect<string, UnknownException, never> =>
  Effect.tryPromise({
    try: async () => {
      const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
      return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    },
    catch: (error) => new UnknownException(error, 'Failed to compute code challenge'),
  })

export { computeCodeChallenge }
