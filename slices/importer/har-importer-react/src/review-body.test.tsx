import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DateTime, Effect, Option } from 'effect'
import { type Extraction, HttpResponseKind } from 'http-extraction-fundamentals'
import { Review } from 'importer-fundamentals'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { ReviewBody } from './review-body.tsx'

/**
 * The interactive review is driven directly — props in, DOM out — over a
 * synthetic pool so a real cross-source overlap (which the FHIR pool has none of)
 * can be forced. The points under test are the four the plan names: the default
 * pick is the top-specificity candidate; toggling a kind off re-derives every
 * pick; unrecognized responses fold into the collapsible no-match section; and
 * the selection the body reports up decodes to only the chosen parses.
 */

afterEach(cleanup)

/** A kind that claims URLs containing `token`, at `specificity`, parsing to its own name. */
const kind = (
  name: string,
  specificity: number,
  token: string
): HttpResponseKind.HttpResponseKind<string> =>
  HttpResponseKind.make({
    name,
    tryRecognize: (url) => (url.includes(token) ? Option.some({ specificity }) : Option.none()),
    parse: () => Effect.succeed([name]),
  })

/** One decoded response the recognizer reads. */
const input = (id: string, url: string): Extraction.Input => ({
  id,
  url,
  status: 200,
  statusText: 'OK',
  headers: [],
  startedAt: DateTime.unsafeNow(),
  body: new Uint8Array(),
  bodyAbsent: false,
})

// A broad `portal` (low specificity) and a `patient` (higher) both claim /Patient.
const portalKind = kind('portal', 10, '/Patient')
const patientKind = kind('patient', 50, '/Patient')
const observationKind = kind('observation', 50, '/Observation')

describe('ReviewBody', () => {
  it('should default a per-response picker to the top-specificity candidate', () => {
    // Arrange
    const pool = [portalKind, patientKind]
    const responses = [input('r0', 'https://ehr.test/Patient/1')]

    // Act
    render(
      <ReviewBody
        responses={responses}
        pool={pool}
        initialSelection={Review.initial(pool)}
        onChange={() => undefined}
      />
    )

    // Assert — the overlap renders a real choice defaulting to the higher-spec kind.
    expect(screen.getByRole('combobox', { name: /Import kind for/ })).toBeDefined()
    expect(screen.getByRole('option', { name: 'patient', selected: true })).toBeDefined()
    expect(screen.getByRole('option', { name: 'portal', selected: false })).toBeDefined()
  })

  it('should re-derive the pick when a kind is toggled off everywhere', async () => {
    // Arrange
    const pool = [portalKind, patientKind]
    const responses = [input('r0', 'https://ehr.test/Patient/1')]
    render(
      <ReviewBody
        responses={responses}
        pool={pool}
        initialSelection={Review.initial(pool)}
        onChange={() => undefined}
      />
    )
    expect(screen.getByRole('combobox', { name: /Import kind for/ })).toBeDefined()

    // Act — turn `patient` off across the whole import.
    await userEvent.click(screen.getByRole('checkbox', { name: 'patient' }))

    // Assert — the overlap collapses to the single remaining `portal`, so the
    // choice disappears: the pick was re-derived from the enabled kinds.
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('should fold unrecognized responses into a collapsible no-match section', () => {
    // Arrange — one recognized Patient, one unrecognized asset.
    const pool = [patientKind]
    const responses = [
      input('r0', 'https://ehr.test/Patient/1'),
      input('r1', 'https://cdn.test/app.7f3c.js'),
    ]

    // Act
    render(
      <ReviewBody
        responses={responses}
        pool={pool}
        initialSelection={Review.initial(pool)}
        onChange={() => undefined}
      />
    )

    // Assert — the miss is counted in the summary and named inside the section.
    expect(screen.getByText(/1 response matched no importer/)).toBeDefined()
    expect(screen.getByText('https://cdn.test/app.7f3c.js')).toBeDefined()
  })

  it('should report a selection that decodes to only the chosen parses', async () => {
    // Arrange
    const pool = [patientKind, observationKind]
    const responses = [
      input('r0', 'https://ehr.test/Patient/1'),
      input('r1', 'https://ehr.test/Observation?subject=1'),
    ]
    let reported: Review.Selection = Review.initial(pool)
    render(
      <ReviewBody
        responses={responses}
        pool={pool}
        initialSelection={Review.initial(pool)}
        onChange={(selection) => {
          reported = selection
        }}
      />
    )

    // Act — opt out of Observations, then decode what the reported selection chose.
    await userEvent.click(screen.getByRole('checkbox', { name: 'observation' }))
    const { resources } = await Effect.runPromise(Review.chosen(pool, responses, reported))

    // Assert — only the Patient decoded; the opted-out Observation wrote nothing.
    expect(resources).toEqual(['patient'])
  })
})
