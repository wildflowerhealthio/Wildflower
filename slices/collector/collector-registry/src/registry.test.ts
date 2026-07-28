import type { ScrapingPlan } from 'collector-fundamentals/model'
import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import {
  FhirR4CollectorDescriptor,
  InstanceConfig as FhirR4InstanceConfig,
  scrapingPlan as fhirR4ScrapingPlan,
} from 'fhir-r4-client-collector'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  CollectorConfig,
  CollectorTag,
  descriptorForConfig,
  descriptorForTag,
  descriptors,
  listSubtitleForConfig,
  resourcePersistenceRuntimeForConfig,
} from './registry.ts'

const { expectLeftToEqual, expectRightToEqual } = utilityExpectations(expect)

describe('CollectorTag', () => {
  it('accepts the fhir-r4 literal', () => {
    expectRightToEqual(Schema.decodeUnknownEither(CollectorTag)('fhir-r4'), 'fhir-r4')
  })

  it('rejects unsupported tags', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CollectorTag)('unsupported-collector'),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('CollectorConfig', () => {
  it('decodes a valid fhir-r4 config', () => {
    const config = Schema.decodeSync(FhirR4InstanceConfig)({
      _tag: 'fhir-r4',
      rootUrl: 'https://example.com',
      patientId: '12345',
    })

    expectRightToEqual(Schema.decodeUnknownEither(CollectorConfig)(config), config)
  })

  it('round-trips any schema-conformant config', () => {
    fc.assert(
      fc.property(Arbitrary.make(CollectorConfig), (config) => {
        const encoded = Schema.encodeSync(CollectorConfig)(config)
        expect(Schema.decodeSync(CollectorConfig)(encoded)).toEqual(config)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects unknown collector tags', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(CollectorConfig)({
        _tag: 'unknown-collector',
        rootUrl: 'https://example.com',
        patientId: '12345',
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})

describe('resourcePersistenceRuntimeForConfig', () => {
  // The context holds the resource union existential; reach the plan only
  // through a `run` program, never by naming the union.
  const planFor = (config: typeof CollectorConfig.Type): ScrapingPlan.ScrapingPlan<unknown> =>
    resourcePersistenceRuntimeForConfig(config).run((context) => context.scrapingPlan)

  /**
   * The parts of a plan that identify *which collector built it for which
   * config*, with the per-build parts projected away.
   *
   * Every plan factory is deterministic given `(config, runId)` — the
   * framework mints the id at dispatch — but the runtime's id is fresh per
   * `resourcePersistenceRuntimeIfMatches` call, and `web-trace-collector`'s
   * recording entity closes over a session id derived from it. Two dispatches
   * of the same config therefore differ by that closure, so the union-wide
   * sweep below compares an identity projection. (The per-collector suites
   * deep-equal plans against a fixed run id.)
   *
   * What survives the projection still fails loudly on a mis-dispatch: a plan
   * from the wrong descriptor has a different `name`, different entity names,
   * and a `firstPage` derived from a different config field.
   */
  const planIdentity = (
    plan: ScrapingPlan.ScrapingPlan<unknown>
  ): Record<string, unknown> | undefined => ({
    name: plan.name,
    firstPage: plan.firstPage,
    stepNames: plan.stepSequence.map((step) => `${step._tag}:${step.name}`),
    entityNames: plan.entityDefinitions.map((entity) => entity.name),
  })

  it('dispatches fhir-r4 configs to the fhir-r4 scraping plan', () => {
    // Decode through the concrete fhir-r4 schema so `config` is the fhir-r4
    // type `fhirR4ScrapingPlan` expects (the `CollectorConfig` union is now
    // wider than a single collector).
    const config = Schema.decodeSync(FhirR4InstanceConfig)({
      _tag: 'fhir-r4',
      rootUrl: 'https://example.com',
      patientId: '12345',
    })

    // The fhir-r4 factory is deterministic given `(config, runId)` and its
    // function-valued plan fields are module singletons, so the dispatched
    // plan deep-equals one built directly with the runtime's own run id.
    const runtime = resourcePersistenceRuntimeForConfig(config)
    expect(runtime.run((context) => context.scrapingPlan)).toEqual(
      runtime.run((context) => fhirR4ScrapingPlan(config, context.runId))
    )
  })

  it('dispatches every schema-conformant config to its descriptor plan', () => {
    // The dispatch must route by the config's own tag for any collector
    // in the list, not just the hardcoded fhir-r4 example above.
    fc.assert(
      fc.property(Arbitrary.make(CollectorConfig), (config) => {
        const descriptor = descriptorForConfig(config)
        expect(descriptor).toBeDefined()
        // `descriptor` is union-typed here, so its config-parameterized
        // `makeScrapingPlan` isn't directly callable; reach the same plan via
        // the descriptor's own narrowing guard (which validates the config
        // against its concrete schema), pinning that the tag lookup and the
        // schema-guard dispatch agree.
        const descriptorPlan = descriptor
          ?.resourcePersistenceRuntimeIfMatches(config)
          ?.run((context) => context.scrapingPlan)
        expect(planIdentity(planFor(config))).toEqual(
          descriptorPlan === undefined ? undefined : planIdentity(descriptorPlan)
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('listSubtitleForConfig', () => {
  it('renders the fhir-r4 subtitle from the configured rootUrl', () => {
    const config = Schema.decodeSync(CollectorConfig)({
      _tag: 'fhir-r4',
      rootUrl: 'https://example.com',
      patientId: '12345',
    })
    expect(listSubtitleForConfig(config)).toBe('https://example.com')
  })

  it('renders the rexall subtitle from the configured account email', () => {
    const config = Schema.decodeSync(CollectorConfig)({
      _tag: 'rexall',
      email: 'member@rexall.test',
      password: 'secret',
    })
    expect(listSubtitleForConfig(config)).toBe('member@rexall.test')
  })
})

describe('descriptors', () => {
  it('assigns each collector a distinct tag', () => {
    // A tag collision would make the derived union / dispatch ambiguous;
    // pin uniqueness so adding a colliding descriptor fails here.
    const tags = descriptors.map((descriptor) => descriptor.tag)
    expect(new Set(tags).size).toBe(tags.length)
  })

  it('includes the fhir-r4 descriptor', () => {
    expect(descriptors).toContain(FhirR4CollectorDescriptor)
  })
})

describe('descriptorForTag / descriptorForConfig', () => {
  it('resolves the fhir-r4 tag to its descriptor', () => {
    expect(descriptorForTag('fhir-r4')).toBe(FhirR4CollectorDescriptor)
  })

  it('resolves a stored config to its descriptor by _tag', () => {
    const config = Schema.decodeSync(CollectorConfig)({
      _tag: 'fhir-r4',
      rootUrl: 'https://example.com',
      patientId: '12345',
    })
    expect(descriptorForConfig(config)).toBe(FhirR4CollectorDescriptor)
  })
})
