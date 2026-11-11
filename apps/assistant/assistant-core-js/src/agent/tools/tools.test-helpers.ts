/**
 * What the tools' tests share: a chat's tools under a grant, a call run or
 * proposed against a stub FHIR server, and the results and records they
 * read.
 *
 * @packageDocumentation
 */
import type { BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Scope } from '@wildflowerhealthio/scopes-core'
import { Effect, type Either } from 'effect'

import type * as ChatPatient from '../../chat-patient.ts'
import * as Chat from '../../chat.ts'
import { onePatientChat, type StubFhirRecords, toolUseBlock } from '../../test-helpers.ts'
import type * as WriteProposal from '../../write-proposal.ts'
import * as RecordAccess from '../record-access.ts'
import * as Tools from './index.ts'

const ada = onePatientChat({ id: 'p1', given: 'Ada', family: 'Lovelace' })
const everyone: ChatPatient.Type = { kind: 'all-patients' }

const accessOf = (...scopes: readonly string[]): RecordAccess.Type =>
  RecordAccess.fromGrantedScopes(scopes.map(Scope.parse))
const everything = accessOf('system/*.cruds')

const toolsFor = (patient: ChatPatient.Type, access = everything): Tools.Type =>
  Tools.make({ access, patient })

const namesOf = (tools: Tools.Type): readonly string[] => tools.definitions.map(({ name }) => name)

/** Run the call `name` with `input` against `server`, as call `call-1`. */
const runCall = (
  tools: Tools.Type,
  server: StubFhirRecords,
  name: string,
  input: unknown,
  cursorsIssued: ReadonlySet<string> = new Set()
): BetaToolResultBlockParam =>
  Effect.runSync(
    Tools.run(tools, { id: 'call-1', name, input }, cursorsIssued).pipe(
      Effect.provide(server.layer)
    )
  )

const succeeded = (content: unknown): BetaToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: 'call-1',
  content: JSON.stringify(content),
})

const failed = (content: string): BetaToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: 'call-1',
  is_error: true,
  content,
})

const observation = (id: string, patientId: string): unknown => ({
  resourceType: 'Observation',
  id,
  subject: { reference: `Patient/${patientId}` },
})

/** A chat in which `read_record` read each of `records`, one round each. */
const chatHavingRead = (...records: readonly unknown[]): Chat.Type =>
  records.reduce<Chat.Type>(
    (chat, record, index) =>
      Chat.append(chat, {
        _tag: 'tool-round',
        modelId: 'claude-sonnet-5',
        message: {
          role: 'assistant',
          content: [toolUseBlock(`read-${String(index)}`, 'read_record', {})],
        },
        results: [
          {
            type: 'tool_result',
            tool_use_id: `read-${String(index)}`,
            content: JSON.stringify(record),
          },
        ],
      }),
    Chat.append(Chat.start('telehealth'), Chat.userEntryOf('Fix my record'))
  )

/** Propose the write `name` with `resource` against `server`, as call `call-1`, after `chat`. */
const proposeCall = (
  tools: Tools.Type,
  server: StubFhirRecords,
  name: string,
  resource: unknown,
  chat: Chat.Type = chatHavingRead()
): Either.Either<WriteProposal.Type, BetaToolResultBlockParam> =>
  Effect.runSync(
    Tools.propose(
      tools,
      { id: 'call-1', name, input: { resource } },
      Tools.versionsReadIn(chat)
    ).pipe(Effect.provide(server.layer))
  )

/** Carry out `proposal` as `decision` against `server`. */
const carryOutAgainst = (
  server: StubFhirRecords,
  proposal: WriteProposal.Type,
  decision: WriteProposal.Decision
): Promise<BetaToolResultBlockParam> =>
  Effect.runPromise(Tools.carryOut(proposal, decision).pipe(Effect.provide(server.layer)))

const weight = {
  resourceType: 'Observation',
  status: 'final',
  code: { text: 'Weight' },
  valueQuantity: { value: 70, unit: 'kg' },
}

const storedWeight = {
  ...weight,
  id: 'o1',
  subject: { reference: 'Patient/p1' },
  meta: { versionId: '3', lastUpdated: '2026-11-01T00:00:00Z' },
}

export {
  ada,
  everyone,
  accessOf,
  everything,
  toolsFor,
  namesOf,
  runCall,
  succeeded,
  failed,
  observation,
  chatHavingRead,
  proposeCall,
  carryOutAgainst,
  weight,
  storedWeight,
}
