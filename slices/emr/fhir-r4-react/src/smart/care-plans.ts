import type { Effect, Schema } from 'effect'
import { CarePlan } from 'fhir-r4/resources'
import type Client from 'fhirclient/lib/Client'

import {
  RESOURCE_PAGE_SIZE,
  type BundleDecodeError,
  type ResourcePageRequestError,
  fetchResourcePage,
  type PagedResourceRead,
  type ResourcePage,
  type ResourcePageCursor,
} from './resource-page.ts'

/** The decoded FHIR R4 `CarePlan` resource. */
type CarePlanResource = Schema.Schema.Type<typeof CarePlan.Schema>

/**
 * One page of a `CarePlan` read: the decoded resources on this page and the
 * cursor to the next page (`null` when this is the last page).
 */
type CarePlanPage = ResourcePage<CarePlanResource>

/** The first-page input for {@link fetchCarePlanPage}. */
interface CarePlanFirstPage {
  /** The patient the search is scoped to — the id the caller read off `client.patient.id`. */
  readonly patientId: string
  /**
   * A `system|code` category token to narrow to one kind of plan (a
   * feature's own plans), sent URL-encoded as the `category` parameter, or
   * `null` for every active plan.
   */
  readonly category: string | null
}

/**
 * The cursor {@link fetchCarePlanPage} reads from. `first` carries the patient
 * and optional category; `{ pageUrl }` continues from a previous page's
 * `nextPageUrl`.
 */
type CarePlanPageCursor = ResourcePageCursor<CarePlanFirstPage>

/** The `CarePlan` read: one patient's `active` plans, optionally of one category, a pinned page size. */
const carePlanRead: PagedResourceRead<
  CarePlanResource,
  Schema.Schema.Encoded<typeof CarePlan.Schema>,
  CarePlanFirstPage
> = {
  resourceType: 'CarePlan',
  schema: CarePlan.Schema,
  firstPageQuery: ({ patientId, category }: CarePlanFirstPage): string =>
    [
      `patient=${encodeURIComponent(patientId)}`,
      ...(category === null ? [] : [`category=${encodeURIComponent(category)}`]),
      `status=active&_count=${RESOURCE_PAGE_SIZE}`,
    ].join('&'),
}

/**
 * Fetch a single page of a patient's `active` `CarePlan`s from the SMART FHIR
 * server and report the cursor to the next page.
 *
 * @param client - The SMART client the search is issued through
 * @param cursor - The patient and optional category for the first page, or a
 *   previous page's `nextPageUrl`
 * @returns An effect yielding the page's decoded `CarePlan`s and the next page's cursor
 *
 * @remarks
 * Always patient-scoped: a care plan is a plan *for* someone, so there is no
 * "every patient" read. The patient id is still a parameter rather than
 * something this reader lifts off `client.patient.id`, so the caller decides
 * what a launch without a patient in context shows instead. Only `active`
 * plans are read — a `completed` or `revoked` plan is not one the patient is
 * following. A category narrows the read to one feature's plans, so plans
 * written by anything else never reach a reader that would call them
 * unreadable.
 */
const fetchCarePlanPage = (
  client: Client,
  cursor: CarePlanPageCursor
): Effect.Effect<CarePlanPage, ResourcePageRequestError | BundleDecodeError> =>
  fetchResourcePage(client, carePlanRead, cursor)

export {
  fetchCarePlanPage,
  type CarePlanFirstPage,
  type CarePlanPage,
  type CarePlanPageCursor,
  type CarePlanResource,
}
