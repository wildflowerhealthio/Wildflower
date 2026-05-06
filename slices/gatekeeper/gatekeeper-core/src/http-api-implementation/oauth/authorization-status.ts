import type { Schema } from 'effect'
import { Effect, Match } from 'effect'
import { GatekeeperStore } from '../../contexts/gatekeeper-store.ts'
import type {
  AuthorizationStatusNotFoundSchema,
  AuthorizationStatusSchema,
} from '../../http-api-definition/oauth.ts'
import { OAuthError500Schema } from '../../http-api-definition/oauth.ts'
import {
  AuthorizationCodes,
  AuthorizationRequests,
  type AuthorizationRequestRow,
} from '../../livestore/index.ts'
import { buildClientRedirectUrl, type OAuthError500 } from './shared.ts'

type AuthorizationStatus = Schema.Schema.Type<typeof AuthorizationStatusSchema>
type AuthorizationStatusNotFound = Schema.Schema.Type<typeof AuthorizationStatusNotFoundSchema>

const getAuthorizationRequestForStatus = (
  id: string
): Effect.Effect<AuthorizationRequestRow, AuthorizationStatusNotFound, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const request = store.query(AuthorizationRequests.queries.byId$(id))
    if (request == null) {
      return yield* Effect.fail({
        error: 'AuthorizationRequestNotFound' as const,
        id,
      })
    }
    return request
  })

const renderApprovedAuthorizationRedirect = (
  request: AuthorizationRequestRow
): Effect.Effect<AuthorizationStatus, OAuthError500, GatekeeperStore> =>
  Effect.gen(function* () {
    if (request.redirectUri == null || request.clientState == null) {
      return yield* Effect.fail(
        OAuthError500Schema.make({
          error: 'server_error',
          error_description: 'Authorization request is not a code-flow request',
        })
      )
    }
    const store = yield* GatekeeperStore
    const issuedCode = store.query(AuthorizationCodes.queries.byRequestId$(request.id))
    if (issuedCode == null) {
      return yield* Effect.fail(
        OAuthError500Schema.make({
          error: 'server_error',
          error_description: 'Authorization code missing',
        })
      )
    }
    return {
      status: 'approved' as const,
      redirect: buildClientRedirectUrl(request.redirectUri, issuedCode.code, request.clientState),
    }
  })

const renderAuthorizationStatus = (
  request: AuthorizationRequestRow
): Effect.Effect<AuthorizationStatus, OAuthError500, GatekeeperStore> =>
  Match.value(request.status).pipe(
    Match.when('denied', () => Effect.succeed<AuthorizationStatus>({ status: 'denied' })),
    Match.when('expired', () =>
      Effect.succeed<AuthorizationStatus>({
        status: 'error',
        message: 'Authorization request expired',
      })
    ),
    Match.when('approved', () => renderApprovedAuthorizationRedirect(request)),
    Match.when('pending', () => Effect.succeed<AuthorizationStatus>({ status: 'pending' })),
    Match.orElse(() =>
      Effect.fail(
        OAuthError500Schema.make({
          error: 'server_error',
          error_description: 'Invalid request status',
        })
      )
    )
  )

export { getAuthorizationRequestForStatus, renderAuthorizationStatus }
