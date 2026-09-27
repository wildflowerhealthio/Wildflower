import type { Effect, Schema } from 'effect'
import { Goal } from 'fhir-r4/resources'
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

/** The decoded FHIR R4 `Goal` resource. */
type GoalResource = Schema.Schema.Type<typeof Goal.Schema>

/**
 * One page of a `Goal` read: the decoded resources on this page and the cursor
 * to the next page (`null` when this is the last page).
 */
type GoalPage = ResourcePage<GoalResource>

/**
 * The cursor {@link fetchGoalPage} reads from. `first` carries the patient id
 * the search is scoped to; `{ pageUrl }` continues from a previous page's
 * `nextPageUrl`.
 */
type GoalPageCursor = ResourcePageCursor<string>

/** The `Goal` read: every one of a patient's goals, a pinned page size. */
const goalRead: PagedResourceRead<
  GoalResource,
  Schema.Schema.Encoded<typeof Goal.Schema>,
  string
> = {
  resourceType: 'Goal',
  schema: Goal.Schema,
  firstPageQuery: (patientId: string): string =>
    `patient=${encodeURIComponent(patientId)}&_count=${RESOURCE_PAGE_SIZE}`,
}

/**
 * Fetch a single page of a patient's `Goal`s from the SMART FHIR server and
 * report the cursor to the next page.
 *
 * @param client - The SMART client the search is issued through
 * @param cursor - The patient id for the first page, or a previous page's `nextPageUrl`
 * @returns An effect yielding the page's decoded `Goal`s and the next page's cursor
 *
 * @remarks
 * Always patient-scoped, like `fetchCarePlanPage`: the goals a plan
 * references are the patient's own. No `lifecycle-status` or `category`
 * filter — which goals matter is the caller's call (a `CarePlan` names its
 * goals by reference, and a reader that follows the references ignores every
 * other goal), so every goal is read and the caller picks.
 */
const fetchGoalPage = (
  client: Client,
  cursor: GoalPageCursor
): Effect.Effect<GoalPage, ResourcePageRequestError | BundleDecodeError> =>
  fetchResourcePage(client, goalRead, cursor)

export { fetchGoalPage, type GoalPage, type GoalPageCursor, type GoalResource }
