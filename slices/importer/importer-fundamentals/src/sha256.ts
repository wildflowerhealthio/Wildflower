import { Data, Effect, Encoding } from 'effect'

/**
 * Raised when `globalThis.crypto.subtle` is missing or its digest refuses.
 *
 * @remarks
 * Every archive attachment carries a SHA-256, so this is not recoverable by
 * storing less. In practice it means an insecure origin (browsers gate
 * `crypto.subtle` on secure contexts) or a runtime below the project's floor —
 * an environment defect rather than a per-file problem.
 */
class DigestUnavailable extends Data.TaggedError('DigestUnavailable')<{
  readonly reason: string
}> {}

/**
 * The base64-encoded SHA-256 of `bytes`, matching FHIR's `Attachment.hash`
 * (a `base64Binary`).
 *
 * @remarks
 * A verbatim copy of `web-trace-core`'s `sha256Base64` — the standard digest,
 * no project-specific behaviour — kept here so `importer-fundamentals` (the
 * home of the shared {@link sourceFileCodec | source-file codec})
 * needs no dependency on `web-trace-core`. Web Crypto rather than
 * `node:crypto`: the importer runs in a WebView, and Web Crypto's digest is
 * `Promise`-returning, which is why the archive encode is `Effect`-shaped.
 *
 * @param bytes - The raw file bytes, backed by a real `ArrayBuffer` (what
 *   `crypto.subtle.digest`'s `BufferSource` parameter requires)
 * @returns The digest, base64-encoded
 */
const sha256Base64 = (bytes: Uint8Array<ArrayBuffer>): Effect.Effect<string, DigestUnavailable> =>
  Effect.suspend(() =>
    globalThis.crypto?.subtle === undefined
      ? Effect.fail(
          new DigestUnavailable({
            reason:
              'globalThis.crypto.subtle is unavailable (insecure context or unsupported runtime)',
          })
        )
      : Effect.tryPromise({
          try: async () =>
            Encoding.encodeBase64(
              new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
            ),
          catch: (cause) =>
            new DigestUnavailable({ reason: `SHA-256 digest failed: ${String(cause)}` }),
        })
  )

export { DigestUnavailable, sha256Base64 }
