import { Either, Encoding, Schema } from 'effect'

const TokenPayload = Schema.Struct({
  offset: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
  count: Schema.Int.pipe(Schema.between(1, 1000)),
})

type TokenPayload = Schema.Schema.Type<typeof TokenPayload>

const decodeToken = Schema.decodeUnknownEither(TokenPayload)

// Page tokens are base64url(JSON({offset, count})) — opaque to clients but
// **not signed**. Anyone with the URL can craft an arbitrary token; the only
// defense is the schema bound applied on decode (offset ≥ 0, count 1..1000),
// which limits blast radius to "skip ahead in your own search results". The
// HttpApi pagination contract documents that clients should follow `next`
// /`previous` links rather than constructing offset URLs themselves; that
// contract is convention-only, not cryptographically enforced. Sign with HMAC
// here (and validate on decode) if/when pagination state grows to anything
// more sensitive than `{offset, count}`.
const encodePageToken = (payload: TokenPayload): string =>
  Encoding.encodeBase64Url(JSON.stringify(payload))

const decodePageToken = (token: string): TokenPayload | undefined => {
  const decodedString = Encoding.decodeBase64UrlString(token)
  if (Either.isLeft(decodedString)) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decodedString.right)
  } catch {
    return undefined
  }
  const result = decodeToken(parsed)
  if (Either.isLeft(result)) {
    return undefined
  }
  return result.right
}

export { encodePageToken, decodePageToken, type TokenPayload }
