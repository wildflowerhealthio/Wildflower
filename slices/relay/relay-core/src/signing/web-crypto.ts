import { Data, Effect } from 'effect'

/**
 * Raised when `globalThis.crypto.subtle` is missing or refuses an operation.
 *
 * @remarks
 * Browsers expose `crypto.subtle` only on secure origins, so in practice this
 * means the page is not served over HTTPS. Retrying does not help.
 */
class WebCryptoUnavailable extends Data.TaggedError('WebCryptoUnavailable')<{
  readonly reason: string
}> {
  // Data.TaggedError leaves `.message` empty; surface the reason so a banner
  // reads without opening its details.
  override get message(): string {
    return this.reason
  }
}

/** `globalThis.crypto`, once its `subtle` half is known to exist. */
const webCrypto: Effect.Effect<Crypto, WebCryptoUnavailable> = Effect.suspend(() =>
  globalThis.crypto?.subtle === undefined
    ? Effect.fail(
        new WebCryptoUnavailable({
          reason: 'Web Crypto is unavailable: the page must be served over HTTPS',
        })
      )
    : Effect.succeed(globalThis.crypto)
)

/** Run one `crypto.subtle` operation, failing with `what` and its cause. */
const subtle = <A>(
  what: string,
  operation: (subtle: SubtleCrypto) => Promise<A>
): Effect.Effect<A, WebCryptoUnavailable> =>
  Effect.flatMap(webCrypto, (crypto) =>
    Effect.tryPromise({
      try: () => operation(crypto.subtle),
      catch: (cause) => new WebCryptoUnavailable({ reason: `${what}: ${String(cause)}` }),
    })
  )

export { subtle, webCrypto, WebCryptoUnavailable }
