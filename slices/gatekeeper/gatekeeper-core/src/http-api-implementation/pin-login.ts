import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { DateTime, Effect } from 'effect'
import { Origin } from 'kitchen-sink'
import { GatekeeperStore } from '../contexts/GatekeeperStore.ts'
import { GatekeeperApi } from '../http-api-definition/index.ts'
import { httpApiGroup } from '../http-api-definition/pin-login.ts'
import { buildSessionCookie } from '../internal/cookies.ts'
import { pinErrorHtml } from '../internal/error-pages.ts'
import { signSessionJwt } from '../internal/jwt.ts'
import { PinChallenges, Sessions, SigningKeys } from '../livestore/index.ts'

const isSafeReturnTo = (value: string): boolean => value.startsWith('/') && !value.startsWith('//')

const layer = HttpApiBuilder.group(GatekeeperApi, 'pin-login', (handlers) =>
  handlers
    .handleRaw('PinPage', () =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const origin = yield* Origin
        const searchParams = yield* HttpServerRequest.ParsedSearchParams
        const returnTo = (() => {
          const value = searchParams['returnTo']
          if (globalThis.Array.isArray(value)) return value[0] ?? '/'
          return value ?? '/'
        })()

        if (!isSafeReturnTo(returnTo)) {
          return HttpServerResponse.text(pinErrorHtml('invalid_returnTo'), {
            status: 400,
            contentType: 'text/html; charset=utf-8',
          })
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

        const expiresAt = DateTime.addDuration(DateTime.unsafeNow(), '2 minutes')
        store.commit(
          PinChallenges.events.pinChallengeIssued({
            id,
            pin,
            returnTo,
            expiresAt,
          })
        )

        return HttpServerResponse.redirect(`${origin}/login/pin/${id}/page`, { status: 302 })
      })
    )
    .handleRaw('PinStatus', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore

        const pending = store.query(PinChallenges.queries.byId$(id))
        if (pending == null) {
          return HttpServerResponse.unsafeJson(
            { status: 'error', message: 'Unknown id' },
            { status: 404 }
          )
        }

        if (
          pending.status === 'pending' &&
          DateTime.lessThan(pending.expiresAt, DateTime.unsafeNow())
        ) {
          store.commit(PinChallenges.events.pinChallengeExpired({ id }))
          return HttpServerResponse.unsafeJson({ status: 'expired' })
        }

        if (pending.status === 'expired') {
          return HttpServerResponse.unsafeJson({ status: 'expired' })
        }

        if (pending.status === 'rejected') {
          return HttpServerResponse.unsafeJson({ status: 'declined' })
        }

        if (pending.status === 'verified') {
          const origin = yield* Origin
          return HttpServerResponse.unsafeJson({
            status: 'approved',
            redirect: `${origin}/login/pin/${id}/complete`,
          })
        }

        return HttpServerResponse.unsafeJson({ status: 'pending' })
      })
    )
    .handleRaw('PinComplete', ({ path: { id } }) =>
      Effect.gen(function* () {
        const store = yield* GatekeeperStore
        const origin = yield* Origin

        const challenge = store.query(PinChallenges.queries.byId$(id))
        if (challenge == null || challenge.status !== 'verified') {
          return HttpServerResponse.unsafeJson(
            { status: 'error', message: 'Invalid or expired request' },
            { status: 400 }
          )
        }

        const session = store.query(Sessions.queries.byId$(id))
        if (session == null) {
          return HttpServerResponse.unsafeJson(
            { status: 'error', message: 'Session not found' },
            { status: 500 }
          )
        }

        const maxAge = Math.max(
          0,
          Math.floor(DateTime.distance(DateTime.unsafeNow(), session.expiresAt) / 1000)
        )

        const [jwk] = store.query(SigningKeys.queries.all$)
        if (jwk === undefined) {
          return HttpServerResponse.unsafeJson(
            { status: 'error', message: 'No signing keys available' },
            { status: 500 }
          )
        }

        const signedTokenEither = yield* Effect.either(
          signSessionJwt(
            jwk,
            {
              iss: `${origin}/fhir`,
              sub: session.id,
              aud: origin,
              type: 'session',
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

        return HttpServerResponse.redirect(challenge.returnTo, {
          status: 302,
          headers: {
            'Set-Cookie': buildSessionCookie(signedTokenEither.right, maxAge),
          },
        })
      })
    )
)

export { httpApiGroup, layer }
