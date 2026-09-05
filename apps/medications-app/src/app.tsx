import { skipToken, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  fetchMedicationRequestPage,
  type MedicationRequestCursor,
  useSmartHandshake,
} from 'fhir-r4-react/smart'
import { InteractionsView } from 'medication-interaction-react'
import {
  dedupeMedicationsByName,
  type Medication,
  type Province,
} from 'medication-sponsorship-core'
import {
  MedicationsView,
  medicationRequestsToMedicationViews,
  ProvincePicker,
} from 'medication-sponsorship-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SegmentedToggle } from 'react-tundraish'

import { catalogs } from './catalogs.ts'
import { getInteractionCatalog } from './interaction-catalog.ts'
import styles from './app.module.css'

/** The two views the header toggle switches between. */
type Tab = 'medications' | 'interactions'

const tabOptions: readonly { value: Tab; label: string }[] = [
  { value: 'medications', label: 'Medications' },
  { value: 'interactions', label: 'Interactions' },
]

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
 * MedicationRequests a page at a time, and renders them either as the
 * medications list (sponsorship chips, province filter) or as the
 * interactions report over the active ones, per the header toggle.
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
  const handshake = useSmartHandshake()
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
            fetchMedicationRequestPage(client, pageParam),
    initialPageParam: initialCursor,
    getNextPageParam: (lastPage): MedicationRequestCursor | undefined =>
      lastPage.nextPageUrl === null ? undefined : { pageUrl: lastPage.nextPageUrl },
  })

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = medications

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
  const hasPages = (medications.data?.pages.length ?? 0) > 0

  // The interactions panel waits on its catalog asset: a load failure and the
  // in-flight fetch each get their own line before the report can render.
  const interactionsPanel = ((): JSX.Element => {
    if (interactionCatalog.isError) {
      return (
        <p className={styles.error}>
          {interactionCatalog.error instanceof Error
            ? interactionCatalog.error.message
            : 'Could not load the interaction database.'}
        </p>
      )
    }
    if (interactionCatalog.data === undefined) {
      return <p className={styles.status}>Loading interaction database…</p>
    }
    return (
      <InteractionsView
        medications={interactionMedications}
        catalog={interactionCatalog.data}
        prescriberOf={prescriberOf}
      />
    )
  })()

  // Either leg can fail — the token exchange or the read that follows it. Surface
  // whichever did; loading covers both the exchange and the first page. A failure
  // while fetching a *later* page keeps the rows already loaded and shows an inline
  // line rather than discarding them.
  const body = ((): JSX.Element => {
    if (handshake.kind === 'error') return <ErrorLine error={handshake.error} />
    if (medications.isError && !hasPages) return <ErrorLine error={medications.error} />
    if (!hasPages) return <p className={styles.status}>Loading medications…</p>
    return (
      <>
        {tab === 'medications' ? (
          <MedicationsView medications={views} province={province} catalogs={catalogs} />
        ) : (
          interactionsPanel
        )}
        {isFetchingNextPage && <p className={styles.status}>Loading more…</p>}
        {medications.isFetchNextPageError && <ErrorLine error={medications.error} />}
        {hasNextPage && <div ref={sentinelRef} aria-hidden="true" />}
      </>
    )
  })()

  return (
    <main className={styles.app}>
      <header className={styles.header}>
        <h1 className="text-heading-3">Medications</h1>
        <div className={styles.controls}>
          <SegmentedToggle value={tab} options={tabOptions} onChange={setTab} aria-label="View" />
          {tab === 'medications' && <ProvincePicker value={province} onChange={setProvince} />}
        </div>
      </header>
      {body}
    </main>
  )
}
