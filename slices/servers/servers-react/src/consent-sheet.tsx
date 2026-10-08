import { useQuery } from '@tanstack/react-query'
import { Match } from 'effect'
import { type JSX, useState } from 'react'
import { Dialog, ErrorBanner, PageLoading } from 'react-tundraish'
import { ApprovalOutcome, ConsentKey, type PendingConsent } from 'servers-core'

import {
  type ConsentDecision,
  consentQueryOptions,
  pendingConsentsQueryOptions,
  useDecideConsent,
  usePendingConsentEvents,
} from './consent-queries.ts'
import { DeviceConsentForm } from './device-consent-form.tsx'
import { OAuthConsentForm } from './oauth-consent-form.tsx'
import type { ListenToHostEvent, RunHostCommand } from './router-context.ts'
import styles from './consent-sheet.module.css'

/** Props for {@link ConsentSheet}. */
interface ConsentSheetProps {
  readonly runHostCommand: RunHostCommand
  readonly listenToHostEvent: ListenToHostEvent
}

/** A waiting consent's identity across servers: its server and its key. */
const waitingId = ({ domain, key }: PendingConsent.Waiting): string =>
  `${domain} ${ConsentKey.asString(key)}`

/** What the sheet says after an approval that granted nothing, which the server records as a denial. */
const NOTHING_GRANTED = 'The last request was denied: nothing you allowed could be granted.'

/** The sheet's title while `front` is the consent in front, if any. */
const sheetTitleFor = (front: PendingConsent.Waiting | undefined): string => {
  if (front === undefined) return 'Nothing was granted'
  return front.key.kind === 'device' ? 'A device wants to pair' : 'An app wants access'
}

/** The consent at the front of the queue: loaded, then asked. */
function WaitingConsent({
  runHostCommand,
  waiting,
  onDecided,
}: {
  readonly runHostCommand: RunHostCommand
  readonly waiting: PendingConsent.Waiting
  /** The consent is no longer waiting; `grantedNothing` when an approval came to a denial. */
  readonly onDecided: (grantedNothing: boolean) => void
}): JSX.Element {
  const consent = useQuery(consentQueryOptions(runHostCommand, waiting))
  const decide = useDecideConsent(runHostCommand, waiting.domain, (outcome, decision) => {
    onDecided(decision.kind === 'approve' && !ApprovalOutcome.isApproved(outcome))
  })
  if (consent.isPending) return <PageLoading message="Loading the request…" />
  if (consent.isError) return <ErrorBanner error={consent.error} />
  const formProps = {
    domain: waiting.domain,
    deciding: decide.isPending,
    decisionError: decide.error,
    onDecide: (decision: ConsentDecision): void => {
      decide.mutate(decision)
    },
  }
  return Match.value(consent.data).pipe(
    Match.when({ kind: 'device' }, (details) => (
      <DeviceConsentForm details={details} {...formProps} />
    )),
    Match.when({ kind: 'oauth' }, (details) => (
      <OAuthConsentForm details={details} {...formProps} />
    )),
    Match.exhaustive
  )
}

/**
 * The consent sheet: whenever a consent waits on any of this device's
 * running servers, a modal asks the Owner about the oldest one of the first
 * server in the queue, with where it stands in the queue ("1 of 3": one
 * consent per server, each server's next once that one is answered).
 *
 * @remarks
 * Closing the sheet without answering leaves the consent waiting and moves
 * on to the next; it comes back when the base opens again. An answered
 * consent leaves the sheet at once, before the host's `pending-consent` event
 * confirms it. An approval that granted nothing is a denial too, and the
 * sheet says so over the next consent, or on its own when nothing else
 * waits, until the Owner answers or closes it.
 */
function ConsentSheet({ runHostCommand, listenToHostEvent }: ConsentSheetProps): JSX.Element {
  usePendingConsentEvents(listenToHostEvent)
  const pendingConsents = useQuery(pendingConsentsQueryOptions(runHostCommand))
  const [setAside, setSetAside] = useState<ReadonlySet<string>>(() => new Set())
  const [grantedNothing, setGrantedNothing] = useState(false)
  const queue = (pendingConsents.data ?? []).filter((waiting) => !setAside.has(waitingId(waiting)))
  const front = queue[0]
  const putAside = (waiting: PendingConsent.Waiting): void => {
    setSetAside((previous) => new Set([...previous, waitingId(waiting)]))
  }
  return (
    // Keyed by the consent in front, so the next one opens a fresh sheet even
    // after the Owner closed the last one: a closed `<dialog>` reopens only
    // when its `open` changes.
    <Dialog
      key={front === undefined ? 'nothing-waiting' : waitingId(front)}
      open={front !== undefined || grantedNothing}
      title={sheetTitleFor(front)}
      onClose={() => {
        setGrantedNothing(false)
        if (front !== undefined) putAside(front)
      }}
    >
      <div className={styles['consent-sheet']}>
        <ErrorBanner error={grantedNothing ? NOTHING_GRANTED : null} />
        {front === undefined ? null : (
          <>
            <p className={styles['consent-sheet__position']} aria-live="polite">
              {`1 of ${queue.length}`}
            </p>
            <WaitingConsent
              key={waitingId(front)}
              runHostCommand={runHostCommand}
              waiting={front}
              onDecided={(decisionGrantedNothing) => {
                setGrantedNothing(decisionGrantedNothing)
                putAside(front)
              }}
            />
          </>
        )}
      </div>
    </Dialog>
  )
}

export { ConsentSheet, type ConsentSheetProps }
