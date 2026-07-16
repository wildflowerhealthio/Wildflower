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

  it('dispatches fhir-r4 configs to the fhir-r4 scraping plan', () => {
    const config = Schema.decodeSync(CollectorConfig)({
      _tag: 'fhir-r4',
      rootUrl: 'https://example.com',
      patientId: '12345',
    })

    // The plan factory is per-config so structural equality stands in
    // for identity. Same `name` + same step sequence + a `firstPage`
    // pointed at the configured patientUrl pin the dispatch.
    expect(planFor(config)).toEqual(fhirR4ScrapingPlan(config))
  })

  it('dispatches every schema-conformant config to its descriptor plan', () => {
    // The dispatch must route by the config's own tag for any collector
    // in the list, not just the hardcoded fhir-r4 example above.
    fc.assert(
      fc.property(Arbitrary.make(CollectorConfig), (config) => {
        const descriptor = descriptorForConfig(config)
        expect(descriptor).toBeDefined()
        expect(planFor(config)).toEqual(descriptor?.makeScrapingPlan(config))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
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
