import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { Grant, Scope, ScopeRequest } from 'scopes-core'
import { describe, expect, test } from 'vite-plus/test'

import {
  consentExclusions,
  consentFlags,
  consentScopeRequest,
  consentSections,
} from './consent-sections.ts'
import type { Consent } from './types.ts'

/** A minimal `Consent` over the given requested scopes — other fields are inert here. */
const makeConsent = (scopes: readonly string[]): Consent => ({
  id: 'consent-1',
  clientId: 'app.example',
  scopes,
  redirectUri: 'https://app.example/cb',
  preApprovedScopes: [],
  patient: null,
})

/** The all-optional request derived from a plain requested-scope list. */
const req = (scopes: readonly string[]): ScopeRequest.ScopeRequest =>
  consentScopeRequest(makeConsent(scopes))

describe('consentScopeRequest', () => {
  test('requested = parsed scopes, required = empty (all-optional)', () => {
    const request = req(['patient/Observation.rs', 'openid'])
    expect(Grant.render(request.requested)).toEqual(['patient/Observation.rs', 'openid'])
    expect(Grant.render(request.required)).toEqual([])
  })
})

describe('consentSections — derivation per kind/context', () => {
  test('one FHIR v2 section per requested context level, patient → user → system', () => {
    const sections = consentSections(
      req(['system/Observation.r', 'patient/Condition.rs', 'user/Encounter.r'])
    )
    expect(sections.map((s) => s.key)).toEqual(['fhirV2/patient', 'fhirV2/user', 'fhirV2/system'])
    expect(sections.every((s) => s.kind === 'fhirV2')).toBe(true)
    expect(sections.every((s) => s.chip === 'FHIR')).toBe(true)
  })

  test('v1 (read/write) and v2 (cruds) become distinct sections', () => {
    const sections = consentSections(req(['patient/Observation.read', 'patient/Condition.rs']))
    expect(sections.map((s) => s.kind)).toEqual(['fhirV2', 'fhirV1'])
    const v2 = sections.find((s) => s.kind === 'fhirV2')
    const v1 = sections.find((s) => s.kind === 'fhirV1')
    expect(v2?.section.catalog).toEqual(['Condition'])
    expect(v1?.section.catalog).toEqual(['Observation'])
  })

  test('a Wildflower admin section appears last when a wildflower scope is requested', () => {
    const sections = consentSections(req(['patient/Observation.r', 'wildflower/Client.r']))
    const last = sections.at(-1)
    expect(last?.kind).toBe('wildflower')
    expect(last?.title).toBe('Wildflower admin')
    expect(last?.chip).toBe('Admin')
    expect(last?.section.catalog).toEqual(['Client'])
  })

  test('no section for a context or kind with no requested scopes', () => {
    const sections = consentSections(req(['patient/Observation.r']))
    expect(sections).toHaveLength(1)
    expect(sections[0]?.key).toBe('fhirV2/patient')
  })
})

describe('consentSections — catalog ordering / wildcard / dedupe', () => {
  test('catalog is ordered by the FHIR catalog, unlisted names appended first-seen', () => {
    // Observation precedes Condition in the catalog; "Zebra" is unlisted (appended first-seen).
    const sections = consentSections(
      req(['patient/Condition.r', 'patient/Zebra.r', 'patient/Observation.r'])
    )
    expect(sections[0]?.section.catalog).toEqual(['Observation', 'Condition', 'Zebra'])
  })

  test('the wildcard resource is excluded from the catalog (the grid injects the row)', () => {
    const sections = consentSections(req(['patient/*.rs', 'patient/Observation.r']))
    expect(sections[0]?.section.catalog).toEqual(['Observation'])
  })

  test('duplicate resource names are de-duplicated', () => {
    const sections = consentSections(req(['patient/Observation.r', 'patient/Observation.cs']))
    expect(sections[0]?.section.catalog).toEqual(['Observation'])
  })
})

describe('consentSections — title suffix logic', () => {
  test('a single patient context reads plain "Health records"', () => {
    const sections = consentSections(req(['patient/Observation.r']))
    expect(sections[0]?.title).toBe('Health records')
  })

  test('a lone system context always names all-patients', () => {
    const sections = consentSections(req(['system/Observation.r']))
    expect(sections[0]?.title).toBe('Health records — all patients')
  })

  test('multiple contexts suffix patient and user', () => {
    const sections = consentSections(req(['patient/Observation.r', 'user/Encounter.r']))
    const byKey = new Map(sections.map((s) => [s.key, s.title]))
    expect(byKey.get('fhirV2/patient')).toBe('Health records — this patient')
    expect(byKey.get('fhirV2/user')).toBe('Health records — your access')
  })
})

describe('consentFlags', () => {
  test('requested known flags in canonical order; unknown scopes surfaced raw', () => {
    const { flags, unknown } = consentFlags(
      req(['offline_access', 'openid', 'x-custom-scope', 'launch/patient'])
    )
    // Canonical order is openid, profile, fhirUser, offline_access, launch, launch/patient.
    expect(flags).toEqual(['openid', 'offline_access', 'launch/patient'])
    expect(unknown).toEqual(['x-custom-scope'])
  })
})

describe('consentExclusions — presence/absence rules', () => {
  test('all four excluded lines when the request is a single narrow patient scope', () => {
    const keys = consentExclusions(req(['patient/Observation.r'])).map((e) => e.key)
    expect(keys).toEqual(['other-record-types', 'admin', 'offline', 'other-patients'])
  })

  test('a FHIR wildcard drops "other health record types"', () => {
    const keys = consentExclusions(req(['patient/*.r'])).map((e) => e.key)
    expect(keys).not.toContain('other-record-types')
  })

  test('a wildflower scope drops the admin line', () => {
    const keys = consentExclusions(req(['wildflower/Client.r'])).map((e) => e.key)
    expect(keys).not.toContain('admin')
  })

  test('offline_access drops the background line', () => {
    const keys = consentExclusions(req(['offline_access'])).map((e) => e.key)
    expect(keys).not.toContain('offline')
  })

  test('a system-context scope drops the other-patients line', () => {
    const keys = consentExclusions(req(['system/Observation.r'])).map((e) => e.key)
    expect(keys).not.toContain('other-patients')
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

describe('consentSections — property', () => {
  test('every requested named resource scope lands in exactly one section', () => {
    fc.assert(
      fc.property(requestedArb, (scopes) => {
        const request = req(scopes)
        const sections = consentSections(request)

        for (const scope of Scope.MultiScope.resourceScopes(request.requested)) {
          const name = scope.resource.serialize()
          if (name === '*') continue // wildcard is injected by the grid, not the catalog
          const matches = sections.filter(
            (section) =>
              section.kind === scope.kind &&
              section.section.context.serialize() === scope.context.serialize() &&
              section.section.catalog.includes(name)
          )
          expect(matches).toHaveLength(1)
        }
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test("every section's catalog names parse under its configuration and stay within request", () => {
    fc.assert(
      fc.property(requestedArb, (scopes) => {
        const request = req(scopes)
        for (const { section } of consentSections(request)) {
          for (const name of section.catalog) {
            expect(section.configuration.resourceClass.parse(name)).not.toBeNull()
          }
        }
        // The requested envelope is self-consistent: it is within itself.
        expect(ScopeRequest.isWithin({ patient: null, ...request.requested }, request)).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
