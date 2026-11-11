import { Schema } from 'effect'

/**
 * How the assistant talks in a chat, chosen when the chat starts and fixed
 * for it.
 *
 * @remarks
 * A namespace module: `Style.Schema`, `Style.Type`, `Style.DEFAULT`.
 * `telehealth` states facts from the record, gives no medical judgement and
 * is quick to say who to contact; `academic`, for sample data, suggests
 * diagnoses and next steps as a professor would. Each style's voice, and
 * the system prompt it builds, are the agent's (`agent/prompts/`).
 *
 * @packageDocumentation
 */

/** The two styles. Persisted in a chat — append, don't rename. */
const StyleSchema = Schema.Literal('telehealth', 'academic')

/** A chat's style. */
type Type = typeof StyleSchema.Type

/** The style a chat starts with until the person picks another. */
const DEFAULT: Type = 'telehealth'

export { DEFAULT, StyleSchema as Schema }
export type { Type }
