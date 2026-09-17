import { Arbitrary, Effect, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { Observation } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test, vi } from 'vite-plus/test'

import {
  BundleDecodeError,
  ResourcePageRequestError,
  fetchResourcePage,
  type PagedResourceRead,
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

  test('a response that is not a bundle fails with BundleDecodeError', async () => {
    for (const response of [null, undefined, 'a string', 42, true]) {
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
  })

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
