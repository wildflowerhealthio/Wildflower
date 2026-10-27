import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Either, Schema } from 'effect'
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
  redirectUris: ['https://examples.smarthealthit.org/growth-chart-app/'],
  grantTypes: ['authorization_code', 'refresh_token'],
  tokenEndpointAuthMethod: 'none',
}

/** One valid app; each rejection test changes one field of it. */
const app = {
  id: '0b6f2a4e-6a0f-4c8e-9d1e-3f6b2f9a7c51',
  name: 'SMART Growth Chart',
  lang: 'en-CA',
  description: "Plots a child's height against standard growth curves.",
  descriptionShort: "A child's growth on standard curves.",
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

const rejects = (input: unknown): boolean => Either.isLeft(decodeCatalog([input]))

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
  it('decodes a minimal document, and one with a client registration', () => {
    expect(decodeCatalog([app])).toEqual(Either.right([app]))
    expect(decodeCatalog([preassignedApp])).toEqual(Either.right([preassignedApp]))
    expect(decodeCatalog([])).toEqual(Either.right([]))
  })

  it('rejects an id that is not a UUID', () => {
    for (const id of ['', 'growth-chart', '0b6f2a4e6a0f4c8e9d1e3f6b2f9a7c51']) {
      expect(rejects({ ...app, id })).toBe(true)
    }
  })

  it('rejects preassignedCredentials without "preassigned" among the registrationModes, and the reverse', () => {
    expect(rejects({ ...app, preassignedCredentials })).toBe(true)
    expect(rejects({ ...app, registrationModes: [], preassignedCredentials })).toBe(true)
    expect(rejects({ ...app, registrationModes: ['preassigned'] })).toBe(true)
  })

  it('rejects an authorization_code client with no redirectUris', () => {
    const { redirectUris: _, ...withoutRedirects } = preassignedCredentials
    expect(rejects({ ...preassignedApp, preassignedCredentials: withoutRedirects })).toBe(true)
    expect(
      rejects({
        ...preassignedApp,
        preassignedCredentials: {
          ...withoutRedirects,
          grantTypes: ['client_credentials'],
          tokenEndpointAuthMethod: 'client_secret_basic',
        },
      })
    ).toBe(false)
  })

  it('rejects a private_key_jwt client with no jwksUri', () => {
    const privateKeyJwt = { ...preassignedCredentials, tokenEndpointAuthMethod: 'private_key_jwt' }
    expect(rejects({ ...preassignedApp, preassignedCredentials: privateKeyJwt })).toBe(true)
    expect(
      rejects({
        ...preassignedApp,
        preassignedCredentials: { ...privateKeyJwt, jwksUri: 'https://example.com/jwks.json' },
      })
    ).toBe(false)
  })

  it('rejects a name shorter than 3 or longer than 150 characters', () => {
    expect(rejects({ ...app, name: 'GC' })).toBe(true)
    expect(rejects({ ...app, name: 'G'.repeat(151) })).toBe(true)
    expect(rejects({ ...app, name: 'GCA' })).toBe(false)
  })

  it('rejects a language tag that is not BCP 47 or longer than six characters', () => {
    expect(rejects({ ...app, lang: 'not a tag' })).toBe(true)
    expect(rejects({ ...app, lang: 'en-CA-x' })).toBe(true)
    expect(rejects({ ...app, lang: 'fr' })).toBe(false)
  })

  it('rejects an http: URL in any URL field', () => {
    expect(rejects({ ...app, iconUrl: 'http://example.com/icon.png' })).toBe(true)
    expect(rejects({ ...app, privacyPolicyUrl: 'http://example.com/privacy' })).toBe(true)
    expect(rejects({ ...app, helpUrl: 'http://example.com/help' })).toBe(true)
    expect(rejects({ ...app, screenshots: ['http://example.com/1.png'] })).toBe(true)
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
          const duplicate = { ...app, id: ids[pick % ids.length], name: 'Another' }
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
