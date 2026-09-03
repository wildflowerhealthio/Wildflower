/**
 * A one-click FHIR server choice on the connect menu: a human label, one line
 * on what picking it does, and the base URL a click connects to.
 */
interface ServerPreset {
  readonly label: string
  /** What a visitor gets by picking this one, in one plain sentence. */
  readonly description: string
  readonly url: string
}

/**
 * The presets for one server, so the menu can explain the server once and
 * list its shortcuts under it.
 */
interface ServerPresetGroup {
  /** The server's name, as the group heading. */
  readonly name: string
  /** The server's address as shown to the visitor, e.g. its origin; a mono side-note. */
  readonly address: string
  /** What this server is and what connecting to it involves. */
  readonly description: string
  readonly presets: readonly ServerPreset[]
}

/**
 * The server groups every app shows unless it passes its own: the desktop
 * host's embedded FHIR server first (it serves a
 * `.well-known/smart-configuration`, so it takes the full OAuth path), then
 * the public SmartHealthIT R4 sandbox, whose three shortcuts each open a
 * different sign-in simulation against the same made-up patients.
 */
const DEFAULT_SERVER_PRESET_GROUPS: readonly ServerPresetGroup[] = [
  {
    name: 'Your Wildflower server',
    address: 'http://127.0.0.1:8080',
    description:
      'The FHIR server the Wildflower desktop app runs on this computer. ' +
      'It holds your own record, and asks you to approve this app the first time it connects.',
    presets: [
      {
        label: 'Local',
        description: 'Connect to the server on this computer.',
        url: 'http://127.0.0.1:8080/fhir-r4',
      },
    ],
  },
  {
    name: 'SmartHealthIT sandbox',
    address: 'https://launch.smarthealthit.org',
    description:
      'A public demo server from SMART Health IT, full of made-up patients. ' +
      'Nothing you do there touches a real record. ' +
      'Each shortcut is the same server with a different sign-in simulated:',
    presets: [
      {
        label: 'Patient login',
        description: 'Sign in as a patient and see that one record.',
        url: 'https://launch.smarthealthit.org/v/r4/sim/WzMsIjZiMjIzZjg5LWU3MjYtNDRkYS04MWFkLTAzZDMwZmM2MTI1NCIsImR0ci1wcmFjdC0yIiwiQVVUTyIsMSwwLDAsIiIsIiIsIiIsIiIsIiIsIiIsIiIsMCwyLCIiXQ/fhir',
      },
      {
        label: "Provider's patient",
        description: 'Sign in as a clinician with a patient already picked for you.',
        url: 'https://launch.smarthealthit.org/v/r4/sim/WzIsIjZiMjIzZjg5LWU3MjYtNDRkYS04MWFkLTAzZDMwZmM2MTI1NCIsImR0ci1wcmFjdC0yIiwiQVVUTyIsMSwwLDAsIiIsIiIsIiIsIiIsIiIsIiIsIiIsMCwyLCIiXQ/fhir',
      },
      {
        label: 'Provider login',
        description: 'Sign in as a clinician and choose a patient yourself.',
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
