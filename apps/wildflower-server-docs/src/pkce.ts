/**
 * PKCE (RFC 7636) and the random values the authorization request needs.
 *
 * Written out here rather than pulled from a package: the challenge is one
 * SHA-256 and a base64url encode, and this console's whole point is a bundle
 * with no avoidable dependencies. It is a standard algorithm pinned to the
 * RFC's own known-answer vector in the tests beside this file — the same
 * treatment `kitchen-sink`'s FNV implementation gets — so "matches the spec" is
 * asserted, not asserted-by-comment. (`gatekeeper-core`'s `internal/pkce.ts` is
 * the Effect-flavoured twin used inside the app tree; it is not exported from
 * that package, and importing `effect` into a static page to reach it would cost
 * more than the ten lines below.)
 *
 * Both entry points take their crypto as an argument, so the tests drive them
 * with fixed bytes and the browser passes `window.crypto`.
 */

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
export const codeChallengeS256 = async (
  verifier: string,
  subtle: DigestSource
): Promise<string> => {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64UrlEncode(new Uint8Array(digest))
}
