import { Data, Effect, Schema } from 'effect'

/**
 * The keyed-hash primitive the pseudonymizer derives every fake value from,
 * built on the one cryptography API that exists unchanged in a browser, a
 * WebView, and Node: Web Crypto.
 *
 * @remarks
 * Web Crypto's digest and sign operations are `Promise`-returning, which is why
 * the whole pseudonymizer is an `Effect` rather than a plain function. Nothing
 * in this package imports `node:crypto` — that would put a platform dependency
 * in the pure layer.
 *
 * @packageDocumentation
 */

/**
 * Raised when `globalThis.crypto.subtle` is missing or refuses the HMAC key.
 *
 * @remarks
 * In practice this means the code is running on an insecure origin (browsers
 * gate `crypto.subtle` on secure contexts) or on a runtime older than the
 * project's floor. It is not recoverable by retrying.
 */
class WebCryptoUnavailable extends Data.TaggedError('WebCryptoUnavailable')<{
  readonly reason: string
}> {}

/** The imported HMAC-SHA-256 key an export's salt resolves to. */
type ExportKey = CryptoKey

const encoder = new TextEncoder()

const encodeBase64Url = Schema.encodeSync(Schema.Uint8ArrayFromBase64Url)

const webCrypto: Effect.Effect<Crypto, WebCryptoUnavailable> = Effect.suspend(() =>
  globalThis.crypto?.subtle === undefined
    ? Effect.fail(
        new WebCryptoUnavailable({
          reason:
            'globalThis.crypto.subtle is unavailable (insecure context or unsupported runtime)',
        })
      )
    : Effect.succeed(globalThis.crypto)
)

/**
 * Mints a fresh export salt: 32 random bytes, base64url-encoded.
 *
 * @returns A salt suitable for {@link importExportKey}
 *
 * @remarks
 * Mint one per export, never per session. A salt stable *within* an export is
 * what makes response A's `pid` and response B's `patientId` land on the same
 * fake — the correspondence that tells a collector author the two endpoints
 * share a key. A salt that changed across exports is what stops two exports of
 * one session from being linked back together.
 */
const mintExportSalt: Effect.Effect<string, WebCryptoUnavailable> = Effect.gen(function* () {
  const crypto = yield* webCrypto
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))
})

/**
 * Imports an export salt as the HMAC-SHA-256 key every pseudonym is derived
 * from.
 *
 * @param salt - A salt from {@link mintExportSalt}, or any caller-supplied
 *   string when a test needs a fixed one
 * @returns The imported key, to be held for the lifetime of one export
 */
const importExportKey = (salt: string): Effect.Effect<ExportKey, WebCryptoUnavailable> =>
  Effect.gen(function* () {
    const crypto = yield* webCrypto
    return yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          'raw',
          encoder.encode(salt),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        ),
      catch: (cause) =>
        new WebCryptoUnavailable({ reason: `Could not import the export key: ${String(cause)}` }),
    })
  })

/**
 * The 32-byte HMAC-SHA-256 of `message` under `key`.
 *
 * @param key - The export key from {@link importExportKey}
 * @param message - The value being pseudonymized, plus any disambiguating prefix
 * @returns The raw digest bytes, which callers expand into a same-shaped fake
 */
const hmac = (key: ExportKey, message: string): Effect.Effect<Uint8Array, WebCryptoUnavailable> =>
  Effect.tryPromise({
    try: async () => new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))),
    catch: (cause) => new WebCryptoUnavailable({ reason: `HMAC failed: ${String(cause)}` }),
  })

export { type ExportKey, hmac, importExportKey, mintExportSalt, WebCryptoUnavailable }
