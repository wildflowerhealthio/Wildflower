import { Events, type LiveQueryDef, queryDb, State, nanoid } from '@livestore/livestore'

import { Schema } from 'effect'
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

/**
 * Pure data shape of an RSA signing key (kid/kty/alg/values). Crypto
 * operations are exposed as standalone functions on this module —
 * callers should use `SigningKey.signJwt(key, ...)` /
 * `SigningKey.verifyJwt(key, ...)` rather than reaching for methods on
 * the value.
 */
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

// `jose.importJWK` returns `CryptoKey | Uint8Array`. For RSA JWKs it's
// always a `CryptoKey`, but verify that at runtime — the type union
// otherwise leaks into our sign/verify call sites and forces an unsafe
// cast. Throwing here surfaces as a rejected Promise, which the Effect
// wrappers in `internal/jwt.ts` already handle.
const importRsaJwk = async (jwk: jose.JWK): Promise<jose.CryptoKey> => {
  const imported = await jose.importJWK(jwk)
  if (!(imported instanceof CryptoKey)) {
    throw new Error('Expected jose.importJWK to return a CryptoKey for an RSA JWK')
  }
  return imported
}

const signJwt = async (key: SigningKey, payload: jose.JWTPayload): Promise<string> => {
  const joseKey = await importRsaJwk(privateJwk(key))
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
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
  const testPub = await importRsaJwk(publicJwk(key))
  return await jose.jwtVerify(token, testPub, {
    issuer: options.expectedIssuer,
    audience: [...options.acceptedAudiences],
  })
}

const make = (input: SigningKey): SigningKey => decodeSigningKey(input)

const fromJosePrivateJwk = async (jwk: jose.CryptoKey): Promise<SigningKey> => {
  const privateJoseJwk = await jose.exportJWK(jwk)
  return make({
    kid: nanoid(),
    kty: 'RSA' as const,
    alg: 'RS256' as const,
    values: {
      d: privateJoseJwk.d ?? '',
      dp: privateJoseJwk.dp ?? '',
      dq: privateJoseJwk.dq ?? '',
      e: privateJoseJwk.e ?? '',
      n: privateJoseJwk.n ?? '',
      p: privateJoseJwk.p ?? '',
      q: privateJoseJwk.q ?? '',
      qi: privateJoseJwk.qi ?? '',
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

const table = State.SQLite.table({
  name: 'signingKeys',
  columns: {
    kid: State.SQLite.text({ primaryKey: true }),
    // Schema-narrow `kty`/`alg` so the row type structurally satisfies
    // `SigningKeyData` and `make(row)` typechecks without re-listing fields.
    kty: State.SQLite.text({ schema: SigningKeySchema.fields.kty }),
    alg: State.SQLite.text({ schema: SigningKeySchema.fields.alg }),
    values: State.SQLite.json({ schema: SigningKeyValuesSchema }),
    isActive: State.SQLite.boolean(),
  },
})

type SigningKeyRow = (typeof table)['Type']

// `row` already structurally satisfies `SigningKey` (kid/kty/alg/values
// — `isActive` is just an extra field), so query maps return rows
// directly without a copy step. Schema-narrowed `kty`/`alg` columns
// keep the literal types intact.

const queries = {
  findByKid$: (kid: string): LiveQueryDef<SigningKey | null> =>
    queryDb(table.where({ kid }), {
      map: (rows): SigningKey | null => rows[0] ?? null,
      label: 'signingKeyByKid',
    }),
  all$: queryDb(table, {
    map: (rows): readonly SigningKey[] => rows,
    label: 'allSigningKeys',
  }),
  active$: queryDb(table.where({ isActive: true }), {
    map: (rows): SigningKey | null => rows[0] ?? null,
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

export {
  SigningKeySchema as Schema,
  fromJosePrivateJwk,
  generate,
  make,
  publicJwk,
  privateJwk,
  signJwt,
  verifyJwt,
  table,
  queries,
  events,
  materializers,
}
export type { SigningKey as Type, SigningKeyRow }
