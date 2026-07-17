import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { FhirR4CollectorDescriptor, InstanceConfig, defaultConfig, scrapingPlan } from './config.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

describe('InstanceConfig', () => {
  it('decodes defaultConfig without error', () => {
    expectRightToEqual(Schema.decodeUnknownEither(InstanceConfig)(defaultConfig), defaultConfig)
  })

  it('round-trips any schema-conformant rootUrl and patientId', () => {
    // Derive the arbitrary from the schema itself so the property test
    // stays in lockstep with the validation pattern — when the schema
    // tightens, the arbitrary narrows automatically.
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const encoded = Schema.encodeSync(InstanceConfig)(config)
        expect(Schema.decodeSync(InstanceConfig)(encoded)).toEqual(config)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects missing rootUrl', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'fhir-r4', patientId: '123' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects missing patientId', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({
        _tag: 'fhir-r4',
        rootUrl: 'https://example.com',
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it.each([
    'javascript:alert(1)',
    'http://',
    'https://r4.smarthealthit.org/',
    'r4.smarthealthit.org',
    'https://example.com?query=1',
    'https://example.com#frag',
    '',
  ])('rejects rootUrl %s', (rootUrl) => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'fhir-r4', rootUrl, patientId: 'abc' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it.each(['', 'a/b', 'a?b', 'a&b', 'has space', 'a'.repeat(65)])(
    'rejects patientId %s',
    (patientId) => {
      expectLeftToEqual(
        Schema.decodeUnknownEither(InstanceConfig)({
          _tag: 'fhir-r4',
          rootUrl: 'https://example.com',
          patientId,
        }),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    }
  )
})

describe('defaultConfig', () => {
  it('points to the SMART Health IT sandbox', () => {
    expect(defaultConfig).toMatchObject({
      rootUrl: 'https://r4.smarthealthit.org',
      patientId: '8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882',
    })
  })
})

describe('FhirR4CollectorDescriptor', () => {
  it('bundles the fhir-r4 schema, default, and plan factory', () => {
    expect(FhirR4CollectorDescriptor.tag).toBe('fhir-r4')
    expect(FhirR4CollectorDescriptor.configSchema).toBe(InstanceConfig)
    expect(FhirR4CollectorDescriptor.defaultConfig).toEqual(defaultConfig)
    // The plan factory is the module's `scrapingPlan` — structural
    // equality on a produced plan stands in for identity.
    expect(FhirR4CollectorDescriptor.makeScrapingPlan(defaultConfig)).toEqual(
      scrapingPlan(defaultConfig)
    )
  })

  it('exposes kind-level display strings (not the route demo label)', () => {
    expect(FhirR4CollectorDescriptor.display.title).toBe('FHIR R4')
    expect(FhirR4CollectorDescriptor.display.description).toBe(
      'Health records from a FHIR R4 server'
    )
  })

  it('derives the list subtitle from the configured rootUrl', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        expect(FhirR4CollectorDescriptor.display.listSubtitle(config)).toBe(config.rootUrl)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('matches its own configs and rejects foreign ones via resourcePersistenceRuntimeIfMatches', () => {
    // The matched runtime seals `Resources`; reach the plan only through `run`.
    const runtime = FhirR4CollectorDescriptor.resourcePersistenceRuntimeIfMatches(defaultConfig)
    expect(runtime?.run((context) => context.scrapingPlan)).toEqual(scrapingPlan(defaultConfig))
    expect(
      FhirR4CollectorDescriptor.resourcePersistenceRuntimeIfMatches({
        _tag: 'not-fhir',
        rootUrl: 'x',
      })
    ).toBeUndefined()
  })
})

describe('scrapingPlan', () => {
  // The plan navigates the sniffer webview directly to the FHIR JSON
  // endpoints via `Uri` sources (the browser's native viewer renders the
  // response, which the sniffer snapshots). A regression to the old
  // inline-`Html` wrapper — or a dropped `?_format=json` / mis-encoded
  // `subject:Patient` query — would silently change what page loads.
  it('mounts the Patient endpoint as the first page via a direct Uri', () => {
    const plan = scrapingPlan(defaultConfig)
    expect(plan.firstPage).toEqual({
      _tag: 'Uri',
      uri: 'https://r4.smarthealthit.org/Patient/8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882?_format=json',
    })
  })

  it('navigates to the Observation endpoint as a single Open step via a direct Uri', () => {
    const plan = scrapingPlan(defaultConfig)
    expect(plan.stepSequence).toEqual([
      {
        action: {
          _tag: 'Open',
          source: {
            _tag: 'Uri',
            uri: 'https://r4.smarthealthit.org/Observation?subject%3APatient=8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882&_count=250&_format=json',
          },
        },
      },
    ])
  })

  it('percent-encodes a patientId that contains URL-significant characters', () => {
    // patientId is schema-constrained to [A-Za-z0-9.-], but the plan
    // applies encodeURIComponent defensively for values arriving through
    // an untyped path — pin that the encoding actually happens by feeding
    // a value with URL-significant characters past the type.
    const plan = scrapingPlan({
      _tag: 'fhir-r4',
      rootUrl: 'https://example.com',
      patientId: 'a/b c',
    })
    expect(plan.firstPage).toEqual({
      _tag: 'Uri',
      uri: 'https://example.com/Patient/a%2Fb%20c?_format=json',
    })
  })
})
