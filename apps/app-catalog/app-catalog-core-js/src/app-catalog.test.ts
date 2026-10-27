import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Either, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { AppCatalog } from './index.ts'

const decodeCatalog = Schema.decodeUnknownEither(AppCatalog.Catalog)
const decodeLaunchUrl = Schema.decodeUnknownEither(AppCatalog.LaunchUrl)
const decodeRedirectUri = Schema.decodeUnknownEither(AppCatalog.RedirectUri)
const decodeContacts = Schema.decodeUnknownEither(AppCatalog.Contacts)

/** A valid public client registration for {@link app}. */
const preassignedCredentials = {
  clientId: 'growth_chart',
  grantTypes: ['authorization_code', 'refresh_token'],
  tokenEndpointAuthMethod: 'none',
  redirectUris: ['https://examples.smarthealthit.org/growth-chart-app/'],
}

/** One valid smart-app; each rejection test changes one field of it. */
const app = {
  id: '0b6f2a4e-6a0f-4c8e-9d1e-3f6b2f9a7c51',
  name: 'SMART Growth Chart',
  description: "Plots a child's height against standard growth curves.",
  descriptionShort: "A child's growth on standard curves.",
  type: 'smart-app',
  contentLanguage: 'en-CA',
  iconUrl: 'https://examples.smarthealthit.org/growth-chart-app/icon.png',
  privacyPolicyUrl: 'https://smarthealthit.org/privacy/',
  termsOfServiceUrl: 'https://smarthealthit.org/terms/',
  launchUrl: 'https://examples.smarthealthit.org/growth-chart-app/launch.html',
  contacts: [
    {
      title: 'SMART Health IT',
      email: 'info@smarthealthit.org',
      url: 'https://smarthealthit.org/',
    },
  ],
  publisher: { id: 'f3a1c2d4-5b6e-4f70-8a91-b2c3d4e5f607', name: 'SMART Health IT' },
}

/** {@link app} with its client registration. */
const preassignedApp = {
  ...app,
  registrationModes: ['preassigned'],
  preassignedCredentials,
}

/** {@link app} as a backend service: no launch URL, both onboarding endpoints. */
const { launchUrl: _launchUrl, ...appWithoutLaunchUrl } = app
const backendService = {
  ...appWithoutLaunchUrl,
  type: 'backend-service',
  onboardingEndpoint: 'https://smarthealthit.org/fhir/$initiate-onboarding',
  offboardingEndpoint: 'https://smarthealthit.org/fhir/$offboard',
}

const rejects = (input: unknown): boolean => Either.isLeft(decodeCatalog([input]))

/** Why the catalog holding `input` fails to decode, or `''` if it decodes. */
const rejectionOf = (input: unknown): string =>
  Either.match(decodeCatalog([input]), {
    onLeft: (error) => ParseResult.TreeFormatter.formatErrorSync(error),
    onRight: () => '',
  })

/** {@link preassignedApp} with its credentials changed by `change`. */
const withCredentials = (change: object): object => ({
  ...preassignedApp,
  preassignedCredentials: { ...preassignedCredentials, ...change },
})

/** `https:` URLs carrying neither `iss` nor `launch`, with paths, queries and fragments. */
const httpsUrl = fc
  .webUrl({ validSchemes: ['https'], withQueryParameters: true, withFragments: true })
  .filter((text) => {
    const { searchParams } = new URL(text)
    return !searchParams.has('iss') && !searchParams.has('launch')
  })

const email = fc.emailAddress().filter((text) => text.length <= 150)
const contactUrl = fc.webUrl({ validSchemes: ['https'] })

describe('Catalog', () => {
  it('decodes a minimal document, one with a client registration, and a backend service', () => {
    expect(decodeCatalog([app])).toEqual(Either.right([app]))
    expect(decodeCatalog([preassignedApp])).toEqual(Either.right([preassignedApp]))
    expect(decodeCatalog([backendService])).toEqual(Either.right([backendService]))
    expect(decodeCatalog([])).toEqual(Either.right([]))
  })

  it('rejects an id that is not a UUID', () => {
    for (const id of ['', 'growth-chart', '0b6f2a4e6a0f4c8e9d1e3f6b2f9a7c51']) {
      expect(rejects({ ...app, id })).toBe(true)
    }
  })

  it('rejects a type other than smart-app or backend-service', () => {
    expect(rejects({ ...app, type: 'web-app' })).toBe(true)
  })

  it('requires a launchUrl of a smart-app, and only of a smart-app', () => {
    expect(rejectionOf(appWithoutLaunchUrl)).toContain(
      'launchUrl SHALL be present when type is "smart-app"'
    )
    expect(
      rejectionOf({ ...app, onboardingEndpoint: backendService.onboardingEndpoint })
    ).toContain('onboardingEndpoint and offboardingEndpoint apply only to a backend-service')
    expect(rejectionOf({ ...backendService, launchUrl: app.launchUrl })).toContain(
      'launchUrl applies only to a smart-app'
    )
  })

  it('requires both onboarding endpoints of a backend-service', () => {
    const { onboardingEndpoint: _onboarding, ...withoutOnboarding } = backendService
    const { offboardingEndpoint: _offboarding, ...withoutOffboarding } = backendService
    for (const service of [withoutOnboarding, withoutOffboarding]) {
      expect(rejectionOf(service)).toContain(
        'onboardingEndpoint and offboardingEndpoint SHALL be present when type is "backend-service"'
      )
    }
  })

  it('requires "preassigned" among the registrationModes for preassignedCredentials, and the reverse', () => {
    for (const registrationModes of [undefined, [], ['dcr']]) {
      expect(rejectionOf({ ...app, registrationModes, preassignedCredentials })).toContain(
        'preassignedCredentials SHALL only be present when registrationModes includes "preassigned"'
      )
    }
    expect(rejectionOf({ ...app, registrationModes: ['dcr', 'preassigned'] })).toContain(
      'registrationModes includes "preassigned" but preassignedCredentials is absent'
    )
    expect(rejects({ ...app, registrationModes: ['dcr'] })).toBe(false)
    expect(rejects({ ...backendService, registrationModes: ['preassigned'] })).toBe(true)
  })

  it('rejects a registration mode named twice, or one outside dcr and preassigned', () => {
    expect(rejectionOf({ ...app, registrationModes: ['dcr', 'dcr'] })).toContain(
      'registrationModes names a mode twice'
    )
    expect(rejects({ ...app, registrationModes: ['manual'] })).toBe(true)
  })

  it('rejects refresh_token without authorization_code', () => {
    expect(
      rejectionOf(
        withCredentials({
          grantTypes: ['client_credentials', 'refresh_token'],
          tokenEndpointAuthMethod: 'client_secret_basic',
        })
      )
    ).toContain('refresh_token SHALL be paired with authorization_code')
  })

  it('rejects a private_key_jwt client with no jwksUri', () => {
    expect(rejectionOf(withCredentials({ tokenEndpointAuthMethod: 'private_key_jwt' }))).toContain(
      'jwksUri SHALL be present when tokenEndpointAuthMethod is private_key_jwt'
    )
    expect(
      rejects(
        withCredentials({
          tokenEndpointAuthMethod: 'private_key_jwt',
          jwksUri: 'https://example.com/jwks.json',
        })
      )
    ).toBe(false)
  })

  it('rejects an authorization_code client with no redirectUris', () => {
    expect(rejectionOf(withCredentials({ redirectUris: undefined }))).toContain(
      'redirectUris SHALL be present when grantTypes includes authorization_code'
    )
    expect(
      rejects(
        withCredentials({
          grantTypes: ['client_credentials'],
          tokenEndpointAuthMethod: 'client_secret_basic',
          redirectUris: undefined,
        })
      )
    ).toBe(false)
  })

  it('rejects postLogoutRedirectUris without authorization_code', () => {
    const postLogoutRedirectUris = ['https://example.com/signed-out']
    expect(
      rejectionOf(
        withCredentials({
          grantTypes: ['client_credentials'],
          tokenEndpointAuthMethod: 'client_secret_basic',
          redirectUris: undefined,
          postLogoutRedirectUris,
        })
      )
    ).toContain('postLogoutRedirectUris applies only when grantTypes includes authorization_code')
    expect(rejects(withCredentials({ postLogoutRedirectUris }))).toBe(false)
  })

  it('rejects two intents sharing a name', () => {
    const intent = { name: 'chart', description: 'Opens the growth chart.' }
    expect(rejects({ ...app, intents: [intent] })).toBe(false)
    expect(
      rejectionOf({ ...app, intents: [intent, { ...intent, description: 'Again.' }] })
    ).toContain('two intents share a name')
  })

  it('rejects a name shorter than 3 or longer than 150 characters', () => {
    expect(rejects({ ...app, name: 'GC' })).toBe(true)
    expect(rejects({ ...app, name: 'G'.repeat(151) })).toBe(true)
    expect(rejects({ ...app, name: 'GCA' })).toBe(false)
  })

  it('rejects a content language or supported language that is not BCP 47', () => {
    expect(rejects({ ...app, contentLanguage: 'not a tag' })).toBe(true)
    expect(rejects({ ...app, languagesSupported: ['en', 'not a tag'] })).toBe(true)
    expect(rejects({ ...app, contentLanguage: 'fr', languagesSupported: ['en', 'fr-CA'] })).toBe(
      false
    )
  })

  it('rejects an http: URL in any URL field', () => {
    expect(rejects({ ...app, iconUrl: 'http://example.com/icon.png' })).toBe(true)
    expect(rejects({ ...app, privacyPolicyUrl: 'http://example.com/privacy' })).toBe(true)
    expect(rejects({ ...app, helpUrl: 'http://example.com/help' })).toBe(true)
    expect(rejects({ ...app, screenshots: ['http://example.com/1.png'] })).toBe(true)
    expect(rejects({ ...backendService, onboardingEndpoint: 'http://example.com/onboard' })).toBe(
      true
    )
  })

  it('rejects eligibilityCriteria longer than 2048 characters', () => {
    expect(rejects({ ...app, eligibilityCriteria: 'a'.repeat(2049) })).toBe(true)
    expect(rejects({ ...app, eligibilityCriteria: 'a'.repeat(2048) })).toBe(false)
  })

  it('rejects a launch URL carrying iss', () => {
    expect(rejects({ ...app, launchUrl: `${app.launchUrl}?iss=https://ehr.example` })).toBe(true)
  })

  it('rejects a scope Scope.parse reads as unknown, and accepts known ones', () => {
    expect(rejects({ ...app, scopes: ['patient/Observation'] })).toBe(true)
    expect(rejects({ ...app, scopes: ['launch', 'openid', 'patient/Observation.rs'] })).toBe(false)
  })

  it('rejects a tag outside the closed list', () => {
    expect(rejects({ ...app, tags: ['genomics'] })).toBe(true)
    expect(rejects({ ...app, tags: ['pediatrics'] })).toBe(false)
  })

  it('rejects contacts with no email or no URL', () => {
    expect(rejects({ ...app, contacts: [{ title: 'Help', url: 'https://example.com/' }] })).toBe(
      true
    )
    expect(rejects({ ...app, contacts: [{ title: 'Help', email: 'help@example.com' }] })).toBe(true)
    expect(rejects({ ...app, contacts: [] })).toBe(true)
  })

  it('accepts distinct ids and rejects any id appearing twice', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 6 }),
        fc.nat(),
        (ids, pick) => {
          const apps = ids.map((id) => ({ ...app, id }))
          expect(Either.isRight(decodeCatalog(apps))).toBe(true)
          const duplicate = { ...backendService, id: ids[pick % ids.length], name: 'Another' }
          expect(Either.isLeft(decodeCatalog([...apps, duplicate]))).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('Contacts', () => {
  it('accepts any contacts holding an email and a URL, together or apart', () => {
    fc.assert(
      fc.property(email, contactUrl, fc.boolean(), (address, url, together) => {
        const contacts = together
          ? [{ title: 'Support', email: address, url }]
          : [
              { title: 'Support', email: address },
              { title: 'Docs', url },
            ]
        expect(decodeContacts(contacts)).toEqual(Either.right(contacts))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects any contacts missing an email or a URL', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            email.map((address) => ({ title: 'Support', email: address })),
            contactUrl.map((url) => ({ title: 'Docs', url }))
          )
        ),
        fc.constantFrom('email', 'url'),
        (contacts, dropped) => {
          const kept = contacts.filter((contact) => !(dropped in contact))
          expect(Either.isLeft(decodeContacts(kept))).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('LaunchUrl', () => {
  it('accepts any https: URL that carries neither iss nor launch', () => {
    fc.assert(
      fc.property(httpsUrl, (text) => {
        expect(decodeLaunchUrl(text)).toEqual(Either.right(text))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects any URL that is not https:', () => {
    fc.assert(
      fc.property(fc.webUrl({ validSchemes: ['http', 'ftp'] }), (text) => {
        expect(Either.isLeft(decodeLaunchUrl(text))).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects a URL carrying iss or launch, which the launcher adds', () => {
    fc.assert(
      fc.property(httpsUrl, fc.constantFrom('iss', 'launch'), (text, name) => {
        const url = new URL(text)
        url.searchParams.append(name, 'x')
        expect(Either.isLeft(decodeLaunchUrl(url.href))).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects a URL carrying credentials, longer than 2048 characters, or not a URL', () => {
    for (const text of [
      'https://user@example.com/launch',
      'https://user:secret@example.com/launch',
      `https://example.com/${'a'.repeat(2048)}`,
      'launch.html',
    ]) {
      expect(Either.isLeft(decodeLaunchUrl(text))).toBe(true)
    }
  })
})

describe('RedirectUri', () => {
  it('accepts any https: URL without a fragment', () => {
    fc.assert(
      fc.property(fc.webUrl({ validSchemes: ['https'], withQueryParameters: true }), (text) => {
        expect(decodeRedirectUri(text)).toEqual(Either.right(text))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects a URL that is not https:, or carries a fragment or credentials', () => {
    for (const text of [
      'http://example.com/',
      'https://example.com/#done',
      'https://example.com/#',
      'https://user:secret@example.com/',
      'callback',
    ]) {
      expect(Either.isLeft(decodeRedirectUri(text))).toBe(true)
    }
  })
})

describe('CATALOG_URL', () => {
  it("is HALO's /apps at the root of the catalog's origin", () => {
    expect(AppCatalog.CATALOG_URL).toBe('https://app-catalog.wildflowerhealth.io/apps')
  })
})
