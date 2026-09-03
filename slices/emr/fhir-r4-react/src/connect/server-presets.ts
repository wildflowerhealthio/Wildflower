/**
 * A one-click FHIR server choice on the connect menu: the button's label and
 * the base URL a click launches against.
 */
interface ServerPreset {
  readonly label: string
  readonly url: string
}

/** The presets for one server, listed under the server's name. */
interface ServerPresetGroup {
  /** The server's name, as the group heading. */
  readonly name: string
  /** The server's address as shown under the heading, e.g. its origin; a mono side-note. */
  readonly address: string
  readonly presets: readonly ServerPreset[]
}

/**
 * The server groups every app shows unless it passes its own: the desktop
 * host's embedded FHIR server first (it serves a
 * `.well-known/smart-configuration`, so it takes the full OAuth path), then
 * the public SmartHealthIT R4 demo server, whose two shortcuts are the same
 * server with a patient already signed in, or with the sign-in process to go
 * through.
 */
const DEFAULT_SERVER_PRESET_GROUPS: readonly ServerPresetGroup[] = [
  {
    name: 'Local Wildflower Server',
    address: 'http://127.0.0.1:8080',
    presets: [{ label: 'Launch', url: 'http://127.0.0.1:8080/fhir-r4' }],
  },
  {
    name: 'Smart Health IT Demo Server',
    address: 'https://launch.smarthealthit.org',
    presets: [
      {
        label: 'Launch as logged in patient',
        url: 'https://launch.smarthealthit.org/v/r4/sim/WzMsIjZiMjIzZjg5LWU3MjYtNDRkYS04MWFkLTAzZDMwZmM2MTI1NCIsImR0ci1wcmFjdC0yIiwiQVVUTyIsMSwwLDAsIiIsIiIsIiIsIiIsIiIsIiIsIiIsMCwyLCIiXQ/fhir',
      },
      {
        label: 'Launch with login process',
        url: 'https://launch.smarthealthit.org/v/r4/sim/WzIsIiIsIiIsIkFVVE8iLDAsMCwwLCIiLCIiLCIiLCIiLCIiLCIiLCIiLDAsMiwiIl0/fhir',
      },
    ],
  },
]

/** Every default preset, in menu order, for callers that need the flat list. */
const DEFAULT_SERVER_PRESETS: readonly ServerPreset[] = DEFAULT_SERVER_PRESET_GROUPS.flatMap(
  (group) => group.presets
)

export { DEFAULT_SERVER_PRESET_GROUPS, DEFAULT_SERVER_PRESETS }
export type { ServerPreset, ServerPresetGroup }
