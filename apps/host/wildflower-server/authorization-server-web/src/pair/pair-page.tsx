import { useQuery } from '@tanstack/react-query'
import { AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import { OAuth } from '@wildflowerhealthio/authorization-core/http-api-definition'
import type { AuthorizationRouterContext } from '@wildflowerhealthio/authorization-react'
import { Field, PageHeader, PageLoading, TextField } from '@wildflowerhealthio/react-tundraish'
import { Effect, Match, Schema } from 'effect'
import { useEffect, useRef, useState, type JSX } from 'react'

import styles from './pair-page.module.css'

/** A started pairing, as `POST /oauth/pair/start` answers it. */
type StartedPairing = typeof OAuth.StartedBrowserPairingSchema.Type

/** Why the server started no pairing. */
type StartRefusal = (typeof OAuth.BrowserPairingRefusedSchema.Type)['error']

/** What starting a pairing answered. */
type StartAnswer =
  | { readonly kind: 'started'; readonly started: StartedPairing }
  | { readonly kind: 'refused'; readonly refusal: StartRefusal }

/** Where a pairing stands, as a poll answered; an unknown pairing reads as expired. */
type PollStatus = (typeof OAuth.BrowserPairingStatusSchema.Type)['status']

/** How much longer the page waits between polls after each `slow_down`, in seconds. */
const SLOW_DOWN_STEP_SECONDS = 5

/** What the page says while it waits: where the Owner approves the code. */
const APPROVE_ON_SERVER =
  "To sign in this browser, approve this code on the device running your server: open its notification, or the server's page in the Wildflower app."

/** Start a pairing that goes on to `next` once approved. */
const startPairing = (
  next: string
): Effect.Effect<StartAnswer, unknown, AuthorizationServerHttpApiClient> =>
  Effect.flatMap(AuthorizationServerHttpApiClient, (client) =>
    client.oauth.BrowserPairingStart({ payload: { next } })
  ).pipe(
    Effect.map((started): StartAnswer => ({ kind: 'started', started })),
    Effect.catchIf(Schema.is(OAuth.BrowserPairingRefusedSchema), (refused) =>
      Effect.succeed<StartAnswer>({ kind: 'refused', refusal: refused.error })
    )
  )

/** Poll the pairing `pairingCode` names, from a browser now named `browserName`. */
const pollPairing = (
  pairingCode: string,
  browserName: string
): Effect.Effect<PollStatus, unknown, AuthorizationServerHttpApiClient> =>
  Effect.flatMap(AuthorizationServerHttpApiClient, (client) =>
    client.oauth.BrowserPairingPoll({ payload: { pairingCode, browserName } })
  ).pipe(
    Effect.map(({ status }) => status),
    Effect.catchIf(Schema.is(OAuth.BrowserPairingNotFoundSchema), () =>
      Effect.succeed<PollStatus>('expired')
    )
  )

interface PairPageProps {
  /** The page query's `next`, which the server checks and resolves. */
  readonly next: string
  /** The runner over the page's own origin (see `browserSessionRunner`). */
  readonly runAuthed: AuthorizationRouterContext.RunAuthed
  /** Leave for `location`, once this browser holds its session. */
  readonly goTo: (location: string) => void
}

/**
 * The pairing page, `/oauth/pair?next=…`, on the authorization server's own
 * origin: how a browser that isn't the Owner's signs in. It starts a pairing,
 * shows its code and a name for this browser, and polls until the Owner
 * decides it on the device running the server. Once approved, the poll's
 * answer sets this browser's session cookie, and the page goes on to the
 * `next` the server resolved.
 */
const PairPage = ({ next, runAuthed, goTo }: PairPageProps): JSX.Element => {
  // Each "Get a new code" starts a fresh pairing.
  const [attempt, setAttempt] = useState(0)
  const startQuery = useQuery({
    queryKey: ['pair-page', 'start', next, attempt],
    queryFn: () => runAuthed(startPairing(next)),
    // One start per attempt: a refetch would start another pairing and drop
    // the code on screen.
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
  const startAgain = (): void => {
    setAttempt((previous) => previous + 1)
  }

  const view = ((): JSX.Element => {
    if (startQuery.isError) {
      return (
        <p className={styles['pair-page__message']}>
          Couldn&apos;t start signing in this browser. Reload the page to try again.
        </p>
      )
    }
    if (startQuery.data === undefined) return <PageLoading message="Getting a code…" />
    return startedView(startQuery.data, { runAuthed, goTo, onStartAgain: startAgain })
  })()

  return (
    <>
      <PageHeader title="Sign In This Browser" />
      {view}
    </>
  )
}

/** What a started pairing's view needs besides the pairing. */
type StartedViewParts = Omit<AwaitingApprovalProps, 'started'>

/**
 * The page once the start has answered: the pairing awaiting approval, or why
 * none started.
 */
const startedView = (startAnswer: StartAnswer, parts: StartedViewParts): JSX.Element =>
  Match.value(startAnswer).pipe(
    Match.discriminatorsExhaustive('kind')({
      started: ({ started }) => (
        <AwaitingApproval key={started.pairingCode} started={started} {...parts} />
      ),
      refused: ({ refusal }) => <StartRefused refusal={refusal} />,
    })
  )

/** Why no pairing started, in plain words. */
const StartRefused = ({ refusal }: { readonly refusal: StartRefusal }): JSX.Element => (
  <p className={styles['pair-page__message']}>
    {Match.value(refusal).pipe(
      Match.when(
        'BrowserPairingNextNotAllowed',
        () => "This sign-in link isn't valid. Go back to the app and sign in from there."
      ),
      Match.when(
        'BrowserSessionClientDisabled',
        () => "This server doesn't let browsers sign in right now."
      ),
      Match.exhaustive
    )}
  </p>
)

interface AwaitingApprovalProps {
  readonly started: StartedPairing
  readonly runAuthed: AuthorizationRouterContext.RunAuthed
  readonly goTo: (location: string) => void
  /** Start a fresh pairing, once this one is declined or expired. */
  readonly onStartAgain: () => void
}

/** How a pairing ended, other than by its approval. */
type Unapproved = 'denied' | 'expired'

/**
 * One started pairing: its code and this browser's name while it waits, and
 * how it ended. It polls every `interval` seconds, waiting longer after each
 * `slow_down`, and sends the name as it stands, which the server records while
 * the pairing waits.
 */
const AwaitingApproval = ({
  started,
  runAuthed,
  goTo,
  onStartAgain,
}: AwaitingApprovalProps): JSX.Element => {
  const [browserName, setBrowserName] = useState(started.browserName)
  const [ending, setEnding] = useState<Unapproved | 'approved' | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  // The poll reads the name as it stands when it fires, not as it stood when
  // polling started.
  const browserNameRef = useRef(browserName)
  useEffect(() => {
    browserNameRef.current = browserName
  }, [browserName])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const pollAfter = (seconds: number): void => {
      timer = setTimeout(() => {
        runAuthed(pollPairing(started.pairingCode, browserNameRef.current)).then(
          (status) => {
            if (cancelled) return
            setUnreachable(false)
            Match.value(status).pipe(
              Match.when('pending', () => {
                pollAfter(seconds)
              }),
              Match.when('slow_down', () => {
                pollAfter(seconds + SLOW_DOWN_STEP_SECONDS)
              }),
              Match.when('approved', () => {
                setEnding('approved')
                goTo(started.next)
              }),
              Match.when('denied', () => {
                setEnding('denied')
              }),
              Match.when('expired', () => {
                setEnding('expired')
              }),
              Match.exhaustive
            )
          },
          () => {
            if (cancelled) return
            setUnreachable(true)
            pollAfter(seconds)
          }
        )
      }, seconds * 1000)
    }
    pollAfter(started.interval)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [started, runAuthed, goTo])

  if (ending === 'approved') {
    return <p className={styles['pair-page__message']}>Signed in. Taking you back…</p>
  }
  if (ending !== null) return <Ended ending={ending} onStartAgain={onStartAgain} />
  return (
    <>
      <p className={styles['pair-page__message']}>{APPROVE_ON_SERVER}</p>
      <Field label="Your code">
        <div className={styles['pair-page__code']}>{started.userCode}</div>
      </Field>
      <TextField
        label="Name this browser"
        value={browserName}
        onChange={setBrowserName}
        autoCapitalize="words"
        description="Your server lists this browser by this name."
      />
      <p className={styles['pair-page__status']} role="status">
        {unreachable ? "Can't reach your server. Still trying…" : 'Waiting for approval…'}
      </p>
    </>
  )
}

interface EndedProps {
  readonly ending: Unapproved
  readonly onStartAgain: () => void
}

/** A pairing that was declined or expired, and the way to a new code. */
const Ended = ({ ending, onStartAgain }: EndedProps): JSX.Element => (
  <>
    <p className={styles['pair-page__message']}>
      {Match.value(ending).pipe(
        Match.when('denied', () => 'The request to sign in this browser was declined.'),
        Match.when('expired', () => 'This code expired before it was approved.'),
        Match.exhaustive
      )}
    </p>
    <div className={styles['pair-page__actions']}>
      <button type="button" className="button-2 filled" onClick={onStartAgain}>
        Get a new code
      </button>
    </div>
  </>
)

export { PairPage }
export type { PairPageProps }
