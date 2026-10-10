import { Effect, Schema } from 'effect'
// The httpbis entry alone: the package's root also loads its `algorithm`
// module, which `require`s Node's `crypto` at the top level.
import {
  createSignatureBase,
  formatSignatureBase,
} from 'http-message-signatures/lib/httpbis/index.js'
import { type BareItem, parseItem, serializeDictionary, serializeList } from 'structured-headers'

import { subtle, type WebCryptoUnavailable } from './web-crypto.ts'

/** The `keyid` the relay checks against `WILDFLOWER_RELAY_ADMIN_KEY`. */
const ADMIN_KEY_ID = 'admin'

/** The only `alg` the relay accepts. */
const ALG = 'hmac-sha256'

/** The label of the one signature a request carries. */
const SIGNATURE_LABEL = 'sig'

/** A request as the signer sees it. */
interface SignableRequest {
  readonly method: string
  /**
   * The absolute URL the request is sent to: its `@target-uri`. A `URL`
   * serializes with the host lowercased and without `:443`, as the relay
   * rebuilds it.
   */
  readonly url: URL
  /** The body's bytes; empty for none. */
  readonly body: Uint8Array<ArrayBuffer>
}

/** What makes a signature unique: when it was made, and a random nonce. */
interface SignatureMoment {
  /** Unix seconds. The relay accepts 60 s of skew either way. */
  readonly created: number
  /** At most 128 characters; never reused within the skew window. */
  readonly nonce: string
}

/**
 * The headers a signed request adds, by lowercase name: `content-digest` (with
 * a body), `signature-input` and `signature`.
 */
type SignatureHeaders = Readonly<Record<string, string>>

const encodeBase64 = Schema.encodeSync(Schema.Uint8ArrayFromBase64)
const encoder = new TextEncoder()

/** `Content-Digest` (RFC 9530) with the body's SHA-256. */
const contentDigest = (
  body: Uint8Array<ArrayBuffer>
): Effect.Effect<string, WebCryptoUnavailable> =>
  Effect.map(
    subtle('SHA-256 failed', (s) => s.digest('SHA-256', body)),
    (digest) => `sha-256=:${encodeBase64(new Uint8Array(digest))}:`
  )

/**
 * Sign `request` with the admin key as the relay's verifier expects
 * (`apps/relay/relay-server/src/site/signature.rs`): one signature labelled `sig`
 * covering `@method`, `@target-uri` and, when there is a body,
 * `content-digest`, with `created`, `nonce`, `keyid="admin"` and
 * `alg="hmac-sha256"`.
 *
 * @param key - The admin key, an HMAC SHA-256 `CryptoKey` (see
 *   `relay-core-js/key-store`)
 * @returns The headers to add: `Content-Digest` (with a body),
 *   `Signature-Input` and `Signature`
 *
 * @remarks
 * `http-message-signatures` derives the covered components and formats the
 * signature base. Its `signMessage` is not used: it hands the base to the key
 * as a Node `Buffer`, which a browser has no global for.
 */
const signAdminRequest = (
  key: CryptoKey,
  request: SignableRequest,
  moment: SignatureMoment
): Effect.Effect<SignatureHeaders, WebCryptoUnavailable> =>
  Effect.gen(function* () {
    const headers: Record<string, string> = {}
    const fields = ['@method', '@target-uri']
    if (request.body.byteLength > 0) {
      headers['content-digest'] = yield* contentDigest(request.body)
      fields.push('content-digest')
    }
    const base = createSignatureBase(
      { fields },
      { method: request.method, url: request.url, headers }
    )
    const params = new Map<string, BareItem>([
      ['created', moment.created],
      ['nonce', moment.nonce],
      ['keyid', ADMIN_KEY_ID],
      ['alg', ALG],
    ])
    const signatureInput = serializeList([[base.map(([field]) => parseItem(field)), params]])
    const signatureBase = formatSignatureBase([...base, ['"@signature-params"', [signatureInput]]])
    const mac = yield* subtle('HMAC failed', (s) =>
      s.sign('HMAC', key, encoder.encode(signatureBase))
    )
    headers['signature-input'] = `${SIGNATURE_LABEL}=${signatureInput}`
    headers['signature'] = serializeDictionary(new Map([[SIGNATURE_LABEL, [mac, new Map()]]]))
    return headers
  })

export { ADMIN_KEY_ID, signAdminRequest }
export type { SignableRequest, SignatureHeaders, SignatureMoment }
