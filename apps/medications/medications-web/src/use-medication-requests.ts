import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  skipToken,
  useInfiniteQuery,
} from '@tanstack/react-query'
import {
  fetchMedicationRequestPage,
  type MedicationRequestCursor,
  type MedicationRequestPage,
  type SmartHandshake,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  type MedicationView,
  medicationRequestsToMedicationViews,
} from '@wildflowerhealthio/medication-core/fhir'
import { useFetchEveryPage } from '@wildflowerhealthio/react-kitchen-sink'
import {
  type PatientChoice,
  patientChoiceKeyOf,
  patientScopeOf,
} from '@wildflowerhealthio/smart-app-react'
import { Effect, Option } from 'effect'
import { useMemo } from 'react'

/** The SMART client a completed handshake hands the app. */
type SmartClient = Extract<SmartHandshake, { readonly kind: 'ready' }>['client']

/** What {@link useMedicationRequests} hands the page. */
interface MedicationRequestRead {
  /** The paged read itself: its pages, paging flags and `fetchNextPage`. */
  readonly pagedQuery: UseInfiniteQueryResult<InfiniteData<MedicationRequestPage>>
  /** Every request landed so far, as a view, in server order. */
  readonly views: readonly MedicationView[]
}

/** Options for {@link useMedicationRequests}. */
interface MedicationRequestReadOptions {
  /** Whether to keep fetching until the last page lands ("load all the rest"). */
  readonly loadAll: boolean
}

/**
 * The paged MedicationRequest read, and what has landed as views.
 *
 * @param client - The SMART client, or `undefined` until the handshake completes.
 * @param patientChoice - Whose requests to read — one patient's, filtered
 *   with `patient=`, or every patient's, unscoped — or `None` while the
 *   reader is choosing.
 * @param options - {@link MedicationRequestReadOptions}.
 * @returns The read and its views.
 *
 * @remarks
 * A `useInfiniteQuery` keyed on the patient chosen, whose first cursor is its
 * scope and every later one the server's `next`-link URL, `skipToken`-gated
 * on the handshake resolving and a patient being chosen, which also narrows
 * `client` to defined inside the query function — no non-null assertion.
 * Pages arrive newest-authored first (server `_sort`), so appending each one
 * never reorders rows already on screen. While `loadAll` holds, `react-kitchen-sink`'s
 * `useFetchEveryPage` requests each next page until the last lands, halting on
 * a failed page — retry is an explicit user action, after which it resumes.
 * Otherwise pages load on demand (the page's scroll sentinel).
 */
const useMedicationRequests = (
  client: SmartClient | undefined,
  patientChoice: Option.Option<PatientChoice>,
  { loadAll }: MedicationRequestReadOptions
): MedicationRequestRead => {
  // The read runs only once a patient is chosen (`skipToken` below); until then
  // it is keyed apart from every choice, and its first cursor is never read.
  const chosenPatientKey = Option.getOrNull(Option.map(patientChoice, patientChoiceKeyOf))
  const firstPageCursor: MedicationRequestCursor = {
    patientId: Option.match(patientChoice, { onNone: () => null, onSome: patientScopeOf }),
  }
  const pagedQuery = useInfiniteQuery({
    queryKey: ['medications', chosenPatientKey],
    // `pageParam` is annotated because the `skipToken` ternary blocks TanStack
    // from inferring the page-param type through it, which would otherwise narrow
    // it to only the first cursor variant.
    queryFn:
      client === undefined || Option.isNone(patientChoice)
        ? skipToken
        : ({ pageParam }: { readonly pageParam: MedicationRequestCursor }) =>
            Effect.runPromise(fetchMedicationRequestPage(client, pageParam)),
    initialPageParam: firstPageCursor,
    getNextPageParam: (lastPage): MedicationRequestCursor | undefined =>
      lastPage.nextPageUrl === null ? undefined : { pageUrl: lastPage.nextPageUrl },
  })
  useFetchEveryPage(pagedQuery, { enabled: loadAll })

  // `data` (and its `pages`) keeps a stable reference between renders unless a
  // page is added, so the mapping only re-runs when the loaded set actually grows.
  const pages = pagedQuery.data?.pages
  const views = useMemo(
    () => medicationRequestsToMedicationViews((pages ?? []).flatMap((page) => page.items)),
    [pages]
  )
  return { pagedQuery, views }
}

export { useMedicationRequests, type MedicationRequestRead, type MedicationRequestReadOptions }
