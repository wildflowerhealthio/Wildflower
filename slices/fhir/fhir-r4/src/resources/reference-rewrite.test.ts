import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { MedicationRequest, ReferenceRewrite, ResourceReferences } from './index.ts'

/**
 * Covers the reference rewrite: where each reference points after it, what
 * it keeps, and that a resource nothing moves in comes back as itself.
 */

const decodeRequest = Schema.decodeUnknownSync(MedicationRequest.Schema)

/** A prescription whose `subject` names its patient by literal and identifier, and whose `requester` names a provider by identifier alone. */
const request = decodeRequest({
  resourceType: 'MedicationRequest',
  status: 'active',
  intent: 'order',
  subject: {
    reference: 'Patient/p-1',
    identifier: { system: 'https://source.example/patient-id', value: 'p-1' },
    display: 'Tyra Banks',
  },
  requester: {
    type: 'Practitioner',
    identifier: { system: 'https://source.example/practitioner-name', value: 'Dr. A Smith' },
    display: 'Dr. A Smith',
  },
})

/** The rewrite that gives `literal` at `path` and leaves every other reference. */
const at =
  (path: string, literal: string | null): ReferenceRewrite.Type =>
  (found) =>
    found.path === path ? Option.some(literal) : Option.none()

describe('ReferenceRewrite.apply', () => {
  it('points the reference a rewrite names where it says, keeping its type, identifier and display', () => {
    const rewritten = ReferenceRewrite.apply(request, at('requester', 'Practitioner/pr-1'))

    expect(rewritten.requester).toEqual({ ...request.requester, reference: 'Practitioner/pr-1' })
    expect(rewritten.subject).toBe(request.subject)
  })

  it('drops the literal of a reference the rewrite gives null', () => {
    const rewritten = ReferenceRewrite.apply(request, at('subject', null))

    expect(rewritten.subject).toEqual({ ...request.subject, reference: null })
  })

  it('gives back the resource itself when nothing moves', () => {
    expect(ReferenceRewrite.apply(request, ReferenceRewrite.none)).toBe(request)
  })

  it('gives back the resource itself when the rewrite gives each reference the literal it carries', () => {
    expect(ReferenceRewrite.apply(request, at('subject', 'Patient/p-1'))).toBe(request)
  })
})

describe('ReferenceRewrite.orElse', () => {
  it('takes the first rewrite’s literal where it gives one, the second’s elsewhere', () => {
    const rewritten = ReferenceRewrite.apply(
      request,
      ReferenceRewrite.orElse(at('subject', 'Patient/first'), (found) =>
        Option.some(`${found.path === 'subject' ? 'Patient' : 'Practitioner'}/second`)
      )
    )

    expect(
      ResourceReferences.collect(rewritten).map(({ reference }) => reference.reference)
    ).toEqual(['Patient/first', 'Practitioner/second'])
  })
})

describe('ReferenceRewrite.fromLookup', () => {
  it('rewrites a reference wherever it is, by the reference alone', () => {
    const rewritten = ReferenceRewrite.apply(
      request,
      ReferenceRewrite.fromLookup(({ display }) =>
        display === 'Dr. A Smith' ? Option.some('Practitioner/pr-1') : Option.none()
      )
    )

    expect(rewritten.requester?.reference).toBe('Practitioner/pr-1')
    expect(rewritten.subject).toBe(request.subject)
  })
})
