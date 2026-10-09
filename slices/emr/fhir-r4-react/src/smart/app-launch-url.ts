import { base64UrlEncode } from 'gatekeeper-core/smart-client'

/**
 * The SMART server an app is launched against: the FHIR base a session is for,
 * and the patient its token response put in context, if it named one.
 */
interface AppLaunchServer {
  readonly fhirBaseUrl: string
  readonly patient: string | undefined
}

/** The host of SMART Health IT's public SMART App Launcher (smart-launcher-v2). */
const SMART_LAUNCHER_HOST = 'launch.smarthealthit.org'

/**
 * A FHIR base the launcher serves: `/v/<fhir version>/fhir`, or the same under
 * a `/sim/<launch code>` segment, which carries the launch options of a
 * standalone launch against it. The version is the first group.
 */
const SMART_LAUNCHER_FHIR_PATH = /^\/v\/(r\d+)\/(?:sim\/[^/]+\/)?fhir\/?$/

/** smart-launcher-v2's `launchTypes`, whose index a launch code carries. */
const LAUNCH_TYPES = [
  'provider-ehr',
  'patient-portal',
  'provider-standalone',
  'patient-standalone',
  'backend-service',
] as const

/** smart-launcher-v2's `clientTypes`, whose index a launch code carries. */
const CLIENT_TYPES = [
  'public',
  'confidential-symmetric',
  'confidential-asymmetric',
  'backend-service',
] as const

/** smart-launcher-v2's `PKCEValidationTypes`, whose index a launch code carries. */
const PKCE_VALIDATIONS = ['none', 'auto', 'always'] as const

/**
 * The `iss` an EHR launch from SMART Health IT's launcher names for the server
 * at `fhirBaseUrl`, or `undefined` when `fhirBaseUrl` is not one of the
 * launcher's FHIR bases.
 *
 * @param fhirBaseUrl - A FHIR base URL, as a session names it. Throws when it
 *   does not parse as a URL.
 * @returns `<launcher origin>/v/<fhir version>/fhir`: the launcher's FHIR base
 *   with any `/sim/<launch code>` segment dropped, since an EHR launch carries
 *   its options in `launch` instead.
 */
const smartLauncherEhrIssuer = (fhirBaseUrl: string): string | undefined => {
  const fhirBase = new URL(fhirBaseUrl)
  if (fhirBase.host !== SMART_LAUNCHER_HOST) return undefined
  const fhirVersion = SMART_LAUNCHER_FHIR_PATH.exec(fhirBase.pathname)?.[1]
  return fhirVersion === undefined ? undefined : `${fhirBase.origin}/v/${fhirVersion}/fhir`
}

/**
 * The launcher's `launch` code for a patient-portal EHR launch: the launcher's
 * launch options as its codec encodes them, base64url of a JSON array in the
 * codec's field order.
 *
 * @param patient - The patient to launch with, logged in already; `undefined`
 *   leaves the launcher to show its patient login.
 *
 * @remarks
 * The options are the launcher page's own defaults (`DEFAULT_LAUNCH_PARAMS`)
 * but for three: `launch_type` is `patient-portal`, an app opened from the
 * patient's own portal, which the launcher is to its reader; `patient` is the
 * session's; and `skip_login` is set whenever a patient is, since the reader
 * has signed in as that patient already. `skip_auth` stays off, so the launcher
 * still asks the reader to authorize the app.
 *
 * The encoding is `encode` in smart-launcher-v2's `src/isomorphic/codec.ts`
 * (https://github.com/smart-on-fhir/smart-launcher-v2/blob/main/src/isomorphic/codec.ts):
 * indexes into `launchTypes`, `clientTypes` and `PKCEValidationTypes`, `1`/`0`
 * for the flags, `''` for an absent string, and the UTF-8 JSON in unpadded
 * base64url, as its Node branch writes it.
 */
const smartLauncherLaunchCode = (patient: string | undefined): string =>
  base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify([
        LAUNCH_TYPES.indexOf('patient-portal'), // launch_type
        patient ?? '', // patient
        '', // provider
        'AUTO', // encounter
        patient === undefined ? 0 : 1, // skip_login
        0, // skip_auth
        0, // sim_ehr
        '', // scope
        '', // redirect_uris
        '', // client_id
        '', // client_secret
        '', // auth_error
        '', // jwks_url
        '', // jwks
        CLIENT_TYPES.indexOf('public'), // client_type
        PKCE_VALIDATIONS.indexOf('auto'), // pkce
        '', // fhir_server
      ])
    )
  )

/**
 * The URL that launches the SMART app whose launch page is `launchPageUrl`
 * against `server`.
 *
 * @param launchPageUrl - The app's SMART launch page, its root: the URL an EHR
 *   registers as its launch URL, which reads `iss` and `launch`.
 * @param server - The server to launch against, and the patient in context.
 * @returns For a server on SMART Health IT's launcher, the EHR launch its
 *   launcher page builds: `launchPageUrl` with `iss` its
 *   {@link smartLauncherEhrIssuer} and `launch` its
 *   {@link smartLauncherLaunchCode} carrying `server.patient`. For any other
 *   server, a standalone launch: `launchPageUrl` with `iss` the FHIR base and no
 *   `launch`, which fhirclient takes as a standalone launch against it.
 *
 * @remarks
 * The EHR launch link is what the launcher page (`src/components/Launcher` in
 * smart-launcher-v2) builds for "the user-specified app": the launch URL with
 * `iss` set to `<launcher origin>/v/<fhir version>/fhir`, then `launch` to the
 * encoded options. The launcher, not this link, then signs the reader in and
 * asks them to authorize the app, so the patient a session is for reaches the
 * app without a picker. Any other server has no launch code to mint, so the
 * app runs a standalone launch and the server's own sign-in and patient
 * selection take over.
 *
 * @example
 * ```ts
 * appLaunchUrl('https://wildflowerhealth.io/medications-app/', {
 *   fhirBaseUrl: 'https://fhir.example.org/r4',
 *   patient: undefined,
 * })
 * // → 'https://wildflowerhealth.io/medications-app/?iss=https%3A%2F%2Ffhir.example.org%2Fr4'
 * ```
 */
const appLaunchUrl = (launchPageUrl: string, server: AppLaunchServer): string => {
  const launchUrl = new URL(launchPageUrl)
  const launcherIssuer = smartLauncherEhrIssuer(server.fhirBaseUrl)
  if (launcherIssuer === undefined) {
    launchUrl.searchParams.set('iss', server.fhirBaseUrl)
  } else {
    launchUrl.searchParams.set('iss', launcherIssuer)
    launchUrl.searchParams.set('launch', smartLauncherLaunchCode(server.patient))
  }
  return launchUrl.href
}

export {
  appLaunchUrl,
  SMART_LAUNCHER_HOST,
  smartLauncherEhrIssuer,
  smartLauncherLaunchCode,
  type AppLaunchServer,
}
