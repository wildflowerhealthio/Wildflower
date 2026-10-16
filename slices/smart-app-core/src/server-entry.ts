import { normalizeServerUrl } from '@wildflowerhealthio/authorization-core/smart-client'
import { Either } from 'effect'

import { MENU_COPY, RELAY_NAME_PROBLEM } from './connect-copy.ts'
import { relayServerUrlFor, type ConnectTarget } from './server-presets.ts'

/**
 * The server a connect menu's entry names, as a FHIR base in
 * `normalizeServerUrl`'s canonical form, or why the text names none, to show
 * beside the entry's field.
 */
type ServerEntryOutcome = Either.Either<string, string>

/**
 * The server the relay name `relayName` names under the official Wildflower
 * relay (`relayServerUrlFor`), or {@link RELAY_NAME_PROBLEM}.
 */
const serverUrlForRelayEntry = (relayName: string): ServerEntryOutcome => {
  const serverUrl = relayServerUrlFor(relayName)
  return serverUrl === undefined ? Either.left(RELAY_NAME_PROBLEM) : Either.right(serverUrl)
}

/**
 * The server the free-entry `text` names (`normalizeServerUrl`), or the
 * `target` menu's invalid-entry message.
 */
const serverUrlForFreeEntry = (text: string, target: ConnectTarget): ServerEntryOutcome => {
  const serverUrl = normalizeServerUrl(text)
  return serverUrl === undefined
    ? Either.left(MENU_COPY[target].invalidFreeEntry)
    : Either.right(serverUrl)
}

export { serverUrlForFreeEntry, serverUrlForRelayEntry, type ServerEntryOutcome }
