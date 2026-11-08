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
 * - {@link Turn} — one streamed turn of a chat.
 *
 * {@link Claude} is the Effect service the model list and a turn reach the
 * API through, and {@link ClaudeRequestFailed} how a call to it fails.
 *
 * @packageDocumentation
 */
export * as ApiKey from './api-key.ts'
export * as Chat from './chat.ts'
export * as ChatPatient from './chat-patient.ts'
export { Claude, ClaudeRequestFailed } from './claude.ts'
export type { ClaudeClient, ClaudeMessageStream } from './claude.ts'
export * as ClaudeModel from './claude-model.ts'
export type { StoragePage } from './internal/page-storage.ts'
export * as Style from './style.ts'
export * as Turn from './turn.ts'
