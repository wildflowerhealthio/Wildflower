import type { BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Effect, Match } from 'effect'

import type * as ChatPatient from '../../chat-patient.ts'
import type { FhirReadFailed, FhirRecords } from '../../fhir-records.ts'
import type * as RecordAccess from '../record-access.ts'
import { capabilities, CAPABILITIES_DEFINITION } from './capabilities.ts'
import { type Call, offeredTypesOf, type Type } from './chat-tools.ts'
import { creatableTypesOf, createRecordDefinition } from './create-record.ts'
import { NEXT_PAGE_DEFINITION, nextPage } from './next-page.ts'
import { readRecord, readRecordDefinition } from './read-record.ts'
import { refuseUnknownTool, type ToolCallRefused } from './refusal.ts'
import { searchRecords, searchRecordsDefinition } from './search-records.ts'
import { CAPABILITIES, NEXT_PAGE, READ_RECORD, SEARCH_RECORDS } from './tool-names.ts'
import { resultOf } from './tool-result.ts'
import { updateRecordDefinition } from './update-record.ts'

/**
 * The tools a chat offers the agent, built from the grant and the patient
 * choice and fixed for the chat, so every request sends the same `tools` and
 * the prompt cache holds; and how a call to one runs against the FHIR
 * server.
 *
 * @remarks
 * A namespace module: `Tools.Type`, `Tools.Call`, `Tools.make`, `Tools.run`,
 * `Tools.propose`, `Tools.carryOut`, `Tools.isWriteCall`,
 * `Tools.versionsReadIn`, `Tools.cursorsIssuedIn`, the tool names, the input
 * schemas each call is decoded through before it runs, the result schemas
 * the transcript reads back, and the result texts it recognises. Each tool
 * is its own file in this folder; this index collects them.
 *
 * - `search_records` — one page of a search, `_count` 20 unless the agent
 *   asks for up to {@link MAX_COUNT}; with `more` and an opaque `next` cursor
 *   when there is another page.
 * - `next_page` — the page a `next` cursor points at.
 * - `read_record` — one record by type and id.
 * - `capabilities` — what the server says it can search on, for the types
 *   the chat offers.
 * - `create_record` — propose a new record, which the person approves or
 *   declines before it is created.
 * - `update_record` — propose a change to a record read in this chat, shown
 *   field by field, which the person approves or declines before it is
 *   saved against the version that was read.
 *
 * There is no delete tool under any grant: a record entered by mistake is
 * marked `entered-in-error` through an update. A read runs with {@link run};
 * a write is first a {@link WriteProposal} ({@link propose}), run once the
 * person decides ({@link carryOut}).
 *
 * In a chat about one patient, each search is pinned to them
 * ({@link PatientPin}), every record read back is checked to be theirs, and
 * every record written is about them or no one patient; a type nothing pins
 * is not offered. A failed call is a tool result with `is_error: true`
 * saying why, the server's `OperationOutcome` text included.
 *
 * @packageDocumentation
 */

/**
 * The tools for a chat about `patient` under `access`: searching (with
 * `next_page` and `capabilities`) when some type can be searched, reading
 * by id when some type can be read, proposing new records and changes when
 * some type can be created or updated, each offering only those types.
 * Nothing deletes, whatever the grant.
 */
const make = ({
  access,
  patient,
}: {
  readonly access: RecordAccess.Type
  readonly patient: ChatPatient.Type
}): Type => {
  const searchableTypes = offeredTypesOf(access.searchable, patient)
  const readableTypes = offeredTypesOf(access.readable, patient)
  const creatableTypes = creatableTypesOf(access.creatable, patient)
  const updatableTypes = offeredTypesOf(access.updatable, patient)
  return {
    patient,
    searchableTypes,
    readableTypes,
    creatableTypes,
    updatableTypes,
    definitions: [
      ...(searchableTypes.length > 0
        ? [
            searchRecordsDefinition(patient, searchableTypes),
            NEXT_PAGE_DEFINITION,
            CAPABILITIES_DEFINITION,
          ]
        : []),
      ...(readableTypes.length > 0 ? [readRecordDefinition(patient, readableTypes)] : []),
      ...(creatableTypes.length > 0 ? [createRecordDefinition(patient, creatableTypes)] : []),
      ...(updatableTypes.length > 0 ? [updateRecordDefinition(patient, updatableTypes)] : []),
    ],
  }
}

/**
 * Run the read `call` with `tools`, against the FHIR server in the context,
 * and succeed with its tool result: the JSON the tool read, or `is_error:
 * true` and why it failed. A call to a tool the chat doesn't have, or to a
 * write tool (which {@link propose} takes), is a failed result too.
 * `next_page` reads only a cursor in `cursorsIssued` ({@link cursorsIssuedIn}).
 */
const run = (
  tools: Type,
  call: Call,
  cursorsIssued: ReadonlySet<string>
): Effect.Effect<BetaToolResultBlockParam, never, FhirRecords> => {
  const offered = tools.definitions.some(({ name }) => name === call.name)
  const result: Effect.Effect<string, ToolCallRefused | FhirReadFailed, FhirRecords> = offered
    ? Match.value(call.name).pipe(
        Match.when(SEARCH_RECORDS, () => searchRecords(tools, call.input)),
        Match.when(NEXT_PAGE, () => nextPage(tools, call.input, cursorsIssued)),
        Match.when(READ_RECORD, () => readRecord(tools, call.input)),
        Match.when(CAPABILITIES, () => capabilities(tools, call.input)),
        Match.orElse(() => refuseUnknownTool(call))
      )
    : refuseUnknownTool(call)
  return Effect.map(Effect.either(result), (outcome) => resultOf(call.id, outcome))
}

export { CapabilitiesInput, CapabilitiesResult } from './capabilities.ts'
export { cursorsIssuedIn, NextPageInput } from './next-page.ts'
export { PageResult } from './page.ts'
export { ReadRecordInput, ReadRecordResult } from './read-record.ts'
export { versionsReadIn } from './record-versions.ts'
export { DEFAULT_COUNT, MAX_COUNT, SearchRecordsInput } from './search-records.ts'
export {
  CAPABILITIES,
  CREATE_RECORD,
  NEXT_PAGE,
  READ_RECORD,
  SEARCH_RECORDS,
  UPDATE_RECORD,
} from './tool-names.ts'
export { ACCEPTED_UNREADABLE_OPENING, STALE_RECORD_TEXT } from './tool-result.ts'
export { carryOut, DECLINED_TEXT, isWriteCall, propose } from './write-proposals.ts'
export { WriteRecordInput, WriteRecordResult } from './write-record.ts'
export { make, run }
export type { Call, Type }
