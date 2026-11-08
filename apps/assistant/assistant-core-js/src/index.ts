/**
 * Assistant's core: everything the chat decides, with no DOM and no React.
 *
 * Every module is a namespace:
 *
 * - {@link ApiKey} — the person's Claude API key, kept in `localStorage`.
 * - {@link ClaudeModel} — the models the key can use, and the one chosen.
 * - {@link Style} — the two chat styles and the system prompt each builds.
 * - {@link ChatPatient} — whose record a chat is about.
 * - {@link Chat} — a chat's entries, its codec and its `sessionStorage` place.
 * - {@link RecordAccess} — what the grant lets the assistant do with the record.
 * - {@link PatientPin} — how a chat about one patient keeps its reads to them.
 * - {@link Tools} — the read tools a chat offers, and how a call to one runs.
 * - {@link ToolCall} — a kept tool call, in words for the transcript.
 * - {@link Turn} — one turn of a chat: replies streamed, tools run, until answered.
 *
 * {@link Claude} is the Effect service the model list and a turn reach the
 * API through, and {@link ClaudeRequestFailed} how a call to it fails.
 * {@link FhirRecords} is the service the tools read the FHIR server through,
 * and {@link FhirReadFailed} how a read fails.
 *
 * @packageDocumentation
 */
export * as ApiKey from './api-key.ts'
export * as Chat from './chat.ts'
export * as ChatPatient from './chat-patient.ts'
export { Claude, ClaudeRequestFailed } from './claude.ts'
export type { ClaudeClient, ClaudeMessageStream } from './claude.ts'
export * as ClaudeModel from './claude-model.ts'
export { FhirReadFailed, FhirRecords } from './fhir-records.ts'
export type { FhirReadFailure } from './fhir-records.ts'
export type { StoragePage } from './internal/page-storage.ts'
export * as PatientPin from './patient-pin.ts'
export * as RecordAccess from './record-access.ts'
export * as Style from './style.ts'
export * as ToolCall from './tool-call.ts'
export * as Tools from './tools.ts'
export * as Turn from './turn.ts'
