/**
 * What the console offers a reader who has not chosen a server: the choices
 * `smart-app-react`'s `ConnectMenu` offers for a Wildflower server, from the
 * same `smart-app-core` data and copy, then one the menu does not have,
 * **Launch without a server**.
 *
 * The console leaves out the menu's demo-server presets: the demo server is a
 * plain SMART server, with none of the Wildflower API this console documents.
 *
 * Pure data; `main.ts` renders it as plain DOM.
 */

import { normalizeServerUrl } from '@wildflowerhealthio/authorization-core/smart-client'
import {
  MENU_COPY,
  RELAY_GROUP_NAME,
  RELAY_NAME_DESCRIPTION,
  RELAY_NAME_LABEL,
  RELAY_NAME_PLACEHOLDER,
  RELAY_NAME_PROBLEM,
  relayServerUrlFor,
} from '@wildflowerhealthio/smart-app-core'
import { Either } from 'effect'

/** The words the console's connect choices use: the launcher's, a Wildflower server's. */
const COPY = MENU_COPY.wildflower

/**
 * The server an entry names, as a FHIR base in `normalizeServerUrl`'s canonical
 * form, or why the text names none, to show beside the entry's field.
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
 * Wildflower menu's invalid-entry message.
 */
const serverUrlForFreeEntry = (text: string): ServerEntryOutcome => {
  const serverUrl = normalizeServerUrl(text)
  return serverUrl === undefined ? Either.left(COPY.invalidFreeEntry) : Either.right(serverUrl)
}

/** A form with one text field that names a server, and its Connect button. */
interface ServerEntryChoice {
  readonly kind: 'server-entry'
  /** The group heading, and the form's accessible name. */
  readonly name: string
  readonly label: string
  /** A line under the field, if any. */
  readonly description?: string
  readonly placeholder: string
  /** The server the field's text names, or why it names none. */
  readonly serverUrlFor: (text: string) => ServerEntryOutcome
}

/** The choice that mounts the reference with no target. */
interface WithoutServerChoice {
  readonly kind: 'without-server'
  readonly name: string
  /** What browsing without a server gives, above the button. */
  readonly description: string
  readonly buttonLabel: string
}

type ConnectChoice = ServerEntryChoice | WithoutServerChoice

/** The heading over the console's connect choices, the Wildflower menu's. */
const CONNECT_HEADING = COPY.heading

/**
 * The console's connect choices, in `ConnectMenu`'s order: the Official
 * Wildflower Relay name entry, the free entry for any other Wildflower server,
 * then **Launch without a server**.
 */
const CONNECT_CHOICES: readonly ConnectChoice[] = [
  {
    kind: 'server-entry',
    name: RELAY_GROUP_NAME,
    label: RELAY_NAME_LABEL,
    description: RELAY_NAME_DESCRIPTION,
    placeholder: RELAY_NAME_PLACEHOLDER,
    serverUrlFor: serverUrlForRelayEntry,
  },
  {
    kind: 'server-entry',
    name: COPY.freeEntryName,
    label: COPY.freeEntryLabel,
    placeholder: COPY.freeEntryPlaceholder,
    serverUrlFor: serverUrlForFreeEntry,
  },
  {
    kind: 'without-server',
    name: 'Without a server',
    description: 'Browse the API reference. Requests cannot be sent until you connect to a server.',
    buttonLabel: 'Launch without a server',
  },
]

export {
  CONNECT_CHOICES,
  CONNECT_HEADING,
  serverUrlForFreeEntry,
  serverUrlForRelayEntry,
  type ConnectChoice,
  type ServerEntryChoice,
  type ServerEntryOutcome,
  type WithoutServerChoice,
}
