import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { FhirR4ResourcesRouterContext, type RunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import type * as FhirR4React from '@wildflowerhealthio/fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import {
  FhirResourceSchema,
  type FhirResourceWithId,
  hasId,
} from '@wildflowerhealthio/fhir-r4/resources'
import type { DecodedBatch, ResolvedBatch } from '@wildflowerhealthio/importer-core'
import { DecodedFile, FormatDecode } from '@wildflowerhealthio/importer-fundamentals'
import { Effect, Layer, Option, Schema } from 'effect'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { ReferentRows } from './referent-rows.tsx'
import {
  GROUP_HEADINGS,
  NEW_LABEL,
  ON_SERVER_GROUP,
  STORED_LIST_ERROR_MESSAGE,
  STORED_LIST_TRUNCATED_MESSAGE,
  UPDATE_LABEL,
} from './referent-text.ts'
import { useLinkChoiceReview } from './use-link-choice-review.ts'

/**
 * The referent rows over the identity map hook, on a hand-built batch and a
 * stub server whose `Patient?identifier=` search answers with the stored
 * Patients given and whose paged list answers with the ones listed, so a
 * default, a pick and the resolved batch read back.
 */

vi.mock('@wildflowerhealthio/fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunAuthed }
})

let currentRunAuthed: RunAuthed
let resolved: ResolvedBatch | undefined

afterEach(() => {
  cleanup()
  resolved = undefined
})

const SOURCE = 'https://source.example/patient-id'
const CUSTOMER = 'https://source.example/customer-id'
const SERVER = 'https://server.example/id'
const PRACTITIONER_NAME = 'https://source.example/practitioner-name'
const TYRA = 'Tyra Banks · 1990-01-02'

describe('ReferentRows', () => {
  it('should show a line per referent, people before providers', async () => {
    await renderRows(BATCH, {})

    const people = screen.getByRole('region', { name: GROUP_HEADINGS.Patient })
    const providers = screen.getByRole('region', { name: GROUP_HEADINGS.Practitioner })
    expect(within(people).getAllByRole('combobox')).toHaveLength(1)
    expect(within(providers).getAllByRole('combobox')).toHaveLength(1)
    expect(within(providers).getByRole('combobox', { name: 'Dr. A Smith' })).toBeDefined()
    expect(people.compareDocumentPosition(providers)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('should default a Patient the search does not find to New', async () => {
    await renderRows(BATCH, {})

    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: TYRA })
    expect(select.selectedOptions[0]?.textContent).toBe(NEW_LABEL)
  })

  it('should pre-select the stored Patient an identifier search finds, without a warning', async () => {
    await renderRows(BATCH, { found: [patientWire('s-1', SERVER)] })

    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: TYRA })
    expect(select.value).toBe('stored:Patient/s-1')
    expect(screen.queryByText(/different/)).toBeNull()
    expect(subjectOfRequest()).toBeNull()
  })

  it('should offer the server’s stored people under their own group, labelled by name', async () => {
    await renderRows(BATCH, {
      listed: [
        patientWire('s-2', SERVER, { family: 'Doe', given: ['Jan'], birthDate: '1980-05-06' }),
      ],
    })

    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: TYRA })
    await waitFor(() => {
      expect(within(select).getByRole('group', { name: ON_SERVER_GROUP })).toBeDefined()
    })
    expect(
      within(within(select).getByRole('group', { name: ON_SERVER_GROUP }))
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Jan Doe · 1980-05-06'])
  })

  it.each([
    {
      differing: 'birth date',
      stored: patientWire('s-1', SERVER, { birthDate: '1991-01-02' }),
    },
    {
      differing: 'given name',
      stored: patientWire('s-1', SERVER, { given: ['Tyrone'] }),
    },
    {
      differing: 'family name and given name',
      stored: patientWire('s-1', SERVER, { family: 'Doe', given: ['Jan'] }),
    },
  ])(
    'should warn, without blocking, when the stored Patient has a different $differing',
    async ({ differing, stored }) => {
      await renderRows(BATCH, { found: [stored] })

      expect(
        screen.getByText(`The record on the server has a different ${differing}.`, { exact: false })
      ).toBeDefined()
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: TYRA }).value).toBe(
        'stored:Patient/s-1'
      )
    }
  )

  it('should offer an update over the copy the search finds under the decoded id, in place of New', async () => {
    await renderRows(BATCH, { found: [patientWire('p-1', SOURCE, { given: ['Tyra', 'Lynne'] })] })

    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: TYRA })
    expect(select.value).toBe('update:Patient/p-1')
    expect(select.selectedOptions[0]?.textContent).toBe(UPDATE_LABEL)
    expect(within(select).queryByRole('option', { name: NEW_LABEL })).toBeNull()
    expect(
      within(within(select).getByRole('group', { name: ON_SERVER_GROUP }))
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Tyra Lynne Banks · 1990-01-02'])
    expect(screen.queryByText(/different/)).toBeNull()

    // Keeping the server's copy instead: the decoded Patient is replaced by it.
    await userEvent.selectOptions(select, 'Tyra Lynne Banks · 1990-01-02')
    await waitFor(() => {
      expect(select.value).toBe('stored:Patient/p-1')
    })
    expect(
      screen.getByText('The record on the server has a different given name.', { exact: false })
    ).toBeDefined()
    await userEvent.selectOptions(select, UPDATE_LABEL)
    await waitFor(() => {
      expect(select.value).toBe('update:Patient/p-1')
    })
  })

  it('should say when the page limit cut the server’s list off', async () => {
    await renderRows(BATCH, { listed: [patientWire('s-2', SERVER)], listContinues: true })

    // Both groups' lists continue, so both say so.
    const notes = await screen.findAllByRole('note')
    expect(notes.map((note) => note.textContent)).toEqual([
      STORED_LIST_TRUNCATED_MESSAGE,
      STORED_LIST_TRUNCATED_MESSAGE,
    ])
  })

  it('should compare the name the stored person goes by, not a former name listed first', async () => {
    await renderRows(BATCH, {
      found: [
        {
          resourceType: 'Patient',
          id: 's-1',
          identifier: [{ system: SERVER, value: 's-1' }],
          name: [
            { use: 'maiden', family: 'Banks', given: ['Tyra'] },
            { use: 'official', family: 'Doe', given: ['Tyra'] },
          ],
          birthDate: '1990-01-02',
        },
      ],
    })

    expect(
      screen.getByText('The record on the server has a different family name.', { exact: false })
    ).toBeDefined()
  })

  it('should not warn when the stored Patient states no birth date to compare', async () => {
    await renderRows(BATCH, { found: [patientWire('s-1', SERVER, { birthDate: null })] })

    expect(screen.queryByText(/different/)).toBeNull()
  })

  it('should resolve the batch on a changed select', async () => {
    await renderRows(BATCH, { listed: [practitionerWire('42', 'Dr. A Smith')] })

    // Tyra's own record and the prescriber's are the import's new records.
    expect(screen.getByRole('status').textContent).toBe(
      '0 records on the server, 2 records from this import'
    )
    expect(requesterOfRequest()).toBe('Practitioner/dr-a-smith')

    // The prescriber is the provider the server holds: the request names it.
    const provider = screen.getByRole('combobox', { name: 'Dr. A Smith' })
    await waitFor(() => {
      expect(within(provider).getByRole('group', { name: ON_SERVER_GROUP })).toBeDefined()
    })
    await userEvent.selectOptions(provider, 'stored:Practitioner/42')
    await waitFor(() => {
      expect(requesterOfRequest()).toBe('Practitioner/42')
    })
    expect(screen.getByRole('status').textContent).toBe(
      '1 record on the server, 1 record from this import'
    )
  })

  it('should say when the server’s list could not be read, and still offer the search’s hits', async () => {
    await renderRows(BATCH, { found: [patientWire('s-1', SERVER)], listFails: true })

    await screen.findByText(STORED_LIST_ERROR_MESSAGE)
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: TYRA })
    expect(select.value).toBe('stored:Patient/s-1')
    expect(
      within(within(select).getByRole('group', { name: ON_SERVER_GROUP }))
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual([TYRA])
  })

  it('should label a found provider by its name even when a found person shares its id', async () => {
    await renderRows(BATCH, {
      found: [patientWire('42', SERVER), practitionerWire('42', 'Dr. A Smith')],
    })

    const provider = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Dr. A Smith' })
    expect(provider.value).toBe('stored:Practitioner/42')
    expect(provider.selectedOptions[0]?.textContent).toBe('Dr. A Smith')
  })

  it('should keep the last review up when a re-decode refuses the batch', async () => {
    // Arrange: a batch that resolves, then a re-decode of it that holds one person twice.
    currentRunAuthed = serverHolding({})
    const { rerender } = renderHarness(BATCH)
    await screen.findByRole('combobox', { name: TYRA })

    // Act
    rerender(
      harnessOver(
        batchOf([
          decodeResource(patientWire('p-1', SOURCE)),
          decodeResource({ ...patientWire('p-1', SOURCE), id: 'p-1-again' }),
        ])
      )
    )

    // Assert: the refusal is said, and the rows of the review before it are
    // still there, taking no choice until the batch resolves again.
    expect((await screen.findByRole('alert')).textContent).toBe('DuplicateReferent')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: TYRA }).disabled).toBe(true)
  })

  it('should refuse a batch that holds one person twice under two ids', async () => {
    currentRunAuthed = serverHolding({})
    renderHarness(
      batchOf([
        decodeResource(patientWire('p-1', SOURCE)),
        decodeResource({ ...patientWire('p-1', SOURCE), id: 'p-1-again' }),
      ])
    )

    expect((await screen.findByRole('alert')).textContent).toBe('DuplicateReferent')
    expect(resolved).toBeUndefined()
  })

  it('should render a household of referents over a long server list in one pass', async () => {
    // Arrange: a dozen people, each mentioned once, and three hundred stored people to offer each.
    const people = Array.from({ length: 12 }, (_, index) => `p-${index}`)
    const batch = batchOf(
      people
        .flatMap((id) => [
          decodeResource(patientWire(id, SOURCE, { given: [`Given${id}`] })),
          requestFor({ system: CUSTOMER, value: `c-${id}` }),
        ])
        .concat([decodeResource(prescriberWire)])
    )
    const listed = Array.from({ length: 300 }, (_, index) =>
      patientWire(`s-${index}`, SERVER, { given: [`Stored${index}`] })
    )

    // Act
    const startedAt = performance.now()
    await renderRows(batch, { listed }, `Given${people[0]} Banks · 1990-01-02`)
    await waitFor(() => {
      expect(
        within(screen.getAllByRole<HTMLSelectElement>('combobox')[0] ?? document.body).getAllByRole(
          'option'
        ).length
      ).toBeGreaterThan(300)
    })
    const elapsedMillis = performance.now() - startedAt

    // Assert: every line painted with the whole list, within a bound generous
    // for jsdom (measured around a second); a quadratic blow-up would miss it.
    // Twelve people and the one prescriber they share.
    expect(screen.getAllByRole('combobox')).toHaveLength(13)
    expect(elapsedMillis, `rendered in ${Math.round(elapsedMillis)}ms`).toBeLessThan(10_000)
  })
})

// Helpers

/** `wire` decoded as a resource with an id; throws when it is none. */
const decodeResource = (wire: unknown): FhirResourceWithId => {
  const resource = Schema.decodeUnknownSync(FhirResourceSchema)(wire)
  if (!hasId(resource)) throw new Error('expected a resource with an id')
  return resource
}

/** A Patient's wire form: Tyra Banks born 1990-01-02 unless a part is given, `null` to leave it out. */
const patientWire = (
  id: string,
  system: string,
  parts: {
    readonly family?: string
    readonly given?: readonly string[]
    readonly birthDate?: string | null
  } = {}
): object => ({
  resourceType: 'Patient',
  id,
  identifier: [{ system, value: id }],
  name: [{ family: parts.family ?? 'Banks', given: parts.given ?? ['Tyra'] }],
  ...(parts.birthDate === null ? {} : { birthDate: parts.birthDate ?? '1990-01-02' }),
})

/** A Practitioner's wire form, named by `text`. */
const practitionerWire = (id: string, text: string): object => ({
  resourceType: 'Practitioner',
  id,
  identifier: [{ system: SERVER, value: id }],
  name: [{ text }],
})

/** The prescriber every request names, keyed by its printed name, as the import implies it. */
const prescriberWire = {
  resourceType: 'Practitioner',
  id: 'dr-a-smith',
  identifier: [{ system: PRACTITIONER_NAME, value: 'Dr. A Smith' }],
  name: [{ text: 'Dr. A Smith' }],
}

/** A request for the account `identifier` names, prescribed by the provider named Dr. A Smith. */
const requestFor = (identifier: {
  readonly system: string
  readonly value: string
}): FhirResourceWithId =>
  decodeResource({
    resourceType: 'MedicationRequest',
    id: `rx-${identifier.value}`,
    status: 'active',
    intent: 'order',
    subject: { type: 'Patient', identifier },
    requester: {
      type: 'Practitioner',
      identifier: { system: PRACTITIONER_NAME, value: 'Dr. A Smith' },
      display: 'Dr. A Smith',
    },
  })

/** A HAR result holding `resources`, the other formats claiming nothing. */
const batchOf = (resources: readonly FhirResourceWithId[]): DecodedBatch => ({
  formats: {
    har: {
      ...FormatDecode.emptyResult('har'),
      title: 'a.har',
      files: [{ id: '0:a.har', fileName: 'a.har', bytes: new Uint8Array([1]) }],
      decoded: {
        sections: [
          {
            title: 'Resources',
            resources: resources.map((resource, index) => ({
              key: `k-${index}`,
              title: resource.resourceType,
              resource,
              origin: 'Decoded',
            })),
          },
        ],
        notes: [],
      },
    },
    'lifelabs-pdf': FormatDecode.emptyResult('lifelabs-pdf'),
    dicom: FormatDecode.emptyResult('dicom'),
  },
  unrecognizedFiles: [],
})

const BATCH = batchOf([
  decodeResource(patientWire('p-1', SOURCE)),
  requestFor({ system: CUSTOMER, value: 'c-9' }),
  decodeResource(prescriberWire),
])

/**
 * What the stub server holds: `found` is what the searches for Tyra (`p-1`)
 * and for the prescriber find, `accountFound` what the account's (`c-9`)
 * finds, `listed` the paged list, which fails outright when `listFails`.
 */
interface Holdings {
  readonly found?: readonly object[]
  readonly accountFound?: readonly object[]
  readonly listed?: readonly object[]
  readonly listFails?: boolean
  /** Whether every page of the list continues to another, so the page limit cuts it off. */
  readonly listContinues?: boolean
}

/** The `resourceType` a wire resource states. */
const resourceTypeOf = Schema.decodeUnknownSync(Schema.Struct({ resourceType: Schema.String }))

/**
 * A server whose searches answer with the holdings of the searched type: the
 * searches for Tyra and the prescriber with `found`, the account's with
 * `accountFound`, every other identifier search with nothing, and the paged
 * list with `listed`, or a 503 when `listFails`.
 */
const serverHolding = ({
  found = [],
  accountFound = [],
  listed = [],
  listFails = false,
  listContinues = false,
}: Holdings): RunAuthed => {
  /** What a search with `identifier` finds. */
  const heldFor = (identifier: string | undefined): readonly object[] => {
    if (identifier === undefined) return listed
    if (identifier.includes(`${CUSTOMER}|c-9`)) return accountFound
    return identifier.includes(`${SOURCE}|p-1`) ||
      identifier.includes(`${PRACTITIONER_NAME}|Dr. A Smith`)
      ? found
      : []
  }
  // Each page of a list that continues names a fresh next page, so the page limit is what ends it.
  let pagesServed = 0
  const searchset = (resources: readonly object[], identifier: string | undefined): Response =>
    new Response(
      JSON.stringify({
        resourceType: 'Bundle',
        type: 'searchset',
        entry: resources.map((resource) => ({ resource })),
        link:
          listContinues && identifier === undefined
            ? [{ relation: 'next', url: `/Patient?_count=50&_pageToken=page-${++pagesServed}` }]
            : [],
      }),
      { headers: { 'content-type': 'application/json' } }
    )
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const params = Object.fromEntries(request.urlParams)
      if (listFails && params['identifier'] === undefined) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response('', { status: 503 }))
        )
      }
      const searchedType = request.url.split('/').at(-1)
      const hits = heldFor(params['identifier']).filter(
        (resource) => resourceTypeOf(resource).resourceType === searchedType
      )
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, searchset(hits, params['identifier']))
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

/** The identity map hook and its rows, reporting the resolved batch on every render. */
const Harness = ({ batch }: { readonly batch: DecodedBatch }): JSX.Element => {
  const { state, choose } = useLinkChoiceReview(batch, 1)
  if (state._tag === 'loading') return <p>Loading</p>
  // Shown as the screen shows them: the resolving, or the one before a refusal.
  const shown = state._tag === 'refused' ? Option.getOrUndefined(state.previous) : state
  if (shown === undefined) {
    return <p role="alert">{state._tag === 'refused' ? state.failure._tag : 'loading'}</p>
  }
  resolved = shown.resolved
  return (
    <>
      {state._tag === 'refused' && <p role="alert">{state.failure._tag}</p>}
      {state._tag === 'error' && <p role="alert">{state.error.message}</p>}
      <ReferentRows
        referents={shown.referents}
        linkChoices={shown.linkChoices}
        plan={shown.resolved.plan}
        found={shown.found}
        disabled={state._tag === 'refused'}
        onChoose={choose}
      />
    </>
  )
}

/** The harness over `batch`, under one query client for the test. */
const harnessOver = (batch: DecodedBatch): JSX.Element => (
  <QueryClientProvider client={queryClient}>
    <Harness batch={batch} />
  </QueryClientProvider>
)

let queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const renderHarness = (batch: DecodedBatch): ReturnType<typeof render> => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(harnessOver(batch))
}

/** Render the rows over `batch` against a server with `holdings`, and wait for the line labelled `firstLabel`. */
const renderRows = async (
  batch: DecodedBatch,
  holdings: Holdings,
  firstLabel: string = TYRA
): Promise<void> => {
  currentRunAuthed = serverHolding(holdings)
  renderHarness(batch)
  await screen.findByRole('combobox', { name: firstLabel })
}

const subjectOfRequest = (): string | null | undefined => {
  const request = DecodedFile.resources(resolved?.formats.har.decoded ?? { sections: [] }).find(
    (entry) => entry.resource.resourceType === 'MedicationRequest'
  )?.resource
  return request !== undefined && 'subject' in request ? request.subject?.reference : undefined
}

/** The literal reference the resolved request's `requester` names. */
const requesterOfRequest = (): string | null | undefined => {
  const request = DecodedFile.resources(resolved?.formats.har.decoded ?? { sections: [] }).find(
    (entry) => entry.resource.resourceType === 'MedicationRequest'
  )?.resource
  return request !== undefined && 'requester' in request ? request.requester?.reference : undefined
}
