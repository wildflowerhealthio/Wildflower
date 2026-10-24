import { type UseMutationOptions } from '@tanstack/react-query'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import type { SessionWidenings } from '@wildflowerhealthio/authorization-core/http-api-definition'
import { Effect, type Schema } from 'effect'

import type { RunAuthed } from '../router-context.ts'

type SessionWideningConsent = Schema.Schema.Type<
  typeof SessionWidenings.SessionWideningConsentSchema
>
type SessionWideningResult = Schema.Schema.Type<typeof SessionWidenings.SessionWideningResultSchema>

/**
 * The Owner's decision on a session widening: approve with the scopes left ticked (the
 * browser's session grows by them), or deny (the session stays as it was).
 */
type SessionWideningDecision =
  | {
      readonly kind: 'approve'
      readonly id: string
      readonly approvedScopes: readonly string[]
    }
  | { readonly kind: 'deny'; readonly id: string }

/**
 * `ApproveSessionWidening` / `DenySessionWidening` over `runAuthed`, as mutation options:
 * the decision's `mutationFn`, which resolves to the resulting decision. The authorization
 * server's widening card (`authorization-server-web`) runs it on the browser session.
 */
const sessionWideningMutationOptions = (
  runAuthed: RunAuthed
): UseMutationOptions<SessionWideningResult, Error, SessionWideningDecision> => ({
  mutationFn: (decision) =>
    runAuthed(
      Effect.flatMap(AuthorizationServerHttpApiClient, (c) =>
        decision.kind === 'approve'
          ? c.sessionWidenings.ApproveSessionWidening({
              path: { id: decision.id },
              payload: { approvedScopes: [...decision.approvedScopes] },
            })
          : c.sessionWidenings.DenySessionWidening({ path: { id: decision.id } })
      )
    ),
})

export { sessionWideningMutationOptions }
export type { SessionWideningConsent, SessionWideningDecision, SessionWideningResult }
