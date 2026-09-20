import { skipToken, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Effect, Match } from 'effect'
import {
  fetchMedicationRequestPage,
  type MedicationRequestCursor,
  useLaunchFailureRedirect,
  useSmartHandshake,
} from 'fhir-r4-react/smart'
import { CalendarView } from 'medication-calendar-react'
import { medicationRequestsToMedicationViews } from 'medication-core/fhir'
import { InteractionsView } from 'medication-interaction-react'
import {
  dedupeMedicationsByName,
  type Medication,
  type Province,
} from 'medication-sponsorship-core'
import { MedicationsView, SavingsView } from 'medication-sponsorship-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChunkBar,
  ErrorBanner,
  GateCard,
  PartialBanner,
  SegmentedToggle,
  type ChunkBarPhase,
} from 'react-tundraish'

import { catalogs } from './catalogs.ts'
import { getInteractionCatalog } from './interaction-catalog.ts'
import { pastEligibleMedications } from './past-medications.ts'
import styles from './app.module.css'

/** The four views the header toggle switches between. */
type Tab = 'medications' | 'calendar' | 'interactions' | 'savings'

const tabOptions: readonly { value: Tab; label: string }[] = [
  { value: 'medications', label: 'Medications' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'interactions', label: 'Interactions' },
  { value: 'savings', label: 'Savings' },
]

/** The chunk bar's copy — the generic component with this app's wording. */
const chunkBarLabels = {
  ariaIdle: (pages: number) => `${pages} pages of your medication list loaded so far`,
  ariaLoading: (pages: number) => `Loading your medication list — ${pages} pages in so far`,
  ariaLocked: 'Your full medication list is loaded',
  ariaError: (pages: number) =>
    `Loading paused after a failed page — ${pages} pages of your medication list in so far`,
  countSuffix: 'medication requests have been loaded.',
  lockedNote: 'That is all of them. Everything below is checked against the full list.',
  errorNote: 'A page of your medication list failed to load — the list is incomplete.',
  retry: 'Retry',
}

/**
 * `true` once `active` has held for `delayMs` — used to keep the interactions
 * gate from flashing when a short list finishes loading almost immediately.
 */
const useDelayedFlag = (active: boolean, delayMs: number): boolean => {
  const [passed, setPassed] = useState(false)
  // Both transitions go through the timer (deactivation at 0ms), so no
  // setState runs synchronously inside the effect.
  useEffect(() => {
    const timer = setTimeout(
      () => {
        setPassed(active)
      },
      active ? delayMs : 0
    )
    return () => {
      clearTimeout(timer)
    }
  }, [active, delayMs])
  return passed && active
}

/** The load-failure line, shown for a failed token exchange or a failed read. */
const ErrorLine = ({ error }: { readonly error: unknown }): JSX.Element => (
  <p className={styles.error}>
    Could not load medications: {error instanceof Error ? error.message : String(error)}
  </p>
)

// The first page is opened with no patient in context; `fetchMedicationRequestPage`
// then reads across every patient the granted scopes expose (see its `null` case).
const initialCursor: MedicationRequestCursor = { patientId: null }

/**
 * The redirect-target app: completes the SMART handshake, loads the patient's
 * MedicationRequests a page at a time, and renders them as one of four views
 * per the header toggle — the medications list, the prescription calendar,
 * the interactions report over the active ones (gated on the full list), or
 * the savings-program breakdown (province picker included). A chunk bar under
 * the H1 tracks the paged load on every view.
 *
 * @remarks
 * Both async legs are TanStack Queries on the page's shared client: the token
 * exchange (`useSmartHandshake`, keyed and deduped so StrictMode's double-mount
 * exchanges the single-use code once) and the paged MedicationRequest read that
 * follows it. The read is a `useInfiniteQuery` whose cursor is the server's
 * `next`-link URL; a bottom-of-list sentinel observed by an `IntersectionObserver`
 * pulls the next page as it scrolls into view, so pages load on demand instead of
 * all at once. The read is `skipToken`-gated on the handshake resolving, which
 * also narrows `client` to defined inside the query function — no non-null
 * assertion. Pages arrive newest-authored first (server `_sort`), so appending
 * each one never reorders rows already on screen.
 */
export const App = (): JSX.Element => {
  const [province, setProvince] = useState<Province>('ON')
  const [tab, setTab] = useState<Tab>('medications')
  // Drives the fetch-to-completion loop ("load all the rest"); set by the
  // chunk-bar tooltip, the paused gate, the partial banners, and automatically
  // on entering Interactions. Never unset: once the last page lands it is
  // inert (`hasNextPage` gates everything derived from it).
  const [loadAllActive, setLoadAllActive] = useState(false)
  // The interactions gate's escape hatch: stream sections as pages arrive.
  // Set once, never unset — on completion the page is simply finished.
  const [showPartial, setShowPartial] = useState(false)
  const handshake = useSmartHandshake()
  // A failed exchange has nothing to retry here (the code is single-use), so
  // carry the reason to the app root, which can offer the connect menu.
  useLaunchFailureRedirect(handshake)
  const client = handshake.kind === 'ready' ? handshake.client : undefined

  const medications = useInfiniteQuery({
    queryKey: ['medications'],
    // `pageParam` is annotated because the `skipToken` ternary blocks TanStack
    // from inferring the page-param type through it, which would otherwise narrow
    // it to only the first cursor variant.
    queryFn:
      client === undefined
        ? skipToken
        : ({ pageParam }: { readonly pageParam: MedicationRequestCursor }) =>
            Effect.runPromise(fetchMedicationRequestPage(client, pageParam)),
    initialPageParam: initialCursor,
    getNextPageParam: (lastPage): MedicationRequestCursor | undefined =>
      lastPage.nextPageUrl === null ? undefined : { pageUrl: lastPage.nextPageUrl },
  })

  const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = medications
  const pagesReceived = medications.data?.pages.length ?? 0

  // The "load all the rest" driver: while active, request the next page
  // whenever one isn't already in flight. An effect rather than a loop so it
  // rides React Query's in-flight dedupe (StrictMode-safe), and it halts on a
  // failed page instead of hammering it — retry is an explicit user action.
  // `pagesReceived` is a dependency deliberately: a page can land within a
  // single commit (never showing `isFetchingNextPage`), and the count is the
  // one input guaranteed to change per page, so the drive can't stall.
  //
  // Cancellation: the effect is not paired with a `cancelQueries` cleanup on
  // purpose. Such a cleanup would fire on StrictMode's dev double-mount and
  // abort the first page's own fetch, forcing a second one on remount — the
  // opposite of what dedup should give. The loop is bounded by
  // `hasNextPage` (the terminal page ends it) and `isFetchNextPageError` (a
  // failed page pauses it until an explicit retry), so it can't run away.
  // Hard abort of an in-flight page belongs on the queryFn's own `signal`
  // seam, i.e. in `fetchMedicationRequestPage`; wire it there when its
  // transport becomes signal-aware.
  useEffect(() => {
    if (
      loadAllActive &&
      pagesReceived > 0 &&
      hasNextPage &&
      !isFetchingNextPage &&
      !isFetchNextPageError
    ) {
      void fetchNextPage()
    }
  }, [
    loadAllActive,
    pagesReceived,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  ])

  const startLoadAll = useCallback(() => {
    setLoadAllActive(true)
    // A failed later-page fetch halts the driver and nothing else clears the
    // error, so `setLoadAllActive(true)` alone is inert when it is already set.
    // Kick the next fetch directly — React Query clears `isFetchNextPageError`
    // on a fresh attempt, which lets the driver effect resume from there.
    if (isFetchNextPageError) void fetchNextPage()
  }, [isFetchNextPageError, fetchNextPage])

  // Entering the Interactions tab starts the full fetch automatically — the
  // report cannot be computed from a partial list, so the user never has to
  // ask for it there. The other tabs render from whatever pages are loaded.
  const selectTab = useCallback((next: Tab) => {
    setTab(next)
    if (next === 'interactions') setLoadAllActive(true)
  }, [])

  // Auto-load the next page when the bottom sentinel scrolls into view. The
  // effect only builds an observer while there is a next page, so a fully-loaded
  // (or gated) list never touches `IntersectionObserver`.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = sentinelRef.current
    if (node === null || !hasNextPage) return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
        void fetchNextPage()
      }
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  // `data` (and its `pages`) keeps a stable reference between renders unless a
  // page is added, so the mapping only re-runs when the loaded set actually grows.
  const views = useMemo(
    () =>
      medicationRequestsToMedicationViews(
        (medications.data?.pages ?? []).flatMap((page) => page.items)
      ),
    [medications.data]
  )
  // Interactions are checked over what the patient currently takes.
  const activeMedications = useMemo(
    () => views.flatMap((view) => (view.medication.status === 'active' ? [view.medication] : [])),
    [views]
  )
  // The interactions report collapses duplicate names to the most recent
  // prescription; scoped here so the rest of the app keeps the full active list.
  const interactionMedications = useMemo(
    () => dedupeMedicationsByName(activeMedications),
    [activeMedications]
  )
  // Completed prescriptions still eligible for a savings program, shown below
  // the active rows there (see {@link pastEligibleMedications}).
  const pastMedications = useMemo(() => pastEligibleMedications(views), [views])
  // Prescriber (requester) display name per medication id, for the avatars the
  // interactions view shows between the patient's own medications.
  const prescriberById = useMemo(() => {
    const map = new Map<string, string>()
    for (const view of views) {
      if (view.requester !== null) map.set(view.medication.id, view.requester)
    }
    return map
  }, [views])
  const prescriberOf = useCallback(
    (medication: Medication): string | null => prescriberById.get(medication.id) ?? null,
    [prescriberById]
  )
  // The interaction catalog is a ~2 MB asset fetched (and decoded once) only
  // when the Interactions tab is first opened — `enabled` keeps it off the
  // Medications-tab path entirely, and it never goes stale within a session.
  const interactionCatalog = useQuery({
    queryKey: ['interaction-catalog'],
    queryFn: getInteractionCatalog,
    enabled: tab === 'interactions',
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  })
  const hasPages = pagesReceived > 0
  const listComplete = hasPages && !hasNextPage
  // `loading` covers both the scroll-triggered page pull and the driven
  // fetch-to-completion; the extra breathing block tracks either. A failed
  // page drops the bar back to idle — nothing is in flight until the retry.
  const barPhase: ChunkBarPhase = Match.value({
    listComplete,
    isFetchNextPageError,
    isFetchingNextPage,
    loadAllActive,
  }).pipe(
    Match.when({ listComplete: true }, (): ChunkBarPhase => 'locked'),
    Match.when({ isFetchNextPageError: true }, (): ChunkBarPhase => 'error'),
    Match.when({ isFetchingNextPage: true }, (): ChunkBarPhase => 'loading'),
    Match.when({ loadAllActive: true }, (): ChunkBarPhase => 'loading'),
    Match.orElse((): ChunkBarPhase => 'idle')
  )

  // The interactions body gates on the *full* medication list — a missing
  // medication means a missing interaction — then on the catalog asset. The
  // gate is suppressed for its first 400ms so a short list never flashes it.
  // Each arm names the fields it depends on as a partial-object pattern;
  // earlier arms win, so the order is priority order.
  const gated = !listComplete && !showPartial
  const gateVisible = useDelayedFlag(gated && tab === 'interactions', 400)
  const interactionsPanel = Match.value({
    catalogError: interactionCatalog.isError,
    catalogData: interactionCatalog.data,
    gated,
    gateVisible,
    isFetchNextPageError,
    barPhase,
  }).pipe(
    Match.when({ catalogError: true }, (): JSX.Element => (
      <p className={styles.error}>
        {interactionCatalog.error instanceof Error
          ? interactionCatalog.error.message
          : 'Could not load the interaction database.'}
      </p>
    )),
    Match.when({ gated: true, gateVisible: false }, (): JSX.Element | null => null),
    Match.when({ gated: true, isFetchNextPageError: true }, (): JSX.Element => (
      <GateCard
        title="Couldn't load part of your list"
        body="A page of your medication list failed to load. Interactions stay paused until it arrives — retrying re-requests just that page."
        showSpinner={false}
        action={{ label: 'Retry', onClick: startLoadAll }}
      />
    )),
    Match.when({ gated: true, barPhase: 'loading' as const }, (): JSX.Element => (
      <GateCard
        title="Waiting for your full medication list"
        body="Interactions are checked against every medication at once — a partial list could miss one."
        action={{
          label: 'Show me it live as it loads anyway',
          onClick: () => {
            setShowPartial(true)
          },
        }}
      />
    )),
    Match.when({ gated: true }, (): JSX.Element => (
      <GateCard
        title="Only part of your medication list is loaded"
        body="Interactions are checked against every medication at once — a partial list could miss one."
        showSpinner={false}
        action={{ label: 'Load the rest of my medications', onClick: startLoadAll }}
      />
    )),
    Match.when(
      // The catalog usually resolves long before the medication list; this
      // covers the rare visit where the list finishes (or goes partial) first.
      { catalogData: undefined },
      (): JSX.Element => (
        <GateCard
          title="Preparing the interaction checker"
          body="Loading the interaction database — a one-time download for this visit."
        />
      )
    ),
    Match.when({ catalogData: Match.defined }, ({ catalogData }): JSX.Element => (
      <>
        {showPartial &&
          !listComplete &&
          (isFetchNextPageError ? (
            // The stream driver has halted on a failed page: say so and
            // offer a retry, rather than claiming it is "still loading"
            // indefinitely.
            <PartialBanner action={{ label: 'Retry', onClick: startLoadAll }}>
              A page of your medication list failed to load. Interactions with the medications that
              haven't loaded yet are missing.
            </PartialBanner>
          ) : (
            <PartialBanner>
              Partial list — still loading. Interactions with medications that haven't loaded yet
              are missing.
            </PartialBanner>
          ))}
        <InteractionsView
          medications={interactionMedications}
          catalog={catalogData}
          prescriberOf={prescriberOf}
        />
      </>
    )),
    Match.exhaustive
  )

  // Calendar and Savings render from the pages loaded so far; while the list
  // is incomplete they carry the amber banner with the load-everything action.
  // A failed later-page fetch is surfaced here too (these tabs have no inline
  // error line of their own), with a retry in place of "load them all?".
  const partialBanner: {
    readonly message: string
    readonly action?: { readonly label: string; readonly onClick: () => void }
  } = Match.value({ isFetchNextPageError, barPhase }).pipe(
    Match.when({ isFetchNextPageError: true }, () => ({
      message:
        'A page of your medication list failed to load — this list is missing some of your medications.',
      action: { label: 'Retry', onClick: startLoadAll },
    })),
    Match.when({ barPhase: 'loading' as const }, () => ({
      message: 'Loading the rest of your medications…',
    })),
    Match.orElse(() => ({
      message: `This list is loaded from your ${views.length} most recent medication requests,`,
      action: { label: 'load them all?', onClick: startLoadAll },
    }))
  )
  const partialListBanner = !listComplete && (
    <PartialBanner action={partialBanner.action}>{partialBanner.message}</PartialBanner>
  )

  // Either leg can fail — the token exchange or the read that follows it. Surface
  // whichever did; loading covers both the exchange and the first page. A failure
  // while fetching a *later* page keeps the rows already loaded and shows an inline
  // line rather than discarding them. Each arm matches on the packed control
  // fields; earlier arms win, so order is priority order.
  const body = Match.value({
    handshakeError: handshake.kind === 'error' ? handshake.error : undefined,
    firstPageError: medications.isError && !hasPages ? medications.error : undefined,
    hasPages,
    tab,
  }).pipe(
    Match.when({ handshakeError: Match.defined }, ({ handshakeError }): JSX.Element => (
      <ErrorBanner error={handshakeError} />
    )),
    Match.when({ firstPageError: Match.defined }, ({ firstPageError }): JSX.Element => (
      <ErrorLine error={firstPageError} />
    )),
    Match.when({ hasPages: false }, (): JSX.Element => (
      <p className={styles.status}>Loading medications…</p>
    )),
    Match.when({ tab: 'medications' as const }, (): JSX.Element => (
      <>
        <MedicationsView medications={views} />
        {isFetchingNextPage && <p className={styles.status}>Loading more…</p>}
        {medications.isFetchNextPageError && <ErrorLine error={medications.error} />}
        {hasNextPage && <div ref={sentinelRef} aria-hidden="true" />}
      </>
    )),
    Match.when({ tab: 'calendar' as const }, (): JSX.Element => (
      <>
        {partialListBanner}
        <CalendarView medications={views} />
      </>
    )),
    Match.when({ tab: 'savings' as const }, (): JSX.Element => (
      <>
        {partialListBanner}
        {/* The same deduplicated active list the interactions report
         * checks, so the two pages agree on what "your medications" means. */}
        <SavingsView
          medications={interactionMedications}
          pastMedications={pastMedications}
          province={province}
          onProvinceChange={setProvince}
          catalogs={catalogs}
        />
      </>
    )),
    Match.orElse((): JSX.Element | null => interactionsPanel)
  )

  return (
    <main className={styles.app}>
      <header className={styles.header}>
        <div className={styles.topRow}>
          <h1 className="text-heading-3">Medications</h1>
          <div className={styles.controls}>
            <SegmentedToggle
              value={tab}
              options={tabOptions}
              onChange={selectTab}
              aria-label="View"
            />
          </div>
        </div>
        <ChunkBar
          phase={barPhase}
          pagesReceived={pagesReceived}
          loadedCount={views.length}
          onLoadAll={startLoadAll}
          labels={chunkBarLabels}
        />
      </header>
      {body}
    </main>
  )
}
