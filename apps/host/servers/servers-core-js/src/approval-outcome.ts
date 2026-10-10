import { Schema } from 'effect'

/**
 * What an approval came to: `denied` when none of the approved scopes could
 * be granted, which the server records as a denial, so the request is no
 * longer waiting either way.
 */
const ApprovalOutcomeSchema = Schema.Struct({ status: Schema.Literal('approved', 'denied') })

/** A decoded {@link ApprovalOutcomeSchema}. */
type Type = typeof ApprovalOutcomeSchema.Type

/** Whether `outcome` granted anything. */
const isApproved = (outcome: Type): boolean => outcome.status === 'approved'

export { ApprovalOutcomeSchema as Schema, isApproved }
export type { Type }
