import { DateTime, Match, Schema } from 'effect'

import { ACADEMIC_VOICE } from './academic-voice.ts'
import * as ChatPatient from './chat-patient.ts'
import * as RecordAccess from './record-access.ts'
import { TELEHEALTH_VOICE } from './telehealth-voice.ts'

/**
 * How the assistant talks in a chat, chosen when the chat starts and fixed
 * for it, and the system prompt each style builds.
 *
 * @remarks
 * A namespace module: `Style.Schema`, `Style.Type`, `Style.DEFAULT`,
 * `Style.systemPromptOf`. `telehealth` states facts from the record, gives
 * no medical judgement and is quick to say who to contact; `academic`, for
 * sample data, suggests diagnoses and next steps as a professor would.
 *
 * @packageDocumentation
 */

/** The two styles. Persisted in a chat — append, don't rename. */
const StyleSchema = Schema.Literal('telehealth', 'academic')

/** A chat's style. */
type Type = typeof StyleSchema.Type

/** The style a chat starts with until the person picks another. */
const DEFAULT: Type = 'telehealth'

/** The style's voice and rules. */
const voiceOf = (style: Type): string =>
  Match.value(style).pipe(
    Match.when('telehealth', () => TELEHEALTH_VOICE),
    Match.when('academic', () => ACADEMIC_VOICE),
    Match.exhaustive
  )

/** Today's date, as the person's calendar has it. */
const dateParagraphOf = (today: DateTime.DateTime): string =>
  `Today's date is ${DateTime.formatIsoDate(today)}.`

/** What a system prompt is built from, besides the style. */
interface SystemPromptParts {
  readonly style: Type
  readonly patient: ChatPatient.Type
  /** Today, in the zone whose calendar date the prompt states. */
  readonly today: DateTime.DateTime
  /** What the grant lets the assistant do with the record. */
  readonly recordAccess: RecordAccess.Type
}

/**
 * The system prompt for a turn: the style's voice and rules, then whose
 * record the chat is about, today's date, and what the assistant can do
 * with the record under its grant, one paragraph each.
 */
const systemPromptOf = ({ style, patient, today, recordAccess }: SystemPromptParts): string =>
  [
    voiceOf(style),
    ChatPatient.paragraphOf(patient),
    dateParagraphOf(today),
    RecordAccess.paragraphOf(recordAccess),
  ].join('\n\n')

export { DEFAULT, StyleSchema as Schema, systemPromptOf, voiceOf }
export type { SystemPromptParts, Type }
