import { UrlMatch } from 'collector-fundamentals/model'
import { makeRemoteResponse } from 'collector-fundamentals/test-helpers'
import { Arbitrary, Duration, Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { Patient } from 'fhir-r4/resources'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { FhirR4CollectorDescriptor, InstanceConfig, defaultConfig, scrapingPlan } from './config.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

/**
 * The factory is deterministic given `(config, runId)` and its function-valued
 * fields (entities, the provenance hook) are module-level singletons, so plans
 * from one config deep-equal each other — no identity projection needed.
 */
const FIXED_RUN_ID = 'test-run'

/** A minimal decoded Patient for exercising the provenance hook's wiring. */
const patient = Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id: 'p1' })

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
    expect(FhirR4CollectorDescriptor.makeScrapingPlan(defaultConfig, FIXED_RUN_ID)).toEqual(
      scrapingPlan(defaultConfig, FIXED_RUN_ID)
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
    // The runtime minted its own run id, so compare against a plan built with it.
    const runtime = FhirR4CollectorDescriptor.resourcePersistenceRuntimeIfMatches(defaultConfig)
    expect(runtime?.run((context) => context.scrapingPlan)).toEqual(
      runtime?.run((context) => scrapingPlan(defaultConfig, context.runId))
    )
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
    const plan = scrapingPlan(defaultConfig, FIXED_RUN_ID)
    expect(plan.firstPage).toEqual({
      _tag: 'Uri',
      uri: 'https://r4.smarthealthit.org/Patient/8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882?_format=json',
    })
  })

  it('navigates to the Observation endpoint as an Open step, then holds until it settles', () => {
    const plan = scrapingPlan(defaultConfig, FIXED_RUN_ID)
    expect(plan.stepSequence).toEqual([
      {
        _tag: 'Navigation',
        name: 'Loading observations',
        action: {
          _tag: 'Open',
          source: {
            _tag: 'Uri',
            uri: 'https://r4.smarthealthit.org/Observation?subject%3APatient=8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882&_count=250&_format=json',
          },
        },
      },
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for observations to load',
        pattern: UrlMatch.make({
          segments: [UrlMatch.literal('Observation')],
          end: 'mustHaveQuery',
        }),
        timeout: Duration.seconds(30),
      },
    ])
  })

  it('states the provenance hook, which mints fhir-r4-prefixed session ids', async () => {
    // The hook itself is exercised in web-trace-core's suite; here pin that
    // the plan wires it and that this collector's traces carry its prefix.
    const plan = scrapingPlan(defaultConfig, FIXED_RUN_ID)
    // Declared as a method for covariance; it is pure and this-free, so the
    // reference is safe to bind.
    // oxlint-disable-next-line typescript-eslint/unbound-method -- pure, this-free method
    const hook = plan.captureProvenance
    expect(hook).toBeDefined()
    const response = makeRemoteResponse({ id: 'req-1' })
    const result = await Effect.runPromise(
      hook?.(FIXED_RUN_ID, response, [patient]) ?? Effect.die('hook asserted defined above')
    )
    expect(result.diagnostics.map((trace) => trace.id)).toEqual(['fhir-r4-test-run-req-1'])
  })

  it('percent-encodes a patientId that contains URL-significant characters', () => {
    // patientId is schema-constrained to [A-Za-z0-9.-], but the plan
    // applies encodeURIComponent defensively for values arriving through
    // an untyped path — pin that the encoding actually happens by feeding
    // a value with URL-significant characters past the type.
    const plan = scrapingPlan(
      {
        _tag: 'fhir-r4',
        rootUrl: 'https://example.com',
        patientId: 'a/b c',
      },
      FIXED_RUN_ID
    )
    expect(plan.firstPage).toEqual({
      _tag: 'Uri',
      uri: 'https://example.com/Patient/a%2Fb%20c?_format=json',
    })
  })
})
