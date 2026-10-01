import { Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  appLaunchUrl,
  SMART_LAUNCHER_HOST,
  smartLauncherEhrIssuer,
  smartLauncherLaunchCode,
} from './app-launch-url.ts'

// Helpers

/**
 * A launch code as smart-launcher-v2's `decode` (`src/isomorphic/codec.ts`)
 * reads one: base64url UTF-8 JSON of a 17-element array, mapped back to the
 * named launch options by the same indexes and lookup tables.
 */
const LaunchCodeArray = Schema.parseJson(
  Schema.Tuple(
    Schema.Number, // launch_type
    Schema.String, // patient
    Schema.String, // provider
    Schema.String, // encounter
    Schema.Number, // skip_login
    Schema.Number, // skip_auth
    Schema.Number, // sim_ehr
    Schema.String, // scope
    Schema.String, // redirect_uris
    Schema.String, // client_id
    Schema.String, // client_secret
    Schema.String, // auth_error
    Schema.String, // jwks_url
    Schema.String, // jwks
    Schema.Number, // client_type
    Schema.Number, // pkce
    Schema.String // fhir_server
  )
)

/** Launch options by their smart-launcher-v2 `SMART.LaunchParams` names. */
type LaunchOptions = Readonly<Record<string, string | boolean | undefined>>

const decodeLaunchCode = (launchCode: string): LaunchOptions => {
  const [
    launchType,
    patient,
    provider,
    encounter,
    skipLogin,
    skipAuth,
    simEhr,
    scope,
    redirectUris,
    clientId,
    clientSecret,
    authError,
    jwksUrl,
    jwks,
    clientType,
    pkce,
    fhirServer,
  ] = Schema.decodeUnknownSync(LaunchCodeArray)(
    Buffer.from(launchCode, 'base64url').toString('utf8')
  )
  return {
    launch_type: [
      'provider-ehr',
      'patient-portal',
      'provider-standalone',
      'patient-standalone',
      'backend-service',
    ][launchType],
    patient,
    provider,
    encounter,
    skip_login: skipLogin === 1,
    skip_auth: skipAuth === 1,
    sim_ehr: simEhr === 1,
    scope,
    redirect_uris: redirectUris,
    client_id: clientId,
    client_secret: clientSecret,
    auth_error: authError,
    jwks_url: jwksUrl,
    jwks,
    client_type: ['public', 'confidential-symmetric', 'confidential-asymmetric', 'backend-service'][
      clientType
    ],
    pkce: ['none', 'auto', 'always'][pkce],
    fhir_server: fhirServer,
  }
}

/** A FHIR resource id (FHIR R4 `id`): what a token response's `patient` names. */
const patientIdArb = fc.stringMatching(/^[A-Za-z0-9\-.]{1,64}$/)

/** A patient in context, or none. */
const patientArb = fc.option(patientIdArb, { nil: undefined })

/** A launcher FHIR version segment. */
const fhirVersionArb = fc.constantFrom('r2', 'r3', 'r4')

/** A launcher `/sim/<launch code>` segment's code. */
const simCodeArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,80}$/)

/** One of the launcher's FHIR bases, with the FHIR version it serves. */
const launcherFhirBaseArb = fc
  .record({
    fhirVersion: fhirVersionArb,
    simCode: fc.option(simCodeArb, { nil: undefined }),
    trailingSlash: fc.boolean(),
  })
  .map(({ fhirVersion, simCode, trailingSlash }) => ({
    fhirVersion,
    fhirBaseUrl: `https://${SMART_LAUNCHER_HOST}/v/${fhirVersion}${
      simCode === undefined ? '' : `/sim/${simCode}`
    }/fhir${trailingSlash ? '/' : ''}`,
  }))

/** A hosted app's SMART launch page, on the published site or a PR preview. */
const launchPageUrlArb = fc
  .tuple(
    fc.constantFrom(
      'https://wildflowerhealth.io/',
      'https://wildflowerhealthio.github.io/staging/pr-7/'
    ),
    fc.constantFrom('medications-app', 'importer-app', 'web-trace-app', 'health-viewer-app')
  )
  .map(([siteRoot, section]) => `${siteRoot}${section}/launch.html`)

/** A FHIR base on any host but the launcher's. */
const otherFhirBaseArb = fc
  .webUrl({ validSchemes: ['https', 'http'], withQueryParameters: false, withFragments: false })
  .filter((url) => new URL(url).host !== SMART_LAUNCHER_HOST)

/** The URL with its query dropped, to compare where a link goes apart from what it carries. */
const withoutQuery = (url: URL): string => `${url.origin}${url.pathname}`

describe('smartLauncherEhrIssuer', () => {
  it("should name the launcher's unsimulated FHIR base for any of its FHIR bases", () => {
    fc.assert(
      fc.property(launcherFhirBaseArb, ({ fhirVersion, fhirBaseUrl }) => {
        expect(smartLauncherEhrIssuer(fhirBaseUrl)).toBe(
          `https://${SMART_LAUNCHER_HOST}/v/${fhirVersion}/fhir`
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should name nothing for a server on another host', () => {
    fc.assert(
      fc.property(otherFhirBaseArb, (fhirBaseUrl) => {
        expect(smartLauncherEhrIssuer(fhirBaseUrl)).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it.each([
    `https://${SMART_LAUNCHER_HOST}/`,
    `https://${SMART_LAUNCHER_HOST}/v/r4/s/abc/fhir`,
    `https://${SMART_LAUNCHER_HOST}/v/r4/sim/abc/s/def/fhir`,
    `https://${SMART_LAUNCHER_HOST}/v/r4/fhir/Patient`,
    `https://${SMART_LAUNCHER_HOST}/v/r4/auth`,
  ])('should name nothing for the launcher path %s, which is not one of its FHIR bases', (url) => {
    expect(smartLauncherEhrIssuer(url)).toBeUndefined()
  })
})

describe('smartLauncherLaunchCode', () => {
  it('should decode, as the launcher decodes it, to a patient-portal launch for the patient', () => {
    fc.assert(
      fc.property(patientArb, (patient) => {
        expect(decodeLaunchCode(smartLauncherLaunchCode(patient))).toStrictEqual({
          launch_type: 'patient-portal',
          patient: patient ?? '',
          provider: '',
          encounter: 'AUTO',
          skip_login: patient !== undefined,
          skip_auth: false,
          sim_ehr: false,
          scope: '',
          redirect_uris: '',
          client_id: '',
          client_secret: '',
          auth_error: '',
          jwks_url: '',
          jwks: '',
          client_type: 'public',
          pkce: 'auto',
          fhir_server: '',
        })
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should encode byte for byte as the launcher does: its own patient-standalone code with the launch type swapped', () => {
    // Arrange — the "Launch with login process" demo preset's `/sim/` code, which
    // the launcher page minted: its defaults as a `patient-standalone` launch.
    const launcherMintedCode = 'WzMsIiIsIiIsIkFVVE8iLDAsMCwwLCIiLCIiLCIiLCIiLCIiLCIiLCIiLDAsMSwiIl0'
    const launcherArray = Buffer.from(launcherMintedCode, 'base64url').toString('utf8')

    // Act
    const launchCode = smartLauncherLaunchCode(undefined)

    // Assert
    expect(Buffer.from(launchCode, 'base64url').toString('utf8')).toBe(
      launcherArray.replace(/^\[3,/, '[1,')
    )
    expect(launchCode).not.toMatch(/[+/=]/)
  })
})

describe('appLaunchUrl', () => {
  it("should build the launcher's EHR launch for a server on the launcher, carrying the session's patient", () => {
    fc.assert(
      fc.property(
        launchPageUrlArb,
        launcherFhirBaseArb,
        patientArb,
        (launchPageUrl, { fhirVersion, fhirBaseUrl }, patient) => {
          // Act
          const launchUrl = new URL(appLaunchUrl(launchPageUrl, { fhirBaseUrl, patient }))

          // Assert
          expect(withoutQuery(launchUrl)).toBe(launchPageUrl)
          expect([...launchUrl.searchParams.keys()]).toStrictEqual(['iss', 'launch'])
          expect(launchUrl.searchParams.get('iss')).toBe(
            `https://${SMART_LAUNCHER_HOST}/v/${fhirVersion}/fhir`
          )
          const launchOptions = decodeLaunchCode(launchUrl.searchParams.get('launch') ?? '')
          expect(launchOptions.launch_type).toBe('patient-portal')
          expect(launchOptions.patient).toBe(patient ?? '')
          expect(launchOptions.skip_login).toBe(patient !== undefined)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should build a standalone launch against any other server: its FHIR base as `iss`, and no `launch`', () => {
    fc.assert(
      fc.property(
        launchPageUrlArb,
        otherFhirBaseArb,
        patientArb,
        (launchPageUrl, fhirBaseUrl, patient) => {
          // Act
          const launchUrl = new URL(appLaunchUrl(launchPageUrl, { fhirBaseUrl, patient }))

          // Assert
          expect(withoutQuery(launchUrl)).toBe(launchPageUrl)
          expect([...launchUrl.searchParams.keys()]).toStrictEqual(['iss'])
          expect(launchUrl.searchParams.get('iss')).toBe(fhirBaseUrl)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should launch the demo preset patient by EHR launch, with that patient logged in', () => {
    // Arrange — the "Launch as logged in patient" preset's FHIR base.
    const fhirBaseUrl =
      'https://launch.smarthealthit.org/v/r4/sim/WzMsIjZiMjIzZjg5LWU3MjYtNDRkYS04MWFkLTAzZDMwZmM2MTI1NCIsImR0ci1wcmFjdC0yIiwiQVVUTyIsMSwwLDAsIiIsIiIsIiIsIiIsIiIsIiIsIiIsMCwyLCIiXQ/fhir'
    const patient = '6b223f89-e726-44da-81ad-03d30fc61254'

    // Act
    const launchUrl = new URL(
      appLaunchUrl('https://wildflowerhealth.io/medications-app/launch.html', {
        fhirBaseUrl,
        patient,
      })
    )

    // Assert
    expect(launchUrl.searchParams.get('iss')).toBe('https://launch.smarthealthit.org/v/r4/fhir')
    expect(decodeLaunchCode(launchUrl.searchParams.get('launch') ?? '')).toMatchObject({
      launch_type: 'patient-portal',
      patient,
      skip_login: true,
      skip_auth: false,
    })
  })

  it('should throw for a FHIR base that is not a URL', () => {
    expect(() =>
      appLaunchUrl('https://wildflowerhealth.io/medications-app/launch.html', {
        fhirBaseUrl: 'not a url',
        patient: undefined,
      })
    ).toThrow()
  })
})
