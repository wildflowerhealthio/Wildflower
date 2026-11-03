import { Schema } from 'effect'

/**
 * How much of its CA's duplicate-certificate limit (Let's Encrypt's: 5 per
 * exact name per 7 days) a server has used: the CA `allowed` that many, the
 * server's certificate history records `used` from it in the window, and the
 * oldest of those leaves the window at `oldestLeavesWindowAt`: none when
 * there are none. The host reports one only for a CA with a limit a server
 * can reach, Let's Encrypt's production CA.
 *
 * @remarks
 * Counted from this device's certificate history, so it estimates the CA's
 * count: it keeps a certificate longer than the CA does, and misses one
 * issued to another install. The CA's refusal is the authority.
 */
const DuplicateCertificateLimitSchema = Schema.Struct({
  allowed: Schema.Number,
  used: Schema.Number,
  oldestLeavesWindowAt: Schema.optionalWith(Schema.DateTimeUtc, { as: 'Option', exact: true }),
})

/** A decoded {@link DuplicateCertificateLimitSchema}. */
type Type = typeof DuplicateCertificateLimitSchema.Type

/** Whether the CA would refuse another certificate now: the window holds all it allows. */
const isUsedUp = ({ allowed, used }: Type): boolean => used >= allowed

export { DuplicateCertificateLimitSchema as Schema, isUsedUp }
export type { Type }
