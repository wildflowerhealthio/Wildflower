import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DateTime, Effect, Option, Schema } from 'effect'
import { type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import { HarSelection, type PreviewedResponse, preview } from 'har-importer-core'
import { type Extraction, HttpResponseKind, SourceDescriptor } from 'http-extraction-fundamentals'
import { Review } from 'importer-fundamentals'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { ReviewBody } from './review-body.tsx'

/**
 * The interactive review is driven directly — props in, DOM out — over synthetic
 * sources so a real cross-source overlap (which the FHIR pool has none of) can be
 * forced. The points under test are: the include toggles are grouped by source
 * under its name and detail; the default pick is the top-specificity candidate;
 * toggling a kind off re-derives every pick; per-resource toggles drop exactly
 * their resource without affecting siblings; per-type tallies reflect the
 * selection; and unrecognized responses fold into the collapsible no-match
 * section.
 */

afterEach(cleanup)

/** A kind that claims URLs containing `token`, at `specificity`, parsing to a fixed resource list. */
const kind = (
  name: string,
  specificity: number,
  token: string,
  resources: readonly unknown[] = [{ resourceType: 'Patient', id: `${name}-1` }]
): HttpResponseKind.HttpResponseKind<unknown> =>
  HttpResponseKind.make({
    name,
    tryRecognize: (url) => (url.includes(token) ? Option.some({ specificity }) : Option.none()),
    parse: () => Effect.succeed([...resources]),
  })

/** A one-source descriptor grouping `kinds` under a name + detail the menu shows. */
const source = (
  name: string,
  ...kinds: readonly HttpResponseKind.HttpResponseKind<unknown>[]
): SourceDescriptor.SourceDescriptor<unknown> =>
  SourceDescriptor.make({
    name,
    display: { title: `${name} title`, description: `${name} detail` },
    responseKinds: kinds,
  })

/** The flat pool of a source list — what the shell's `HarSelection.initial` seeds from. */
const poolOf = (
  sources: readonly SourceDescriptor.SourceDescriptor<unknown>[]
): readonly HttpResponseKind.HttpResponseKind<unknown>[] =>
  sources.flatMap((entry) => entry.responseKinds)

/** One decoded response the recognizer reads. */
const input = (id: string, url: string): Extraction.Input => ({
  id,
  url,
  method: Option.some('GET'),
  status: 200,
  statusText: 'OK',
  headers: [],
  startedAt: DateTime.unsafeNow(),
  body: new Uint8Array(),
  bodyAbsent: false,
})

/** Decode a wire-shape FHIR resource into a typed `FhirResource` for tests. */
const decodeFhirResource = (wire: unknown): FhirResource =>
  Schema.decodeUnknownSync(FhirResourceSchema)(wire)

/** Compute previews the way the shell does — synchronous parses fold cleanly through runSync. */
const previewOf = (
  pool: readonly HttpResponseKind.HttpResponseKind<unknown>[],
  responses: readonly Extraction.Input[],
  harSelection: HarSelection.Selection
): readonly PreviewedResponse<HttpResponseKind.HttpResponseKind<unknown>, unknown>[] =>
  Effect.runSync(preview(pool, responses, harSelection))

/**
 * Extract the labeled resources from a set of previews — the shape
 * `Review.chosenResources` reads. Each previewed resource with an
 * `outcome._tag === 'resources'` produces one entry.
 */
const labeledFromPreviews = (
  previews: readonly PreviewedResponse<HttpResponseKind.HttpResponseKind<unknown>, unknown>[]
): readonly { key: string; title: string; resource: unknown }[] =>
  previews.flatMap((p) =>
    p.outcome._tag === 'resources'
      ? p.outcome.resources.map((r) => ({ key: r.key, title: '', resource: r.resource }))
      : []
  )

// A broad `portal` (low specificity) and a `patient` (higher) both claim /Patient.
const portalKind = kind('portal', 10, '/Patient')
const patientKind = kind('patient', 50, '/Patient')
const observationKind = kind('observation', 50, '/Observation', [
  { resourceType: 'Observation', id: 'obs-1' },
])

describe('ReviewBody', () => {
  it('should group the include toggles by source under its name and detail', () => {
    // Arrange — two distinct sources, one kind each.
    const sources = [source('portal-source', portalKind), source('ehr-source', patientKind)]
    const pool = poolOf(sources)
    const responses = [input('r0', 'https://ehr.test/Patient/1')]
    const harSel = HarSelection.initial(pool)
    const sel = Review.initial<FhirResource>()

    // Act
    render(
      <ReviewBody
        responses={responses}
        sources={sources}
        previews={previewOf(pool, responses, harSel)}
        harSelection={harSel}
        onHarSelectionChange={() => undefined}
        selection={sel}
        onSelectionChange={() => undefined}
      />
    )

    // Assert — each source labels its own group, and its kind's toggle sits inside it.
    const portalGroup = screen.getByRole('group', { name: 'portal-source title' })
    const ehrGroup = screen.getByRole('group', { name: 'ehr-source title' })
    expect(portalGroup.textContent).toContain('portal-source detail')
    expect(ehrGroup.textContent).toContain('ehr-source detail')
    expect(within(portalGroup).getByRole('checkbox', { name: 'portal' })).toBeDefined()
    expect(within(ehrGroup).getByRole('checkbox', { name: 'patient' })).toBeDefined()
  })

  it('should label a toggle by the kind name without its ResponseKind suffix', () => {
    // Arrange — a kind whose name carries the conventional suffix.
    const sources = [source('ehr-source', kind('PrescriptionResponseKind', 50, '/Patient'))]
    const pool = poolOf(sources)
    const responses = [input('r0', 'https://ehr.test/Patient/1')]
    const harSel = HarSelection.initial(pool)
    const sel = Review.initial<FhirResource>()

    // Act
    render(
      <ReviewBody
        responses={responses}
        sources={sources}
        previews={previewOf(pool, responses, harSel)}
        harSelection={harSel}
        onHarSelectionChange={() => undefined}
        selection={sel}
        onSelectionChange={() => undefined}
      />
    )

    // Assert — the suffix is stripped from the label, and the un-suffixed name is gone.
    expect(screen.getByRole('checkbox', { name: 'Prescription' })).toBeDefined()
    expect(screen.queryByRole('checkbox', { name: 'PrescriptionResponseKind' })).toBeNull()
  })

  it('should disable a toggle for a kind that recognizes nothing in the file', () => {
    // Arrange — one file with only a Patient; the Observation kind claims nothing here.
    const sources = [source('ehr-source', patientKind, observationKind)]
    const pool = poolOf(sources)
    const responses = [input('r0', 'https://ehr.test/Patient/1')]
    const harSel = HarSelection.initial(pool)
    const sel = Review.initial<FhirResource>()

    // Act
    render(
      <ReviewBody
        responses={responses}
        sources={sources}
        previews={previewOf(pool, responses, harSel)}
        harSelection={harSel}
        onHarSelectionChange={() => undefined}
        selection={sel}
        onSelectionChange={() => undefined}
      />
    )

    // Assert — the matching kind is togglable and checked; the non-matching one
    // is disabled and reads as unchecked.
    const patient = screen.getByRole<HTMLInputElement>('checkbox', { name: 'patient' })
    const observation = screen.getByRole<HTMLInputElement>('checkbox', { name: 'observation' })
    expect(patient.disabled).toBe(false)
    expect(patient.checked).toBe(true)
    expect(observation.disabled).toBe(true)
    expect(observation.checked).toBe(false)
  })

  it('should default a per-response picker to the top-specificity candidate', () => {
    // Arrange — a broad and a specific kind that overlap on /Patient.
    const sources = [source('ehr-source', portalKind, patientKind)]
    const pool = poolOf(sources)
    const responses = [input('r0', 'https://ehr.test/Patient/1')]
    const harSel = HarSelection.initial(pool)
    const sel = Review.initial<FhirResource>()

    // Act
    render(
      <ReviewBody
        responses={responses}
        sources={sources}
        previews={previewOf(pool, responses, harSel)}
        harSelection={harSel}
        onHarSelectionChange={() => undefined}
        selection={sel}
        onSelectionChange={() => undefined}
      />
    )

    // Assert — the overlap renders a real choice defaulting to the higher-spec kind.
    expect(screen.getByRole('combobox', { name: /Import kind for/ })).toBeDefined()
    expect(screen.getByRole('option', { name: 'patient', selected: true })).toBeDefined()
    expect(screen.getByRole('option', { name: 'portal', selected: false })).toBeDefined()
  })

  it('should list one row per previewed resource with type, summary, and include checkbox', () => {
    // Arrange — a source producing two resources for one response
    const twoObs = kind('observation', 50, '/Observation', [
      { resourceType: 'Observation', id: 'o1', code: { text: 'Weight' } },
      { resourceType: 'Observation', id: 'o2', code: { text: 'Height' } },
    ])
    const sources = [source('ehr-source', twoObs)]
    const pool = poolOf(sources)
    const responses = [input('r-obs', 'https://ehr.test/Observation?s=1')]
    const harSel = HarSelection.initial(pool)
    const sel = Review.initial<FhirResource>()

    // Act
    render(
      <ReviewBody
        responses={responses}
        sources={sources}
        previews={previewOf(pool, responses, harSel)}
        harSelection={harSel}
        onHarSelectionChange={() => undefined}
        selection={sel}
        onSelectionChange={() => undefined}
      />
    )

    // Assert — each resource gets its own row + checkbox; the tally names them
    expect(screen.getByRole('checkbox', { name: /Include Observation Weight/ })).toBeDefined()
    expect(screen.getByRole('checkbox', { name: /Include Observation Height/ })).toBeDefined()
    expect(screen.getByRole('status').textContent).toContain('2 Observation')
  })

  it('should update the per-type tally when a resource is toggled off', async () => {
    // Arrange
    const twoObs = kind('observation', 50, '/Observation', [
      { resourceType: 'Observation', id: 'o1', code: { text: 'Weight' } },
      { resourceType: 'Observation', id: 'o2', code: { text: 'Height' } },
    ])
    const sources = [source('ehr-source', twoObs)]
    const pool = poolOf(sources)
    const responses = [input('r-obs', 'https://ehr.test/Observation?s=1')]
    const harSel = HarSelection.initial(pool)
    let currentSelection = Review.initial<FhirResource>()
    const previews = previewOf(pool, responses, harSel)
    const { rerender } = render(
      <ReviewBody
        responses={responses}
        sources={sources}
        previews={previews}
        harSelection={harSel}
        onHarSelectionChange={() => undefined}
        selection={currentSelection}
        onSelectionChange={(next) => {
          currentSelection = next
        }}
      />
    )

    // Act — untick the first observation, then re-render with the new selection
    await userEvent.click(screen.getByRole('checkbox', { name: /Include Observation Weight/ }))
    rerender(
      <ReviewBody
        responses={responses}
        sources={sources}
        previews={previews}
        harSelection={harSel}
        onHarSelectionChange={() => undefined}
        selection={currentSelection}
        onSelectionChange={(next) => {
          currentSelection = next
        }}
      />
    )

    // Assert — the tally now names the exclusion; chosenResources drops it too
    expect(screen.getByRole('status').textContent).toContain('2 Observation, 1 excluded')
    const labeled = labeledFromPreviews(previews)
    const chosen = Review.chosenResources(labeled, currentSelection)
    const idOf = (resource: unknown): string => {
      if (typeof resource !== 'object' || resource === null || !('id' in resource)) return ''
      const value = (resource as { readonly id: unknown }).id
      return typeof value === 'string' ? value : ''
    }
    expect(chosen.map(idOf)).toEqual(['o2'])
  })

  it('should re-derive the pick when a kind is toggled off everywhere', async () => {
    // Arrange
    const sources = [source('ehr-source', portalKind, patientKind)]
    const pool = poolOf(sources)
    const responses = [input('r0', 'https://ehr.test/Patient/1')]
    let currentHarSel = HarSelection.initial(pool)
    const sel = Review.initial<FhirResource>()
    const { rerender } = render(
      <ReviewBody
        responses={responses}
        sources={sources}
        previews={previewOf(pool, responses, currentHarSel)}
        harSelection={currentHarSel}
        onHarSelectionChange={(next) => {
          currentHarSel = next
        }}
        selection={sel}
        onSelectionChange={() => undefined}
      />
    )
    expect(screen.getByRole('combobox', { name: /Import kind for/ })).toBeDefined()

    // Act — turn `patient` off across the whole import, re-render with the new
    // har selection + previews
    await userEvent.click(screen.getByRole('checkbox', { name: 'patient' }))
    rerender(
      <ReviewBody
        responses={responses}
        sources={sources}
        previews={previewOf(pool, responses, currentHarSel)}
        harSelection={currentHarSel}
        onHarSelectionChange={(next) => {
          currentHarSel = next
        }}
        selection={sel}
        onSelectionChange={() => undefined}
      />
    )

    // Assert — the overlap collapses to the single remaining `portal`, so the
    // choice disappears: the pick was re-derived from the enabled kinds.
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('should mark an edited resource with a chip and offer a Revert button', () => {
    // Arrange — one recognized Patient previewed, then the reviewer's edit
    // registered in the selection (the dialog itself is exercised in
    // resource-editor.test). Patient is used here because its describe path
    // reads a name that survives the schema round-trip; the point is that
    // an edit rides through to the description, whatever the type.
    const sources = [source('ehr-source', patientKind)]
    const pool = poolOf(sources)
    const responses = [input('r-p', 'https://ehr.test/Patient/1')]
    const harSel = HarSelection.initial(pool)
    const initial = Review.initial<FhirResource>()
    const previews = previewOf(pool, responses, harSel)
    // A real, decoded Patient — the same shape a reviewer's Keep would
    // produce — so the override is typed by the selection's `TParsed`.
    const edited = decodeFhirResource({
      resourceType: 'Patient',
      id: 'patient-1',
      name: [{ text: 'Edited By Hand' }],
    })
    const editedSelection = Review.edit(initial, 'r-p:0', edited)

    // Act
    render(
      <ReviewBody
        responses={responses}
        sources={sources}
        previews={previews}
        harSelection={harSel}
        onHarSelectionChange={() => undefined}
        selection={editedSelection}
        onSelectionChange={() => undefined}
      />
    )

    // Assert — the chip is visible and Revert exists; the description reflects
    // that the row now reads through the override's own value (a `Patient`,
    // not the parsed original the pool synthesised).
    expect(screen.getByText('Edited')).toBeDefined()
    expect(screen.getByRole('button', { name: /Revert edit to Patient/ })).toBeDefined()
  })

  it('should call onSelectionChange with a reverted selection when Revert is clicked', async () => {
    // Arrange — one edit in place
    const sources = [source('ehr-source', patientKind)]
    const pool = poolOf(sources)
    const responses = [input('r-p', 'https://ehr.test/Patient/1')]
    const harSel = HarSelection.initial(pool)
    const initial = Review.initial<FhirResource>()
    const previews = previewOf(pool, responses, harSel)
    const edited = decodeFhirResource({ resourceType: 'Patient', id: 'patient-1' })
    const editedSelection = Review.edit(initial, 'r-p:0', edited)
    let seen: Review.Selection<FhirResource> | null = null

    // Act
    render(
      <ReviewBody
        responses={responses}
        sources={sources}
        previews={previews}
        harSelection={harSel}
        onHarSelectionChange={() => undefined}
        selection={editedSelection}
        onSelectionChange={(next) => {
          seen = next
        }}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /Revert edit to/ }))

    // Assert — the revert reached the shell and cleared the override
    expect(seen).not.toBeNull()
    if (seen === null) throw new Error('unreachable: assertion above holds')
    expect(Review.isResourceEdited(seen, 'r-p:0')).toBe(false)
  })

  it('should fold unrecognized responses into a collapsible no-match section', () => {
    // Arrange — one recognized Patient, one unrecognized asset.
    const sources = [source('ehr-source', patientKind)]
    const pool = poolOf(sources)
    const responses = [
      input('r0', 'https://ehr.test/Patient/1'),
      input('r1', 'https://cdn.test/app.7f3c.js'),
    ]
    const harSel = HarSelection.initial(pool)
    const sel = Review.initial<FhirResource>()

    // Act
    render(
      <ReviewBody
        responses={responses}
        sources={sources}
        previews={previewOf(pool, responses, harSel)}
        harSelection={harSel}
        onHarSelectionChange={() => undefined}
        selection={sel}
        onSelectionChange={() => undefined}
      />
    )

    // Assert — the miss is counted in the summary and named inside the section.
    expect(screen.getByText(/1 response matched no importer/)).toBeDefined()
    expect(screen.getByText('https://cdn.test/app.7f3c.js')).toBeDefined()
  })
})
