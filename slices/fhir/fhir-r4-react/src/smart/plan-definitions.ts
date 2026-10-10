import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import { PlanDefinition } from '@wildflowerhealthio/fhir-r4/resources'
import type { Effect, Schema } from 'effect'
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

/**
 * The schema every `PlanDefinition` entry decodes through: the R4 resource with
 * its `id` required, as the FHIR server always returns one. An entry without an
 * `id` fails the decode.
 */
const PlanDefinitionWithIdSchema = withMandatoryId(PlanDefinition.Schema)

/** The decoded FHIR R4 `PlanDefinition` resource, `id` present. */
type PlanDefinitionResource = Schema.Schema.Type<typeof PlanDefinitionWithIdSchema>

/**
 * One page of a `PlanDefinition` read: the decoded resources on this page and
 * the cursor to the next page (`null` when this is the last page).
 */
type PlanDefinitionPage = ResourcePage<PlanDefinitionResource>

/** The first-page input for {@link fetchPlanDefinitionPage}. */
interface PlanDefinitionFirstPage {
  /**
   * The `system|code` token the plan definitions carry as `topic`, sent
   * URL-encoded as the `topic` search parameter.
   */
  readonly topicToken: string
}

/**
 * The cursor {@link fetchPlanDefinitionPage} reads from. `first` carries the
 * topic; `{ pageUrl }` continues from a previous page's `nextPageUrl`.
 */
type PlanDefinitionPageCursor = ResourcePageCursor<PlanDefinitionFirstPage>

/** The `PlanDefinition` read: every plan definition on one topic, a pinned page size. */
const planDefinitionRead: PagedResourceRead<
  PlanDefinitionResource,
  Schema.Schema.Encoded<typeof PlanDefinitionWithIdSchema>,
  PlanDefinitionFirstPage
> = {
  resourceType: 'PlanDefinition',
  schema: PlanDefinitionWithIdSchema,
  firstPageQuery: ({ topicToken }: PlanDefinitionFirstPage): string =>
    `topic=${encodeURIComponent(topicToken)}&_count=${RESOURCE_PAGE_SIZE}`,
}

/**
 * Fetch a single page of the `PlanDefinition`s on one topic from the SMART FHIR
 * server and report the cursor to the next page.
 *
 * @param client - The SMART client the search is issued through
 * @param cursor - The topic for the first page, or a previous page's `nextPageUrl`
 * @returns An effect yielding the page's decoded `PlanDefinition`s and the next page's cursor
 *
 * @remarks
 * Not patient-scoped: a `PlanDefinition` is a definition, not a record about
 * someone, so it carries no patient to search by. The topic is the caller's —
 * a feature's own token narrows the read to that feature's definitions. No
 * `status` is searched and no order is pinned: a caller reads the topic's
 * definitions whole and decides which it follows.
 */
const fetchPlanDefinitionPage = (
  client: Client,
  cursor: PlanDefinitionPageCursor
): Effect.Effect<PlanDefinitionPage, ResourcePageRequestError | BundleDecodeError> =>
  fetchResourcePage(client, planDefinitionRead, cursor)

export {
  fetchPlanDefinitionPage,
  type PlanDefinitionFirstPage,
  type PlanDefinitionPage,
  type PlanDefinitionPageCursor,
  type PlanDefinitionResource,
}
