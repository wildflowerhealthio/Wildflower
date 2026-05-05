import { Events, type LiveQueryDef, queryDb, State, nanoid } from '@livestore/livestore'

import { Array, Schema } from 'effect'
import * as jose from 'jose'

class RsaJwk extends Schema.Class<RsaJwk>('RsaJwk')({
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

  static async fromJosePrivateJwk(jwk: jose.CryptoKey): Promise<RsaJwk> {
    const privateJoseJwk = await jose.exportJWK(jwk)
    const kid = nanoid()
    return Schema.decodeUnknownSync(RsaJwk)({
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

  static async generate(): Promise<RsaJwk> {
    const { privateKey } = await jose.generateKeyPair('RS256', {
      modulusLength: 2048,
      extractable: true,
    })
    return await RsaJwk.fromJosePrivateJwk(privateKey)
  }
}

const table = State.SQLite.table({
  name: 'RsaJwks',
  schema: RsaJwk,
})

const queries = {
  findJwkByKid$: (kid: string): LiveQueryDef<RsaJwk | null> =>
    queryDb(table.where({ kid }), {
      map: (rows): RsaJwk | null => {
        if (Array.isNonEmptyReadonlyArray(rows)) {
          return RsaJwk.make(rows[0])
        }
        return null
      },
      label: 'findJwkByKid',
    }),
  allJwks$: queryDb(table, {
    map: (rows): readonly RsaJwk[] => rows.map((row) => RsaJwk.make(row)),
    label: 'allJwks',
  }),
}

const events = {
  jwkAdded: Events.synced({
    name: 'v1.JwkAdded',
    schema: Schema.Struct({
      rsaJwk: RsaJwk,
    }),
  }),
} as const

const materializers = State.SQLite.materializers(events, {
  'v1.JwkAdded': ({ rsaJwk }) => table.insert(rsaJwk),
})

export { RsaJwk, table, queries, events, materializers }
