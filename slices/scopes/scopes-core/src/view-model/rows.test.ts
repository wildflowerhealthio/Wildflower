import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { Cell, Grant, Rows, Scope, type ScopeRequest, type ResourceSection } from '../index.ts'

const patient = Scope.Contexts.Fhir.patient
const v2 = Scope.FhirV2.configuration
const catalog = ['Observation', 'Condition'].map((name) => Scope.ResourceType.Fhir.parse(name)!)
const section: ResourceSection.ResourceSection<'fhirV2'> = {
  kind: 'fhirV2',
  configuration: v2,
  context: patient,
  resources: catalog,
}

const fhirAt = (
  level: Scope.Contexts.Fhir.Level,
  name: string,
  l: Scope.Permission.Cruds.Interaction[]
): Scope.FhirV2 =>
  new Scope.FhirV2(
    new Scope.Contexts.Fhir(level),
    Scope.ResourceType.Fhir.parse(name)!,
    new Scope.Permission.Cruds(l)
  )

const fhirV2 = (name: string, l: Scope.Permission.Cruds.Interaction[]): Scope.FhirV2 =>
  fhirAt('patient', name, l)

const request = (
  requested: Scope.Any[],
  required: Scope.Any[] = []
): ScopeRequest.ScopeRequest => ({
  requested: Grant.make(requested),
  required: Grant.make(required),
})

const rowKeys = (rows: readonly Rows.Row<'fhirV2'>[]): string[] =>
  rows.map((r) => r.resource.serialize())

describe('Rows.build — row list + stored scope', () => {
  test('each resource becomes a row, in the given order', () => {
    const rows = Rows.build(section, Grant.make([]), null)
    expect(rowKeys(rows)).toEqual(['Observation', 'Condition'])
    expect(rows.every((r) => !r.isWildcard)).toBe(true)
  })

  test('stored carries the first grant row for (context, resource)', () => {
    const scope = fhirV2('Observation', ['r'])
    const rows = Rows.build(section, Grant.make([scope]), null)
    expect(rows[0]?.stored?.serialize()).toBe('patient/Observation.r')
    expect(rows[1]?.stored).toBeUndefined()
  })

  test('stored matches the exact context only', () => {
    const rows = Rows.build(section, Grant.make([fhirAt('system', 'Observation', ['r'])]), null)
    expect(rows[0]?.stored).toBeUndefined()
  })
})

describe('Rows.build — wildcard-row policy (§2/§3)', () => {
  test('open mode: includeWildcard prepends the * row', () => {
    const rows = Rows.build(section, Grant.make([]), null, { includeWildcard: true })
    expect(rowKeys(rows)).toEqual(['*', 'Observation', 'Condition'])
    expect(rows[0]?.isWildcard).toBe(true)
  })

  test('open mode: without includeWildcard there is no * row', () => {
    const rows = Rows.build(section, Grant.make([]), null)
    expect(rowKeys(rows)).toEqual(['Observation', 'Condition'])
  })

  test('request mode: a requested wildcard at this context offers the * row', () => {
    // An app requesting `patient/*.rs` must be grantable the wildcard itself, not
    // only the concrete rows beneath it.
    const req = request([fhirV2('*', ['r', 's'])])
    const rows = Rows.build(section, Grant.make([]), req, { includeWildcard: true })
    expect(rowKeys(rows)).toEqual(['*', 'Observation', 'Condition'])
    expect(rows[0]?.cellFor('r').state).toBe('off')
    expect(rows[0]?.cellFor('c').state).toBe('disabled')
  })

  test('request mode: no requested wildcard ⇒ no * row', () => {
    const req = request([fhirV2('Observation', ['r'])])
    const rows = Rows.build(section, Grant.make([]), req, { includeWildcard: true })
    expect(rowKeys(rows)).toEqual(['Observation', 'Condition'])
  })

  test('request mode: a covering system wildcard offers the * row in the patient section', () => {
    // `system/*` can grant `patient/*` (context coverage), so the patient section
    // must offer the wildcard row — the expandable "allow any record type" path.
    const req = request([fhirAt('system', '*', ['r'])])
    const rows = Rows.build(section, Grant.make([]), req, { includeWildcard: true })
    expect(rowKeys(rows)).toEqual(['*', 'Observation', 'Condition'])
    expect(rows[0]?.cellFor('r').state).toBe('off')
  })

  test('request mode: a patient wildcard does not leak into the system section (no upward coverage)', () => {
    const systemSection: ResourceSection.ResourceSection<'fhirV2'> = {
      ...section,
      context: Scope.Contexts.Fhir.system,
    }
    const req = request([fhirV2('*', ['r'])])
    const rows = Rows.build(systemSection, Grant.make([]), req, { includeWildcard: true })
    expect(rowKeys(rows)).toEqual(['Observation', 'Condition'])
  })
})

describe('Rows.build — cells agree with Cell.forItem', () => {
  const interactions: readonly Scope.Permission.Cruds.Interaction[] = ['c', 'r', 'u', 'd', 's']

  test('required cells lock, wildcard-covered cells lock, granted cells read on', () => {
    const req = request(
      [fhirV2('Observation', ['r', 'c']), fhirV2('Condition', ['r'])],
      [fhirV2('Observation', ['r'])]
    )
    const grant = Grant.make([fhirV2('Observation', ['r', 'c'])])
    const rows = Rows.build(section, grant, req)
    expect(rows[0]?.cellFor('r')).toEqual({ state: 'locked', lockReason: { kind: 'required' } })
    expect(rows[0]?.cellFor('c').state).toBe('on')
    expect(rows[0]?.cellFor('u').state).toBe('disabled')
    expect(rows[1]?.cellFor('r').state).toBe('off')
  })

  test('duplicate required rows for one resource are unioned, not first-wins', () => {
    // `Grant.make` groups by kind only, so a split request can carry two required rows
    // for the same (context, resource) — both must lock, matching `toggleItem`'s merge.
    const req = request(
      [fhirV2('Observation', ['r', 's'])],
      [fhirV2('Observation', ['r']), fhirV2('Observation', ['s'])]
    )
    const rows = Rows.build(section, Grant.make([]), req)
    expect(rows[0]?.cellFor('r')).toEqual({ state: 'locked', lockReason: { kind: 'required' } })
    expect(rows[0]?.cellFor('s')).toEqual({ state: 'locked', lockReason: { kind: 'required' } })
  })

  test('every cell equals Cell.forItem on random small grants and requests (property)', () => {
    const scopeArb = fc
      .record({
        level: fc.constantFrom<Scope.Contexts.Fhir.Level>('patient', 'user', 'system'),
        name: fc.constantFrom('*', 'Observation', 'Condition'),
        letters: fc.uniqueArray(
          fc.constantFrom<Scope.Permission.Cruds.Interaction>('c', 'r', 'u', 'd', 's'),
          { minLength: 1 }
        ),
      })
      .map(({ level, name, letters }) => fhirAt(level, name, letters))
    const scopesArb = fc.array(scopeArb, { maxLength: 4 })

    fc.assert(
      fc.property(
        scopesArb,
        scopesArb,
        scopesArb,
        fc.boolean(),
        (granted, requested, required, openMode) => {
          const grant = Grant.make(granted)
          const req = openMode ? null : request(requested, required)
          const rows = Rows.build(section, grant, req, { includeWildcard: true })
          for (const row of rows) {
            for (const interaction of interactions) {
              expect(row.cellFor(interaction)).toEqual(
                Cell.forItem(v2, grant, req, patient, row.resource, interaction)
              )
            }
          }
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
