import type { ScrapingPlan } from 'collector-fundamentals/model'
import { Arbitrary, Duration, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { InstanceConfig, RexallCollectorDescriptor, defaultConfig, scrapingPlan } from './config.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

/**
 * The parts of a plan that identify *which factory built it for which config*,
 * with the per-build parts projected away.
 *
 * `scrapingPlan` mints a fresh provenance run id per build and closes both
 * entities over it, so two builds from one config are structurally unequal by
 * construction (different id, different capturing `parse` closure). Deep
 * equality would assert "the factory is pure", which is deliberately no longer
 * true — see the `scrapingPlan` remarks and the plan-purity trap in
 * [slices/collector/AGENTS.md](../../AGENTS.md). Everything a wrong factory
 * would get wrong survives the projection: the plan name, the entity names, the
 * step sequence (which carries the configured credentials), and `firstPage`.
 */
const planIdentity = (plan: ScrapingPlan.ScrapingPlan<unknown>): Record<string, unknown> => ({
  name: plan.name,
  firstPage: plan.firstPage,
  steps: plan.stepSequence,
  entityNames: plan.entityDefinitions.map((entity) => entity.name),
})

describe('InstanceConfig', () => {
  it('decodes defaultConfig without error', () => {
    expectRightToEqual(Schema.decodeUnknownEither(InstanceConfig)(defaultConfig), defaultConfig)
  })

  it('round-trips any schema-conformant email and password', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const encoded = Schema.encodeSync(InstanceConfig)(config)
        expect(Schema.decodeSync(InstanceConfig)(encoded)).toEqual(config)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects missing email', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'rexall', password: 'pw' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects missing password', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'rexall', email: 'a@b.com' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it.each([
    '',
    'not-an-email',
    '@example.com',
    'a@b',
    'no-domain@',
    'has space@example.com',
    'a@ex ample.com',
  ])('rejects malformed email %j', (email) => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'rexall', email, password: 'pw' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it.each([['' /* empty */], ['x'.repeat(257) /* over-long */]])(
    'rejects malformed password (len %s)',
    (password) => {
      expectLeftToEqual(
        Schema.decodeUnknownEither(InstanceConfig)({
          _tag: 'rexall',
          email: 'a@b.com',
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
      _tag: 'rexall',
      email: 'you@example.com',
      password: 'your-password',
    })
  })
})

describe('RexallCollectorDescriptor', () => {
  it('bundles the rexall schema, default, and plan factory', () => {
    expect(RexallCollectorDescriptor.tag).toBe('rexall')
    expect(RexallCollectorDescriptor.configSchema).toBe(InstanceConfig)
    expect(RexallCollectorDescriptor.defaultConfig).toEqual(defaultConfig)
    // An identity projection of a produced plan stands in for identity — the
    // factory is per-run impure; see `planIdentity`.
    expect(planIdentity(RexallCollectorDescriptor.makeScrapingPlan(defaultConfig))).toEqual(
      planIdentity(scrapingPlan(defaultConfig))
    )
  })

  it('exposes kind-level display strings', () => {
    expect(RexallCollectorDescriptor.display.title).toBe('Rexall')
    expect(RexallCollectorDescriptor.display.description).toBe(
      'Prescriptions from Rexall Be Well (letsbewell.ca)'
    )
  })

  it('derives the list subtitle from the configured account email', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        expect(RexallCollectorDescriptor.display.listSubtitle(config)).toBe(config.email)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('matches its own configs and rejects foreign ones via resourcePersistenceRuntimeIfMatches', () => {
    const runtime = RexallCollectorDescriptor.resourcePersistenceRuntimeIfMatches(defaultConfig)
    expect(runtime?.run((context) => planIdentity(context.scrapingPlan))).toEqual(
      planIdentity(scrapingPlan(defaultConfig))
    )
    expect(
      RexallCollectorDescriptor.resourcePersistenceRuntimeIfMatches({
        _tag: 'fhir-r4',
        rootUrl: 'https://x',
      })
    ).toBeUndefined()
  })

  it('renders the account-email subtitle for its own config via listSubtitleIfMatches', () => {
    expect(
      RexallCollectorDescriptor.listSubtitleIfMatches({
        _tag: 'rexall',
        email: 'member@rexall.test',
        password: 'pw',
      })
    ).toBe('member@rexall.test')
    expect(
      RexallCollectorDescriptor.listSubtitleIfMatches({ _tag: 'fhir-r4', rootUrl: 'https://x' })
    ).toBeUndefined()
  })
})

describe('scrapingPlan', () => {
  it('mounts the letsbewell login page as the first page', () => {
    const plan = scrapingPlan(defaultConfig)
    expect(plan.firstPage).toEqual({ _tag: 'Uri', uri: 'https://letsbewell.ca/sign-in' })
  })

  it('scripts login (fill/fill/click), holds for the redirect, opens prescriptions, and settles', () => {
    const plan = scrapingPlan({ _tag: 'rexall', email: 'a@b.com', password: 'secret' })
    expect(plan.stepSequence).toEqual([
      { _tag: 'Delay', name: 'Waiting for login page', duration: Duration.seconds(2) },
      {
        _tag: 'Navigation',
        name: 'Entering email',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: 'input[type="email"]', value: 'a@b.com' },
        },
      },
      { _tag: 'Delay', name: 'Pausing before password', duration: Duration.seconds(0.25) },
      {
        _tag: 'Navigation',
        name: 'Entering password',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: 'input[type="password"]', value: 'secret' },
        },
      },
      { _tag: 'Delay', name: 'Pausing before submit', duration: Duration.seconds(0.25) },
      {
        _tag: 'Navigation',
        name: 'Submitting login',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Click', querySelector: 'button[type="submit"]' },
        },
      },
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for logged-in page',
        pattern: /:\/\/app\.letsbewell\.ca/,
        timeout: Duration.seconds(30),
      },
      {
        _tag: 'Navigation',
        name: 'Opening prescriptions',
        action: {
          _tag: 'Open',
          source: { _tag: 'Uri', uri: 'https://app.letsbewell.ca/health/prescriptions' },
        },
      },
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for prescriptions to load',
        pattern: /:\/\/app\.letsbewell\.ca\/health\/prescriptions/,
        timeout: Duration.seconds(30),
      },
      { _tag: 'Delay', name: 'Collecting prescriptions', duration: Duration.seconds(8) },
    ])
  })

  it('interpolates the config credentials into the login fills', () => {
    const plan = scrapingPlan({ _tag: 'rexall', email: 'user@rexall.test', password: 'hunter2' })
    const fills = plan.stepSequence.flatMap((step) =>
      step._tag === 'Navigation' &&
      step.action._tag === 'PageAction' &&
      step.action.action.kind === 'Fill'
        ? [step.action.action.value]
        : []
    )
    expect(fills).toEqual(['user@rexall.test', 'hunter2'])
  })
})
