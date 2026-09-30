import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DateTime, Effect, Either, Layer, Schema } from 'effect'
import * as fc from 'fast-check'
import { FhirR4ResourcesRouterContext, type RunAuthed } from 'fhir-r4-react'
import type * as FhirR4React from 'fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import type { JSX, ReactNode } from 'react'
import { DataSet, WriteOrder } from 'synthetic-data-core'
import {
  importRexallPerson,
  importShoppersFamily,
  rexallPersonCaseArbitrary,
  shoppersFamilyCaseArbitrary,
} from 'synthetic-data-core/test-helpers'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { COMPLETE_HEADING, PARTIAL_HEADING } from './load-results.tsx'
import { SyntheticDataScreen } from './synthetic-data-screen.tsx'

/**
 * The whole load, driven through the real screen → `synthetic-data-core`
 * reader → `persistBatchBundle` path. Two seams are stubbed: `fetch`, which
 * serves an assembled data set of real importer output from memory, and the
 * router's authed runner, whose `HttpClient` records every batch bundle and
 * answers each entry. The assertions read what reached the FHIR server.
 */

/**
 * jsdom's `TextEncoder` hands back a `Uint8Array` from another realm, which
 * the HAR codec's `Uint8ArrayFromSelf` schemas reject on `instanceof`, so a
 * generated HAR would import to nothing — a jsdom artifact, as
 * `importer-react`'s screen test records. The codec builds its encoder when
 * its module loads, so the encoder is replaced before any import, with one
 * that re-wraps its output through the ambient `Uint8Array`: the one realm a
 * browser has.
 */
vi.hoisted(() => {
  const AmbientTextEncoder = globalThis.TextEncoder
  class RealmSafeTextEncoder extends AmbientTextEncoder {
    override encode(input?: string): Uint8Array<ArrayBuffer> {
      return new Uint8Array(super.encode(input))
    }
  }
  globalThis.TextEncoder = RealmSafeTextEncoder
})

vi.mock('fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunAuthed }
})

const ROOT = 'https://data.example/sets/demo/'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

const AS_OF = DateTime.unsafeMake('2026-09-28T12:00:00.000Z')

/** Generous: building the data set runs two imports. */
const SETUP_TIMEOUT_MILLIS = 60_000

/** A load writes a few hundred resources through the stub server. */
const LOAD_TIMEOUT_MILLIS = 10_000

/** A test waits for a load, and then reads the page. */
const TEST_TIMEOUT_MILLIS = 2 * LOAD_TIMEOUT_MILLIS

let files: readonly DataSet.File[]
let resourcesByPerson: ReadonlyMap<string, readonly FhirResource[]>
let currentRunAuthed: RunAuthed
let bundles: RecordedEntry[][]
let fetched: { readonly url: string; readonly credentials: RequestCredentials | undefined }[]
let queryClient: QueryClient

const labelOf = (resource: FhirResource): string => `${resource.resourceType}/${resource.id}`

/** The distinct `Type/id`s of `resources`. */
const labelsOf = (resources: readonly FhirResource[]): readonly string[] =>
  [...new Set(resources.map(labelOf))].toSorted()

beforeAll(async () => {
  const [rexallCase] = fc.sample(rexallPersonCaseArbitrary, { numRuns: 1, seed: 41 })
  const [familyCase] = fc.sample(shoppersFamilyCaseArbitrary, { numRuns: 1, seed: 43 })
  if (rexallCase === undefined || familyCase === undefined) throw new Error('expected samples')
  const rexall = (await importRexallPerson(rexallCase)).resources
  const family = (await importShoppersFamily(familyCase, 'family.har')).resources
  resourcesByPerson = new Map([
    ['person-1', rexall],
    ['person-2', family],
  ])
  files = Either.getOrThrow(
    DataSet.assemble(AS_OF, COMMIT, [
      {
        person: { key: 'person-1', displayName: 'Sam Okoye', summary: 'Pharmacy and an X-ray.' },
        resources: rexall,
      },
      {
        person: { key: 'person-2', displayName: 'Riley Singh', summary: 'A family account.' },
        resources: family,
      },
    ])
  )
}, SETUP_TIMEOUT_MILLIS)

beforeEach(() => {
  bundles = []
  fetched = []
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  currentRunAuthed = recordingServer({})
  serve(files)
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.unstubAllGlobals()
})

describe('SyntheticDataScreen', () => {
  it('reads the data set at the address it starts with, and lists everyone in it, checked', async () => {
    render(<SyntheticDataScreen initialDataSetAddress={ROOT} />, { wrapper: withQueryClient })

    const people = await screen.findByRole('group', { name: 'People to load' })
    const boxes = within(people).getAllByRole('checkbox')
    expect(boxes.map((box) => box.closest('label')?.textContent)).toEqual([
      expect.stringContaining('Sam Okoye'),
      expect.stringContaining('Riley Singh'),
    ])
    expect(boxes.every((box) => box instanceof HTMLInputElement && box.checked)).toBe(true)
    expect(screen.getByText(/As of 2026-09-28/)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Load 2 people' })).toBeDefined()
    expect(fetched).toEqual([{ url: `${ROOT}index.json`, credentials: 'omit' }])
    expect(bundles).toHaveLength(0)
  })

  it(
    'writes every chosen resource once, after what it references, with each source file carried inline',
    async () => {
      render(<SyntheticDataScreen initialDataSetAddress={ROOT} />, { wrapper: withQueryClient })
      await userEvent.click(await screen.findByRole('button', { name: 'Load 2 people' }))

      await screen.findByRole(
        'heading',
        { name: COMPLETE_HEADING },
        { timeout: LOAD_TIMEOUT_MILLIS }
      )
      const everyone = [...resourcesByPerson.values()].flat()
      const written = bundles.flat()
      expect(written.map((entry) => entry.label).toSorted()).toEqual(labelsOf(everyone))
      expect(screen.getByRole('status').textContent).toBe(
        `Wrote ${written.length} of ${written.length} resources.`
      )

      // Every reference to a written resource names one an earlier bundle wrote.
      const bundleOf = new Map(
        bundles.flatMap((bundle, index) => bundle.map((entry) => [entry.label, index] as const))
      )
      for (const entry of written) {
        for (const reference of entry.references) {
          const target = bundleOf.get(reference)
          if (target !== undefined) expect(target).toBeLessThan(bundleOf.get(entry.label) ?? -1)
        }
      }
      for (const bundle of bundles) {
        expect(bundle.length).toBeLessThanOrEqual(WriteOrder.MAX_BUNDLE_ENTRIES)
      }

      // Each source file is written with its file's bytes as data, as the import stored it.
      const sourceFiles = everyone.filter(
        (resource) =>
          resource.resourceType === 'DocumentReference' &&
          resource.content[0]?.attachment.data !== null
      )
      expect(sourceFiles.length).toBeGreaterThan(0)
      for (const sourceFile of sourceFiles) {
        const entry = written.find(({ label }) => label === labelOf(sourceFile))
        const attachment =
          sourceFile.resourceType === 'DocumentReference' ? sourceFile.content[0]?.attachment : null
        expect(entry?.attachment).toEqual({ data: attachment?.data, url: undefined })
      }
      // The files came from the data set's own host, without credentials.
      expect(fetched.every(({ url }) => url.startsWith(ROOT))).toBe(true)
      expect(new Set(fetched.map(({ credentials }) => credentials))).toEqual(new Set(['omit']))
    },
    TEST_TIMEOUT_MILLIS
  )

  it(
    'writes only the people left checked',
    async () => {
      render(<SyntheticDataScreen initialDataSetAddress={ROOT} />, { wrapper: withQueryClient })
      await userEvent.click(await screen.findByRole('checkbox', { name: /Riley Singh/ }))
      await userEvent.click(screen.getByRole('button', { name: 'Load 1 person' }))

      await screen.findByRole(
        'heading',
        { name: COMPLETE_HEADING },
        { timeout: LOAD_TIMEOUT_MILLIS }
      )
      expect(
        bundles
          .flat()
          .map((entry) => entry.label)
          .toSorted()
      ).toEqual(labelsOf(resourcesByPerson.get('person-1') ?? []))
    },
    TEST_TIMEOUT_MILLIS
  )

  it(
    'writes nothing when a source file is not the file its DocumentReference describes',
    async () => {
      const har = files.find((file) => file.path === 'har/family.har')
      if (har === undefined || typeof har.contents === 'string') {
        throw new Error('expected the family HAR')
      }
      const tampered = new Uint8Array(har.contents)
      tampered[0] = (tampered[0] ?? 0) ^ 0xff
      serve(files.map((file) => (file.path === har.path ? { ...file, contents: tampered } : file)))
      render(<SyntheticDataScreen initialDataSetAddress={ROOT} />, { wrapper: withQueryClient })

      await userEvent.click(await screen.findByRole('button', { name: 'Load 2 people' }))

      const alert = await screen.findByRole('alert', {}, { timeout: LOAD_TIMEOUT_MILLIS })
      expect(alert.textContent).toContain('Nothing was written: 1 file could not be read.')
      expect(alert.textContent).toContain('har/family.har')
      expect(alert.textContent).toContain('SHA-256')
      expect(bundles).toHaveLength(0)
    },
    TEST_TIMEOUT_MILLIS
  )

  it(
    'shows the resources the server rejected, with its messages, and still writes the rest',
    async () => {
      currentRunAuthed = recordingServer({
        rejects: (label) => label.startsWith('MedicationRequest/'),
      })
      render(<SyntheticDataScreen initialDataSetAddress={ROOT} />, { wrapper: withQueryClient })
      await userEvent.click(await screen.findByRole('button', { name: 'Load 2 people' }))

      await screen.findByRole(
        'heading',
        { name: PARTIAL_HEADING },
        { timeout: LOAD_TIMEOUT_MILLIS }
      )
      const everyone = [...resourcesByPerson.values()].flat()
      const rejected = labelsOf(everyone).filter((label) => label.startsWith('MedicationRequest/'))
      expect(rejected.length).toBeGreaterThan(0)
      const total = labelsOf(everyone).length
      expect(screen.getByRole('status').textContent).toBe(
        `Wrote ${total - rejected.length} of ${total} resources.`
      )
      const failed = screen.getByText(/^422 Unprocessable Entity ·/).closest('details')
      expect(failed?.open).toBe(true)
      expect(failed?.textContent).toContain('A MedicationRequest is not welcome here.')
    },
    TEST_TIMEOUT_MILLIS
  )

  it('names what is wrong with an address instead of reading it', async () => {
    render(<SyntheticDataScreen initialDataSetAddress={ROOT} />, { wrapper: withQueryClient })
    await screen.findByRole('group', { name: 'People to load' })
    const field = screen.getByRole('textbox', { name: 'Data set' })

    await userEvent.clear(field)
    await userEvent.type(field, 'ftp://data.example/sets/demo/')
    await userEvent.click(screen.getByRole('button', { name: 'Read data set' }))

    expect(screen.getByRole('alert').textContent).toBe(
      'The address must start https:// or http://.'
    )
    expect(fetched).toHaveLength(1)
  })

  it('says why a data set could not be read', async () => {
    serve([])
    render(<SyntheticDataScreen initialDataSetAddress={ROOT} />, { wrapper: withQueryClient })

    expect((await screen.findByText(/^Could not load the data set:/)).textContent).toBe(
      'Could not load the data set: index.json: The server answered 404 Not Found.'
    )
  })
})

// Helpers

/** One entry of a recorded batch bundle: what it wrote, what it references, its attachment. */
interface RecordedEntry {
  readonly label: string
  readonly references: ReadonlySet<string>
  readonly attachment: { readonly data: unknown; readonly url: unknown } | undefined
}

/** `files`, served at {@link ROOT} by a stubbed `fetch` that records each request. */
const serve = (served: readonly DataSet.File[]): void => {
  const byUrl = new Map(served.map((file) => [new URL(file.path, ROOT).href, file.contents]))
  vi.stubGlobal('fetch', (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    fetched.push({ url, credentials: init?.credentials })
    const contents = byUrl.get(url)
    return Promise.resolve(
      contents === undefined
        ? new Response('', { status: 404, statusText: 'Not Found' })
        : new Response(typeof contents === 'string' ? contents : new Uint8Array(contents), {
            status: 200,
          })
    )
  })
}

/** Just what the tests read of a written batch bundle. */
const BundleBody = Schema.parseJson(
  Schema.Struct({
    entry: Schema.Array(
      Schema.Struct({
        request: Schema.Struct({ method: Schema.String, url: Schema.String }),
        resource: Schema.Unknown,
      })
    ),
  })
)

const AttachmentOf = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      attachment: Schema.Struct({
        data: Schema.optional(Schema.NullOr(Schema.String)),
        url: Schema.optional(Schema.Unknown),
      }),
    })
  ),
})

const RELATIVE_REFERENCE = /^[A-Z][A-Za-z]*\/[A-Za-z0-9\-.]{1,64}$/

/** Every relative reference in a written resource's JSON. */
const referencesIn = (json: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(json)) {
    for (const item of json) referencesIn(item, found)
  } else if (typeof json === 'object' && json !== null) {
    for (const [key, value] of Object.entries(json)) {
      if (key === 'reference' && typeof value === 'string' && RELATIVE_REFERENCE.test(value)) {
        found.add(value)
      } else {
        referencesIn(value, found)
      }
    }
  }
  return found
}

/**
 * An authed runner over a stub FHIR server that records every batch bundle
 * and answers each entry `201 Created`, or `422` with an OperationOutcome for
 * the entries `rejects` names.
 */
const recordingServer = (config: { readonly rejects?: (label: string) => boolean }): RunAuthed => {
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const text =
        request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''
      const { entry } = Schema.decodeUnknownSync(BundleBody)(text)
      bundles.push(
        entry.map(({ request: entryRequest, resource }) => {
          const attachment = Either.getOrUndefined(
            Schema.decodeUnknownEither(AttachmentOf)(resource)
          )?.content[0]?.attachment
          return {
            label: entryRequest.url,
            references: referencesIn(resource),
            attachment:
              attachment === undefined
                ? undefined
                : { data: attachment.data ?? undefined, url: attachment.url ?? undefined },
          }
        })
      )
      const response = {
        resourceType: 'Bundle',
        type: 'batch-response',
        entry: entry.map(({ request: entryRequest }) =>
          config.rejects?.(entryRequest.url) === true
            ? {
                response: {
                  status: '422 Unprocessable Entity',
                  outcome: {
                    resourceType: 'OperationOutcome',
                    issue: [
                      {
                        severity: 'error',
                        code: 'business-rule',
                        diagnostics: 'A MedicationRequest is not welcome here.',
                      },
                    ],
                  },
                },
              }
            : { response: { status: '201 Created' } }
        ),
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      )
    })
  )
  return <A, E>(
    effect: Effect.Effect<A, E, HttpClient.HttpClient | FhirR4ResourcesHttpApiClient>
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          FhirR4ResourcesRouterContext.sliceRuntimeLayer.pipe(Layer.provideMerge(httpLayer))
        ),
        Effect.scoped
      )
    )
}

const withQueryClient = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)
