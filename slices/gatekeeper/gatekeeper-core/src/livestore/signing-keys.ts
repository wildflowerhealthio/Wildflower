import { Events, type LiveQueryDef, queryDb, State, nanoid } from '@livestore/livestore'

import { Array, Schema } from 'effect'
import * as jose from 'jose'

class SigningKey extends Schema.Class<SigningKey>('SigningKey')({
  kty: Schema.Literal('RSA'),
  alg: Schema.Literal('RS256'),
  kid: Schema.String.pipe(State.SQLite.withPrimaryKey),
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
    return await new jose.SignJWT(payload).setProtectedHeader({ alg: 'RS256' }).sign(joseKey)
  }

  async verifyJwt(token: string): Promise<jose.JWTVerifyResult<jose.JWTPayload>> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const testPub = (await jose.importJWK(this.publicJwk())) as jose.CryptoKey
    return await jose.jwtVerify(token, testPub)
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

const table = State.SQLite.table({
  name: 'signingKeys',
  schema: SigningKey,
})

const queries = {
  findByKid$: (kid: string): LiveQueryDef<SigningKey | null> =>
    queryDb(table.where({ kid }), {
      map: (rows): SigningKey | null => {
        if (Array.isNonEmptyReadonlyArray(rows)) {
          return SigningKey.make(rows[0])
        }
        return null
      },
      label: 'signingKeyByKid',
    }),
  all$: queryDb(table, {
    map: (rows): readonly SigningKey[] => rows.map((row) => SigningKey.make(row)),
    label: 'allSigningKeys',
  }),
}

const events = {
  signingKeyAdded: Events.synced({
    name: 'v1.SigningKeyAdded',
    schema: Schema.Struct({
      signingKey: SigningKey,
    }),
  }),
} as const

const materializers = State.SQLite.materializers(events, {
  'v1.SigningKeyAdded': ({ signingKey }) => table.insert(signingKey),
})

export { SigningKey, table, queries, events, materializers }
