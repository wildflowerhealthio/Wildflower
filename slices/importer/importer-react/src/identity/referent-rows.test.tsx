import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { FhirR4ResourcesRouterContext, type RunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import type * as FhirR4React from '@wildflowerhealthio/fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import {
  FhirResourceSchema,
  Practitioner,
  type FhirResource,
} from '@wildflowerhealthio/fhir-r4/resources'
import type { BatchDecodeResult } from '@wildflowerhealthio/importer-core'
import { DecodedFile, FormatDecode } from '@wildflowerhealthio/importer-fundamentals'
import { Effect, Layer, Schema } from 'effect'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { ReferentRows } from './referent-rows.tsx'
import {
  DONT_LINK_LABEL,
  GROUP_HEADINGS,
  NEW_LABEL,
  newAsLabel,
  ON_SERVER_GROUP,
} from './referent-text.ts'
import { useIdentityMap } from './use-identity-map.ts'

/**
 * The referent rows over the identity map hook, on a hand-built batch and a
 * stub server whose `Patient?identifier=` search answers with the stored
 * Patients given and whose paged list answers with the ones listed, so a
 * default, a pick and the placed batch read back.
 */

vi.mock('@wildflowerhealthio/fhir-r4-react', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4React>()
  return { ...actual, useRunAuthed: (): RunAuthed => currentRunAuthed }
})

let currentRunAuthed: RunAuthed
let placed: BatchDecodeResult | undefined

afterEach(() => {
  cleanup()
  placed = undefined
})

const SOURCE = 'https://source.example/patient-id'
const CUSTOMER = 'https://source.example/customer-id'
const SERVER = 'https://server.example/id'
const TYRA = 'Tyra Banks · 1990-01-02'

describe('ReferentRows', () => {
  it('should show a line per referent, people before providers', async () => {
    await renderRows(BATCH, {})

    const people = screen.getByRole('region', { name: GROUP_HEADINGS.Patient })
    const providers = screen.getByRole('region', { name: GROUP_HEADINGS.Practitioner })
    expect(within(people).getAllByRole('combobox')).toHaveLength(2)
    expect(within(people).getByRole('combobox', { name: 'c-9' })).toBeDefined()
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

  it('should not warn when the stored Patient states no birth date to compare', async () => {
    await renderRows(BATCH, { found: [patientWire('s-1', SERVER, { birthDate: null })] })

    expect(screen.queryByText(/different/)).toBeNull()
  })

  it('should place the batch on a changed select', async () => {
    await renderRows(BATCH, {})

    // The account is the person the Patient line creates: its mentions follow.
    const account = screen.getByRole('combobox', { name: 'c-9' })
    await userEvent.selectOptions(account, newAsLabel(TYRA))
    await waitFor(() => {
      expect(subjectOfRequest()).toBe('Patient/p-1')
    })

    // Unlinked again: the mention keeps its identifier-only form.
    await userEvent.selectOptions(account, DONT_LINK_LABEL)
    await waitFor(() => {
      expect(subjectOfRequest()).toBeNull()
    })
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
    expect(placed).toBeUndefined()
  })

  it('should render a household of referents over a long server list in one pass', async () => {
    // Arrange: a dozen people, each mentioned once, and three hundred stored people to offer each.
    const people = Array.from({ length: 12 }, (_, index) => `p-${index}`)
    const batch = batchOf(
      people.flatMap((id) => [
        decodeResource(patientWire(id, SOURCE, { given: [`Given${id}`] })),
        requestFor({ system: CUSTOMER, value: `c-${id}` }),
      ])
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
    // Twelve people, their twelve accounts, and the one prescriber they share.
    expect(screen.getAllByRole('combobox')).toHaveLength(25)
    expect(elapsedMillis, `rendered in ${Math.round(elapsedMillis)}ms`).toBeLessThan(10_000)
  })
})

// Helpers

const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)

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

/** A request for the account `identifier` names, prescribed by a provider known only by name. */
const requestFor = (identifier: {
  readonly system: string
  readonly value: string
}): FhirResource =>
  decodeResource({
    resourceType: 'MedicationRequest',
    id: `rx-${identifier.value}`,
    status: 'active',
    intent: 'order',
    subject: { type: 'Patient', identifier },
    requester: {
      type: 'Practitioner',
      identifier: { system: Practitioner.NAME_IDENTIFIER_SYSTEM, value: 'Dr. A Smith' },
      display: 'Dr. A Smith',
    },
  })

/** A HAR result holding `resources`, the other formats claiming nothing. */
const batchOf = (resources: readonly FhirResource[]): BatchDecodeResult => ({
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
          })),
        },
      ],
      notes: [],
    },
  },
  'lifelabs-pdf': FormatDecode.emptyResult('lifelabs-pdf'),
  dicom: FormatDecode.emptyResult('dicom'),
  unrecognizedFiles: [],
})

const BATCH = batchOf([
  decodeResource(patientWire('p-1', SOURCE)),
  requestFor({ system: CUSTOMER, value: 'c-9' }),
])

/** What the stub server holds: `found` is what the search for Tyra (`p-1`) finds, `listed` the paged list. */
interface Holdings {
  readonly found?: readonly object[]
  readonly listed?: readonly object[]
}

/** The `resourceType` a wire resource states. */
const resourceTypeOf = Schema.decodeUnknownSync(Schema.Struct({ resourceType: Schema.String }))

/**
 * A server whose search for Tyra answers with the resources of `found` of the
 * searched type, whose other identifier searches find nothing, and whose
 * paged lists answer with those of `listed`.
 */
const serverHolding = ({ found = [], listed = [] }: Holdings): RunAuthed => {
  /** What a search with `identifier` finds: the list without one, `found` for Tyra's, nothing else. */
  const heldFor = (identifier: string | undefined): readonly object[] => {
    if (identifier === undefined) return listed
    return identifier.includes(`${SOURCE}|p-1`) ? found : []
  }
  const searchset = (resources: readonly object[]): Response =>
    new Response(
      JSON.stringify({
        resourceType: 'Bundle',
        type: 'searchset',
        entry: resources.map((resource) => ({ resource })),
      }),
      { headers: { 'content-type': 'application/json' } }
    )
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const params = Object.fromEntries(request.urlParams)
      const searchedType = request.url.split('/').at(-1)
      const hits = heldFor(params['identifier']).filter(
        (resource) => resourceTypeOf(resource).resourceType === searchedType
      )
      return Effect.succeed(HttpClientResponse.fromWeb(request, searchset(hits)))
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

/** The identity map hook and its rows, reporting the placed batch on every render. */
const Harness = ({ batch }: { readonly batch: BatchDecodeResult }): JSX.Element => {
  const { state, choose } = useIdentityMap(batch, 1)
  if (state._tag === 'loading') return <p>Loading</p>
  if (state._tag === 'refused') return <p role="alert">{state.failure._tag}</p>
  placed = state.placed
  return (
    <>
      {state._tag === 'error' && <p role="alert">{state.error.message}</p>}
      <ReferentRows
        referents={state.referents}
        linkChoices={state.linkChoices}
        linkTargets={state.linkTargets}
        found={state.found}
        onChoose={choose}
      />
    </>
  )
}

const renderHarness = (batch: BatchDecodeResult): void => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <Harness batch={batch} />
    </QueryClientProvider>
  )
}

/** Render the rows over `batch` against a server with `holdings`, and wait for the line labelled `firstLabel`. */
const renderRows = async (
  batch: BatchDecodeResult,
  holdings: Holdings,
  firstLabel: string = TYRA
): Promise<void> => {
  currentRunAuthed = serverHolding(holdings)
  renderHarness(batch)
  await screen.findByRole('combobox', { name: firstLabel })
}

const subjectOfRequest = (): string | null | undefined => {
  const request = DecodedFile.resources(placed?.har.decoded ?? { sections: [] }).find(
    (entry) => entry.resource.resourceType === 'MedicationRequest'
  )?.resource
  return request !== undefined && 'subject' in request ? request.subject?.reference : undefined
}
