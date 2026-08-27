import { makeCollectorHttpResponse } from 'collector-fundamentals/test-helpers'
import { Arbitrary, Duration, Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { localResourceId, originalIdOf } from 'fhir-r4/identity'
import { type FhirResource, Patient } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import { traceResourceId } from 'web-trace-core'

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
  // The plan's `Open` steps take the sniffer
  // directly to the FHIR JSON endpoints via `Uri` sources (the browser's native
  // viewer renders the response, which the sniffer snapshots). Each `Open` is
  // followed by a **pattern-less** `AwaitPageSettled` — "wait for the next
  // settle" — because each `Open` targets a fresh document, so no url pattern is
  // needed to disambiguate. A dropped `?_format=json` / mis-encoded
  // `subject:Patient` query, or a re-introduced settle `pattern`, would show here.
  it('opens the Patient then Observation endpoints, holding until each settles', () => {
    const plan = scrapingPlan(defaultConfig, FIXED_RUN_ID)
    expect(plan.stepSequence).toEqual([
      {
        _tag: 'Navigation',
        name: 'Loading patient',
        action: {
          _tag: 'Open',
          source: {
            _tag: 'Uri',
            uri: 'https://r4.smarthealthit.org/Patient/8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882?_format=json',
          },
        },
      },
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for patient to load',
        timeout: Duration.seconds(30),
      },
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
    const response = makeCollectorHttpResponse({ id: 'req-1' })
    const result = await Effect.runPromise(
      hook?.(FIXED_RUN_ID, response, [patient]) ?? Effect.die('hook asserted defined above')
    )
    expect(result.diagnostics.map((trace) => trace.id)).toEqual([
      traceResourceId({ sessionId: 'fhir-r4-test-run', requestId: 'req-1' }),
    ])
  })

  it('percent-encodes a patientId that contains URL-significant characters', () => {
    // patientId is schema-constrained to [A-Za-z0-9.-], but the plan
    // applies encodeURIComponent defensively for values arriving through
    // an untyped path — pin that the encoding actually happens by feeding
    // a value with URL-significant characters past the type. The Patient URL
    // now rides the plan's first `Open` step.
    const plan = scrapingPlan(
      {
        _tag: 'fhir-r4',
        rootUrl: 'https://example.com',
        patientId: 'a/b c',
      },
      FIXED_RUN_ID
    )
    expect(plan.stepSequence[0]).toEqual({
      _tag: 'Navigation',
      name: 'Loading patient',
      action: {
        _tag: 'Open',
        source: {
          _tag: 'Uri',
          uri: 'https://example.com/Patient/a%2Fb%20c?_format=json',
        },
      },
    })
  })
})

/**
 * The plan's entities as the framework sees them — `fhir-r4-source`'s
 * pre-adopted `fhirR4SourceEntities`, not the raw module singletons the entity
 * suites exercise. The entity suites pin the FHIR decode; these pin what
 * adoption does to it afterwards (re-key under the URL's root).
 */
describe('source identity', () => {
  const ROOT_URL = 'https://r4.example.org/baseR4'
  const CONFIG: InstanceConfig = {
    _tag: 'fhir-r4',
    rootUrl: ROOT_URL,
    patientId: 'pat-7',
  }

  const responseKindNamed = (name: string): HttpResponseKind.HttpResponseKind<FhirResource> => {
    const found = scrapingPlan(CONFIG, FIXED_RUN_ID).responseKinds.find(
      (responseKind) => responseKind.name === name
    )
    if (found === undefined) throw new Error(`no response kind named ${name}`)
    return found
  }

  const parseBody = (name: string, url: string, body: unknown): readonly FhirResource[] =>
    Effect.runSync(
      responseKindNamed(name).parse(
        makeCollectorHttpResponse({
          url,
          headers: [['content-type', 'application/fhir+json']],
          body: JSON.stringify(body),
        })
      )
    )

  const adoptedPatient = (): FhirResource => {
    const [resource] = parseBody('PatientResponseKind', `${ROOT_URL}/Patient/pat-7`, {
      resourceType: 'Patient',
      id: 'pat-7',
      identifier: [{ system: 'http://hospital.example/mrn', value: 'MRN-42' }],
      // A server that spells its own references absolutely — `baseUrl` is what
      // makes this rewrite rather than dangle.
      managingOrganization: { reference: `${ROOT_URL}/Organization/org-3` },
    })
    if (resource === undefined) throw new Error('the fixture yields one Patient')
    return resource
  }

  it('keys the Patient under the configured rootUrl, keeping the server id as an identifier', () => {
    const adopted = adoptedPatient()
    expect(adopted.id).toBe(localResourceId(ROOT_URL, 'Patient', 'pat-7'))
    if (adopted.resourceType !== 'Patient') throw new Error('expected a Patient')
    expect(adopted.identifier[0]?.value).toBe('pat-7')
    expect(adopted.identifier[0]?.system?.href).toBe(new URL(ROOT_URL).href)
    // The server's own identifier survives behind the injected one.
    expect(adopted.identifier[1]?.value).toBe('MRN-42')
  })

  it('rewrites an absolute self-reference as if it had been written relatively', () => {
    const adopted = adoptedPatient()
    if (adopted.resourceType !== 'Patient') throw new Error('expected a Patient')
    expect(adopted.managingOrganization?.reference).toBe(
      `Organization/${localResourceId(ROOT_URL, 'Organization', 'org-3')}`
    )
  })

  it('lands an Observation subject on the id its Patient is adopted to', () => {
    // `emr-rust`'s `$everything` searches `?subject=Patient/{id}`, so the two
    // sides have to agree after adoption, not just before it.
    const patientId = adoptedPatient().id
    const [observation] = parseBody(
      'ObservationListResponseKind',
      `${ROOT_URL}/Observation?subject%3APatient=pat-7`,
      {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [
          {
            resource: {
              resourceType: 'Observation',
              id: 'obs-1',
              status: 'final',
              code: { text: 'Weight' },
              subject: { reference: 'Patient/pat-7' },
            },
          },
        ],
      }
    )
    if (observation?.resourceType !== 'Observation') throw new Error('expected an Observation')
    expect(observation.id).toBe(localResourceId(ROOT_URL, 'Observation', 'obs-1'))
    expect(observation.subject?.reference).toBe(`Patient/${patientId}`)
  })

  it('reads the server id back off an adopted resource', () => {
    // What a follow-up generator would call to build a source-server URL.
    expect(originalIdOf({ system: ROOT_URL, baseUrl: ROOT_URL }, adoptedPatient())).toBe('pat-7')
  })
})
