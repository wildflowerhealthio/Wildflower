import type { FormatKind } from './registry.ts'

/**
 * The groups a batch's reviewed resources fall into: one per claimed format,
 * and one for the batch's linked records, which no format holds. A resource
 * key is unique within a group, not across groups, so the server diff, the
 * preview and the write plan each scope a resource by its group.
 *
 * @packageDocumentation
 */

/** The group of the preview the batch's linked records are reviewed in, beside the formats'. */
const LINKED_GROUP = 'linked'

/** A group of the preview: a format's, or the batch's linked records. */
type ReviewGroup = FormatKind | typeof LINKED_GROUP

export { LINKED_GROUP, type ReviewGroup }
