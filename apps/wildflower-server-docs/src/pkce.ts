/**
 * PKCE (RFC 7636) and the random values the authorization request needs.
 *
 * Written out here rather than pulled from a package: the challenge is one
 * SHA-256 and a base64url encode, and this console's whole point is a bundle
 * with no avoidable dependencies. It is a standard algorithm pinned to the
 * RFC's own known-answer vector in the tests beside this file — the same
 * treatment `kitchen-sink`'s FNV implementation gets — so "matches the spec" is
 * asserted, not asserted-by-comment.
 *
 * The digest is a `Promise`, so {@link codeChallengeS256} is an `Effect` that
 * fails with {@link PkceUnavailable} — the same shape `web-trace-core`'s
 * `hmac.ts` gives the one other Web Crypto dependency in the repo. The random
 * values stay plain functions of an injected source: they cannot fail, and the
 * source is what tests substitute.
 */

import { Data, Effect } from 'effect'

/**
 * Raised when Web Crypto will not produce an S256 challenge — an insecure
 * origin (browsers gate `crypto.subtle` on secure contexts) or a runtime
 * without it. Not recoverable by retrying, and fatal to sign-in: this console
 * does not fall back to a `plain` challenge.
 */
export class PkceUnavailable extends Data.TaggedError('PkceUnavailable')<{
  readonly reason: string
}> {}

/** The slice of Web Crypto this module needs. */
export interface RandomBytesSource {
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>
}

/** The slice of `crypto.subtle` this module needs. */
export interface DigestSource {
  digest(algorithm: 'SHA-256', data: BufferSource): Promise<ArrayBuffer>
}

/** `bytes` in unpadded base64url (RFC 4648 §5), the encoding PKCE uses. */
export const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** `byteLength` random bytes, base64url-encoded. */
export const randomBase64Url = (byteLength: number, random: RandomBytesSource): string =>
  base64UrlEncode(random.getRandomValues(new Uint8Array(byteLength)))

/**
 * A fresh `code_verifier`: 32 random bytes, which base64url-encode to 43
 * characters — the shortest length RFC 7636 §4.1 allows, and the length
 * `gatekeeper-rust` validates against.
 */
export const createCodeVerifier = (random: RandomBytesSource): string => randomBase64Url(32, random)

/**
 * A fresh `state`: 16 random bytes. Its job is CSRF protection on the way back
 * — the console compares it to the value it stashed before redirecting — so it
 * only has to be unguessable, not long.
 */
export const createState = (random: RandomBytesSource): string => randomBase64Url(16, random)

/**
 * The S256 `code_challenge` for `verifier`: base64url(SHA-256(ASCII(verifier))).
 *
 * S256 only. RFC 7636 also defines `plain`, and Scalar's own client silently
 * falls back to it when `crypto.subtle` is missing; this console does not — a
 * `plain` challenge is no protection at all, and `gatekeeper-rust`'s authorize
 * endpoint rejects it anyway.
 */
export const codeChallengeS256 = (
  verifier: string,
  subtle: DigestSource
): Effect.Effect<string, PkceUnavailable> =>
  Effect.tryPromise({
    try: async () =>
      base64UrlEncode(new Uint8Array(await subtle.digest('SHA-256', encoder.encode(verifier)))),
    catch: (cause) =>
      new PkceUnavailable({
        reason: `This browser could not compute a PKCE challenge: ${String(cause)}`,
      }),
  })

const encoder = new TextEncoder()
