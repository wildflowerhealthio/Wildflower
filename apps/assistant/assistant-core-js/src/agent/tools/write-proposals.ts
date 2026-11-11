import type { BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Effect, Either, Match, Option } from 'effect'

import { type FhirReadFailed, FhirRecords } from '../../fhir-records.ts'
import type * as WriteProposal from '../../write-proposal.ts'
import type { Call } from './chat-tools.ts'
import type * as ChatTools from './chat-tools.ts'
import { proposeCreate } from './create-record.ts'
import { refuseUnknownTool, type ToolCallRefused } from './refusal.ts'
import { CREATE_RECORD, UPDATE_RECORD } from './tool-names.ts'
import { resultOf } from './tool-result.ts'
import { proposeUpdate } from './update-record.ts'
import { writeRecordResultOf } from './write-record.ts'

/**
 * How a write call goes: proposed to the person, then carried out as they
 * decided.
 *
 * @packageDocumentation
 */

/** The tool result text for a change the person declined. */
const DECLINED_TEXT = 'The user declined this change.'

/**
 * The write `call` asks for, as a proposal for the person to decide on
 * (`Right`); or, on the left, the tool result refusing it: a tool the chat
 * doesn't have, an input that doesn't decode, a type the tool doesn't
 * offer, a record about another patient in a chat about one, or an update
 * of a record not read in this chat or changed since. An update reads the
 * record again, so its proposal is against the record as it is now.
 */
const propose = (
  tools: ChatTools.Type,
  call: Call,
  versionsRead: ReadonlyMap<string, string>
): Effect.Effect<
  Either.Either<WriteProposal.Type, BetaToolResultBlockParam>,
  never,
  FhirRecords
> => {
  const offered = tools.definitions.some(({ name }) => name === call.name)
  const proposal: Effect.Effect<WriteProposal.Type, ToolCallRefused | FhirReadFailed, FhirRecords> =
    offered
      ? Match.value(call.name).pipe(
          Match.when(CREATE_RECORD, () => proposeCreate(tools, call)),
          Match.when(UPDATE_RECORD, () => proposeUpdate(tools, call, versionsRead)),
          Match.orElse(() => refuseUnknownTool(call))
        )
      : refuseUnknownTool(call)
  return Effect.either(proposal).pipe(
    Effect.map(Either.mapLeft((failure) => resultOf(call.id, Either.left(failure))))
  )
}

/** The tool result for a proposal the person declined, with their reason when they gave one. */
const declinedResultOf = (
  proposal: WriteProposal.Type,
  reason: Option.Option<string>
): BetaToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: proposal.callId,
  is_error: true,
  content: Option.match(reason, {
    onNone: () => DECLINED_TEXT,
    onSome: (given) => `${DECLINED_TEXT} Reason: ${given}`,
  }),
})

/**
 * The tool result for `proposal` once the person decided: approved, the
 * write is made (an update with `If-Match` naming the version it was
 * proposed against) and the result is the stored record, or why it wasn't
 * saved; declined, nothing is written and the result says so, with the
 * person's reason. Either way not saved is `is_error: true`.
 */
const carryOut = (
  proposal: WriteProposal.Type,
  decision: WriteProposal.Decision
): Effect.Effect<BetaToolResultBlockParam, never, FhirRecords> =>
  Match.value(decision).pipe(
    Match.when({ kind: 'declined' }, ({ reason }) =>
      Effect.succeed(declinedResultOf(proposal, reason))
    ),
    Match.when({ kind: 'approved' }, () =>
      Effect.flatMap(FhirRecords, (records) =>
        Match.value(proposal).pipe(
          Match.when({ kind: 'create' }, ({ resource }) => records.create({ resource })),
          Match.when({ kind: 'update' }, ({ resource, versionId }) =>
            records.update({ resource, versionId })
          ),
          Match.exhaustive
        )
      ).pipe(
        Effect.map((written) => writeRecordResultOf(proposal.resource.resourceType, written)),
        Effect.either,
        Effect.map((outcome) => resultOf(proposal.callId, outcome))
      )
    ),
    Match.exhaustive
  )

/** Whether `call` is to one of the tools that write: it is proposed, not run. */
const isWriteCall = (call: Pick<Call, 'name'>): boolean =>
  call.name === CREATE_RECORD || call.name === UPDATE_RECORD

export { carryOut, DECLINED_TEXT, isWriteCall, propose }
