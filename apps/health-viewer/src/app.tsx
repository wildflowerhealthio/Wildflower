import { skipToken, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { DateTime, Effect, Match, Option } from 'effect'
import {
  fetchMedicationRequestPage,
  fetchObservationPage,
  fetchPatient,
  type MedicationRequestCursor,
  type ObservationPageCursor,
  useLaunchFailureRedirect,
  useSmartHandshake,
} from 'fhir-r4-react/smart'
import { type RangePreset, groupForPanel, readRecord, xDomain } from 'health-viewer-core'
import { Series, ValueAxis } from 'health-viewer-fundamentals'
import { HealthViewerLayout, MultiAxisChart, RangePresets, SeriesPanel } from 'health-viewer-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ErrorBanner } from 'react-tundraish'

import { patientLineOf } from './patient-line.ts'
import { PatientPicker, type SmartClient } from './patient-picker.tsx'
import { useUrlSelection } from './use-url-selection.ts'
import styles from './app.module.css'

/** A failed read, as one line: what could not be loaded, and why. */
const ErrorLine = ({
  subject,
  error,
}: {
  readonly subject: string
  readonly error: unknown
}): JSX.Element => (
  <p className={styles.error}>
    Could not load {subject}: {error instanceof Error ? error.message : String(error)}
  </p>
)

/** `amount` with its noun, pluralised with a plain `s`. */
const formatCount = (amount: number, noun: string): string =>
  `${amount} ${amount === 1 ? noun : `${noun}s`}`

/** What an infinite query tells the page-draining effect. */
interface PagedQueryProgress {
  readonly pagesReceived: number
  readonly hasNextPage: boolean
  readonly isFetchingNextPage: boolean
  readonly isFetchNextPageError: boolean
  readonly fetchNextPage: () => Promise<unknown>
}

/**
 * Keep requesting a paged read's next page until its last one lands, so the
 * whole record loads up front with no scroll sentinel.
 *
 * @remarks
 * The medications app's "load all the rest" driver, always on: an effect
 * rather than a loop so it rides React Query's in-flight dedupe (StrictMode
 * safe), halting on a failed page instead of hammering it. `pagesReceived` is
 * a dependency because a page can land within a single commit, never showing
 * `isFetchingNextPage`, and the count is the one input guaranteed to change
 * per page.
 */
const useFetchEveryPage = ({
  pagesReceived,
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError,
  fetchNextPage,
}: PagedQueryProgress): void => {
  useEffect(() => {
    if (pagesReceived > 0 && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      void fetchNextPage()
    }
  }, [pagesReceived, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage])
}

/** The patient's name and birth date under the page title, from one `Patient` read. */
const PatientLine = ({
  client,
  patientId,
}: {
  readonly client: SmartClient
  readonly patientId: string
}): JSX.Element | null => {
  const patient = useQuery({
    queryKey: ['patient', patientId],
    queryFn: () => Effect.runPromise(fetchPatient(client, patientId)),
  })
  if (patient.isError) return <ErrorLine subject="the patient" error={patient.error} />
  if (patient.data === undefined) return null
  if (Option.isNone(patient.data)) {
    return <p className={styles.error}>Could not read patient {patientId}: not a FHIR Patient</p>
  }
  return <p className={styles.patient}>{patientLineOf(patient.data.value)}</p>
}

/**
 * The redirect-target app: completes the SMART handshake, settles on a
 * patient, loads every one of their Observations and MedicationRequests, and
 * plots the series the reader selects on one time axis.
 *
 * @remarks
 * The patient is the launch's (`client.patient.id`) or, with none in
 * context, the URL's `?patient=`; with neither the page is a patient picker.
 *
 * Both reads are `useInfiniteQuery`s on the shell's client, `skipToken`-gated
 * on the handshake and the patient, each drained by {@link useFetchEveryPage}
 * so the two kinds page concurrently and the chart re-renders as pages land.
 * `health-viewer-core`'s `readRecord` turns what has landed into series, and
 * the page only composes: `groupForPanel` for the panel, `ValueAxis.assign`
 * for the chart's axes, `xDomain` for its window.
 *
 * The selection lives only in the URL ({@link useUrlSelection}); every change
 * — a series, a range, a pick — is an updater over the latest selection, so
 * changes made in one tick compose. Once both reads have finished paging,
 * selected ids this record holds no series for — a link shared from another
 * patient's record — are dropped from the selection and the URL; not before,
 * or a series on a later page would be lost.
 */
export const App = (): JSX.Element => {
  const handshake = useSmartHandshake()
  // A failed exchange has nothing to retry here (the code is single-use), so
  // carry the reason to the app root, which can offer the connect menu.
  useLaunchFailureRedirect(handshake)
  const client = handshake.kind === 'ready' ? handshake.client : undefined

  const { selection, updateSelection } = useUrlSelection()
  // The instant the page opened: the right edge of every bounded range, held
  // still so the chart's window does not move on each render.
  const [openedAt] = useState(() => DateTime.unsafeNow())

  const patientId = client?.patient.id ?? selection.patient

  const observations = useInfiniteQuery({
    queryKey: ['observations', patientId],
    // `pageParam` is annotated because the `skipToken` ternary blocks TanStack
    // from inferring the page-param type through it.
    queryFn:
      client === undefined || patientId === null
        ? skipToken
        : ({ pageParam }: { readonly pageParam: ObservationPageCursor }) =>
            Effect.runPromise(fetchObservationPage(client, pageParam)),
    initialPageParam: { first: patientId } satisfies ObservationPageCursor,
    getNextPageParam: (lastPage): ObservationPageCursor | undefined =>
      lastPage.nextPageUrl === null ? undefined : { pageUrl: lastPage.nextPageUrl },
  })

  const medicationRequests = useInfiniteQuery({
    queryKey: ['medication-requests', patientId],
    queryFn:
      client === undefined || patientId === null
        ? skipToken
        : ({ pageParam }: { readonly pageParam: MedicationRequestCursor }) =>
            Effect.runPromise(fetchMedicationRequestPage(client, pageParam)),
    initialPageParam: { patientId } satisfies MedicationRequestCursor,
    getNextPageParam: (lastPage): MedicationRequestCursor | undefined =>
      lastPage.nextPageUrl === null ? undefined : { pageUrl: lastPage.nextPageUrl },
  })

  useFetchEveryPage({
    pagesReceived: observations.data?.pages.length ?? 0,
    hasNextPage: observations.hasNextPage,
    isFetchingNextPage: observations.isFetchingNextPage,
    isFetchNextPageError: observations.isFetchNextPageError,
    fetchNextPage: observations.fetchNextPage,
  })
  useFetchEveryPage({
    pagesReceived: medicationRequests.data?.pages.length ?? 0,
    hasNextPage: medicationRequests.hasNextPage,
    isFetchingNextPage: medicationRequests.isFetchingNextPage,
    isFetchNextPageError: medicationRequests.isFetchNextPageError,
    fetchNextPage: medicationRequests.fetchNextPage,
  })

  // `data` keeps a stable reference until a page is added, so the record is
  // re-read only when what has landed grows.
  const recordReading = useMemo(
    () =>
      readRecord({
        observations: (observations.data?.pages ?? []).flatMap((page) => page.items),
        medicationRequests: (medicationRequests.data?.pages ?? []).flatMap((page) => page.items),
      }),
    [observations.data, medicationRequests.data]
  )
  // Entries a page carried that did not decode — an Observation that is not
  // one, a MedicationRequest without its `id` — counted beside what the
  // sources could not read, so nothing leaves the chart unmentioned.
  const undecodedEntryCount = useMemo(
    () =>
      [...(observations.data?.pages ?? []), ...(medicationRequests.data?.pages ?? [])].reduce(
        (total, page) => total + page.droppedEntryCount,
        0
      ),
    [observations.data, medicationRequests.data]
  )
  const catalogGroups = useMemo(() => groupForPanel(recordReading.filed), [recordReading])
  const seriesById = useMemo(
    () => new Map(recordReading.filed.map(({ series }) => [series.id, series])),
    [recordReading]
  )

  const recordIsComplete =
    observations.data !== undefined &&
    medicationRequests.data !== undefined &&
    !observations.hasNextPage &&
    !medicationRequests.hasNextPage

  // Once the record is whole, drop selected ids it holds no series for. An
  // updater over the latest selection that returns it unchanged when nothing
  // is dropped, so it re-renders and writes the URL only when it must.
  useEffect(() => {
    if (!recordIsComplete) return
    updateSelection((latestSelection) => {
      const heldSeriesIds = latestSelection.series.filter((seriesId) => seriesById.has(seriesId))
      return heldSeriesIds.length === latestSelection.series.length
        ? latestSelection
        : { ...latestSelection, series: heldSeriesIds }
    })
  }, [recordIsComplete, seriesById, updateSelection])

  const selectedSeries = useMemo(
    () =>
      selection.series.flatMap((seriesId) => {
        const series = seriesById.get(seriesId)
        return series === undefined ? [] : [series]
      }),
    [selection.series, seriesById]
  )
  const axes = useMemo(() => ValueAxis.assign(selectedSeries), [selectedSeries])
  const chartTimeDomain = useMemo(
    () => xDomain(selection.range, openedAt, Series.extentOfAll(selectedSeries)),
    [selection.range, openedAt, selectedSeries]
  )

  const changeSelectedSeries = useCallback(
    (selectedSeriesIds: readonly string[]) => {
      updateSelection((latestSelection) => ({ ...latestSelection, series: selectedSeriesIds }))
    },
    [updateSelection]
  )
  const changeRange = useCallback(
    (range: RangePreset) => {
      updateSelection((latestSelection) => ({ ...latestSelection, range }))
    },
    [updateSelection]
  )
  const pickPatient = useCallback(
    (pickedPatientId: string) => {
      updateSelection((latestSelection) => ({ ...latestSelection, patient: pickedPatientId }))
    },
    [updateSelection]
  )

  const observationsArePaging = observations.hasNextPage && !observations.isFetchNextPageError
  const medicationRequestsArePaging =
    medicationRequests.hasNextPage && !medicationRequests.isFetchNextPageError
  const statusLines = [
    ...(observationsArePaging || medicationRequestsArePaging
      ? [
          <p key="paging" className={styles.status}>
            Loading more…
          </p>,
        ]
      : []),
    ...(observations.isFetchNextPageError
      ? [<ErrorLine key="observations" subject="observations" error={observations.error} />]
      : []),
    ...(medicationRequests.isFetchNextPageError
      ? [
          <ErrorLine
            key="medication-requests"
            subject="medication requests"
            error={medicationRequests.error}
          />,
        ]
      : []),
  ]

  const unreadableCount = recordReading.dropped + undecodedEntryCount
  const leftOutNotes = [
    ...(recordReading.undated > 0
      ? [`${formatCount(recordReading.undated, 'undated record')} skipped`]
      : []),
    ...(unreadableCount > 0 ? [`${formatCount(unreadableCount, 'record')} couldn't be read`] : []),
  ]

  // Each arm matches on the packed control fields; earlier arms win, so the
  // order is priority order. A failed first page of either read replaces the
  // body; a failed later page is an inline line that keeps every row loaded.
  const body = Match.value({
    handshake,
    patientId,
    firstPageFailure: Match.value({
      observationsError:
        observations.isError && observations.data === undefined ? observations.error : undefined,
      medicationRequestsError:
        medicationRequests.isError && medicationRequests.data === undefined
          ? medicationRequests.error
          : undefined,
    }).pipe(
      Match.when({ observationsError: Match.defined }, ({ observationsError }) => (
        <ErrorLine subject="observations" error={observationsError} />
      )),
      Match.when({ medicationRequestsError: Match.defined }, ({ medicationRequestsError }) => (
        <ErrorLine subject="medication requests" error={medicationRequestsError} />
      )),
      Match.orElse(() => undefined)
    ),
    firstPagesLanded: observations.data !== undefined && medicationRequests.data !== undefined,
  }).pipe(
    Match.when({ handshake: { kind: 'error' } }, ({ handshake: { error } }) => (
      <ErrorBanner error={error} />
    )),
    Match.when({ handshake: { kind: 'connecting' } }, () => (
      <p className={styles.status}>Loading…</p>
    )),
    Match.when(
      { handshake: { kind: 'ready' }, patientId: Match.null },
      ({ handshake: { client: readyClient } }) => (
        <PatientPicker client={readyClient} onPatientPick={pickPatient} />
      )
    ),
    Match.when({ firstPageFailure: Match.defined }, ({ firstPageFailure }) => firstPageFailure),
    Match.when({ firstPagesLanded: false }, () => <p className={styles.status}>Loading…</p>),
    Match.orElse(() => (
      <HealthViewerLayout
        seriesPanel={
          <SeriesPanel
            catalogGroups={catalogGroups}
            selectedSeriesIds={selection.series}
            onSelectionChange={changeSelectedSeries}
          />
        }
        selectedSeriesCount={selection.series.length}
        rangePresets={
          <RangePresets selectedPreset={selection.range} onPresetChange={changeRange} />
        }
        status={statusLines.length === 0 ? null : statusLines}
      >
        <MultiAxisChart axes={axes} xDomain={chartTimeDomain} />
        {leftOutNotes.length > 0 && <p className={styles.note}>{leftOutNotes.join(' · ')}</p>}
      </HealthViewerLayout>
    ))
  )

  return (
    <main className={styles.app}>
      <header className={styles.header}>
        <h1 className="text-heading-3">Synthesized Health Viewer</h1>
        {client !== undefined && patientId !== null && (
          <PatientLine client={client} patientId={patientId} />
        )}
      </header>
      {body}
    </main>
  )
}
