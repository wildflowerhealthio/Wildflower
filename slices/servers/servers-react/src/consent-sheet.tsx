import { useQuery } from '@tanstack/react-query'
import { type JSX, useState } from 'react'
import { Dialog, ErrorBanner, PageLoading } from 'react-tundraish'
import { ConsentKey, type PendingConsent } from 'servers-core'

import { ConsentForm } from './consent-form.tsx'
import {
  consentQueryOptions,
  pendingConsentsQueryOptions,
  useDecideConsent,
  usePendingConsentEvents,
} from './consent-queries.ts'
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

/** What an approval that granted nothing says. */
const NOTHING_GRANTED = 'Nothing you allowed could be granted, so the request was denied.'

/** The consent at the front of the queue: loaded, then asked. */
function WaitingConsent({
  runHostCommand,
  waiting,
  onDecided,
}: {
  readonly runHostCommand: RunHostCommand
  readonly waiting: PendingConsent.Waiting
  readonly onDecided: () => void
}): JSX.Element {
  const consent = useQuery(consentQueryOptions(runHostCommand, waiting))
  const decide = useDecideConsent(runHostCommand, waiting.domain)
  const [nothingGranted, setNothingGranted] = useState(false)
  if (consent.isPending) return <PageLoading message="Loading the request…" />
  if (consent.isError) return <ErrorBanner error={consent.error} />
  return (
    <ConsentForm
      domain={waiting.domain}
      details={consent.data}
      deciding={decide.isPending}
      decisionError={decide.error ?? (nothingGranted ? NOTHING_GRANTED : null)}
      onDecide={(decision) => {
        setNothingGranted(false)
        decide.mutate(decision, {
          onSuccess: (outcome) => {
            if (decision.kind === 'approve' && outcome.status === 'denied') {
              setNothingGranted(true)
              return
            }
            onDecided()
          },
        })
      }}
    />
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
 * confirms it.
 */
function ConsentSheet({ runHostCommand, listenToHostEvent }: ConsentSheetProps): JSX.Element {
  usePendingConsentEvents(listenToHostEvent)
  const pendingConsents = useQuery(pendingConsentsQueryOptions(runHostCommand))
  const [setAside, setSetAside] = useState<ReadonlySet<string>>(() => new Set())
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
      open={front !== undefined}
      title={front?.key.kind === 'device' ? 'A device wants to pair' : 'An app wants access'}
      onClose={() => {
        if (front !== undefined) putAside(front)
      }}
    >
      {front === undefined ? null : (
        <div className={styles['consent-sheet']}>
          <p className={styles['consent-sheet__position']} aria-live="polite">
            {`1 of ${queue.length}`}
          </p>
          <WaitingConsent
            key={waitingId(front)}
            runHostCommand={runHostCommand}
            waiting={front}
            onDecided={() => {
              putAside(front)
            }}
          />
        </div>
      )}
    </Dialog>
  )
}

export { ConsentSheet, type ConsentSheetProps }
