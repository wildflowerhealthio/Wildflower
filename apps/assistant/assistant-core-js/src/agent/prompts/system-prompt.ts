import { DateTime, Match } from 'effect'

import type * as ChatPatient from '../../chat-patient.ts'
import type * as Style from '../../style.ts'
import type * as RecordAccess from '../record-access.ts'
import { ACADEMIC_VOICE } from './academic-voice.ts'
import * as ChatPatientParagraph from './chat-patient-paragraph.ts'
import * as RecordAccessParagraph from './record-access-paragraph.ts'
import { TELEHEALTH_VOICE } from './telehealth-voice.ts'

/**
 * The system prompt a turn sends: the style's voice, then the chat's
 * patient, today's date and the grant, one paragraph each.
 *
 * @remarks
 * A namespace module: `SystemPrompt.Parts`, `SystemPrompt.voiceOf`,
 * `SystemPrompt.of`.
 *
 * @packageDocumentation
 */

/** The style's voice and rules. */
const voiceOf = (style: Style.Type): string =>
  Match.value(style).pipe(
    Match.when('telehealth', () => TELEHEALTH_VOICE),
    Match.when('academic', () => ACADEMIC_VOICE),
    Match.exhaustive
  )

/** Today's date, as the person's calendar has it. */
const dateParagraphOf = (today: DateTime.DateTime): string =>
  `Today's date is ${DateTime.formatIsoDate(today)}.`

/** What a system prompt is built from. */
interface Parts {
  readonly style: Style.Type
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
const of = ({ style, patient, today, recordAccess }: Parts): string =>
  [
    voiceOf(style),
    ChatPatientParagraph.of(patient),
    dateParagraphOf(today),
    RecordAccessParagraph.of(recordAccess),
  ].join('\n\n')

export { of, voiceOf }
export type { Parts }
