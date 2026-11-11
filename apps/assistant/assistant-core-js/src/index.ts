/**
 * Assistant's core: everything the chat decides, with no DOM and no React.
 *
 * Every module is a namespace:
 *
 * - {@link BrowserStorage} — the browser's `localStorage` and `sessionStorage`, as key-value stores.
 * - {@link ApiKey} — the person's Claude API key, kept in `localStorage`.
 * - {@link ClaudeModel} — the models the key can use, and the one chosen.
 * - {@link Style} — the two chat styles.
 * - {@link ChatPatient} — whose record a chat is about.
 * - {@link Chat} — a chat's entries, its codec and its `sessionStorage` place.
 * - {@link RecordAccess} — what the grant lets the assistant do with the record.
 * - {@link PatientPin} — how a chat about one patient keeps its reads to them.
 * - {@link SearchParam} — one FHIR search parameter, as the agent gives it.
 * - {@link Tools} — the tools a chat offers, how a read runs and how a write is proposed and made.
 * - {@link WriteProposal} — a write the agent proposed, as the person decides on it.
 * - {@link ToolCall} — a kept tool call, in words for the transcript.
 * - {@link Turn} — one turn of a chat: replies streamed, tools run, until answered.
 *
 * {@link Claude} is the Effect service the model list and a turn reach the
 * API through, and {@link ClaudeRequestFailed} how a call to it fails.
 * {@link FhirRecords} is the service the tools read and write the FHIR
 * server through; {@link FhirReadFailed} and {@link FhirWriteFailed} say how
 * a read or a write fails.
 *
 * @packageDocumentation
 */
export * as ApiKey from './api-key.ts'
export * as BrowserStorage from './browser-storage.ts'
export * as Chat from './chat.ts'
export * as ChatPatient from './chat-patient.ts'
export { Claude, ClaudeRequestFailed } from './anthropic-ai/claude.ts'
export type { ClaudeClient, ClaudeMessageStream } from './anthropic-ai/claude.ts'
export * as ClaudeModel from './anthropic-ai/claude-model.ts'
export { FhirReadFailed, FhirRecords, FhirWriteFailed } from './fhir-records.ts'
export type { FhirReadFailure } from './fhir-records.ts'
export * as PatientPin from './agent/patient-pin.ts'
export * as RecordAccess from './agent/record-access.ts'
export * as SearchParam from './search-param.ts'
export * as Style from './style.ts'
export * as ToolCall from './agent/tool-call.ts'
export * as Tools from './agent/tools/index.ts'
export * as Turn from './agent/turn.ts'
export * as WriteProposal from './write-proposal.ts'
