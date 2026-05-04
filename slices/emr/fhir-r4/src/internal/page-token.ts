import { Schema } from 'effect'

const TokenPayload = Schema.Struct({
  offset: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
  count: Schema.Int.pipe(Schema.between(1, 1000)),
})

type TokenPayload = Schema.Schema.Type<typeof TokenPayload>

const decodeToken = Schema.decodeUnknownSync(TokenPayload)

const encodePageToken = (payload: TokenPayload): string =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')

const decodePageToken = (token: string): TokenPayload | undefined => {
  try {
    const json: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
    return decodeToken(json)
  } catch {
    return undefined
  }
}

export { encodePageToken, decodePageToken, type TokenPayload }
