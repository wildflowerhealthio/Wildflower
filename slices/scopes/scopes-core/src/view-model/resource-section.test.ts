import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { GrantDraft, Scope, ScopeRequest, ResourceSection } from '../index.ts'

/** The all-optional request derived from a plain requested-scope list. */
const req = (scopes: readonly string[]): ScopeRequest.ScopeRequest =>
  ScopeRequest.fromRequestedScopes({ optional: scopes })

/** A draft over a plain scope list (no launch patient). */
const draftOf = (scopes: readonly string[]): GrantDraft.GrantDraft => GrantDraft.fromScopes(scopes)

/** A section's (kind, context) identity — the discriminator pair a section is derived by. */
const keyOf = (section: ResourceSection.Any): string =>
  `${section.kind}/${section.context.serialize()}`

/** A section's resource names, in row order. */
const resourceNames = (section: ResourceSection.Any): string[] =>
  section.resources.map((resource) => resource.serialize())

describe('Sections.fromRequest — derivation per kind/context', () => {
  test('one FHIR v2 section per requested context level, patient → user → system', () => {
    const sections = ResourceSection.listFromRequest(
      req(['system/Observation.r', 'patient/Condition.rs', 'user/Encounter.r'])
    )
    expect(sections.map(keyOf)).toEqual(['fhirV2/patient', 'fhirV2/user', 'fhirV2/system'])
    expect(sections.every((s) => s.kind === 'fhirV2')).toBe(true)
  })

  test('v1 (read/write) and v2 (cruds) become distinct sections', () => {
    const sections = ResourceSection.listFromRequest(
      req(['patient/Observation.read', 'patient/Condition.rs'])
    )
    expect(sections.map((s) => s.kind)).toEqual(['fhirV2', 'fhirV1'])
    const v2 = sections.find((s) => s.kind === 'fhirV2')
    const v1 = sections.find((s) => s.kind === 'fhirV1')
    expect(v2 && resourceNames(v2)).toEqual(['Condition'])
    expect(v1 && resourceNames(v1)).toEqual(['Observation'])
  })

  test('a Wildflower admin section appears last when a wildflower scope is requested', () => {
    const sections = ResourceSection.listFromRequest(
      req(['patient/Observation.r', 'wildflower/Client.r'])
    )
    const last = sections.at(-1)
    expect(last?.kind).toBe('wildflower')
    expect(last && resourceNames(last)).toEqual(['Client'])
  })

  test('no section for a context or kind with no requested scopes', () => {
    const sections = ResourceSection.listFromRequest(req(['patient/Observation.r']))
    expect(sections.map(keyOf)).toEqual(['fhirV2/patient'])
  })
})

describe('Sections.fromRequest — resource ordering / wildcard / dedupe', () => {
  test('resources are ordered by the FHIR catalog, unlisted names appended first-seen', () => {
    // Observation precedes Condition in the catalog; "Zebra" is unlisted (appended first-seen).
    const sections = ResourceSection.listFromRequest(
      req(['patient/Condition.r', 'patient/Zebra.r', 'patient/Observation.r'])
    )
    expect(sections[0] && resourceNames(sections[0])).toEqual(['Observation', 'Condition', 'Zebra'])
  })

  test('the wildcard resource is excluded from the resources (the grid injects the row)', () => {
    const sections = ResourceSection.listFromRequest(req(['patient/*.rs', 'patient/Observation.r']))
    expect(sections[0] && resourceNames(sections[0])).toEqual(['Observation'])
  })

  test('duplicate resource names are de-duplicated', () => {
    const sections = ResourceSection.listFromRequest(
      req(['patient/Observation.r', 'patient/Observation.cs'])
    )
    expect(sections[0] && resourceNames(sections[0])).toEqual(['Observation'])
  })
})

describe('Sections.listForDraft — seeded-draft reduction to listFromRequest', () => {
  test('a draft seeded from the request reduces to listFromRequest', () => {
    const scopes = ['system/Observation.r', 'patient/Condition.rs', 'wildflower/Client.r']
    const request = req(scopes)
    // How every consent surface mounts: the draft starts with everything requested.
    const fromDraft = ResourceSection.listForDraft(request, draftOf(scopes))
    const fromRequest = ResourceSection.listFromRequest(request)
    expect(fromDraft.map(keyOf)).toEqual(fromRequest.map(keyOf))
    expect(fromDraft.map(resourceNames)).toEqual(fromRequest.map(resourceNames))
  })

  test('a fully-pruned draft keeps the active context (with its requested rows re-tickable)', () => {
    const request = req(['patient/Observation.r', 'patient/Condition.r'])
    const fromDraft = ResourceSection.listForDraft(
      request,
      draftOf([]),
      new Map(),
      Scope.Contexts.Fhir.patient
    )
    expect(fromDraft.map(keyOf)).toEqual(['fhirV2/patient'])
    expect(fromDraft[0] && resourceNames(fromDraft[0])).toEqual(['Observation', 'Condition'])
  })

  test('a requested-but-deselected context hides (the subject switch re-homes the draft)', () => {
    // The device asked at patient/, but the whole selection moved to system/ —
    // the empty patient section must not linger as a mixed-context leftover.
    const request = ScopeRequest.expandable({
      requested: ['patient/Observation.r'],
      available: ['system/*.cruds'],
    })
    const fromDraft = ResourceSection.listForDraft(
      request,
      draftOf(['system/Observation.r']),
      new Map(),
      Scope.Contexts.Fhir.system
    )
    expect(fromDraft.map(keyOf)).toEqual(['fhirV2/system'])
  })
})

describe('Sections.listForDraft — expandable mode', () => {
  const expandable = ScopeRequest.expandable({
    requested: ['patient/Observation.r'],
    available: ['system/*.cruds', 'wildflower/*.cruds'],
  })

  test('empty requesting-page picker: the active FHIR context seeds a section to add into', () => {
    // requested = ∅, available = system/* + wildflower/*, subject = all-patients (system).
    const request = ScopeRequest.expandable({
      requested: [],
      available: ['system/*.cruds', 'wildflower/*.cruds'],
    })
    const sections = ResourceSection.listForDraft(
      request,
      draftOf([]),
      new Map(),
      Scope.Contexts.Fhir.system
    )
    // A system FHIR section (empty of named resources — the grid injects the `*` row) and the
    // Wildflower admin section, both from the available envelope.
    expect(sections.map(keyOf)).toEqual(['fhirV2/system', 'wildflower/wildflower'])
    expect(sections.every((section) => section.resources.length === 0)).toBe(true)
  })

  test('a draft grant beyond `requested` surfaces its resource as a row', () => {
    // The approver added `patient/Condition.r`, never requested — it must appear.
    const sections = ResourceSection.listForDraft(expandable, draftOf(['patient/Condition.r']))
    const patientV2 = sections.find((section) => keyOf(section) === 'fhirV2/patient')
    expect(patientV2 && resourceNames(patientV2)).toEqual(['Observation', 'Condition'])
  })

  test('"+ Add rule" extra names appear as rows before they are toggled', () => {
    const extra = new Map([['fhirV2/patient', ['Immunization']]])
    const sections = ResourceSection.listForDraft(expandable, draftOf([]), extra)
    const patientV2 = sections.find((section) => keyOf(section) === 'fhirV2/patient')
    // Requested Observation, plus the added-but-untoggled Immunization.
    expect(patientV2 && resourceNames(patientV2)).toEqual(['Observation', 'Immunization'])
  })

  test('an active context the envelope cannot grant is not offered as a section', () => {
    // available covers only patient FHIR (patient/*), so the system active context is
    // dropped — and the deselected, empty patient section doesn't linger either.
    const patientOnly = ScopeRequest.expandable({
      requested: ['patient/Observation.r'],
      available: ['patient/*.cruds'],
    })
    const sections = ResourceSection.listForDraft(
      patientOnly,
      draftOf([]),
      new Map(),
      Scope.Contexts.Fhir.system
    )
    expect(sections.map(keyOf)).toEqual([])
  })
})

// Arbitraries over the real catalog × contexts × cruds letters.
const contextArb = fc.constantFrom('patient', 'user', 'system')
const resourceNameArb = fc.constantFrom(...Scope.ResourceType.Fhir.catalog)
const letterArb = fc.constantFrom('c', 'r', 'u', 'd', 's')
const fhirScopeStringArb = fc
  .record({
    context: contextArb,
    name: resourceNameArb,
    perms: fc.uniqueArray(letterArb, { minLength: 1 }),
  })
  .map(({ context, name, perms }) => `${context}/${name}.${perms.join('')}`)
const requestedArb = fc.uniqueArray(fhirScopeStringArb, { maxLength: 8 })

describe('Sections.fromRequest — property', () => {
  test('every requested named resource scope lands in exactly one section', () => {
    fc.assert(
      fc.property(requestedArb, (scopes) => {
        const request = req(scopes)
        const sections = ResourceSection.listFromRequest(request)

        for (const scope of Scope.MultiScope.resourceScopes(request.requested)) {
          const name = scope.resource.serialize()
          if (name === '*') continue // wildcard is injected by the grid, not the section
          const matches = sections.filter(
            (section) =>
              section.kind === scope.kind &&
              section.context.serialize() === scope.context.serialize() &&
              resourceNames(section).includes(name)
          )
          expect(matches).toHaveLength(1)
        }
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test("every section's resources round-trip under its configuration and stay within request", () => {
    fc.assert(
      fc.property(requestedArb, (scopes) => {
        const request = req(scopes)
        for (const section of ResourceSection.listFromRequest(request)) {
          for (const resource of section.resources) {
            expect(section.configuration.resourceClass.parse(resource.serialize())).toEqual(
              resource
            )
          }
        }
        // The requested envelope is self-consistent: it is within itself.
        expect(ScopeRequest.isWithin({ patient: null, ...request.requested }, request)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
