import { Events, type LiveQueryDef, queryDb, State, nanoid } from '@livestore/livestore'

import { Array, Schema } from 'effect'
import * as jose from 'jose'

class SigningKey extends Schema.Class<SigningKey>('SigningKey')({
  kty: Schema.Literal('RSA'),
  alg: Schema.Literal('RS256'),
  kid: Schema.String,
  values: Schema.Struct({
    d: Schema.String,
    dp: Schema.String,
    dq: Schema.String,
    e: Schema.String,
    n: Schema.String,
    p: Schema.String,
    q: Schema.String,
    qi: Schema.String,
  }),
}) {
  publicJwk(): jose.JWK_RSA_Public {
    return {
      kid: this.kid,
      key_ops: ['verify'],
      e: this.values.e,
      n: this.values.n,
      kty: 'RSA' as const,
      alg: 'RS256' as const,
    }
  }

  privateJwk(): jose.JWK_RSA_Private {
    return {
      kid: this.kid,
      key_ops: ['sign'],
      d: this.values.d,
      dp: this.values.dp,
      dq: this.values.dq,
      e: this.values.e,
      n: this.values.n,
      kty: 'RSA' as const,
      alg: 'RS256' as const,
      p: this.values.p,
      q: this.values.q,
      qi: this.values.qi,
    }
  }

  async signJwt(payload: jose.JWTPayload): Promise<string> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const joseKey = (await jose.importJWK(this.privateJwk())) as jose.CryptoKey
    return await new jose.SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: this.kid })
      .sign(joseKey)
  }

  /**
   * Verify a JWT against this key. Callers MUST supply
   * `expectedIssuer` and `acceptedAudiences` so iss/aud are checked by
   * `jose.jwtVerify` itself — the library is the canonical place for
   * those checks. The method exists so the wrapper in `internal/jwt.ts`
   * can iterate over multiple keys during rotation; direct callers are
   * forced to be explicit about issuer/audience instead of getting a
   * silent-accept default.
   */
  async verifyJwt(
    token: string,
    options: { expectedIssuer: string; acceptedAudiences: ReadonlyArray<string> }
  ): Promise<jose.JWTVerifyResult<jose.JWTPayload>> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const testPub = (await jose.importJWK(this.publicJwk())) as jose.CryptoKey
    return await jose.jwtVerify(token, testPub, {
      issuer: options.expectedIssuer,
      audience: [...options.acceptedAudiences],
    })
  }

  static async fromJosePrivateJwk(jwk: jose.CryptoKey): Promise<SigningKey> {
    const privateJoseJwk = await jose.exportJWK(jwk)
    const kid = nanoid()
    return Schema.decodeUnknownSync(SigningKey)({
      kid,
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

  static async generate(): Promise<SigningKey> {
    const { privateKey } = await jose.generateKeyPair('RS256', {
      modulusLength: 2048,
      extractable: true,
    })
    return await SigningKey.fromJosePrivateJwk(privateKey)
  }
}

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

const rowToSigningKey = (row: SigningKeyRow): SigningKey =>
  SigningKey.make({
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
      signingKey: SigningKey,
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

export { SigningKey, table, queries, events, materializers }
export type { SigningKeyRow }
