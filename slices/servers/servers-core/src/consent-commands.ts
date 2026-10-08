import type { Effect } from 'effect'
import { Schema } from 'effect'

import * as ApprovalOutcome from './approval-outcome.ts'
import type * as ConsentApproval from './consent-approval.ts'
import * as ConsentDetails from './consent-details.ts'
import type * as ConsentKey from './consent-key.ts'
import { type HostCommandError, invokeHostCommand, type TauriInvoke } from './host-commands.ts'
import * as PendingConsent from './pending-consent.ts'

/** The oldest consent waiting on each running server that has one. */
const listPendingConsents: Effect.Effect<
  readonly PendingConsent.Type[],
  HostCommandError,
  TauriInvoke
> = invokeHostCommand('pending_consents_list', Schema.Array(PendingConsent.Schema))

/**
 * The consent `consent` waiting on the server `domain`.
 *
 * @remarks
 * Fails with the host's refusal (see `HostCommandFailed.refusal`): kind
 * `serverNotRunning` when the server isn't running, `notPending` when the
 * consent was answered elsewhere or expired.
 */
const readConsent = ({
  domain,
  consent,
}: {
  readonly domain: string
  readonly consent: ConsentKey.Type
}): Effect.Effect<ConsentDetails.Type, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_consent_get', ConsentDetails.Schema, { domain, consent })

/**
 * Approve a consent waiting on the server `domain` as the Owner.
 *
 * @remarks
 * Fails with the refusals {@link readConsent} names, and kind
 * `registrationNotAcknowledged` for a new or changed app the approval didn't
 * acknowledge.
 */
const approveConsent = ({
  domain,
  approval,
}: {
  readonly domain: string
  readonly approval: ConsentApproval.Type
}): Effect.Effect<ApprovalOutcome.Type, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_consent_approve', ApprovalOutcome.Schema, { domain, approval })

/** Deny the consent `consent` waiting on the server `domain`. */
const denyConsent = ({
  domain,
  consent,
}: {
  readonly domain: string
  readonly consent: ConsentKey.Type
}): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_consent_deny', Schema.Null, { domain, consent })

export { approveConsent, denyConsent, listPendingConsents, readConsent }
