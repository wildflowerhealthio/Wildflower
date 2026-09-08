import { makeCollectorHttpResponse } from 'collector-fundamentals/test-helpers'
import { Arbitrary, Duration, Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { localResourceId } from 'fhir-r4/identity'
import { type FhirResource, Patient } from 'fhir-r4/resources'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import { traceResourceId } from 'web-trace-core'

import { LIFELABS_SYSTEM, lifeLabsSource } from 'lifelabs-source'
import {
  InstanceConfig,
  LifeLabsCollectorDescriptor,
  defaultConfig,
  scrapingPlan,
} from './config.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

/**
 * The factory is deterministic given `(config, runId)` and its function-valued
 * fields (the kinds, the provenance hook) are module-level singletons, so plans
 * from one config deep-equal each other.
 */
const FIXED_RUN_ID = 'test-run'

/** A minimal decoded Patient for exercising the provenance hook's wiring. */
const patient = Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id: 'p1' })

describe('InstanceConfig', () => {
  it('decodes defaultConfig without error', () => {
    expectRightToEqual(Schema.decodeUnknownEither(InstanceConfig)(defaultConfig), defaultConfig)
  })

  it('round-trips any schema-conformant username and password', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const encoded = Schema.encodeSync(InstanceConfig)(config)
        expect(Schema.decodeSync(InstanceConfig)(encoded)).toEqual(config)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('accepts a plain (non-email) username', () => {
    expectRightToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({
        _tag: 'lifelabs',
        username: 'jdoe42',
        password: 'pw',
      }),
      { _tag: 'lifelabs', username: 'jdoe42', password: 'pw' }
    )
  })

  it('rejects missing username', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'lifelabs', password: 'pw' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects missing password', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'lifelabs', username: 'a@b.com' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it.each(['', 'has space', ' leading', 'trailing ', 'tab\tinside', 'x'.repeat(255)])(
    'rejects malformed username %j',
    (username) => {
      expectLeftToEqual(
        Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'lifelabs', username, password: 'pw' }),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    }
  )

  it.each([['' /* empty */], ['x'.repeat(257) /* over-long */]])(
    'rejects malformed password (len %s)',
    (password) => {
      expectLeftToEqual(
        Schema.decodeUnknownEither(InstanceConfig)({
          _tag: 'lifelabs',
          username: 'a@b.com',
          password,
        }),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    }
  )
})

describe('defaultConfig', () => {
  it('is a harmless, valid placeholder', () => {
    expect(defaultConfig).toEqual({
      _tag: 'lifelabs',
      username: 'you@example.com',
      password: 'your-password',
    })
  })
})

describe('LifeLabsCollectorDescriptor', () => {
  it('bundles the lifelabs schema, default, and plan factory', () => {
    expect(LifeLabsCollectorDescriptor.tag).toBe('lifelabs')
    expect(LifeLabsCollectorDescriptor.configSchema).toBe(InstanceConfig)
    expect(LifeLabsCollectorDescriptor.defaultConfig).toEqual(defaultConfig)
    // The framework mints the run id; this factory ignores it, so the plan is a
    // pure function of config.
    expect(LifeLabsCollectorDescriptor.makeScrapingPlan(defaultConfig, FIXED_RUN_ID)).toEqual(
      scrapingPlan(defaultConfig, FIXED_RUN_ID)
    )
  })

  it('exposes kind-level display strings', () => {
    expect(LifeLabsCollectorDescriptor.display.title).toBe('LifeLabs')
    expect(LifeLabsCollectorDescriptor.display.description).toBe(
      'Lab results from LifeLabs MyCareCompass (mycarecompass.lifelabs.com)'
    )
  })

  it('derives the list subtitle from the configured account username', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        expect(LifeLabsCollectorDescriptor.display.listSubtitle(config)).toBe(config.username)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('matches its own configs and rejects foreign ones via resourcePersistenceRuntimeIfMatches', () => {
    const runtime = LifeLabsCollectorDescriptor.resourcePersistenceRuntimeIfMatches(defaultConfig)
    expect(runtime?.run((context) => context.scrapingPlan)).toEqual(
      scrapingPlan(defaultConfig, FIXED_RUN_ID)
    )
    expect(
      LifeLabsCollectorDescriptor.resourcePersistenceRuntimeIfMatches({
        _tag: 'fhir-r4',
        rootUrl: 'https://x',
      })
    ).toBeUndefined()
  })

  it('renders the username subtitle for its own config via listSubtitleIfMatches', () => {
    expect(
      LifeLabsCollectorDescriptor.listSubtitleIfMatches({
        _tag: 'lifelabs',
        username: 'member@lifelabs.test',
        password: 'pw',
      })
    ).toBe('member@lifelabs.test')
    expect(
      LifeLabsCollectorDescriptor.listSubtitleIfMatches({ _tag: 'fhir-r4', rootUrl: 'https://x' })
    ).toBeUndefined()
  })
})

describe('scrapingPlan', () => {
  it('opens the analytics page as its first step — signed out, the SPA bounces to the login', () => {
    const plan = scrapingPlan(defaultConfig, FIXED_RUN_ID)
    expect(plan.stepSequence[0]).toEqual({
      _tag: 'Navigation',
      name: 'Opening lab results',
      action: {
        _tag: 'Open',
        source: { _tag: 'Uri', uri: 'https://www.on.mycarecompass.lifelabs.com/analytics' },
      },
    })
  })

  it('consumes the source package’s pre-adopted kinds by reference', () => {
    expect(scrapingPlan(defaultConfig, FIXED_RUN_ID).responseKinds).toBe(
      lifeLabsSource.responseKinds
    )
  })

  it('opens results, autofills the IdentityServer login, holds for the captcha login, reopens results, and settles', () => {
    const plan = scrapingPlan(
      { _tag: 'lifelabs', username: 'a@b.com', password: 'secret' },
      FIXED_RUN_ID
    )
    expect(plan.stepSequence).toEqual([
      {
        _tag: 'Navigation',
        name: 'Opening lab results',
        action: {
          _tag: 'Open',
          source: { _tag: 'Uri', uri: 'https://www.on.mycarecompass.lifelabs.com/analytics' },
        },
      },
      // The portal's own IdentityServer, not myvisit.lifelabs.com (the
      // separate appointment-booking product).
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for login page',
        pattern: /:\/\/login\.on\.mycarecompass\.lifelabs\.com\//,
        timeout: Duration.seconds(30),
        continueOnTimeout: true,
      },
      { _tag: 'Delay', name: 'Waiting to enter username', duration: Duration.seconds(2) },
      {
        _tag: 'Navigation',
        name: 'Entering username',
        action: {
          _tag: 'PageAction',
          action: {
            kind: 'Fill',
            querySelector: 'input[type="email"], input[name="Username"], input[name="username"]',
            value: 'a@b.com',
          },
        },
      },
      { _tag: 'Delay', name: 'Waiting to enter password', duration: Duration.seconds(0.25) },
      {
        _tag: 'Navigation',
        name: 'Entering password',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: 'input[type="password"]', value: 'secret' },
        },
      },
      // No submit Click: the captcha means the user completes the login, and
      // the run parks on the OIDC callback *arriving* back on the portal host
      // (the SPA then routes client-side, so a settle would be the wrong hold)
      // for minutes, not seconds.
      {
        _tag: 'AwaitPageRequested',
        name: 'Waiting for you to solve the captcha and log in',
        pattern: /:\/\/www\.on\.mycarecompass\.lifelabs\.com\//,
        timeout: Duration.minutes(5),
      },
      {
        _tag: 'Navigation',
        name: 'Reopening lab results',
        action: {
          _tag: 'Open',
          source: { _tag: 'Uri', uri: 'https://www.on.mycarecompass.lifelabs.com/analytics' },
        },
      },
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for lab results to settle',
        pattern: /:\/\/(?:www\.)?on\.mycarecompass\.lifelabs\.com\/analytics/,
        timeout: Duration.seconds(30),
      },
      { _tag: 'Delay', name: 'Done, waiting just a little longer', duration: Duration.seconds(8) },
    ])
  })

  it('never clicks a submit button — the captcha hands the login to the user', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const clicks = scrapingPlan(config, FIXED_RUN_ID).stepSequence.filter(
          (step) =>
            step._tag === 'Navigation' &&
            step.action._tag === 'PageAction' &&
            step.action.action.kind === 'Click'
        )
        expect(clicks).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('only ever opens the user-facing portal page, never the API or login host', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const opened = scrapingPlan(config, FIXED_RUN_ID).stepSequence.flatMap((step) =>
          step._tag === 'Navigation' &&
          step.action._tag === 'Open' &&
          step.action.source._tag === 'Uri'
            ? [new URL(step.action.source.uri).host]
            : []
        )
        expect(opened).toEqual([
          'www.on.mycarecompass.lifelabs.com',
          'www.on.mycarecompass.lifelabs.com',
        ])
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('states the provenance hook, which mints lifelabs-prefixed session ids', async () => {
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
      traceResourceId({ sessionId: 'lifelabs-test-run', requestId: 'req-1' }),
    ])
  })

  it('interpolates the config credentials into the login fills', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const fills = scrapingPlan(config, FIXED_RUN_ID).stepSequence.flatMap((step) =>
          step._tag === 'Navigation' &&
          step.action._tag === 'PageAction' &&
          step.action.action.kind === 'Fill'
            ? [step.action.action.value]
            : []
        )
        expect(fills).toEqual([config.username, config.password])
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

/**
 * The plan's kind as the framework sees it — pre-adopted in `lifelabs-source`.
 * The source suite pins the portal-JSON → R4 synthesis; this pins that the
 * live plan hands the framework the adopted output (re-keyed under a derived
 * local id, subject rewritten).
 */
describe('source identity', () => {
  const SUMMARY_URL = 'https://on-api.mycarecompass.lifelabs.com/api/Report/GetAnalyticSummary'

  const parseThrough = (): readonly FhirResource[] => {
    const [kind] = scrapingPlan(defaultConfig, FIXED_RUN_ID).responseKinds
    if (kind === undefined) throw new Error('expected a response kind')
    return Effect.runSync(
      kind.parse(
        makeCollectorHttpResponse({
          url: SUMMARY_URL,
          body: JSON.stringify({
            entity: {
              selectedPatient: '31653025',
              patients: [{ text: 'Test Patient', value: '31653025', isPrimary: true }],
              analytics: [
                { testCode: 'TRX', testItemId: 'AAAA', testItemName: 'X', testResultValue: '1' },
              ],
            },
          }),
        })
      )
    )
  }

  it('keys the Patient and Observation under derived local ids and rewrites the subject', () => {
    const resources = parseThrough()
    const patientId = localResourceId(LIFELABS_SYSTEM, 'Patient', '31653025')
    const observation = resources.find((r) => r.resourceType === 'Observation')
    if (observation?.resourceType !== 'Observation') throw new Error('expected an Observation')

    expect(resources.find((r) => r.resourceType === 'Patient')?.id).toBe(patientId)
    expect(observation.id).toBe(localResourceId(LIFELABS_SYSTEM, 'Observation', 'AAAA'))
    expect(observation.subject?.reference).toBe(`Patient/${patientId}`)
  })
})
