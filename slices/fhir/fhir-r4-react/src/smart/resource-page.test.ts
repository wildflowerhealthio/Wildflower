import { Observation } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import {
  Arbitrary,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  TestClock,
  TestContext,
} from 'effect'
import * as fc from 'fast-check'
import type Client from 'fhirclient/lib/Client'
import HttpError from 'fhirclient/lib/HttpError'
import { describe, expect, test, vi } from 'vite-plus/test'

import {
  BundleDecodeError,
  ResourcePageCycleError,
  ResourcePageRequestError,
  fetchAllResourcePages,
  fetchResourcePage,
  type PagedResourceRead,
  type ResourcePage,
  type ResourcePageCursor,
} from './resource-page.ts'
import { stubSmartClient } from './stub-smart-client.test-helpers.ts'

type ObservationType = Schema.Schema.Type<typeof Observation.Schema>
type ObservationEncoded = Schema.Schema.Encoded<typeof Observation.Schema>

// The reader under test is resource-agnostic; `Observation` stands in for "some
// resource" because it is the read this module was generalised for, and its
// schema carries the interesting decode case (a defaulted `status`).
const observationRead: PagedResourceRead<ObservationType, ObservationEncoded, string> = {
  resourceType: 'Observation',
  schema: Observation.Schema,
  firstPageQuery: (patientId: string): string => `patient=${encodeURIComponent(patientId)}`,
}

const decodeObservation = Schema.decodeUnknownOption(Observation.Schema)
const encodeObservation = Schema.encodeSync(Observation.Schema)

/** One generated `entry.resource`, carrying whether it is expected to decode. */
interface GeneratedEntry {
  readonly decodable: boolean
  /** The `id` a decodable entry must surface as, or `null` when it is dropped. */
  readonly id: string | null
  readonly resource: unknown
}

/**
 * A decodable `Observation` on the wire, identified by the `id` it was generated
 * from. `id` and `status` come from the resource's own schemas — `status` from
 * `Observation.StatusSchema` — so the rows track the schema's value set rather
 * than a hand-listed copy of it. `code` is the only other element the schema
 * requires; an empty CodeableConcept is the smallest valid one.
 */
const decodableEntryArb: fc.Arbitrary<GeneratedEntry> = Arbitrary.make(
  Schema.Struct({ id: Schema.String, status: Observation.StatusSchema })
).map(({ id, status }) => ({
  decodable: true,
  id,
  resource: { resourceType: 'Observation', id, status, code: {} },
}))

/**
 * Wire values that are *not* decodable `Observation`s: an absent
 * `entry.resource`, assorted non-resources, a resource of another type, an
 * `Observation` missing the required `code`, and one whose `code` is not a
 * CodeableConcept. The property below re-checks every one against the schema, so
 * a schema change that makes one of these decodable fails the test rather than
 * silently weakening the "undecodable rows are dropped" claim.
 */
const UNDECODABLE_RESOURCES: readonly unknown[] = [
  undefined,
  null,
  'not a resource',
  42,
  {},
  { malformed: true },
  { resourceType: 'Patient', id: 'pat-1' },
  { resourceType: 'Observation', id: 'obs-1', status: 'final' },
  { resourceType: 'Observation', id: 'obs-1', status: 'final', code: 'not-a-concept' },
]

const undecodableEntryArb: fc.Arbitrary<GeneratedEntry> = fc
  .constantFrom(...UNDECODABLE_RESOURCES)
  .map((resource) => ({ decodable: false, id: null, resource }))

const entryArb = fc.oneof(decodableEntryArb, undecodableEntryArb)

/** A bundle `link` array paired with the `nextPageUrl` it must produce. */
interface LinkCase {
  /** The bundle's `link` value; `undefined` omits the key entirely. */
  readonly link: unknown
  readonly expectedNext: string | null
}

const SELF_LINK = { relation: 'self', url: 'https://fhir.example/Observation' }

/**
 * Every way a page can fail to name a next cursor: no `link` key, an explicit
 * `null`, an empty array, links that include no `next`, and a `next` whose `url`
 * is absent, `null` or empty.
 */
const CURSORLESS_LINK_CASES: readonly LinkCase[] = [
  { link: undefined, expectedNext: null },
  { link: null, expectedNext: null },
  { link: [], expectedNext: null },
  { link: [SELF_LINK], expectedNext: null },
  { link: [SELF_LINK, { relation: 'next' }], expectedNext: null },
  { link: [SELF_LINK, { relation: 'next', url: null }], expectedNext: null },
  { link: [SELF_LINK, { relation: 'next', url: '' }], expectedNext: null },
]

const linkCaseArb: fc.Arbitrary<LinkCase> = fc.oneof(
  fc.constantFrom(...CURSORLESS_LINK_CASES),
  fc.webUrl().map((url) => ({
    link: [SELF_LINK, { relation: 'next', url }],
    expectedNext: url,
  }))
)

/** A searchset bundle carrying `resources`; `link: undefined` omits the key. */
const bundle = (resources: readonly unknown[], link: unknown): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  ...(link === undefined ? {} : { link }),
})

/**
 * What `fetch` rejects with when no HTTP response arrived, as each browser words
 * it: Firefox, Chrome, Safari. The reader must recognise all of them by type.
 */
const DROPPED_REQUEST_MESSAGES = [
  'NetworkError when attempting to fetch resource.',
  'Failed to fetch',
  'Load failed',
] as const

const droppedRequestArb: fc.Arbitrary<TypeError> = fc
  .constantFrom(...DROPPED_REQUEST_MESSAGES)
  .map((message) => new TypeError(message))

/**
 * A rejection fhirclient gives for an HTTP error response: the `HttpError` its
 * `checkResponse` throws for any response that is not `ok`.
 */
const httpError = (status: number): HttpError =>
  new HttpError(new Response(null, { status, statusText: `status ${status}` }))

/**
 * A stub fhirclient `Client` whose `request` rejects with each of `failures` in
 * turn and then resolves to `response`, counting the attempts it was asked for.
 */
const flakySmartClient = (
  failures: readonly unknown[],
  response: unknown
): { readonly client: Client; readonly attempts: () => number } => {
  let attempts = 0
  const client = {
    request: (): Promise<unknown> => {
      const failure = failures[attempts]
      attempts += 1
      return failure === undefined ? Promise.resolve(response) : Promise.reject(failure)
    },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only stub, only `request` is exercised
  } as unknown as Client
  return { client, attempts: () => attempts }
}

/**
 * Run `effect` on `TestClock`, advancing it 2 s — past the whole retry backoff
 * (250 + 500 + 1000 ms) — so retried reads don't wait on the real clock.
 */
const runOnTestClock = <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(effect)
      yield* TestClock.adjust(Duration.seconds(2))
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestContext.TestContext))
  )

describe('fetchResourcePage', () => {
  test('property: a page yields exactly its decodable entries, in order, and the next cursor', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(entryArb, { maxLength: 8 }),
        linkCaseArb,
        async (entries, linkCase) => {
          const { client } = stubSmartClient(
            bundle(
              entries.map((entry) => entry.resource),
              linkCase.link
            )
          )

          const page = await Effect.runPromise(
            fetchResourcePage(client, observationRead, { first: 'pat-1' })
          )

          // Each fixture really is (un)decodable — otherwise the assertions
          // below would hold for a reason that is not the reader's doing.
          for (const entry of entries) {
            expect(Option.isSome(decodeObservation(entry.resource))).toBe(entry.decodable)
          }

          const expectedIds = entries.filter((entry) => entry.decodable).map((entry) => entry.id)
          expect(page.items.map((item) => item.id)).toEqual(expectedIds)
          expect(page.nextPageUrl).toBe(linkCase.expectedNext)

          const expectedDropped = entries.filter((entry) => !entry.decodable).length
          expect(page.droppedEntryCount).toBe(expectedDropped)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test("property: the first page is the read's resource type joined to its own query", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z]{1,20}$/u),
        fc.string(),
        fc.string(),
        async (resourceType, first, paramName) => {
          // A verified mock: the query it returns is reachable only through the
          // `first` the cursor carried.
          const firstPageQuery = vi.fn((value: string): string => `${paramName}=${value}`)
          const { client, queries } = stubSmartClient(bundle([], undefined))

          await Effect.runPromise(
            fetchResourcePage(
              client,
              { resourceType, schema: Observation.Schema, firstPageQuery },
              { first }
            )
          )

          expect(firstPageQuery).toHaveBeenCalledWith(first)
          expect(queries).toEqual([`${resourceType}?${paramName}=${first}`])
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: a later page is requested by its cursor URL verbatim', async () => {
    await fc.assert(
      fc.asyncProperty(fc.webUrl(), async (pageUrl) => {
        const firstPageQuery = vi.fn((patientId: string): string => patientId)
        const { client, queries } = stubSmartClient(bundle([], undefined))

        await Effect.runPromise(
          fetchResourcePage(client, { ...observationRead, firstPageQuery }, { pageUrl })
        )

        // The server's own `next` link is used as-is — no re-derivation of
        // scope, sort or page size, so the first-page query is never consulted.
        expect(queries).toEqual([pageUrl])
        expect(firstPageQuery).not.toHaveBeenCalled()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test.each([null, undefined, 'a string', 42, true])(
    'a response that is not a bundle fails with BundleDecodeError: %p',
    async (response) => {
      const { client } = stubSmartClient(response)

      const exit = await Effect.runPromiseExit(
        fetchResourcePage(client, observationRead, { first: 'pat-1' })
      )

      expect(exit._tag).toBe('Failure')
      if (exit._tag === 'Failure') {
        const error = exit.cause._tag === 'Fail' ? exit.cause.error : undefined
        expect(error).toBeInstanceOf(BundleDecodeError)
        if (error instanceof BundleDecodeError) {
          expect(error.response).toBe(response)
        }
      }
    }
  )

  test('a request failure surfaces as ResourcePageRequestError', async () => {
    const requestError = new Error('network down')
    const { client } = stubSmartClient(null)
    // Override the stub's request to reject
    client.request = () => Promise.reject(requestError)

    const exit = await Effect.runPromiseExit(
      fetchResourcePage(client, observationRead, { first: 'pat-1' })
    )

    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure') {
      const error = exit.cause._tag === 'Fail' ? exit.cause.error : undefined
      expect(error).toBeInstanceOf(ResourcePageRequestError)
      if (error instanceof ResourcePageRequestError) {
        expect(error.cause).toBe(requestError)
      }
    }
  })

  test('property: a request the network dropped is retried, and the retry returns the page', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(droppedRequestArb, { minLength: 1, maxLength: 3 }),
        async (drops) => {
          const { client, attempts } = flakySmartClient(
            drops,
            bundle([{ resourceType: 'Observation', id: 'obs-1', status: 'final', code: {} }], [])
          )

          const exit = await runOnTestClock(
            fetchResourcePage(client, observationRead, { first: 'pat-1' })
          )

          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isSuccess(exit)) {
            expect(exit.value.items.map((item) => item.id)).toEqual(['obs-1'])
          }
          expect(attempts()).toBe(drops.length + 1)
        }
      ),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  test('a request the network keeps dropping fails after its retries, carrying the last cause', async () => {
    const drops = [1, 2, 3, 4, 5].map((attempt) => new TypeError(`Failed to fetch (${attempt})`))
    const { client, attempts } = flakySmartClient(drops, bundle([], undefined))

    const exit = await runOnTestClock(
      fetchResourcePage(client, observationRead, { first: 'pat-1' })
    )

    // One initial attempt + three retries.
    expect(attempts()).toBe(4)
    expect(exit).toEqual(Exit.fail(new ResourcePageRequestError({ cause: drops[3] })))
  })

  test.each([
    { name: 'HTTP 401', cause: httpError(401) },
    { name: 'HTTP 403', cause: httpError(403) },
    { name: 'HTTP 404', cause: httpError(404) },
    { name: 'HTTP 500', cause: httpError(500) },
    {
      name: 'an aborted request',
      cause: new DOMException('The operation was aborted.', 'AbortError'),
    },
  ])('$name fails at once, without a retry', async ({ cause }) => {
    const { client, attempts } = flakySmartClient([cause, cause], bundle([], undefined))

    const exit = await runOnTestClock(
      fetchResourcePage(client, observationRead, { first: 'pat-1' })
    )

    expect(attempts()).toBe(1)
    expect(exit).toEqual(Exit.fail(new ResourcePageRequestError({ cause })))
  })

  test('a fully-populated Observation survives the page element-for-element', async () => {
    // The generated rows above are minimal by design: a whole-schema arbitrary
    // costs roughly half a second per resource, far too much for a property.
    // Two seeded whole-resource samples keep the wire path covered end to end —
    // every element the schema can carry, out through encode and back through
    // the page's decode.
    const samples = fc.sample(Arbitrary.make(Observation.Schema), { numRuns: 2, seed: 573 })

    await Promise.all(
      samples.map(async (observation) => {
        const wire = encodeObservation(observation)
        const { client } = stubSmartClient(bundle([wire], undefined))

        const page = await Effect.runPromise(
          fetchResourcePage(client, observationRead, { first: 'pat-1' })
        )

        expect(page.items).toHaveLength(1)
        // Re-encoded rather than compared as decoded values: the decoded form
        // holds `URL` and `DateTime.Utc` instances, which structural equality
        // cannot tell apart.
        expect(page.items.map((item) => encodeObservation(item))).toEqual([wire])
      })
    )
  })
})

describe('fetchAllResourcePages', () => {
  test('property: reads every page in order, joining their items and summing their dropped entries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ items: fc.array(fc.nat()), dropped: fc.nat({ max: 3 }) }), {
          minLength: 1,
          maxLength: 6,
        }),
        async (pages) => {
          // Arrange — page `n` links to page `n + 1`; the last links nowhere
          const cursors: ResourcePageCursor<string>[] = []
          const fetchPage = (
            cursor: ResourcePageCursor<string>
          ): Effect.Effect<ResourcePage<number>> => {
            cursors.push(cursor)
            const index = 'first' in cursor ? 0 : Number(cursor.pageUrl.split('=')[1])
            const page = pages[index] ?? { items: [], dropped: 0 }
            return Effect.succeed({
              items: page.items,
              droppedEntryCount: page.dropped,
              nextPageUrl:
                index + 1 < pages.length ? `https://fhir.example/next?page=${index + 1}` : null,
            })
          }

          // Act
          const all = await Effect.runPromise(fetchAllResourcePages(fetchPage, 'first-input'))

          // Assert
          expect(all.items).toEqual(pages.flatMap((page) => page.items))
          expect(all.droppedEntryCount).toBe(pages.reduce((sum, page) => sum + page.dropped, 0))
          expect(cursors[0]).toEqual({ first: 'first-input' })
          expect(cursors).toHaveLength(pages.length)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('fails on a next link naming a page already read, rather than looping', async () => {
    // Arrange — the second page links back to itself
    const loop = 'https://fhir.example/next?page=1'
    const fetchPage = (): Effect.Effect<ResourcePage<number>> =>
      Effect.succeed({ items: [1], droppedEntryCount: 0, nextPageUrl: loop })

    // Act
    const failure = await Effect.runPromise(
      Effect.flip(fetchAllResourcePages(fetchPage, 'first-input'))
    )

    // Assert
    expect(failure).toEqual(new ResourcePageCycleError({ pageUrl: loop }))
  })

  test('fails the whole read when a page fails, rather than returning what it read so far', async () => {
    // Arrange — the first page links on; the second fails
    const fetchPage = (
      cursor: ResourcePageCursor<string>
    ): Effect.Effect<ResourcePage<number>, ResourcePageRequestError> =>
      'first' in cursor
        ? Effect.succeed({
            items: [1],
            droppedEntryCount: 0,
            nextPageUrl: 'https://fhir.example/next?page=1',
          })
        : Effect.fail(new ResourcePageRequestError({ cause: 'down' }))

    // Act
    const failure = await Effect.runPromise(
      Effect.flip(fetchAllResourcePages(fetchPage, 'first-input'))
    )

    // Assert
    expect(failure._tag).toBe('ResourcePageRequestError')
  })
})
