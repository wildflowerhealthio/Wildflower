import { Effect } from 'effect'

const encoder = new TextEncoder()

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

/**
 * Hash a PIN with the issuing challenge id as salt. Stored on the
 * `pinChallenges` row (and in the `pinChallengeIssued` event) instead
 * of the plaintext PIN, so the event log doesn't retain the secret.
 *
 * The challenge id is a UUID, so per-challenge salting prevents shared
 * rainbow tables across challenges. A determined attacker can still
 * brute-force the 900k 6-digit PIN space against any single hash —
 * the short PIN TTL (~2 min) is the load-bearing defense.
 */
const hashPin = (challengeId: string, pin: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(`${challengeId}:${pin}`))
    return toHex(buffer)
  })

export { hashPin }
