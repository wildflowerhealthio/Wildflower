import { Events, type LiveQueryDef, queryDb, State, nanoid } from '@livestore/livestore'

import { Array, Schema } from 'effect'
import * as jose from 'jose'

const SigningKeyValuesSchema = Schema.Struct({
  d: Schema.String,
  dp: Schema.String,
  dq: Schema.String,
  e: Schema.String,
  n: Schema.String,
  p: Schema.String,
  q: Schema.String,
  qi: Schema.String,
})

const SigningKeySchema = Schema.Struct({
  kty: Schema.Literal('RSA'),
  alg: Schema.Literal('RS256'),
  kid: Schema.String,
  values: SigningKeyValuesSchema,
})

type SigningKey = typeof SigningKeySchema.Type

const decodeSigningKey = Schema.decodeUnknownSync(SigningKeySchema)

const publicJwk = (key: SigningKey): jose.JWK_RSA_Public => ({
  kid: key.kid,
  key_ops: ['verify'],
  e: key.values.e,
  n: key.values.n,
  kty: 'RSA' as const,
  alg: 'RS256' as const,
})

const privateJwk = (key: SigningKey): jose.JWK_RSA_Private => ({
  kid: key.kid,
  key_ops: ['sign'],
  d: key.values.d,
  dp: key.values.dp,
  dq: key.values.dq,
  e: key.values.e,
  n: key.values.n,
  kty: 'RSA' as const,
  alg: 'RS256' as const,
  p: key.values.p,
  q: key.values.q,
  qi: key.values.qi,
})

const signJwt = async (key: SigningKey, payload: jose.JWTPayload): Promise<string> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const joseKey = (await jose.importJWK(privateJwk(key))) as jose.CryptoKey
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .sign(joseKey)
}

/**
 * Verify a JWT against `key`. Callers MUST supply `expectedIssuer` and
 * `acceptedAudiences` so iss/aud are checked by `jose.jwtVerify` itself
 * — the library is the canonical place for those checks. The wrapper in
 * `internal/jwt.ts` iterates over multiple keys for rotation; direct
 * callers are forced to be explicit about issuer/audience instead of
 * getting a silent-accept default.
 */
const verifyJwt = async (
  key: SigningKey,
  token: string,
  options: { expectedIssuer: string; acceptedAudiences: ReadonlyArray<string> }
): Promise<jose.JWTVerifyResult<jose.JWTPayload>> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const testPub = (await jose.importJWK(publicJwk(key))) as jose.CryptoKey
  return await jose.jwtVerify(token, testPub, {
    issuer: options.expectedIssuer,
    audience: [...options.acceptedAudiences],
  })
}

const fromJosePrivateJwk = async (jwk: jose.CryptoKey): Promise<SigningKey> => {
  const privateJoseJwk = await jose.exportJWK(jwk)
  return decodeSigningKey({
    kid: nanoid(),
    kty: 'RSA' as const,
    alg: 'RS256' as const,
    values: {
      d: privateJoseJwk.d,
      dp: privateJoseJwk.dp,
      dq: privateJoseJwk.dq,
      e: privateJoseJwk.e,
      n: privateJoseJwk.n,
      p: privateJoseJwk.p,
      q: privateJoseJwk.q,
      qi: privateJoseJwk.qi,
    },
  })
}

const generate = async (): Promise<SigningKey> => {
  const { privateKey } = await jose.generateKeyPair('RS256', {
    modulusLength: 2048,
    extractable: true,
  })
  return await fromJosePrivateJwk(privateKey)
}

const make = (input: typeof SigningKeySchema.Type): SigningKey => decodeSigningKey(input)

const SigningKey = {
  schema: SigningKeySchema,
  publicJwk,
  privateJwk,
  signJwt,
  verifyJwt,
  fromJosePrivateJwk,
  generate,
  make,
} as const

const table = State.SQLite.table({
  name: 'signingKeys',
  columns: {
    kid: State.SQLite.text({ primaryKey: true }),
    kty: State.SQLite.text(),
    alg: State.SQLite.text(),
    values: State.SQLite.json({ schema: SigningKeyValuesSchema }),
    isActive: State.SQLite.boolean(),
  },
})

type SigningKeyRow = (typeof table)['Type']

const rowToSigningKey = (row: SigningKeyRow): SigningKey => ({
  kid: row.kid,
  kty: 'RSA' as const,
  alg: 'RS256' as const,
  values: row.values,
})

const queries = {
  findByKid$: (kid: string): LiveQueryDef<SigningKey | null> =>
    queryDb(table.where({ kid }), {
      map: (rows): SigningKey | null => {
        if (Array.isNonEmptyReadonlyArray(rows)) {
          return rowToSigningKey(rows[0])
        }
        return null
      },
      label: 'signingKeyByKid',
    }),
  all$: queryDb(table, {
    map: (rows): readonly SigningKey[] => rows.map((row) => rowToSigningKey(row)),
    label: 'allSigningKeys',
  }),
  active$: queryDb(table.where({ isActive: true }), {
    map: (rows): SigningKey | null => {
      if (Array.isNonEmptyReadonlyArray(rows)) {
        return rowToSigningKey(rows[0])
      }
      return null
    },
    label: 'activeSigningKey',
  }),
}

const events = {
  signingKeyAdded: Events.synced({
    name: 'v1.SigningKeyAdded',
    schema: Schema.Struct({
      signingKey: SigningKeySchema,
    }),
  }),
  signingKeyActivated: Events.synced({
    name: 'v1.SigningKeyActivated',
    schema: Schema.Struct({
      kid: Schema.String,
    }),
  }),
} as const

const materializers = State.SQLite.materializers(events, {
  'v1.SigningKeyAdded': ({ signingKey }) =>
    table.insert({
      kid: signingKey.kid,
      kty: signingKey.kty,
      alg: signingKey.alg,
      values: signingKey.values,
      isActive: false,
    }),
  'v1.SigningKeyActivated': ({ kid }) => [
    table.update({ isActive: false }).where({ isActive: true }),
    table.update({ isActive: true }).where({ kid }),
  ],
})

export { SigningKey, SigningKeySchema, table, queries, events, materializers }
export type { SigningKeyRow }
