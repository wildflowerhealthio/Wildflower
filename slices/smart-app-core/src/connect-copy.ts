import { RELAY_DOMAIN, type ConnectTarget } from './server-presets.ts'

/** The words that differ between a SMART app's connect menu and the launcher's. */
const MENU_COPY = {
  'fhir-r4': {
    heading: 'Launch with a FHIR server',
    freeEntryName: 'Another FHIR R4 server',
    freeEntryLabel: 'FHIR base URL',
    freeEntryPlaceholder: 'https://example.org/fhir',
    invalidFreeEntry: 'Enter a valid http(s) FHIR base URL, e.g. https://example.org/fhir.',
  },
  wildflower: {
    heading: 'Connect to a server',
    freeEntryName: 'Another Wildflower server',
    freeEntryLabel: 'Server URL',
    freeEntryPlaceholder: 'https://my-server.example.com',
    invalidFreeEntry: 'Enter a valid http(s) server URL, e.g. https://my-server.example.com.',
  },
} as const satisfies Record<ConnectTarget, Record<string, string>>

/** The heading (and form name) of the group that connects by relay name. */
const RELAY_GROUP_NAME = 'Official Wildflower Relay'

/** The relay name field's label. */
const RELAY_NAME_LABEL = 'Official Wildflower Relay Name'

/** The line under the relay name field, saying where the named server is found. */
const RELAY_NAME_DESCRIPTION = `This server is found at https://[Name]${RELAY_DOMAIN}`

/** The relay name field's placeholder, an example name. */
const RELAY_NAME_PLACEHOLDER = 'my-server'

/** Why a relay name entry names no relayed server (see `relayServerUrlFor`). */
const RELAY_NAME_PROBLEM =
  "Enter your server's relay name: letters, digits and hyphens, e.g. my-server."

export {
  MENU_COPY,
  RELAY_GROUP_NAME,
  RELAY_NAME_DESCRIPTION,
  RELAY_NAME_LABEL,
  RELAY_NAME_PLACEHOLDER,
  RELAY_NAME_PROBLEM,
}
