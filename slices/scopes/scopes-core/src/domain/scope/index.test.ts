import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as Scope from './index.ts'

const fhirV2 = (
  context: Scope.Contexts.Fhir.Level,
  name: string,
  permission: Scope.Permission.Cruds
): Scope.Base => {
  return new Scope.FhirV2(
    new Scope.Contexts.Fhir(context),
    Scope.ResourceType.Fhir.parse(name)!,
    permission
  )
}
const fhirV1 = (
  context: Scope.Contexts.Fhir.Level,
  name: string,
  permission: Scope.Permission.ReadWrite
): Scope.Base => {
  return new Scope.FhirV1(
    new Scope.Contexts.Fhir(context),
    Scope.ResourceType.Fhir.parse(name)!,
    permission
  )
}

describe('Scope.scopeParse — total parse (mirrors Rust Scope)', () => {
  test('classifies flag / fhir / wildflower / unknown', () => {
    expect(Scope.parse('openid')).toEqual({ kind: 'known', name: 'openid' })
    expect(Scope.parse('launch/patient')).toEqual({ kind: 'known', name: 'launch/patient' })
    expect(Scope.parse('patient/Observation.rs')).toEqual(
      fhirV2('patient', 'Observation', new Scope.Permission.Cruds(['r', 's']))
    )
    expect(Scope.parse('system/*.cruds')).toEqual(
      fhirV2('system', '*', new Scope.Permission.Cruds(['c', 'r', 'u', 'd', 's']))
    )
    // v1 words are FHIR-only — they still parse for a FHIR scope...
    expect(Scope.parse('patient/Observation.read')).toEqual(
      fhirV1('patient', 'Observation', new Scope.Permission.ReadWrite(['read']))
    )
    // ...but NOT for Wildflower: a v1 word there is unparseable → unknown.
    expect(Scope.parse('wildflower/Grant.read')).toEqual({
      kind: 'unknown',
      raw: 'wildflower/Grant.read',
    })
    expect(Scope.parse('wildflower/*.write')).toEqual({
      kind: 'unknown',
      raw: 'wildflower/*.write',
    })
    // A v2 letter bag still parses for Wildflower.
    expect(Scope.parse('wildflower/Grant.cruds')).toEqual(
      new Scope.Wildflower(
        new Scope.Contexts.Wildflower(),
        new Scope.ResourceType.Wildflower.Known('Grant'),
        new Scope.Permission.Cruds(['c', 'r', 'u', 'd', 's'])
      ) satisfies Scope.ResourceScope.Base<
        Scope.Contexts.Wildflower,
        Scope.ResourceType.Wildflower,
        Scope.Permission.Cruds.Interaction,
        'wildflower'
      >
    )
    // wildflower context + unknown resource ⇒ unknown (the set is closed, like Rust)
    expect(Scope.parse('wildflower/Nope.cruds')).toEqual({
      kind: 'unknown',
      raw: 'wildflower/Nope.cruds',
    })
    expect(Scope.parse('patient/Observation.rx')).toEqual({
      kind: 'unknown',
      raw: 'patient/Observation.rx',
    })
    expect(Scope.parse('totally-made-up')).toEqual({ kind: 'unknown', raw: 'totally-made-up' })
  })

  test('parse strips a v2 `?`-search-parameter suffix (mirrors Rust strip_search_suffix)', () => {
    expect(Scope.parse('patient/Observation.rs?category=vital-signs')).toEqual(
      fhirV2('patient', 'Observation', new Scope.Permission.Cruds(['r', 's']))
    )
    // A bare `?` with no letters before it leaves an empty perms segment ⇒ unknown.
    expect(Scope.parse('patient/Observation.?category=x')).toEqual({
      kind: 'unknown',
      raw: 'patient/Observation.?category=x',
    })
  })

  test('parse splits type/perms on the first dot; a second dot is invalid (⇒ unknown)', () => {
    // Rust splits type/perms on the *first* dot (`split_once('.')`); `a.b` is not a
    // resource with perms `rs`, and multiple dots are rejected outright.
    expect(Scope.parse('patient/a.b.rs')).toEqual({ kind: 'unknown', raw: 'patient/a.b.rs' })
    // The single-dot form still parses (resource `Observation`, perms `rs`).
    expect(Scope.parse('patient/Observation.rs')).toEqual(
      fhirV2('patient', 'Observation', new Scope.Permission.Cruds(['r', 's']))
    )
  })

  test('FHIR + Wildflower scopes round-trip through serialize → parse', () => {
    const crudsArb: fc.Arbitrary<Scope.Permission.Cruds> = fc
      .uniqueArray(fc.constantFrom<Scope.Permission.Cruds.Interaction>('c', 'r', 'u', 'd', 's'), {
        minLength: 1,
      })
      .map((l) => new Scope.Permission.Cruds(l))
    // FHIR can be a cruds permission or a v1 word; Wildflower is cruds only.
    const fhirPermission: fc.Arbitrary<Scope.Permission.ReadWrite | Scope.Permission.Cruds> =
      fc.oneof(
        crudsArb,
        fc.constantFrom(
          Scope.Permission.ReadWrite.read,
          Scope.Permission.ReadWrite.write,
          Scope.Permission.ReadWrite.star
        )
      )
    const fhirArb = fc
      .tuple(
        fc.constantFrom<Scope.Contexts.Fhir.Level>('patient', 'user', 'system'),
        fc.constantFrom('Observation', 'Patient', '*'),
        fhirPermission
      )
      .map(
        ([ctx, name, a]): Scope.Base =>
          a instanceof Scope.Permission.ReadWrite ? fhirV1(ctx, name, a) : fhirV2(ctx, name, a)
      )
    const wfArb = fc
      .tuple(fc.constantFrom<Scope.ResourceType.Wildflower.Resource>('Grant', 'Client'), crudsArb)
      .map(
        ([resource, permission]): Scope.Base =>
          new Scope.Wildflower(
            new Scope.Contexts.Wildflower(),
            new Scope.ResourceType.Wildflower.Known(resource),
            permission
          )
      )
    fc.assert(
      fc.property(fc.oneof(fhirArb, wfArb), (scope) => {
        expect(Scope.parse(scope.serialize() ?? '')).toEqual(scope)
      })
    )
  })

  test('isResourceScope distinguishes resource scopes from flags/unknowns', () => {
    expect(Scope.ResourceScope.isResourceScope(Scope.parse('openid'))).toBe(false)
    expect(Scope.ResourceScope.isResourceScope(Scope.parse('mystery'))).toBe(false)
    expect(Scope.ResourceScope.isResourceScope(Scope.parse('patient/Observation.r'))).toBe(true)
  })
})

describe('Scope.ResourceType.Fhir.catalog — the labelled row set (spec.md §4)', () => {
  test('is the labelled FHIR resources, wildcard excluded, each parsing to a Known', () => {
    const catalog = Scope.ResourceType.Fhir.catalog
    expect(catalog).toContain('Observation')
    expect(catalog).toContain('Patient')
    expect(catalog).not.toContain('*')
    for (const name of catalog) {
      const parsed = Scope.ResourceType.Fhir.parse(name)
      expect(parsed).toBeInstanceOf(Scope.ResourceType.Fhir.Known)
      expect(parsed?.serialize()).toBe(name)
    }
  })
})
