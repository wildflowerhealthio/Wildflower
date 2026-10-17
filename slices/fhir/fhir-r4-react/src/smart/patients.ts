import { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Option, Schema } from 'effect'
import type Client from 'fhirclient/lib/Client'

import {
  RESOURCE_PAGE_SIZE,
  ResourcePageRequestError,
  type BundleDecodeError,
  fetchResourcePage,
  type PagedResourceRead,
  type ResourcePage,
  type ResourcePageCursor,
} from './resource-page.ts'

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

const decodePatient = Schema.decodeUnknownOption(Patient.Schema)

/**
 * Fetch a single page of `Patient`s from the SMART FHIR server and report the
 * cursor to the next page.
 *
 * @param client - The SMART client the search is issued through
 * @param cursor - `{ first: null }` for the first page, or a previous page's `nextPageUrl`
 * @returns An effect yielding the page's decoded `Patient`s and the next page's cursor
 *
 * @remarks
 * This is the patient picker's read (`smart-app-react`'s `PatientPicker`):
 * every patient the session can see, for the user to choose whose records the
 * app reads. The one chosen is read directly with {@link fetchPatient}.
 */
const fetchPatientPage = (
  client: Client,
  cursor: PatientPageCursor
): Effect.Effect<PatientPage, ResourcePageRequestError | BundleDecodeError> =>
  fetchResourcePage(client, patientRead, cursor)

/**
 * What a read of one `Patient` by id found: the patient, an answer that does
 * not decode as one, or the server saying it holds no patient under that id.
 */
type PatientRead =
  | { readonly kind: 'found'; readonly patient: PatientResource }
  | { readonly kind: 'not-a-patient' }
  | { readonly kind: 'missing' }

/**
 * Whether a rejected `client.request` is the server answering that it holds no
 * such resource: fhirclient's `HttpError` with status 404 Not Found or 410
 * Gone.
 */
const isNoSuchResource = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'status' in cause &&
  (cause.status === 404 || cause.status === 410)

/**
 * Read one `Patient` by id.
 *
 * @param client - The SMART client the read is issued through
 * @param id - The patient's logical id, e.g. the `client.patient.id` a launch put in context
 * @returns An effect yielding the decoded `Patient` (`found`), `not-a-patient`
 *          when the server's answer does not decode as one, or `missing` when
 *          the server answers 404 or 410
 *
 * @remarks
 * Every other failure, a transport failure or another HTTP status, surfaces
 * through the error channel as {@link ResourcePageRequestError}: "this server
 * does not have that patient", "this server sent something this client cannot
 * read" and "the read failed" are different things for a caller to show.
 */
const fetchPatient = (
  client: Client,
  id: string
): Effect.Effect<PatientRead, ResourcePageRequestError> =>
  Effect.tryPromise({
    try: () => client.request<unknown>(`Patient/${encodeURIComponent(id)}`),
    catch: (cause) => new ResourcePageRequestError({ cause }),
  }).pipe(
    Effect.map((resource) =>
      Option.match(decodePatient(resource), {
        onNone: (): PatientRead => ({ kind: 'not-a-patient' }),
        onSome: (patient): PatientRead => ({ kind: 'found', patient }),
      })
    ),
    Effect.catchIf(
      ({ cause }) => isNoSuchResource(cause),
      () => Effect.succeed<PatientRead>({ kind: 'missing' })
    )
  )

export {
  fetchPatient,
  fetchPatientPage,
  type PatientPage,
  type PatientPageCursor,
  type PatientRead,
  type PatientResource,
}
