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

import {
  MENU_COPY,
  RELAY_GROUP_NAME,
  RELAY_NAME_DESCRIPTION,
  RELAY_NAME_LABEL,
  RELAY_NAME_PLACEHOLDER,
  serverUrlForFreeEntry,
  serverUrlForRelayEntry,
  type ServerEntryOutcome,
} from '@wildflowerhealthio/smart-app-core'

/** The words the console's connect choices use: the launcher's, a Wildflower server's. */
const COPY = MENU_COPY.wildflower

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
    serverUrlFor: (text) => serverUrlForFreeEntry(text, 'wildflower'),
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
  type ConnectChoice,
  type ServerEntryChoice,
  type WithoutServerChoice,
}
