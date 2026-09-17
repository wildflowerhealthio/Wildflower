import { Effect, type Option, Schema } from 'effect'
import { Patient } from 'fhir-r4/resources'
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

/** The `Patient` read backing the no-context picker. */
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
 * This is the picker's read: what a launch with no patient in context offers the
 * user to choose from. A launch that _does_ carry a patient reads that one
 * directly with {@link fetchPatient} instead.
 */
const fetchPatientPage = (
  client: Client,
  cursor: PatientPageCursor
): Effect.Effect<PatientPage, ResourcePageRequestError | BundleDecodeError> =>
  fetchResourcePage(client, patientRead, cursor)

/**
 * Read one `Patient` by id.
 *
 * @param client - The SMART client the read is issued through
 * @param id - The patient's logical id, e.g. the `client.patient.id` a launch put in context
 * @returns An effect yielding the decoded `Patient`, or `None` when the server's
 *          answer does not decode as one
 *
 * @remarks
 * Only a decode failure is reported as `None` — a transport or HTTP failure
 * surfaces through the error channel as {@link ResourcePageRequestError},
 * because "this server does not have that patient" and "this server sent
 * something this client cannot read" are different things for a caller to show.
 */
const fetchPatient = (
  client: Client,
  id: string
): Effect.Effect<Option.Option<PatientResource>, ResourcePageRequestError> =>
  Effect.tryPromise({
    try: () => client.request<unknown>(`Patient/${encodeURIComponent(id)}`),
    catch: (cause) => new ResourcePageRequestError({ cause }),
  }).pipe(Effect.map((resource) => decodePatient(resource)))

export {
  fetchPatient,
  fetchPatientPage,
  type PatientPage,
  type PatientPageCursor,
  type PatientResource,
}
