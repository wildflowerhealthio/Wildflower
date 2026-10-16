import { APP_SLUGS, sectionUrl, type HostedAppId } from '@wildflowerhealthio/branding-core'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'
import {
  anonymizeHost,
  anonymizeUrl,
  anonymizeUrlsInText,
  HOST_PLACEHOLDER,
  INVALID_URL_PLACEHOLDER,
  RESOURCE_ID_PLACEHOLDER,
  VERSION_ID_PLACEHOLDER,
} from './anonymize-url.ts'
import { FHIR_RESOURCE_TYPES } from './fhir-resource-types.ts'

const resourceTypeArb = fc.constantFrom(
  'Patient',
  'Observation',
  'MedicationRequest',
  'AllergyIntolerance',
  'DocumentReference'
)

/** Whether `segment` is a FHIR resource type (`Patient`). */
const isResourceType = (segment: string): boolean => FHIR_RESOURCE_TYPES.has(segment)

/**
 * A FHIR id (`[A-Za-z0-9\-.]{1,64}`), less the two the URL parser resolves as
 * dot segments and resource types' names, which the "resource type's name as
 * an id" example covers.
 */
const resourceIdArb = fc
  .stringMatching(/^[A-Za-z0-9\-.]{1,64}$/)
  .filter((id) => id !== '.' && id !== '..' && !isResourceType(id))

/** A FHIR base-path segment: lowercase route words and version tags such as `R4`. */
const basePathSegmentArb = fc.oneof(
  fc.stringMatching(/^[a-z]{1,6}(-[a-z]{1,6})?$/),
  fc.constantFrom('R4', 'r4', 'FHIR', 'STU3', 'api', 'baseR4')
)

/** Every hosted app, by its `branding-core` id. */
const HOSTED_APP_IDS = Object.keys(APP_SLUGS).filter((id): id is HostedAppId =>
  Object.hasOwn(APP_SLUGS, id)
)

/** Each hosted app's own origin, as `branding-core` publishes it. */
const HOSTED_APP_ORIGINS: readonly string[] = HOSTED_APP_IDS.map(
  (id) => new URL(sectionUrl(id)).origin
)

/** The hostnames reported as written; every other host becomes {@link HOST_PLACEHOLDER}. */
const KEPT_HOSTNAMES: readonly string[] = [
  'localhost',
  'tauri.localhost',
  'wildflowerhealth.io',
  ...HOSTED_APP_ORIGINS.map((origin) => new URL(origin).hostname),
]

/** An origin a request can go to: a web origin, or one of the kept hosts. */
const originArb = fc.oneof(
  fc.webUrl().map((url) => new URL(url).origin),
  fc.constantFrom(
    'http://localhost:5173',
    'http://tauri.localhost',
    'https://wildflowerhealth.io',
    ...HOSTED_APP_ORIGINS
  )
)

/** `origin` as anonymizeUrl reports it: kept for a kept host, `{host}` behind the scheme otherwise. */
const expectedOrigin = (origin: string): string => {
  const { protocol, hostname } = new URL(origin)
  return KEPT_HOSTNAMES.includes(hostname) ? origin : `${protocol}//${HOST_PLACEHOLDER}`
}

/**
 * Whether `segment` is kept wherever it stands: a lowercase route word, a
 * resource type, an operation or interaction, or a FHIR base-path name.
 */
const isReadableShaped = (segment: string): boolean =>
  /^\.?[a-z]+(-[a-z]+)*$/.test(segment) ||
  isResourceType(segment) ||
  /^[$_][a-z]+(-[a-z]+)*$/.test(segment) ||
  ['fhir', 'r4', 'r4b', 'r5', 'stu3', 'dstu2', 'baser4', 'baser4b', 'baser5', 'basedstu3'].includes(
    segment.toLowerCase()
  )

const queryOrFragmentArb = fc.constantFrom('', '?_id=123&name=Smith', '#top', '?q=1#frag')

/** A FHIR request URL with its parts, so a property can say what should survive. */
const fhirRequestArb = fc.record({
  origin: originArb,
  basePath: fc.array(basePathSegmentArb, { maxLength: 3 }),
  resources: fc.array(fc.tuple(resourceTypeArb, resourceIdArb), { minLength: 1, maxLength: 3 }),
  versionId: fc.option(fc.stringMatching(/^[0-9]{1,4}$/), { nil: undefined }),
  queryOrFragment: queryOrFragmentArb,
})

type FhirRequest = typeof fhirRequestArb extends fc.Arbitrary<infer A> ? A : never

const fhirRequestUrl = ({
  origin,
  basePath,
  resources,
  versionId,
  queryOrFragment,
}: FhirRequest): string =>
  [
    origin,
    ...basePath,
    ...resources.flat(),
    ...(versionId === undefined ? [] : ['_history', versionId]),
  ].join('/') + queryOrFragment

/** A FHIR request URL written as a reference relative to the server's origin. */
const relativeFhirRequestArb = fc.record({
  form: fc.constantFrom('root-relative', 'path-relative'),
  fhirRequest: fhirRequestArb,
})

type RelativeFhirRequest = typeof relativeFhirRequestArb extends fc.Arbitrary<infer A> ? A : never

const relativeFhirRequestUrl = ({ form, fhirRequest }: RelativeFhirRequest): string => {
  const rootRelativeUrl = fhirRequestUrl(fhirRequest).slice(fhirRequest.origin.length)
  return form === 'root-relative' ? rootRelativeUrl : rootRelativeUrl.slice(1)
}

/** Any string a caller might hand in: web URLs, FHIR URLs, relative references, and noise. */
const anyUrlInputArb = fc.oneof(
  fc.webUrl({ withQueryParameters: true, withFragments: true }),
  fhirRequestArb.map(fhirRequestUrl),
  relativeFhirRequestArb.map(relativeFhirRequestUrl),
  fc.string(),
  fc.string({ unit: fc.constantFrom('/', '.', ':', '?', '#', '\\', '%', 'a', 'P', '1', '_', '$') })
)

/** The anonymized path a FHIR request reduces to: its base path and resource shape. */
const expectedPathSegments = (fhirRequest: FhirRequest): readonly string[] => [
  ...fhirRequest.basePath,
  ...fhirRequest.resources.flatMap(([resourceType]) => [resourceType, RESOURCE_ID_PLACEHOLDER]),
  ...(fhirRequest.versionId === undefined ? [] : ['_history', VERSION_ID_PLACEHOLDER]),
]

describe('anonymizeUrl', () => {
  test('property: anonymizing twice is the same as anonymizing once', () => {
    fc.assert(
      fc.property(anyUrlInputArb, (url) => {
        const anonymizedUrl = anonymizeUrl(url)

        expect(anonymizeUrl(anonymizedUrl)).toBe(anonymizedUrl)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('property: never keeps a query string or fragment', () => {
    fc.assert(
      fc.property(anyUrlInputArb, (url) => {
        const anonymizedUrl = anonymizeUrl(url)

        expect(anonymizedUrl).not.toContain('?')
        expect(anonymizedUrl).not.toContain('#')
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('property: keeps the scheme of a web URL, and its host only if it is a kept one', () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (url) => {
        expect(new URL(anonymizeUrl(url)).origin).toBe(expectedOrigin(new URL(url).origin))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: reduces a FHIR request to its base path and resource shape', () => {
    fc.assert(
      fc.property(fhirRequestArb, (fhirRequest) => {
        const expectedUrl = [
          expectedOrigin(fhirRequest.origin),
          ...expectedPathSegments(fhirRequest),
        ].join('/')

        expect(anonymizeUrl(fhirRequestUrl(fhirRequest))).toBe(expectedUrl)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('property: reduces a relative FHIR request to its base path and resource shape', () => {
    fc.assert(
      fc.property(relativeFhirRequestArb, (relativeFhirRequest) => {
        const expectedPath = expectedPathSegments(relativeFhirRequest.fhirRequest).join('/')

        expect(anonymizeUrl(relativeFhirRequestUrl(relativeFhirRequest))).toBe(
          relativeFhirRequest.form === 'root-relative' ? `/${expectedPath}` : expectedPath
        )
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('property: replaces every segment after a resource type, and every other unreadable one', () => {
    fc.assert(
      fc.property(
        originArb,
        fc.array(
          fc.oneof(
            resourceTypeArb,
            resourceIdArb,
            basePathSegmentArb,
            fc.stringMatching(/^[A-Z][a-z]{1,8}$/)
          ),
          { maxLength: 8 }
        ),
        (origin, pathSegments) => {
          const anonymizedSegments = new URL(
            anonymizeUrl([origin, ...pathSegments].join('/'))
          ).pathname
            .split('/')
            .slice(1)

          pathSegments.forEach((segment, index) => {
            const previous = pathSegments[index - 1]
            if (
              (previous !== undefined && isResourceType(previous)) ||
              !isReadableShaped(segment)
            ) {
              expect(decodeURIComponent(anonymizedSegments[index] ?? '')).toBe(
                RESOURCE_ID_PLACEHOLDER
              )
            } else {
              expect(anonymizedSegments[index]).toBe(segment)
            }
          })
        }
      ),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('reduces a root-relative path to its anonymized path', () => {
    expect(anonymizeUrl('/fhir/Patient/123/_history/4?_format=json#x')).toBe(
      '/fhir/Patient/{id}/_history/{vid}'
    )
  })

  test.each([
    {
      label: 'an instance operation',
      url: 'https://fhir.example/r4/Patient/123/$everything',
      expected: 'https://{host}/r4/Patient/{id}/$everything',
    },
    {
      label: 'a type operation',
      url: 'https://fhir.example/r4/Patient/$match',
      expected: 'https://{host}/r4/Patient/$match',
    },
    {
      label: 'a type search',
      url: 'https://fhir.example/r4/Observation/_search?code=1',
      expected: 'https://{host}/r4/Observation/_search',
    },
    {
      label: 'a type history',
      url: 'https://fhir.example/r4/Observation/_history/7',
      expected: 'https://{host}/r4/Observation/_history/{vid}',
    },
    {
      label: 'a compartment search',
      url: 'https://fhir.example/api/FHIR/R4/Patient/e63wRTbPfr1p8UW81d8Seiw3/Observation?category=vital-signs',
      expected: 'https://{host}/api/FHIR/R4/Patient/{id}/Observation',
    },
    {
      label: 'a trailing slash',
      url: 'https://fhir.example/r4/Patient/',
      expected: 'https://{host}/r4/Patient/',
    },
    {
      label: "a resource type's name as an id, at the cost of the segment after it",
      url: 'https://fhir.example/r4/Patient/Observation/Abc',
      expected: 'https://{host}/r4/Patient/{id}/{id}',
    },
    {
      label: 'a capitalized name that is not a resource type',
      url: 'https://fhir.example/users/Johnsmith',
      expected: 'https://{host}/users/{id}',
    },
    {
      label: 'credentials in the authority',
      url: 'https://user:secret@fhir.example/r4/Patient/1',
      expected: 'https://{host}/r4/Patient/{id}',
    },
    {
      label: 'a percent-encoded resource type',
      url: 'https://fhir.example/r4/Pati%65nt/123',
      expected: 'https://{host}/r4/Pati%65nt/{id}',
    },
    {
      label: 'a percent-encoded id',
      url: 'https://fhir.example/r4/Patient/a%20b%2Fc',
      expected: 'https://{host}/r4/Patient/{id}',
    },
    {
      label: 'a path-relative search',
      url: 'Observation?patient=1',
      expected: 'Observation',
    },
    {
      label: 'a path-relative read',
      url: 'Patient/123/_history/4',
      expected: 'Patient/{id}/_history/{vid}',
    },
    {
      label: 'a protocol-relative URL',
      url: '//user:secret@fhir.example:8443/r4/Patient/123?x=1',
      expected: '//{host}/r4/Patient/{id}',
    },
    { label: 'an empty string', url: '', expected: '' },
    { label: 'a bare word', url: 'Patient', expected: 'Patient' },
  ])('keeps the shape of $label', ({ url, expected }) => {
    expect(anonymizeUrl(url)).toBe(expected)
  })

  test.each([
    {
      label: 'a server page named by its domain',
      url: 'http://tauri.localhost/servers/android-emu.relay.wildflowerhealth.io',
      expected: 'http://tauri.localhost/servers/{id}',
    },
    {
      label: 'an approved grant',
      url: 'https://authorization.wildflowerhealth.io/approved/6f1c9a2e-3b4d-4c5e-8f60-718293a4b5c6',
      expected: 'https://authorization.wildflowerhealth.io/approved/{id}',
    },
    {
      label: 'an app launch by a 32-hex client id',
      url: 'https://launcher.wildflowerhealth.io/home/launch/0123456789abcdef0123456789abcdef',
      expected: 'https://launcher.wildflowerhealth.io/home/launch/{id}',
    },
    {
      label: 'an app settings page by a numeric id',
      url: 'http://localhost:5173/settings/apps/42',
      expected: 'http://localhost:5173/settings/apps/{id}',
    },
    {
      label: 'a device authorization by its user code',
      url: 'https://authorization.wildflowerhealth.io/devices/WDJB-MJHT',
      expected: 'https://authorization.wildflowerhealth.io/devices/{id}',
    },
    {
      label: 'an OAuth consent by its id',
      url: 'https://authorization.wildflowerhealth.io/oauth-consent/6f1c9a2e-3b4d-4c5e-8f60-718293a4b5c6',
      expected: 'https://authorization.wildflowerhealth.io/oauth-consent/{id}',
    },
    {
      label: 'a file name',
      url: '/assets/index-BfXk2c1a.js',
      expected: '/assets/{id}',
    },
    {
      label: 'an id behind a `$`',
      url: '/fhir/$abc123',
      expected: '/fhir/{id}',
    },
    {
      label: 'an id behind a `_`',
      url: '/fhir/_9f86d081',
      expected: '/fhir/{id}',
    },
    {
      label: 'an uppercase code that is no FHIR base name',
      url: '/devices/WDJBMJHT',
      expected: '/devices/{id}',
    },
    {
      label: 'a percent-encoded domain',
      url: '/servers/ruth%2Erelay',
      expected: '/servers/{id}',
    },
  ])('replaces the id in $label', ({ url, expected }) => {
    expect(anonymizeUrl(url)).toBe(expected)
  })

  test.each([
    {
      label: 'a relay subdomain',
      url: 'https://android-emu.relay.wildflowerhealth.io/fhir/Patient/1',
      expected: 'https://{host}/fhir/Patient/{id}',
    },
    {
      label: 'the relay itself',
      url: 'https://relay.wildflowerhealth.io/',
      expected: 'https://{host}/',
    },
    {
      label: 'a personal subdomain',
      url: 'https://ruth.wildflowerhealth.io/launcher/',
      expected: 'https://{host}/launcher/',
    },
    {
      label: 'a custom domain and its port',
      url: 'https://health.ruthmarks.example:8443/fhir/R4/metadata',
      expected: 'https://{host}/fhir/R4/metadata',
    },
    {
      label: 'a loopback address',
      url: 'http://127.0.0.1:8080/fhir',
      expected: 'http://{host}/fhir',
    },
    {
      label: 'a protocol-relative relay host',
      url: '//android-emu.relay.wildflowerhealth.io/servers',
      expected: '//{host}/servers',
    },
  ])('replaces the host of $label', ({ url, expected }) => {
    expect(anonymizeUrl(url)).toBe(expected)
  })

  test.each(HOSTED_APP_ORIGINS)("keeps the hosted app's own host %s", (origin) => {
    expect(anonymizeUrl(`${origin}/settings`)).toBe(`${origin}/settings`)
  })

  test.each([
    'https://launcher.wildflowerhealth.io/',
    'http://localhost:5173/servers',
    'http://tauri.localhost/',
    '//localhost:5173/fhir',
  ])('keeps the kept host of %s', (url) => {
    expect(anonymizeUrl(url)).toBe(url)
  })

  test.each([
    '/.well-known/smart-configuration',
    '/api/FHIR/R4/metadata',
    '/baseR4/Patient/$everything',
    '/fhir/Patient/_history',
    '/fhir/ValueSet/$validate-code',
    '/authorization/oauth-consent',
  ])('keeps the route words and FHIR vocabulary of %s', (url) => {
    expect(anonymizeUrl(url)).toBe(url)
  })

  test.each([
    'https://{host}/servers/{id}',
    '//{host}/fhir/Patient/{id}/_history/{vid}',
    '/servers/{id}',
    '{id}/{vid}',
    INVALID_URL_PLACEHOLDER,
  ])('anonymizes its own output %s to itself', (url) => {
    expect(anonymizeUrl(url)).toBe(url)
  })

  test.each([
    { label: 'a data URL', url: 'data:text/plain,Patient/123' },
    { label: 'a non-web scheme', url: 'ftp://fhir.example/Patient/123' },
    { label: 'a web scheme with no host', url: 'https://' },
  ])('reports $label as an invalid URL', ({ url }) => {
    expect(anonymizeUrl(url)).toBe(INVALID_URL_PLACEHOLDER)
  })
})

describe('anonymizeHost', () => {
  test.each([
    { label: 'a relay host', host: 'android-emu.relay.wildflowerhealth.io', expected: '{host}' },
    { label: 'a host and port', host: 'fhir.example:8443', expected: '{host}' },
    { label: 'an origin', host: 'https://ruth.wildflowerhealth.io', expected: 'https://{host}' },
    { label: 'a kept host and port', host: 'localhost:5173', expected: 'localhost:5173' },
    {
      label: 'a kept origin',
      host: 'https://wildflowerhealth.io',
      expected: 'https://wildflowerhealth.io',
    },
    { label: 'a kept host with a path behind it', host: 'localhost/secret', expected: '{host}' },
    { label: 'a root-relative path', host: '/fhir', expected: '{host}' },
    { label: 'a path-relative path', host: 'api/fhir/r4', expected: '{host}' },
    { label: 'the placeholder', host: '{host}', expected: '{host}' },
    { label: 'the placeholder origin', host: 'https://{host}', expected: 'https://{host}' },
    { label: 'an origin that does not parse', host: 'https://', expected: '{host}' },
    { label: 'an empty string', host: '', expected: '{host}' },
  ])('reduces $label', ({ host, expected }) => {
    expect(anonymizeHost(host)).toBe(expected)
  })

  test('property: anonymizing twice is the same as anonymizing once', () => {
    fc.assert(
      fc.property(fc.oneof(fc.domain(), originArb, fc.string()), (host) => {
        const anonymizedHost = anonymizeHost(host)

        expect(anonymizeHost(anonymizedHost)).toBe(anonymizedHost)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('anonymizeUrlsInText', () => {
  test('anonymizes the URL in a span description and keeps the method', () => {
    expect(anonymizeUrlsInText('GET https://fhir.example/r4/Patient/123?_count=5')).toBe(
      'GET https://{host}/r4/Patient/{id}'
    )
  })

  test('anonymizes a transaction name that carries a domain', () => {
    expect(anonymizeUrlsInText('/servers/android-emu.relay.wildflowerhealth.io')).toBe(
      '/servers/{id}'
    )
  })

  test('anonymizes a root-relative transaction name', () => {
    expect(anonymizeUrlsInText('/fhir/Observation/abc')).toBe('/fhir/Observation/{id}')
  })

  test('anonymizes a path-relative URL and keeps tabs and newlines between tokens', () => {
    expect(anonymizeUrlsInText('GET\tPatient/123\nGET Observation?patient=123')).toBe(
      'GET\tPatient/{id}\nGET Observation'
    )
  })

  test('reads a URL without the punctuation around it, and keeps the punctuation', () => {
    expect(
      anonymizeUrlsInText(
        'see (https://wildflowerhealth.io/servers). Then "https://ruth.example/Patient/1", or <Patient/2>!'
      )
    ).toBe(
      'see (https://wildflowerhealth.io/servers). Then "https://{host}/Patient/{id}", or <Patient/{id}>!'
    )
  })

  test('replaces a date, which reads as a path', () => {
    expect(anonymizeUrlsInText('Invalid birth date 10/15/2026.')).toBe(
      'Invalid birth date {id}/{id}/{id}.'
    )
  })

  test('property: leaves text without URL tokens as written', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string().filter((token) => !/\s|[/?#]|^[(<["'`]*https?:/i.test(token))),
        (tokens) => {
          const text = tokens.join(' ')

          expect(anonymizeUrlsInText(text)).toBe(text)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: anonymizing twice is the same as anonymizing once', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(anyUrlInputArb, fc.string())), (tokens) => {
        const anonymizedText = anonymizeUrlsInText(tokens.join(' '))

        expect(anonymizeUrlsInText(anonymizedText)).toBe(anonymizedText)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
