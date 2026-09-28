import { normalizeServerUrl } from 'fhir-r4-react/smart'

/**
 * What a connect menu connects: a SMART app launching against a FHIR R4 base
 * (`fhir-r4`), or the Wildflower owner UI signing in to a Wildflower server's
 * origin (`wildflower`). The same server is addressed differently by each, so
 * every URL on the menu is built for one of them.
 */
type ConnectTarget = 'fhir-r4' | 'wildflower'

/**
 * The domain every Wildflower-hosted server is a subdomain of, with its leading
 * dot, so `https://${subdomain}${WILDFLOWER_DOMAIN}` is a hosted server's origin.
 */
const WILDFLOWER_DOMAIN = '.wildflowerhealth.io'

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
  /**
   * Whether the server is a Wildflower server. It places the Wildflower-hosted
   * group, which the connect menu lists after the leading run of Wildflower
   * groups; a sign-in reads what kind of server it is off the URL instead.
   */
  readonly wildflowerServer: boolean
  /** A quiet line under the address saying what to expect of this server, if anything. */
  readonly notice?: string
  readonly presets: readonly ServerPreset[]
}

/**
 * The URL a `target` connects to for the Wildflower server at `origin`: its
 * FHIR R4 base for a SMART app, the origin itself for the owner UI.
 */
const wildflowerServerUrlFor = (target: ConnectTarget, origin: string): string =>
  target === 'fhir-r4' ? `${origin}/fhir-r4` : origin

/**
 * `serverUrl` without a trailing `/fhir-r4` (or `/fhir-r4/`): the API base of a
 * Wildflower server entered by its FHIR base. The owner UI talks to the API
 * base, and its sign-in finds the FHIR base under it, so the entry is turned
 * back into the address the rest of the page uses.
 */
const withoutFhirR4Mount = (serverUrl: string): string => serverUrl.replace(/\/fhir-r4\/?$/, '')

/**
 * One or more dot-separated DNS labels: letters, digits and hyphens, no label
 * starting or ending with a hyphen — so `ruth` and `medication.ruth` pass, and
 * `-ruth`, `ruth.` and `ru..th` do not.
 */
const HOSTED_SUBDOMAIN = /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)*$/i

/**
 * The URL a `target` connects to for the Wildflower-hosted server at
 * `subdomain` of {@link WILDFLOWER_DOMAIN}, in `normalizeServerUrl`'s canonical
 * form (the host lower-cased), or `undefined` when the trimmed `subdomain` is
 * not one.
 *
 * @remarks
 * The subdomain is checked before it is spliced into the URL: the URL parser
 * would otherwise read a `/`, `@` or `:` in it as the start of a path,
 * userinfo or port, and connect somewhere other than a Wildflower subdomain.
 */
const hostedServerUrlFor = (target: ConnectTarget, subdomain: string): string | undefined => {
  const trimmedSubdomain = subdomain.trim()
  if (!HOSTED_SUBDOMAIN.test(trimmedSubdomain)) return undefined
  return normalizeServerUrl(
    wildflowerServerUrlFor(target, `https://${trimmedSubdomain}${WILDFLOWER_DOMAIN}`)
  )
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
 * What the owner UI can expect of the demo server: it signs in there as at any
 * SMART server, but none of the Wildflower-only API is there.
 */
const SMART_HEALTH_IT_WILDFLOWER_NOTICE =
  "Wildflower specific features won't be available, but app launching should work."

/**
 * The server groups a `target`'s connect menu shows (a SMART app may pass its
 * own instead): the Wildflower server at `localOrigin` first (it serves a
 * `.well-known/smart-configuration`, so a SMART app takes the full OAuth
 * path), then the public SmartHealthIT R4 demo server.
 *
 * @param target - What the menu connects, which picks each Wildflower URL's
 *   form and whether the demo server carries its notice.
 * @param localOrigin - The local Wildflower server's origin, e.g.
 *   `http://127.0.0.1:8080`, with no path.
 */
const serverPresetGroupsFor = (
  target: ConnectTarget,
  localOrigin: string
): readonly ServerPresetGroup[] => {
  const smartHealthIt: ServerPresetGroup = {
    name: 'Smart Health IT Demo Server',
    address: 'https://launch.smarthealthit.org',
    wildflowerServer: false,
    presets: SMART_HEALTH_IT_PRESETS,
  }
  return [
    {
      name: 'Local Wildflower Server',
      address: localOrigin,
      wildflowerServer: true,
      presets: [
        {
          // The owner UI signs in rather than launching an app.
          label: target === 'fhir-r4' ? 'Launch' : 'Connect',
          url: wildflowerServerUrlFor(target, localOrigin),
        },
      ],
    },
    target === 'wildflower'
      ? { ...smartHealthIt, notice: SMART_HEALTH_IT_WILDFLOWER_NOTICE }
      : smartHealthIt,
  ]
}

/**
 * The server groups every SMART app shows unless it passes its own: the
 * `fhir-r4` groups for the desktop host's embedded server at its default
 * loopback origin.
 */
const DEFAULT_SERVER_PRESET_GROUPS: readonly ServerPresetGroup[] = serverPresetGroupsFor(
  'fhir-r4',
  'http://127.0.0.1:8080'
)

/** Every default preset, in menu order, for callers that need the flat list. */
const DEFAULT_SERVER_PRESETS: readonly ServerPreset[] = DEFAULT_SERVER_PRESET_GROUPS.flatMap(
  (group) => group.presets
)

export {
  DEFAULT_SERVER_PRESET_GROUPS,
  DEFAULT_SERVER_PRESETS,
  hostedServerUrlFor,
  serverPresetGroupsFor,
  withoutFhirR4Mount,
  wildflowerServerUrlFor,
  WILDFLOWER_DOMAIN,
}
export type { ConnectTarget, ServerPreset, ServerPresetGroup }
