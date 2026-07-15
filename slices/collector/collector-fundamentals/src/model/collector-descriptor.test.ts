import { Duration, Effect, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as CollectorDescriptor from './collector-descriptor.ts'
import * as ScrapingPlan from './scraping-plan.ts'

// A minimal, self-contained collector config + plan so the descriptor
// tests don't depend on any concrete `*-client-collector` package.
const SampleConfig = Schema.TaggedStruct('sample', {
  host: Schema.String.pipe(Schema.pattern(/^[a-z]+$/)),
})
type SampleConfig = typeof SampleConfig.Type

const defaultConfig: SampleConfig = { _tag: 'sample', host: 'example' }

const makeScrapingPlan = (config: SampleConfig): ScrapingPlan.ScrapingPlan<never> =>
  ScrapingPlan.make<never>({
    name: `sample:${config.host}`,
    entityDefinitions: [],
    firstPage: { _tag: 'Uri', uri: `https://${config.host}` },
    stepSequence: [],
    stepDelay: Duration.seconds(1),
  })

const descriptor = CollectorDescriptor.make({
  tag: 'sample',
  configSchema: SampleConfig,
  defaultConfig,
  makeScrapingPlan,
  display: {
    title: 'Sample',
    description: 'A sample collector',
    listSubtitle: (config) => config.host,
  },
  // The sample plan emits `never`, so these are never actually invoked;
  // they exist to satisfy the descriptor shape.
  persistResource: () => Effect.void,
  describeResource: () => ({ kind: 'sample', id: 'sample' }),
})

describe('CollectorDescriptor.make', () => {
  it('carries the authored fields through unchanged', () => {
    expect(descriptor.tag).toBe('sample')
    expect(descriptor.configSchema).toBe(SampleConfig)
    expect(descriptor.defaultConfig).toEqual(defaultConfig)
    expect(descriptor.makeScrapingPlan).toBe(makeScrapingPlan)
    expect(descriptor.display.title).toBe('Sample')
    expect(descriptor.display.description).toBe('A sample collector')
    expect(descriptor.display.listSubtitle(defaultConfig)).toBe('example')
  })

  it('deep-freezes the descriptor, its display, and its defaultConfig', () => {
    expect(Object.isFrozen(descriptor)).toBe(true)
    expect(Object.isFrozen(descriptor.display)).toBe(true)
    expect(Object.isFrozen(descriptor.defaultConfig)).toBe(true)
    expect(() => {
      // @ts-expect-error — mutating a frozen descriptor field is a type
      // error; assert the runtime freeze holds too.
      descriptor.display.title = 'mutated'
    }).toThrow()
  })

  it('does not freeze the shared config schema (a module-level export)', () => {
    // Freezing an Effect `Schema` in place would mutate the client
    // package's exported schema for every other importer.
    expect(Object.isFrozen(SampleConfig)).toBe(false)
  })
})

describe('CollectorDescriptor scrapingPlanIfMatches', () => {
  it("returns this collector's plan for one of its configs", () => {
    expect(descriptor.scrapingPlanIfMatches(defaultConfig)).toEqual(makeScrapingPlan(defaultConfig))
  })

  it('returns undefined for a config with a different tag', () => {
    expect(descriptor.scrapingPlanIfMatches({ _tag: 'other', host: 'example' })).toBeUndefined()
  })

  it('returns undefined for a structurally invalid config', () => {
    // Right tag, but `host` violates the schema pattern — the guard is
    // structural (via `Schema.is`), not tag-only.
    expect(descriptor.scrapingPlanIfMatches({ _tag: 'sample', host: 'NOT-lower' })).toBeUndefined()
  })
})

describe('CollectorDescriptor runIngredientsIfMatches', () => {
  it('delivers the plan (and persist/describe) for one of its configs', () => {
    const ingredients = descriptor.runIngredientsIfMatches(defaultConfig)
    expect(ingredients).toBeDefined()
    // The bundle holds `Resources` existential — consumers reach it only
    // through the `provide` continuation, never by naming the union.
    const plan = ingredients?.provide((bundle) => bundle.scrapingPlan)
    expect(plan).toEqual(makeScrapingPlan(defaultConfig))
  })

  it('returns undefined for a config with a different tag', () => {
    expect(descriptor.runIngredientsIfMatches({ _tag: 'other', host: 'example' })).toBeUndefined()
  })

  it('returns undefined for a structurally invalid config', () => {
    expect(
      descriptor.runIngredientsIfMatches({ _tag: 'sample', host: 'NOT-lower' })
    ).toBeUndefined()
  })
})
