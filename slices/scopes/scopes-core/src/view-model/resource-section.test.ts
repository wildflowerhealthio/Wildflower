import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { Scope, ScopeRequest, ResourceSection } from '../index.ts'

/** The all-optional request derived from a plain requested-scope list. */
const req = (scopes: readonly string[]): ScopeRequest.ScopeRequest =>
  ScopeRequest.fromRequestedScopes({ optional: scopes })

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
