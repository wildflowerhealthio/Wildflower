import { makeRemoteResponse } from 'collector-fundamentals/test-helpers'
import { Arbitrary, Duration, Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  DEFAULT_BODY_CONTENT_TYPES,
  DEFAULT_MAX_BODY_BYTES,
  defaultConfig,
  IDLE_TIMEOUT,
  InstanceConfig,
  isAbsoluteHttpUrl,
  mintSessionId,
  scrapingPlan,
  USER_DISMISS_TIMEOUT,
  WebTraceCollectorDescriptor,
} from './config.ts'

const { expectRightToEqual } = utilityExpectations(expect)

const decode = Schema.decodeUnknownEither(InstanceConfig)

describe('InstanceConfig', () => {
  it('decodes the default config', () => {
    expectRightToEqual(decode(defaultConfig), defaultConfig)
  })

  it('round-trips any schema-conformant config', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        expectRightToEqual(decode(Schema.encodeSync(InstanceConfig)(config)), config)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('treats sessionLabel as optional', () => {
    expectRightToEqual(decode(defaultConfig), defaultConfig)
    expect(decode({ ...defaultConfig, sessionLabel: 'refill flow' })._tag).toBe('Right')
  })

  it.each([
    ['a non-http scheme', { rootUrl: 'file:///etc/passwd' }],
    ['a relative URL', { rootUrl: '/portal' }],
    ['a blank URL', { rootUrl: '' }],
    ['a full media type instead of a token', { bodyContentTypes: ['application/json'] }],
    ['an upper-case token', { bodyContentTypes: ['JSON'] }],
    ['a negative size cap', { maxBodyBytes: -1 }],
    ['a fractional size cap', { maxBodyBytes: 1.5 }],
    ['an absurd size cap', { maxBodyBytes: 1024 * 1024 * 1024 }],
  ])('rejects %s', (_label, override) => {
    expect(decode({ ...defaultConfig, ...override })._tag).toBe('Left')
  })

  it.each(['https://portal.example.com', 'http://localhost:8080/login?next=/home'])(
    'accepts %s as a root URL',
    (rootUrl) => {
      expect(decode({ ...defaultConfig, rootUrl })._tag).toBe('Right')
    }
  )

  it('accepts a structured-suffix token like fhir+json', () => {
    expect(decode({ ...defaultConfig, bodyContentTypes: ['fhir+json'] })._tag).toBe('Right')
  })

  it('accepts an empty allowlist — metadata-only recording is a valid choice', () => {
    expect(decode({ ...defaultConfig, bodyContentTypes: [] })._tag).toBe('Right')
  })
})

describe('isAbsoluteHttpUrl', () => {
  it.each([
    ['https://example.com', true],
    ['http://example.com', true],
    ['file:///tmp/x', false],
    ['data:text/html,hi', false],
    ['javascript:alert(1)', false],
    ['//example.com', false],
    ['not a url', false],
  ])('%s → %s', (value, expected) => {
    expect(isAbsoluteHttpUrl(value)).toBe(expected)
  })
})

describe('defaults', () => {
  it('stores the content types a collector author reads, and no binary', () => {
    expect(DEFAULT_BODY_CONTENT_TYPES).toEqual(['json', 'text', 'html', 'xml'])
  })

  it('caps a body at 1 MiB', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(1024 * 1024)
  })
})

describe('mintSessionId', () => {
  it('is fresh per call, so two recordings of one remote never collide', () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintSessionId(defaultConfig)))
    expect(ids.size).toBe(50)
  })

  it('prefixes the label when there is one, for a legible session id', () => {
    expect(mintSessionId({ ...defaultConfig, sessionLabel: 'refill' })).toMatch(/^refill-/)
  })

  it.each([
    ['an absent label', undefined],
    ['a whitespace-only label', '   '],
  ])('emits a bare uuid for %s', (_label, sessionLabel) => {
    expect(mintSessionId({ ...defaultConfig, sessionLabel })).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })
})

describe('scrapingPlan', () => {
  it('opens the configured root URL first', () => {
    const plan = scrapingPlan({ ...defaultConfig, rootUrl: 'https://portal.example.com/login' })
    expect(plan.firstPage).toEqual({ _tag: 'Uri', uri: 'https://portal.example.com/login' })
  })

  it('hands the browser to the user: show the window, then park until they close it', () => {
    // The pairing is the whole reason this collector can exist — an empty step
    // sequence would complete on the first settled PageLoaded, before the user
    // had clicked anything.
    expect(scrapingPlan(defaultConfig).stepSequence.map((step) => step._tag)).toEqual([
      'EnsureWindowVisible',
      'AwaitUserDismiss',
    ])
  })

  it('sets the plan idle timeout above the hold’s own timeout', () => {
    // Otherwise the sync runner's silent-host guard abandons the run long
    // before the user acts, and before the hold's own bound can do its job.
    expect(Duration.toMillis(IDLE_TIMEOUT)).toBeGreaterThan(Duration.toMillis(USER_DISMISS_TIMEOUT))
    expect(scrapingPlan(defaultConfig).idleTimeout).toStrictEqual(IDLE_TIMEOUT)
  })

  it('registers exactly one entity, and it is the catch-all recorder', () => {
    const plan = scrapingPlan(defaultConfig)
    expect(plan.entityDefinitions.map((entity) => entity.name)).toEqual(['RawExchangeEntity'])
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        expect(plan.entityDefinitions.every((entity) => entity.isFoundAt(url))).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('gives each build its own session id, so two runs are two recordings', async () => {
    // Reached through the entity rather than asserted on the plan, because the
    // session id is deliberately not a plan field — it lives in the closure the
    // recording entity carries.
    const resourceIdFromAFreshBuild = async (): Promise<string | undefined> => {
      const [entity] = scrapingPlan(defaultConfig).entityDefinitions
      if (entity === undefined) throw new Error('unreachable: one entity asserted above')
      const [resource] = await Effect.runPromise(entity.parse(makeRemoteResponse({ id: 'req-1' })))
      return resource?.id ?? undefined
    }

    const [first, second] = await Promise.all([
      resourceIdFromAFreshBuild(),
      resourceIdFromAFreshBuild(),
    ])
    expect(first).toBeDefined()
    expect(first).not.toBe(second)
    // Both still end in the same request id — only the session half moved.
    expect(first?.endsWith('-req-1')).toBe(true)
    expect(second?.endsWith('-req-1')).toBe(true)
  })
})

describe('WebTraceCollectorDescriptor', () => {
  it('is registered under the web-trace tag', () => {
    expect(WebTraceCollectorDescriptor.tag).toBe('web-trace')
    expect(defaultConfig._tag).toBe('web-trace')
  })

  it('matches its own configs', () => {
    expect(
      WebTraceCollectorDescriptor.resourcePersistenceRuntimeIfMatches(defaultConfig)
    ).toBeDefined()
  })

  it.each([
    ['fhir-r4', { _tag: 'fhir-r4', rootUrl: 'https://example.com', patientId: '1' }],
    ['rexall', { _tag: 'rexall', email: 'a@b.co', password: 'x' }],
  ])('returns undefined for a %s config', (_label, config) => {
    // The guard takes `unknown` and validates structurally, which is what lets
    // the registry dispatch a stored config without a cast.
    expect(WebTraceCollectorDescriptor.resourcePersistenceRuntimeIfMatches(config)).toBeUndefined()
  })

  it('names the collector kind, not a route', () => {
    expect(WebTraceCollectorDescriptor.display.title).toBe('Web Trace')
  })

  it.each([
    ['the root URL alone when unlabelled', undefined, 'https://example.com'],
    ['the root URL and the label', 'refill flow', 'https://example.com — refill flow'],
    ['the root URL alone for an empty label', '', 'https://example.com'],
  ])('subtitles a remote with %s', (_label, sessionLabel, expected) => {
    expect(
      WebTraceCollectorDescriptor.display.listSubtitle({ ...defaultConfig, sessionLabel })
    ).toBe(expected)
  })
})
