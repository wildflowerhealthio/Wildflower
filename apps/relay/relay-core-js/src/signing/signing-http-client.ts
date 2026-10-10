import { type HttpBody, HttpClient, HttpClientError, HttpClientRequest } from '@effect/platform'
import { Clock, Effect, Layer, Option, Schema } from 'effect'

import { AdminKeyStore, NoAdminKey } from '../key-store/admin-key-store.ts'
import { signAdminRequest } from './admin-request-signer.ts'
import { webCrypto } from './web-crypto.ts'

const encodeBase64Url = Schema.encodeSync(Schema.Uint8ArrayFromBase64Url)

/** 16 random bytes, base64url: 22 characters, well under the relay's 128. */
const freshNonce: Effect.Effect<string, Effect.Effect.Error<typeof webCrypto>> = Effect.map(
  webCrypto,
  (crypto) => encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)))
)

/** The bytes of a body the signer can digest: none, or one already in memory. */
const bodyBytes = (body: HttpBody.HttpBody): Effect.Effect<Uint8Array<ArrayBuffer>, Error> => {
  if (body._tag === 'Empty') return Effect.succeed(new Uint8Array())
  if (body._tag === 'Uint8Array') return Effect.succeed(new Uint8Array(body.body))
  return Effect.fail(new Error(`cannot sign a ${body._tag} body`))
}

/**
 * `request` signed with the stored admin key, its URL made absolute against
 * `origin` so the URL fetched is the `@target-uri` signed. A request that
 * cannot be signed (no key stored, Web Crypto missing, a streamed body) fails
 * as an `Encode` `RequestError` carrying the reason as its `cause`, before
 * anything is sent.
 */
const signRequest = (
  store: AdminKeyStore['Type'],
  origin: string,
  request: HttpClientRequest.HttpClientRequest
): Effect.Effect<HttpClientRequest.HttpClientRequest, HttpClientError.RequestError> =>
  Effect.gen(function* () {
    const key = yield* Effect.flatMap(
      store.load,
      Option.match({ onNone: () => Effect.fail(new NoAdminKey()), onSome: Effect.succeed })
    )
    const url = new URL(request.url, origin)
    for (const [name, value] of request.urlParams) url.searchParams.append(name, value)
    // The query as the transport writes it back (form-encoded), and no
    // fragment, which is never sent: the URL fetched is the one signed.
    url.search = url.searchParams.toString()
    url.hash = ''
    const body = yield* bodyBytes(request.body)
    const headers = yield* signAdminRequest(
      key,
      { method: request.method, url, body },
      { created: Math.floor((yield* Clock.currentTimeMillis) / 1000), nonce: yield* freshNonce }
    )
    // A `URL` replaces the request's URL, params and hash alike.
    return request.pipe(HttpClientRequest.setUrl(url), HttpClientRequest.setHeaders(headers))
  }).pipe(
    Effect.mapError(
      (cause) =>
        new HttpClientError.RequestError({
          request,
          reason: 'Encode',
          cause,
          description: String(cause),
        })
    )
  )

/**
 * An `HttpClient` that signs every request with the admin key in
 * {@link AdminKeyStore} (see `signAdminRequest`), over the `HttpClient` the
 * layer is given. `origin` is the admin site's, normally `location.origin`.
 */
const signingHttpClient = (
  origin: string
): Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient | AdminKeyStore> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const store = yield* AdminKeyStore
      return client.pipe(
        HttpClient.mapRequestEffect((request) => signRequest(store, origin, request))
      )
    })
  )

export { signingHttpClient }
