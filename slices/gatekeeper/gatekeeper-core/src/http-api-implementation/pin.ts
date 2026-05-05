import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { nanoid } from '@livestore/livestore'
import { DateTime, Effect } from 'effect'
import { Origin } from 'kitchen-sink'
import { notifyPinAuthListeners } from '../contexts/AuthListeners.ts'
import { AuthRenderer } from '../contexts/AuthRenderer.ts'
import { AuthStore } from '../contexts/AuthStore.ts'
import { AuthApi } from '../http-api-definition/index.ts'
import { httpApiGroup } from '../http-api-definition/pin.ts'
import { buildSessionCookie } from '../internal/cookies.ts'
import { signSessionJwt } from '../internal/jwt.ts'
import { Clients, JsonWebKeys, PinAuths } from '../livestore/index.ts'

const isSafeReturnTo = (value: string): boolean => value.startsWith('/') && !value.startsWith('//')

const layer = HttpApiBuilder.group(AuthApi, 'pin', (handlers) =>
  handlers
    .handleRaw('PinPage', () =>
      Effect.gen(function* () {
        const store = yield* AuthStore
        const renderer = yield* AuthRenderer
        const origin = yield* Origin
        const searchParams = yield* HttpServerRequest.ParsedSearchParams
        const returnTo = (() => {
          const value = searchParams['returnTo']
          if (globalThis.Array.isArray(value)) return value[0] ?? '/'
          return value ?? '/'
        })()

        if (!isSafeReturnTo(returnTo)) {
          return renderer.pinError({ kind: 'invalid_returnTo' })
        }

        const id = crypto.randomUUID()
        const pinBuf = new Uint32Array(1)
        const pinBiasLimit = Math.floor(0xffffffff / 900000) * 900000
        let pinRandom: number
        do {
          crypto.getRandomValues(pinBuf)
          pinRandom = pinBuf[0]!
        } while (pinRandom >= pinBiasLimit)
        const pin = (100000 + (pinRandom % 900000)).toString()

        const exp = DateTime.addDuration(DateTime.unsafeNow(), '2 minutes')
        store.commit(
          PinAuths.events.pinAuthCreated({
            id,
            pin,
            returnTo,
            exp,
          })
        )

        const created = store.query(PinAuths.queries.byId$(id))
        if (created != null) {
          notifyPinAuthListeners(created)
        }

        return renderer.pinPage({
          id,
          pin,
          statusUrl: `${origin}/auth/pin/status/${id}`,
          timeoutMs: 2 * 60 * 1000,
        })
      })
    )
    .handleRaw('PinStatus', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* AuthStore

        const pending = store.query(PinAuths.queries.byId$(id))
        if (pending == null) {
          return HttpServerResponse.unsafeJson(
            { status: 'error', message: 'Unknown id' },
            { status: 404 }
          )
        }

        if (DateTime.lessThan(pending.exp, DateTime.unsafeNow())) {
          store.commit(PinAuths.events.pinAuthDeleted({ id }))
          return HttpServerResponse.unsafeJson({ status: 'expired' })
        }

        if (pending.status === 'approved') {
          const origin = yield* Origin
          return HttpServerResponse.unsafeJson({
            status: 'approved',
            redirect: `${origin}/auth/pin/grant/${id}`,
          })
        }

        return HttpServerResponse.unsafeJson({ status: 'pending' })
      })
    )
    .handleRaw('PinGrant', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* AuthStore
        const origin = yield* Origin

        const pending = store.query(PinAuths.queries.byId$(id))
        if (pending == null || pending.status !== 'approved') {
          return HttpServerResponse.unsafeJson(
            { status: 'error', message: 'Invalid or expired request' },
            { status: 400 }
          )
        }

        const duration = pending.duration ?? 'request'
        const maxAge = (() => {
          if (duration === '15min') return 900
          if (duration === '1min') return 60
          return 30
        })()

        const [jwk] = store.query(JsonWebKeys.queries.allJwks$)
        if (jwk === undefined) {
          return HttpServerResponse.unsafeJson(
            { status: 'error', message: 'No signing keys available' },
            { status: 500 }
          )
        }

        const sessionId = nanoid()
        const signedTokenEither = yield* Effect.either(
          signSessionJwt(
            jwk,
            {
              iss: `${origin}/fhir`,
              sub: sessionId,
              aud: origin,
              type: 'pin',
            },
            maxAge
          )
        )
        if (signedTokenEither._tag === 'Left') {
          return HttpServerResponse.unsafeJson(
            { status: 'error', message: 'Failed to create session' },
            { status: 500 }
          )
        }

        store.commit(
          Clients.events.clientApproved({
            id: Clients.ClientIdSchema.make(sessionId),
            clientId: sessionId,
            type: 'pin',
            scopes: [],
            redirectUri: '',
            approvedAt: DateTime.unsafeNow(),
            label: 'PIN session',
            patient: null,
          })
        )

        store.commit(PinAuths.events.pinAuthDeleted({ id }))

        return HttpServerResponse.redirect(pending.returnTo, {
          status: 302,
          headers: {
            'Set-Cookie': buildSessionCookie(signedTokenEither.right, maxAge),
          },
        })
      })
    )
)

export { httpApiGroup, layer }
