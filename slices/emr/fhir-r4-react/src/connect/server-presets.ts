/**
 * A one-click FHIR server choice on the connect menu: a human label and the
 * base URL a click connects to.
 */
interface ServerPreset {
  readonly label: string
  readonly url: string
}

/**
 * The presets every app shows unless it passes its own. `Local` is the desktop
 * host's embedded FHIR server (it serves a `.well-known/smart-configuration`, so
 * it takes the full OAuth path); the SmartHealthIT R4 demo is a public sandbox
 * for testing the flow end to end.
 */
const DEFAULT_SERVER_PRESETS: readonly ServerPreset[] = [
  { label: 'Local', url: 'http://127.0.0.1:8080/fhir-r4' },
  {
    label: 'SmartHealthit.org R4 Patient Login',
    url: 'https://launch.smarthealthit.org/v/r4/sim/WzMsIjZiMjIzZjg5LWU3MjYtNDRkYS04MWFkLTAzZDMwZmM2MTI1NCIsImR0ci1wcmFjdC0yIiwiQVVUTyIsMSwwLDAsIiIsIiIsIiIsIiIsIiIsIiIsIiIsMCwyLCIiXQ/fhir',
  },
  {
    label: "SmartHealthit.org R4 Provider's Patient",
    url: 'https://launch.smarthealthit.org/v/r4/sim/WzIsIjZiMjIzZjg5LWU3MjYtNDRkYS04MWFkLTAzZDMwZmM2MTI1NCIsImR0ci1wcmFjdC0yIiwiQVVUTyIsMSwwLDAsIiIsIiIsIiIsIiIsIiIsIiIsIiIsMCwyLCIiXQ/fhir',
  },
  {
    label: 'SmartHealthit.org R4 Provider Login',
    url: 'https://launch.smarthealthit.org/v/r4/sim/WzIsIiIsIiIsIkFVVE8iLDAsMCwwLCIiLCIiLCIiLCIiLCIiLCIiLCIiLDAsMiwiIl0/fhir',
  },
]

export { DEFAULT_SERVER_PRESETS, type ServerPreset }
