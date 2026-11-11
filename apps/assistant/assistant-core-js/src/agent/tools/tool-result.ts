import type { BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Either, Match, Option } from 'effect'

import type { FhirReadFailed, FhirWriteFailed } from '../../fhir-records.ts'
import type { ToolCallRefused } from './refusal.ts'

/**
 * A call's tool result: the tool's JSON, or `is_error: true` and why it
 * failed, in words for the agent.
 *
 * @packageDocumentation
 */

/** What the agent is told of a read the server failed. */
const fhirFailureTextOf = ({ failure }: FhirReadFailed): string =>
  Match.value(failure).pipe(
    Match.when({ kind: 'error-status' }, ({ status, outcomeText }) => {
      const answered = `The FHIR server answered ${String(status)}.`
      return Option.match(outcomeText, {
        onNone: () => answered,
        onSome: (text) => `${answered} It said: ${text}`,
      })
    }),
    Match.when({ kind: 'unreachable' }, () => "The FHIR server couldn't be reached."),
    Match.when({ kind: 'not-json' }, () => "The FHIR server's answer wasn't JSON."),
    Match.exhaustive
  )

/** The tool result text for an update whose record changed since it was read. */
const STALE_RECORD_TEXT = 'The record changed since you read it; re-read it first.'

/** The opening of the tool result text for a write the server accepted but answered unreadably. */
const ACCEPTED_UNREADABLE_OPENING = 'The FHIR server accepted the change'

/** What the agent is told of a write the server failed. */
const writeFailureTextOf = ({ failure }: FhirWriteFailed): string =>
  Match.value(failure).pipe(
    Match.when({ kind: 'precondition-failed' }, () => STALE_RECORD_TEXT),
    Match.when({ kind: 'error-status' }, ({ status, outcomeText }) => {
      const answered = `The FHIR server answered ${String(status)}, so nothing was saved.`
      return Option.match(outcomeText, {
        onNone: () => answered,
        onSome: (text) => `${answered} It said: ${text}`,
      })
    }),
    Match.when(
      { kind: 'unreachable' },
      () => "The FHIR server couldn't be reached, so nothing was saved."
    ),
    Match.when(
      { kind: 'accepted-unreadable' },
      ({ status }) =>
        `${ACCEPTED_UNREADABLE_OPENING} (${String(status)}) but its answer couldn't be read, so it was probably saved. Search for the record before trying again.`
    ),
    Match.exhaustive
  )

/** The tool result for the call `callId` names: the tool's JSON, or `is_error: true` and why it failed. */
const resultOf = (
  callId: string,
  outcome: Either.Either<string, ToolCallRefused | FhirReadFailed | FhirWriteFailed>
): BetaToolResultBlockParam =>
  Either.match(outcome, {
    onRight: (content): BetaToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: callId,
      content,
    }),
    onLeft: (failure): BetaToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: callId,
      is_error: true,
      content: Match.value(failure).pipe(
        Match.tag('ToolCallRefused', ({ reason }) => reason),
        Match.tag('FhirReadFailed', fhirFailureTextOf),
        Match.tag('FhirWriteFailed', writeFailureTextOf),
        Match.exhaustive
      ),
    }),
  })

export { ACCEPTED_UNREADABLE_OPENING, resultOf, STALE_RECORD_TEXT }
