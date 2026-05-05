import { DateTime, Effect } from 'effect'
import { AuthorizationCodes, AuthorizationRequests } from '../livestore/index.ts'
import { GatekeeperStore } from './gatekeeper-store.ts'

/**
 * Mark an authorization request as approved, issue a single-use authorization
 * code, and return the redirect URL the OAuth client should be sent to.
 *
 * Returns `null` when the request is not found, is not in `pending` status,
 * or when `grantedScopes` is not a subset of the request's `requestedScopes`
 * (scope-escalation guard). The caller cannot distinguish these cases — that
 * is intentional: from the OAuth client's perspective they all collapse to
 * "consent did not produce a code".
 */
const approveAuthorizationRequest = (
  requestId: string,
  grantedScopes: readonly string[],
  patient?: string
): Effect.Effect<string | null, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const pending = store.query(AuthorizationRequests.queries.byId$(requestId))
    if (pending == null) return null
    if (pending.status !== 'pending') return null
    if (pending.grantType !== 'authorization_code') return null
    if (pending.redirectUri == null || pending.clientState == null || pending.codeChallenge == null)
      return null
    const requestedScopeSet = new Set(pending.requestedScopes)
    if (!grantedScopes.every((s) => requestedScopeSet.has(s))) return null

    const code = crypto.randomUUID()
    const issuedAt = yield* DateTime.now
    const codeExpiresAt = DateTime.addDuration(issuedAt, '60 seconds')

    store.commit(
      AuthorizationRequests.events.authorizationRequestApproved({
        id: requestId,
        grantedScopes,
        patient: patient ?? null,
      }),
      AuthorizationCodes.events.authorizationCodeIssued({
        code,
        requestId,
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        grantedScopes,
        patient: patient ?? null,
        issuedAt,
        expiresAt: codeExpiresAt,
      })
    )

    const redirect = new URL(pending.redirectUri)
    redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', pending.clientState)
    return redirect.toString()
  })

const denyAuthorizationRequest = (requestId: string): Effect.Effect<void, never, GatekeeperStore> =>
  Effect.gen(function* () {
    const store = yield* GatekeeperStore
    const pending = store.query(AuthorizationRequests.queries.byId$(requestId))
    if (pending == null) return
    store.commit(AuthorizationRequests.events.authorizationRequestDenied({ id: requestId }))
  })

export { approveAuthorizationRequest, denyAuthorizationRequest }
