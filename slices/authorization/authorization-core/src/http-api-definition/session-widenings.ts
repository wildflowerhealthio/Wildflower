import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { InsufficientScopeSchema } from '@wildflowerhealthio/shared-structures-core/http-api-definition'
import { Schema } from 'effect'
import { RequireAuthMiddleware } from './require-auth.ts'

/**
 * A session widening as its card loads it: a paired browser asking, from an app's limited page,
 * for its browser session to hold more.
 */
const SessionWideningConsentSchema = Schema.Struct({
  id: Schema.String,
  // The name of the browser that asks: its session's.
  browserName: Schema.String,
  // The app whose request the browser's session fell short of.
  clientId: Schema.String,
  clientName: Schema.String,
  // What the session lacked of the app's request: the most the Owner may grant.
  requestedScopes: Schema.Array(Schema.String),
  // The scopes the card's ticks start from: those of the requested ones the reader may pass on.
  // The Owner may only untick.
  startingScopes: Schema.Array(Schema.String),
  // The approval scopes the reader's own token lacks to approve the widening
  // (`wildflower/AuthorizationRequest.u`). Empty when the reader may approve.
  missingApprovalScopes: Schema.Array(Schema.String),
})

const SessionWideningResultSchema = Schema.Union(
  Schema.Struct({ status: Schema.Literal('approved') }),
  Schema.Struct({ status: Schema.Literal('denied') })
)

const SessionWideningNotFoundSchema = Schema.Struct({
  error: Schema.Literal('SessionWideningNotFound'),
  id: Schema.String,
})

const SessionWideningApproveBodySchema = Schema.Struct({
  // The scopes the Owner left ticked, clamped to what the browser asked for and to the
  // approver's own grant. None left is a deny.
  approvedScopes: Schema.Array(Schema.String),
})

/**
 * The Owner's side of a session widening: read it on its card, approve it (the browser's session
 * grows by what is approved) or deny it (the session stays as it was). Gated like the device
 * routes, on `wildflower/AuthorizationRequest.r` to read and `.u` to decide.
 */
const httpApiGroup = HttpApiGroup.make('sessionWidenings', { topLevel: false })
  .add(
    HttpApiEndpoint.get('GetSessionWidening', '/session-widenings/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(SessionWideningConsentSchema)
      .addError(SessionWideningNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.post('ApproveSessionWidening', '/session-widenings/:id/approve')
      .setPath(Schema.Struct({ id: Schema.String }))
      .setPayload(SessionWideningApproveBodySchema)
      .addSuccess(SessionWideningResultSchema)
      .addError(SessionWideningNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.post('DenySessionWidening', '/session-widenings/:id/deny')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(SessionWideningResultSchema)
      .addError(SessionWideningNotFoundSchema, { status: 404 })
  )
  .addError(InsufficientScopeSchema, { status: 403 })
  .middleware(RequireAuthMiddleware)
  .prefix('/authorization')

export {
  httpApiGroup,
  SessionWideningApproveBodySchema,
  SessionWideningConsentSchema,
  SessionWideningNotFoundSchema,
  SessionWideningResultSchema,
}
