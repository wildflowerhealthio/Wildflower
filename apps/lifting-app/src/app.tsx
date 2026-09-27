import { FetchHttpClient } from '@effect/platform'
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DateTime, Effect, Match, Option } from 'effect'
import type { RunAuthed } from 'fhir-r4-react'
import {
  buildSmartRouterContext,
  useLaunchFailureRedirect,
  useSmartHandshake,
} from 'fhir-r4-react/smart'
import type Client from 'fhirclient/lib/Client'
import { unknownErrorToString } from 'kitchen-sink'
import type { ExerciseAttempt, Plan } from 'lifting-core'
import type { StoredPlan } from 'lifting-core/fhir'
import { HistoryView, PlanEditor, ProgressionReview, TodayView } from 'lifting-react'
import { useMemo, useRef, useState, type JSX } from 'react'
import { ErrorBanner, GateCard, PageLoading, PartialBanner, SegmentedToggle } from 'react-tundraish'

import {
  type AttemptRecord,
  persistEveryResource,
  planResources,
  type PlanRecord,
  planWriteIdsFor,
  type PlanWriteIds,
  progressionResources,
  readAttemptRecord,
  readPlanRecord,
  sessionResources,
  sessionWriteIdsFor,
  type SessionWriteIds,
} from './lifting-record.ts'
import styles from './app.module.css'

/** The four views the header toggle switches between. */
type Tab = 'today' | 'progress' | 'plan' | 'history'

const tabOptions: readonly { value: Tab; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'progress', label: 'Progress' },
  { value: 'plan', label: 'Plan' },
  { value: 'history', label: 'History' },
]

/** `count` with the noun agreeing with it: `1 plan`, `2 plans`. */
const countOf = (count: number, singular: string, plural: string): string =>
  `${count} ${count === 1 ? singular : plural}`

/** A failed write as the line a lifting view shows in its error banner, or `null`. */
const writeErrorText = (error: Error | null): string | null =>
  error === null ? null : unknownErrorToString(error)

/** The app's one clock: a logged session's time, and a new plan's `created`. */
const now = (): DateTime.Utc => DateTime.unsafeNow()

/**
 * The notices for plans the plan read found but could not use — nothing on
 * the record is dropped without saying so.
 */
const PlanRecordNotices = ({ record }: { readonly record: PlanRecord }): JSX.Element => (
  <>
    {record.unreadablePlanCount > 0 && (
      <PartialBanner>
        {countOf(record.unreadablePlanCount, 'active plan', 'active plans')} on your record could
        not be read as a lifting plan and {record.unreadablePlanCount === 1 ? 'is' : 'are'} not
        shown.
      </PartialBanner>
    )}
    {record.otherPlanCount > 0 && (
      <PartialBanner>
        {countOf(record.otherPlanCount, 'other active lifting plan', 'other active lifting plans')}{' '}
        on your record {record.otherPlanCount === 1 ? 'is' : 'are'} not the one shown here.
      </PartialBanner>
    )}
    {record.droppedEntryCount > 0 && (
      <PartialBanner>
        {countOf(record.droppedEntryCount, 'plan or goal record', 'plan or goal records')} from the
        server could not be decoded and {record.droppedEntryCount === 1 ? 'was' : 'were'} skipped.
      </PartialBanner>
    )}
  </>
)

/** The notices for logged observations that did not read as attempts. */
const AttemptRecordNotices = ({ record }: { readonly record: AttemptRecord }): JSX.Element => (
  <>
    {record.unreadableCount > 0 && (
      <PartialBanner>
        {countOf(record.unreadableCount, 'logged attempt', 'logged attempts')} could not be read.
        The due workout and the progression are decided without{' '}
        {record.unreadableCount === 1 ? 'it' : 'them'}.
      </PartialBanner>
    )}
    {record.retractedCount > 0 && (
      <PartialBanner>
        {countOf(record.retractedCount, 'logged attempt was', 'logged attempts were')} retracted and{' '}
        {record.retractedCount === 1 ? 'is' : 'are'} not counted.
      </PartialBanner>
    )}
  </>
)

/** Props for {@link LiftingApp}. */
interface LiftingAppProps {
  /** The SMART client the plan and attempt searches are issued through. */
  readonly client: Client
  /** The launch's patient: every search is scoped to them and every write names them. */
  readonly patientId: string
  /** Runs a write against the FHIR server the handshake named, with the granted token. */
  readonly runAuthed: RunAuthed
}

/**
 * The lifting screens for one patient: the plan they follow and every attempt
 * logged against it, read off the server, under a **Today | Progress | Plan |
 * History** toggle, and the three writes those screens hand back.
 *
 * @remarks
 * Split from {@link App} so the whole tree can be driven in a test over a stub
 * transport: the handshake is the only part that needs a browser redirect.
 *
 * The app holds no lifting logic. Reads go through `fhir-r4-react/smart`'s
 * page readers and `lifting-core/fhir`'s readers ({@link readPlanRecord},
 * {@link readAttemptRecord}); each view is a `lifting-react` screen over plain
 * props; each write is the view's callback value through `lifting-core/fhir`'s
 * writers into one batch `Bundle` ({@link persistEveryResource}).
 *
 * Every write is a TanStack mutation that, once it settles — failed or not,
 * since a batch's entries land independently — invalidates this patient's
 * lifting queries and stays pending until they have refetched. There are no
 * optimistic cache edits, so what the views show is always what the server
 * holds. While any write is pending every view's controls are disabled, so two
 * writes never race; a failed write is shown in the view that made it, and a
 * retry of it writes under the same ids ({@link PlanWriteIds},
 * {@link SessionWriteIds}).
 */
const LiftingApp = ({ client, patientId, runAuthed }: LiftingAppProps): JSX.Element => {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>('today')

  const liftingQueryKey = ['lifting', patientId] as const
  const planRecord = useQuery({
    queryKey: [...liftingQueryKey, 'plan'],
    queryFn: () => Effect.runPromise(readPlanRecord(client, patientId)),
  })
  const stored = Option.getOrUndefined(
    Option.flatMap(Option.fromNullable(planRecord.data), (record) => record.current)
  )
  const carePlanId = stored?.carePlanId
  const attemptRecord = useQuery({
    queryKey: [...liftingQueryKey, 'attempts', carePlanId],
    queryFn:
      carePlanId === undefined
        ? skipToken
        : () => Effect.runPromise(readAttemptRecord(client, patientId, carePlanId)),
  })

  // Awaited in each mutation's `onSettled` — after a failure as well as a
  // success, because a batch's entries land independently and a partly
  // rejected write still changed the record — so a mutation stays pending until
  // the refetch lands and no view offers a control over stale data.
  const refetchLifting = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: liftingQueryKey })

  // The ids the save or session in progress writes under: made when the view
  // hands a value back, kept for a retry of the same save or session so a
  // partly landed write is completed in place, and dropped once it lands
  // whole. Refs, not state: they never change what renders.
  const planWrite = useRef<PlanWriteIds | null>(null)
  const sessionWrite = useRef<SessionWriteIds | null>(null)

  const savePlan = useMutation({
    mutationFn: ({ plan, ids }: { plan: Plan; ids: PlanWriteIds }) =>
      runAuthed(persistEveryResource(planResources(plan, ids, patientId))),
    onSuccess: () => {
      planWrite.current = null
      setTab('today')
    },
    onSettled: refetchLifting,
  })
  const logSession = useMutation({
    mutationFn: ({
      sessionAttempts,
      ids,
      liftedAgainst,
    }: {
      sessionAttempts: readonly ExerciseAttempt[]
      ids: SessionWriteIds
      liftedAgainst: StoredPlan
    }) =>
      runAuthed(
        Effect.flatMap(
          sessionResources(sessionAttempts, ids, liftedAgainst, patientId),
          persistEveryResource
        )
      ),
    onSuccess: () => {
      sessionWrite.current = null
      setTab('progress')
    },
    onSettled: refetchLifting,
  })
  const applyProgression = useMutation({
    mutationFn: ({ progressed, current }: { progressed: Plan; current: StoredPlan }) =>
      runAuthed(
        Effect.flatMap(progressionResources(progressed, current, patientId), persistEveryResource)
      ),
    onSettled: refetchLifting,
  })
  const writing = savePlan.isPending || logSession.isPending || applyProgression.isPending

  const planEditor = (
    <PlanEditor
      // Re-seeded when the stored plan it edits changes identity (a first save).
      key={carePlanId ?? 'new'}
      initial={stored?.plan ?? null}
      onSave={(plan) => {
        // A retry keeps the ids of the save it retries — unless the plan it
        // replaces is no longer the one those ids were made for.
        const retried = planWrite.current
        const ids =
          retried !== null && (stored === undefined || stored.carePlanId === retried.carePlanId)
            ? retried
            : planWriteIdsFor(stored, now())
        planWrite.current = ids
        savePlan.mutate({ plan, ids })
      }}
      pending={writing}
      error={writeErrorText(savePlan.error)}
    />
  )

  const noPlanGate = (
    <GateCard
      title="No lifting plan yet"
      body="Create a plan to start logging sessions — the plan editor can start you on StrongLifts 5×5."
      showSpinner={false}
      action={{
        label: 'Create a plan',
        onClick: () => {
          setTab('plan')
        },
      }}
    />
  )

  const viewFor = (current: StoredPlan, attempts: readonly ExerciseAttempt[]): JSX.Element =>
    Match.value(tab).pipe(
      Match.when('today', () => (
        <TodayView
          plan={current.plan}
          attempts={attempts}
          now={now}
          onLogSession={(sessionAttempts) => {
            // A retry of the same workout under the same plan keeps its ids.
            const workoutLabel = sessionAttempts[0]?.workoutLabel ?? ''
            const retried = sessionWrite.current
            const ids =
              retried !== null &&
              retried.carePlanId === current.carePlanId &&
              retried.workoutLabel === workoutLabel
                ? retried
                : sessionWriteIdsFor(current, workoutLabel)
            sessionWrite.current = ids
            logSession.mutate({ sessionAttempts, ids, liftedAgainst: current })
          }}
          pending={writing}
          error={writeErrorText(logSession.error)}
        />
      )),
      Match.when('progress', () => (
        <ProgressionReview
          plan={current.plan}
          attempts={attempts}
          onAccept={(progressed) => {
            applyProgression.mutate({ progressed, current })
          }}
          pending={writing}
          error={writeErrorText(applyProgression.error)}
        />
      )),
      Match.when('plan', () => planEditor),
      Match.when('history', () => <HistoryView plan={current.plan} attempts={attempts} />),
      Match.exhaustive
    )

  const body = ((): JSX.Element => {
    if (planRecord.isPending) return <PageLoading message="Loading your plan…" />
    if (planRecord.isError) return <ErrorBanner error={planRecord.error} />
    if (stored === undefined) return tab === 'plan' ? planEditor : noPlanGate
    if (tab === 'plan') return planEditor
    if (attemptRecord.isPending) return <PageLoading message="Loading your sessions…" />
    if (attemptRecord.isError) return <ErrorBanner error={attemptRecord.error} />
    return (
      <>
        <AttemptRecordNotices record={attemptRecord.data} />
        {viewFor(stored, attemptRecord.data.attempts)}
      </>
    )
  })()

  return (
    <>
      <header className={styles['header']}>
        <h1 className="text-heading-3">Lifting</h1>
        <div className={styles['controls']}>
          <SegmentedToggle value={tab} options={tabOptions} onChange={setTab} aria-label="View" />
        </div>
      </header>
      {planRecord.data !== undefined && <PlanRecordNotices record={planRecord.data} />}
      {body}
    </>
  )
}

/**
 * The redirect-target app: completes the SMART handshake, then mounts the
 * lifting screens for the patient the launch named.
 *
 * @remarks
 * **No router.** `apps/importer-web` builds a TanStack router only because
 * `importer-react` reads its authed runner out of route context;
 * `lifting-react`'s screens take plain props and callbacks and never read
 * route context, so this app takes the `runAuthed` that
 * `buildSmartRouterContext` returns and hands it to {@link LiftingApp}
 * directly. The context is still built by that one shared function, so the
 * auth-critical wiring (the FHIR-base prefix, the bearer header) is not
 * copied here.
 *
 * Reads go through the fhirclient `Client` the handshake yields (its
 * `request` already carries the token and the server base); writes go
 * through `runAuthed`, the typed client over plain `FetchHttpClient.layer` —
 * this app talks to exactly one host, the FHIR server the handshake named.
 *
 * A lifting plan is always some patient's, so a launch with no patient in
 * context stops at a gate saying so rather than guessing whose record to
 * read or write.
 */
const App = (): JSX.Element => {
  const queryClient = useQueryClient()
  const handshake = useSmartHandshake()
  // A failed exchange has nothing to retry here (the code is single-use), so
  // carry the reason to the app root, which can offer the connect menu.
  useLaunchFailureRedirect(handshake)

  const client = handshake.kind === 'ready' ? handshake.client : undefined
  // Memoised on the (stable) resolved client, so a re-render does not rebuild
  // the runtime underneath in-flight writes.
  const runAuthed = useMemo<RunAuthed | undefined>(
    () =>
      client === undefined
        ? undefined
        : buildSmartRouterContext(
            {
              serverUrl: client.state.serverUrl,
              accessToken: client.state.tokenResponse?.access_token,
            },
            FetchHttpClient.layer,
            queryClient
          ).runAuthed,
    [client, queryClient]
  )
  const patientId = client?.patient.id ?? null

  return (
    <main className={styles['app']}>
      {handshake.kind === 'connecting' && <PageLoading message="Connecting…" />}
      {handshake.kind === 'error' && <ErrorBanner error={handshake.error} />}
      {client !== undefined && patientId === null && (
        <GateCard
          title="Lifting needs a patient"
          body="This launch did not name a patient. A lifting plan is always someone's, so launch Lifting from a patient's record, or connect again and pick a patient."
          showSpinner={false}
        />
      )}
      {client !== undefined && patientId !== null && runAuthed !== undefined && (
        <LiftingApp client={client} patientId={patientId} runAuthed={runAuthed} />
      )}
    </main>
  )
}

export { App, LiftingApp, type LiftingAppProps }
