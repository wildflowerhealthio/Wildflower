import { Schema } from 'effect'

/**
 * How many certificates a server's certificate history records from its CA
 * within the CA's duplicate-certificate window (Let's Encrypt's: 5 per exact
 * name per 7 days), against the CA's `limit`, and when the oldest of those
 * leaves the window: none when there are none. The host reports one only for
 * a CA with a limit a server can reach, Let's Encrypt's production CA.
 */
const DuplicateCertificatesSchema = Schema.Struct({
  limit: Schema.Number,
  count: Schema.Number,
  oldestLeavesWindowAt: Schema.optionalWith(Schema.DateTimeUtc, { as: 'Option', exact: true }),
})

/** A decoded {@link DuplicateCertificatesSchema}. */
type Type = typeof DuplicateCertificatesSchema.Type

/** Whether the CA would refuse another certificate now: the window holds its limit. */
const isAtLimit = ({ limit, count }: Type): boolean => count >= limit

/** Whether one more certificate would use up the CA's limit, or it is used up already. */
const nextReachesLimit = ({ limit, count }: Type): boolean => count + 1 >= limit

export { DuplicateCertificatesSchema as Schema, isAtLimit, nextReachesLimit }
export type { Type }
