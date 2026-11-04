import { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import type { Option } from 'effect'
import { Effect, Schema } from 'effect'

import {
  BundleDecodeError,
  RESOURCE_PAGE_SIZE,
  ResourcePageRequestError,
  fetchResourcePage,
  type PagedResourceRead,
  type ResourcePage,
  type ResourcePageCursor,
} from './resource-page.ts'
import { SmartClient, type FhirRequestError } from './smart-client.ts'

/** The decoded FHIR R4 `Patient` resource. */
type PatientResource = Schema.Schema.Type<typeof Patient.Schema>

/**
 * One page of a `Patient` read: the decoded resources on this page and the
 * cursor to the next page (`null` when this is the last page).
 */
type PatientPage = ResourcePage<PatientResource>

/**
 * The cursor {@link fetchPatientPage} reads from. The read takes no first-page
 * input — every patient the session can see is in scope — so `{ first: null }`
 * opens it and `{ pageUrl }` continues it.
 */
type PatientPageCursor = ResourcePageCursor<null>

// Sorted by family name, server-side, so the picker's rows are in a stable,
// human-scannable order and scroll paging can append without reordering.
// `family` is the FHIR R4 `Patient` search parameter backing `name.family`.
const FIRST_PAGE_QUERY = `_sort=family&_count=${RESOURCE_PAGE_SIZE}`

/** The `Patient` read backing the patient picker. */
const patientRead: PagedResourceRead<
  PatientResource,
  Schema.Schema.Encoded<typeof Patient.Schema>,
  null
> = {
  resourceType: 'Patient',
  schema: Patient.Schema,
  firstPageQuery: (): string => FIRST_PAGE_QUERY,
}

/**
 * Fetch a single page of `Patient`s from the SMART FHIR server and report the
 * cursor to the next page.
 *
 * @param cursor - `{ first: null }` for the first page, or a previous page's `nextPageUrl`
 * @returns An effect yielding the page's decoded `Patient`s and the next page's cursor
 *
 * @remarks
 * This is the patient picker's read (`smart-app-react`'s `PatientPicker`):
 * every patient the session can see, for the user to choose whose records the
 * app reads. The one chosen is read directly with {@link fetchPatient}.
 */
const fetchPatientPage = (
  cursor: PatientPageCursor
): Effect.Effect<PatientPage, ResourcePageRequestError | BundleDecodeError, SmartClient> =>
  fetchResourcePage(patientRead, cursor)

/**
 * Whether a failed `SmartClient` request is the server answering that it holds no
 * such resource: 404 Not Found or 410 Gone.
 */
const isNoSuchResource = (cause: FhirRequestError): boolean =>
  cause._tag === 'FhirHttpError' && (cause.status === 404 || cause.status === 410)

/** Decode `resource` as a `Patient`, failing with what did not decode. */
const decodePatient = (resource: unknown): Effect.Effect<PatientResource, BundleDecodeError> =>
  Schema.decodeUnknown(Patient.Schema)(resource).pipe(
    Effect.mapError((cause) => new BundleDecodeError({ cause, response: resource }))
  )

/**
 * Read one `Patient` by id.
 *
 * @param id - The patient's logical id, e.g. the `launchPatientId` a launch put in context
 * @returns An effect yielding the decoded `Patient`, or `None` when the
 *          server answers 404 or 410
 *
 * @remarks
 * Every other failure surfaces through the error channel: a transport failure
 * or another HTTP status as {@link ResourcePageRequestError}, and an answer
 * that does not decode as a `Patient` as {@link BundleDecodeError}, as a page
 * reader reports an entry it cannot decode. "This server does not have that
 * patient" is the one answer a caller acts on rather than reports.
 */
const fetchPatient = (
  id: string
): Effect.Effect<
  Option.Option<PatientResource>,
  ResourcePageRequestError | BundleDecodeError,
  SmartClient
> =>
  SmartClient.pipe(
    Effect.flatMap((client) => client.request(`Patient/${encodeURIComponent(id)}`)),
    Effect.mapError((cause) => new ResourcePageRequestError({ cause })),
    Effect.flatMap(decodePatient),
    Effect.asSome,
    Effect.catchIf(
      (error) => error instanceof ResourcePageRequestError && isNoSuchResource(error.cause),
      () => Effect.succeedNone
    )
  )

export {
  fetchPatient,
  fetchPatientPage,
  type PatientPage,
  type PatientPageCursor,
  type PatientResource,
}
