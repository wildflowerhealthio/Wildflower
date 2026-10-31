/**
 * The session widening's card: a paired browser asking, from an app's limited page, for
 * its browser session to hold more, for the Owner to approve or decline. The Owner may
 * only untick: the shared {@link ScopePicker} runs in its clamped mode over what the
 * browser asked for, so nothing beyond it can be granted. Approving grows the browser's
 * session by what is left ticked; declining leaves it as it was.
 *
 * The surrounding chrome (the page shell and its `PageHeader`) is the caller's.
 */

import type { UseMutationResult } from '@tanstack/react-query'
import { Chip, ErrorBanner, Field, FieldDescription } from '@wildflowerhealthio/react-tundraish'
import { GrantDraft, ScopeRequest } from '@wildflowerhealthio/scopes-core'
import { ScopePicker } from '@wildflowerhealthio/scopes-react'
import type { JSX } from 'react'
import { useMemo, useState } from 'react'

import type {
  SessionWideningConsent,
  SessionWideningDecision,
  SessionWideningResult,
} from '../../queries/index.ts'
import styles from './session-widening-card.module.css'

/**
 * What the card sends the Owner's decision through: a session-widening mutation's
 * `mutate`, and its pending state and failure. The surface composing the card decides
 * whose session the decision runs on.
 */
type SessionWideningMutation = Pick<
  UseMutationResult<SessionWideningResult, Error, SessionWideningDecision>,
  'mutate' | 'isPending' | 'error'
>

interface SessionWideningCardProps {
  readonly consent: SessionWideningConsent
  readonly consentMutation: SessionWideningMutation
  /** Called with the server's answer once the Owner's decision is recorded. */
  readonly onDone: (result: SessionWideningResult) => void
}

/** The session widening's card. */
const SessionWideningCard = ({
  consent,
  consentMutation,
  onDone,
}: SessionWideningCardProps): JSX.Element => {
  const request = useMemo(
    () => ScopeRequest.fromRequestedScopes({ optional: consent.requestedScopes }),
    [consent]
  )
  const [draft, setDraft] = useState(() => GrantDraft.fromScopes(consent.startingScopes, null))
  const submitting = consentMutation.isPending

  const handleApprove = (): void => {
    consentMutation.mutate(
      { kind: 'approve', id: consent.id, approvedScopes: GrantDraft.serializeAll(draft) },
      {
        onSuccess: (result) => {
          onDone(result)
        },
      }
    )
  }

  const handleDecline = (): void => {
    consentMutation.mutate(
      { kind: 'deny', id: consent.id },
      {
        onSuccess: (result) => {
          onDone(result)
        },
      }
    )
  }

  return (
    <>
      <p className={styles['session-widening-card__intro']}>
        A browser signed in to your server asks to do more, for an app it runs.
      </p>

      <Field label="Browser">
        <span className={styles['session-widening-card__name']}>{consent.browserName}</span>{' '}
        <Chip>Remote</Chip>
      </Field>

      <Field label="Application">
        <span className={styles['session-widening-card__name']}>{consent.clientName}</span>
        <FieldDescription>
          <code>{consent.clientId}</code>
        </FieldDescription>
      </Field>

      <ScopePicker
        subjectName={consent.browserName}
        request={request}
        draft={draft}
        onDraftChange={setDraft}
        phrasing="asking"
      />

      <p className={styles['session-widening-card__footnote']}>
        Only approve a browser you recognize. It keeps this access until its session ends.
      </p>

      <ErrorBanner error={consentMutation.error} />

      <div className={styles['session-widening-card__actions']}>
        <button
          type="button"
          className="button-2 outline accent-red"
          disabled={submitting}
          onClick={handleDecline}
        >
          Decline
        </button>
        <button
          type="button"
          className="button-2 filled"
          // A fully-unticked draft is a deny on the server; block it rather than let
          // Approve decline by accident.
          disabled={submitting || !GrantDraft.hasScopes(draft)}
          onClick={handleApprove}
        >
          Approve
        </button>
      </div>
    </>
  )
}

export { SessionWideningCard }
export type { SessionWideningCardProps, SessionWideningMutation }
