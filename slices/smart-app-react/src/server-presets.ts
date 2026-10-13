import { normalizeServerUrl } from '@wildflowerhealthio/fhir-r4-react/smart'

/**
 * What a connect menu connects: a SMART app launching against a FHIR R4 base
 * (`fhir-r4`), or the Wildflower launcher signing in to a server
 * (`wildflower`). Both address a Wildflower server by its origin, its FHIR
 * base; they differ in what a pick does there.
 */
type ConnectTarget = 'fhir-r4' | 'wildflower'

/**
 * The domain every official Wildflower relay name sits under, with its leading
 * dot, so `https://${name}${RELAY_DOMAIN}` is a relayed server's origin.
 */
const RELAY_DOMAIN = '.relay.wildflowerhealth.io'

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
  /** A quiet line under the address saying what to expect of this server, if anything. */
  readonly notice?: string
  readonly presets: readonly ServerPreset[]
}

/**
 * One DNS label: letters, digits and hyphens, not starting or ending with a
 * hyphen — so `ruth` and `ruth-lab` pass, and `-ruth`, `ruth-` and
 * `medication.ruth` do not.
 */
const RELAY_NAME = /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i

/**
 * The origin of the server relayed at `relayName` under {@link RELAY_DOMAIN},
 * its FHIR base, in `normalizeServerUrl`'s canonical form (the host
 * lower-cased), or `undefined` when the trimmed `relayName` is not one.
 *
 * @remarks
 * The name is checked before it is spliced into the URL: the URL parser would
 * otherwise read a `/`, `@` or `:` in it as the start of a path, userinfo or
 * port, and connect somewhere other than a Wildflower relay.
 */
const relayServerUrlFor = (relayName: string): string | undefined => {
  const trimmedRelayName = relayName.trim()
  if (!RELAY_NAME.test(trimmedRelayName)) return undefined
  return normalizeServerUrl(`https://${trimmedRelayName}${RELAY_DOMAIN}`)
}

/**
 * The public SmartHealthIT R4 demo server's two shortcuts: the same server
 * with a patient already signed in, or with the sign-in process to go through.
 * The same for both targets — it is a plain SMART server either way.
 */
const SMART_HEALTH_IT_PRESETS: readonly ServerPreset[] = [
  {
    label: 'Launch as logged in patient',
    url: 'https://launch.smarthealthit.org/v/r4/sim/WzMsIjZiMjIzZjg5LWU3MjYtNDRkYS04MWFkLTAzZDMwZmM2MTI1NCIsImR0ci1wcmFjdC0yIiwiQVVUTyIsMSwwLDAsIiIsIiIsIiIsIiIsIiIsIiIsIiIsMCwyLCIiXQ/fhir',
  },
  {
    label: 'Launch with login process',
    url: 'https://launch.smarthealthit.org/v/r4/sim/WzMsIiIsIiIsIkFVVE8iLDAsMCwwLCIiLCIiLCIiLCIiLCIiLCIiLCIiLDAsMSwiIl0/fhir',
  },
]

/**
 * What the launcher can expect of the demo server: it signs in there as at any
 * SMART server, but none of the Wildflower-only API is there.
 */
const SMART_HEALTH_IT_WILDFLOWER_NOTICE =
  "Wildflower specific features won't be available, but app launching should work."

/**
 * The server groups a `target`'s connect menu shows (a SMART app may pass its
 * own instead): the public SmartHealthIT R4 demo server.
 *
 * @param target - What the menu connects, which decides whether the demo
 *   server carries its notice.
 */
const serverPresetGroupsFor = (target: ConnectTarget): readonly ServerPresetGroup[] => {
  const smartHealthIt: ServerPresetGroup = {
    name: 'Smart Health IT Demo Server',
    address: 'https://launch.smarthealthit.org',
    presets: SMART_HEALTH_IT_PRESETS,
  }
  return [
    target === 'wildflower'
      ? { ...smartHealthIt, notice: SMART_HEALTH_IT_WILDFLOWER_NOTICE }
      : smartHealthIt,
  ]
}

/** The server groups every SMART app shows unless it passes its own: the `fhir-r4` groups. */
const DEFAULT_SERVER_PRESET_GROUPS: readonly ServerPresetGroup[] = serverPresetGroupsFor('fhir-r4')

/** Every default preset, in menu order, for callers that need the flat list. */
const DEFAULT_SERVER_PRESETS: readonly ServerPreset[] = DEFAULT_SERVER_PRESET_GROUPS.flatMap(
  (group) => group.presets
)

export {
  DEFAULT_SERVER_PRESET_GROUPS,
  DEFAULT_SERVER_PRESETS,
  RELAY_DOMAIN,
  relayServerUrlFor,
  serverPresetGroupsFor,
}
export type { ConnectTarget, ServerPreset, ServerPresetGroup }
