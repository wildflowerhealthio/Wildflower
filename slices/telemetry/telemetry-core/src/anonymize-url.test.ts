import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'
import {
  anonymizeUrl,
  anonymizeUrlsInText,
  INVALID_URL_PLACEHOLDER,
  RESOURCE_ID_PLACEHOLDER,
  VERSION_ID_PLACEHOLDER,
} from './anonymize-url.ts'

const resourceTypeArb = fc.constantFrom(
  'Patient',
  'Observation',
  'MedicationRequest',
  'AllergyIntolerance',
  'DocumentReference'
)

/** Whether `segment` is shaped like a FHIR resource type (`Patient`). */
const isResourceTypeShaped = (segment: string): boolean => /^[A-Z][a-z][A-Za-z]*$/.test(segment)

/**
 * A FHIR id (`[A-Za-z0-9\-.]{1,64}`), less the two the URL parser resolves as
 * dot segments and the ones shaped like a resource type, which the
 * "type-shaped id" example covers.
 */
const resourceIdArb = fc
  .stringMatching(/^[A-Za-z0-9\-.]{1,64}$/)
  .filter((id) => id !== '.' && id !== '..' && !isResourceTypeShaped(id))

/** A FHIR base-path segment: lowercase words and version tags such as `R4`. */
const basePathSegmentArb = fc.oneof(
  fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/),
  fc.constantFrom('R4', 'FHIR', 'STU3', 'api')
)

const queryOrFragmentArb = fc.constantFrom('', '?_id=123&name=Smith', '#top', '?q=1#frag')

/** A FHIR request URL with its parts, so a property can say what should survive. */
const fhirRequestArb = fc.record({
  origin: fc.webUrl().map((url) => new URL(url).origin),
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

/** Any string a caller might hand in: web URLs, FHIR URLs, paths, and noise. */
const anyUrlInputArb = fc.oneof(
  fc.webUrl({ withQueryParameters: true, withFragments: true }),
  fhirRequestArb.map(fhirRequestUrl),
  fhirRequestArb.map((fhirRequest) => new URL(fhirRequestUrl(fhirRequest)).pathname),
  fc.string()
)

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

  test('property: keeps the origin of a web URL', () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (url) => {
        expect(new URL(anonymizeUrl(url)).origin).toBe(new URL(url).origin)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: reduces a FHIR request to its base path and resource shape', () => {
    fc.assert(
      fc.property(fhirRequestArb, (fhirRequest) => {
        const expectedUrl = [
          fhirRequest.origin,
          ...fhirRequest.basePath,
          ...fhirRequest.resources.flatMap(([resourceType]) => [
            resourceType,
            RESOURCE_ID_PLACEHOLDER,
          ]),
          ...(fhirRequest.versionId === undefined ? [] : ['_history', VERSION_ID_PLACEHOLDER]),
        ].join('/')

        expect(anonymizeUrl(fhirRequestUrl(fhirRequest))).toBe(expectedUrl)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  test('property: replaces every segment after a resource-type-shaped one', () => {
    fc.assert(
      fc.property(
        fc.webUrl().map((url) => new URL(url).origin),
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
            if (previous !== undefined && isResourceTypeShaped(previous)) {
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
      expected: 'https://fhir.example/r4/Patient/{id}/$everything',
    },
    {
      label: 'a type operation',
      url: 'https://fhir.example/r4/Patient/$match',
      expected: 'https://fhir.example/r4/Patient/$match',
    },
    {
      label: 'a type search',
      url: 'https://fhir.example/r4/Observation/_search?code=1',
      expected: 'https://fhir.example/r4/Observation/_search',
    },
    {
      label: 'a type history',
      url: 'https://fhir.example/r4/Observation/_history/7',
      expected: 'https://fhir.example/r4/Observation/_history/{vid}',
    },
    {
      label: 'a compartment search',
      url: 'https://fhir.example/api/FHIR/R4/Patient/e63wRTbPfr1p8UW81d8Seiw3/Observation?category=vital-signs',
      expected: 'https://fhir.example/api/FHIR/R4/Patient/{id}/Observation',
    },
    {
      label: 'a trailing slash',
      url: 'https://fhir.example/r4/Patient/',
      expected: 'https://fhir.example/r4/Patient/',
    },
    {
      label: 'a resource-type-shaped id, at the cost of the segment after it',
      url: 'https://fhir.example/r4/Patient/Abc/Observation',
      expected: 'https://fhir.example/r4/Patient/{id}/{id}',
    },
    {
      label: 'credentials in the authority',
      url: 'https://user:secret@fhir.example/r4/Patient/1',
      expected: 'https://fhir.example/r4/Patient/{id}',
    },
  ])('keeps the shape of $label', ({ url, expected }) => {
    expect(anonymizeUrl(url)).toBe(expected)
  })

  test.each([
    { label: 'an empty string', url: '' },
    { label: 'a bare word', url: 'Patient' },
    { label: 'a relative path', url: 'Patient/123' },
    { label: 'a protocol-relative URL', url: '//fhir.example/Patient/123' },
    { label: 'a data URL', url: 'data:text/plain,Patient/123' },
    { label: 'a non-web scheme', url: 'ftp://fhir.example/Patient/123' },
  ])('reports $label as an invalid URL', ({ url }) => {
    expect(anonymizeUrl(url)).toBe(INVALID_URL_PLACEHOLDER)
  })
})

describe('anonymizeUrlsInText', () => {
  test('anonymizes the URL in a span description and keeps the method', () => {
    expect(anonymizeUrlsInText('GET https://fhir.example/r4/Patient/123?_count=5')).toBe(
      'GET https://fhir.example/r4/Patient/{id}'
    )
  })

  test('anonymizes a root-relative transaction name', () => {
    expect(anonymizeUrlsInText('/fhir/Observation/abc')).toBe('/fhir/Observation/{id}')
  })

  test('property: leaves text without URL tokens as written', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string().filter((token) => !token.includes(' ') && !/^(\/|https?:)/i.test(token))
        ),
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
