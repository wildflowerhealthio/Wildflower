import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { nanoid } from '@livestore/livestore'
import { DateTime, Effect } from 'effect'
import { Origin } from 'kitchen-sink'
import { AuthListeners } from '../contexts/AuthListeners.ts'
import { AuthRenderer } from '../contexts/AuthRenderer.ts'
import { AuthState } from '../contexts/AuthState.ts'
import { AuthStore } from '../contexts/AuthStore.ts'
import { AuthApi } from '../http-api-definition/index.ts'
import { httpApiGroup } from '../http-api-definition/pin.ts'
import { buildSessionCookie } from '../internal/cookies.ts'
import { signSessionJwt } from '../internal/jwt.ts'
import { ApprovedApps, JsonWebKeys } from '../livestore/index.ts'

const isSafeReturnTo = (value: string): boolean => value.startsWith('/') && !value.startsWith('//')

const layer = HttpApiBuilder.group(AuthApi, 'pin', (handlers) =>
  handlers
    .handleRaw('PinPage', () =>
      Effect.gen(function* () {
        const state = yield* AuthState
        const renderer = yield* AuthRenderer
        const listeners = yield* AuthListeners
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
        const pin = Math.floor(100000 + Math.random() * 900000).toString()

        const pending = {
          id,
          pin,
          returnTo,
          exp: DateTime.addDuration(DateTime.unsafeNow(), '2 minutes'),
          status: 'pending' as const,
        }
        state.pinAuths.set(id, pending)

        listeners.notifyPinAuthListeners(pending)

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
        const state = yield* AuthState

        const pending = state.pinAuths.get(id)
        if (pending == null) {
          return HttpServerResponse.unsafeJson(
            { status: 'error', message: 'Unknown id' },
            { status: 404 }
          )
        }

        if (DateTime.lessThan(pending.exp, DateTime.unsafeNow())) {
          state.pinAuths.delete(id)
          return HttpServerResponse.unsafeJson({ status: 'expired' })
        }

        if (pending.status === 'declined') {
          state.pinAuths.delete(id)
          return HttpServerResponse.unsafeJson({ status: 'declined' })
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
        const state = yield* AuthState
        const origin = yield* Origin

        const pending = state.pinAuths.get(id)
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
          ApprovedApps.events.appApproved({
            id: ApprovedApps.ApprovedAppIdSchema.make(sessionId),
            clientId: sessionId,
            type: 'pin',
            scopes: [],
            redirectUri: '',
            approvedAt: DateTime.unsafeNow(),
            label: 'PIN session',
            patient: null,
          })
        )

        state.pinAuths.delete(id)

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
