import { describe, expect, test } from 'vite-plus/test'

import { Grant, GrantDraft, Scope } from '../index.ts'

const patient = new Scope.Contexts.Fhir('patient')
const cruds = (l: Scope.Permission.Cruds.Interaction[]): Scope.Permission.Cruds =>
  new Scope.Permission.Cruds(l)
const fhirV2 = (name: string, l: Scope.Permission.Cruds.Interaction[]): Scope.FhirV2 =>
  new Scope.FhirV2(patient, Scope.ResourceType.Fhir.parse(name)!, cruds(l))
const fhirV1 = (name: string, permission: Scope.Permission.ReadWrite): Scope.FhirV1 =>
  new Scope.FhirV1(patient, Scope.ResourceType.Fhir.parse(name)!, permission)
const grant = (scopes: Scope.Any[]): GrantDraft.GrantDraft => ({
  patient: 'jordan',
  ...Grant.make(scopes),
})

describe('GrantDraft.serialize — dedupe (§3)', () => {
  test('a specific scope omits interactions already in the same-context wildcard', () => {
    expect(
      GrantDraft.serialize(grant([fhirV2('*', ['r']), fhirV2('Observation', ['c', 'r'])]))
    ).toEqual(['patient/*.r', 'patient/Observation.c'])
  })

  test('a specific scope fully covered by the wildcard emits nothing', () => {
    expect(
      GrantDraft.serialize(grant([fhirV2('*', ['r', 's']), fhirV2('Observation', ['r'])]))
    ).toEqual(['patient/*.rs'])
  })

  test('a same-style v1 wildcard dedupes a v1 word row', () => {
    expect(
      GrantDraft.serialize(
        grant([
          fhirV1('*', Scope.Permission.ReadWrite.read),
          fhirV1('Observation', Scope.Permission.ReadWrite.read),
        ])
      )
    ).toEqual(['patient/*.read'])
  })

  test('a Wildflower wildcard does not dedupe a patient FHIR scope', () => {
    const wf: Scope.Wildflower = new Scope.Wildflower(
      new Scope.Contexts.Wildflower(),
      Scope.ResourceType.Wildflower.parse('*')!,
      cruds(['r'])
    )
    expect(GrantDraft.serialize(grant([wf, fhirV2('Observation', ['r'])]))).toContain(
      'patient/Observation.r'
    )
  })
})

describe('GrantDraft.initial — seed from required (§2)', () => {
  test('open mode (null request) starts empty', () => {
    const draft = GrantDraft.initial(null, 'jordan')
    expect(draft.patient).toBe('jordan')
    expect(GrantDraft.serializeAll(draft)).toEqual([])
  })

  test('request mode seeds the draft with the required scopes and flags', () => {
    const request = {
      requested: Grant.make([fhirV2('Observation', ['r', 'c']), Scope.Known.openid]),
      required: Grant.make([fhirV2('Observation', ['r']), Scope.Known.openid]),
    }
    const draft = GrantDraft.initial(request, 'jordan')
    // The required scope/flag are present, so a grid cell the picker locks on is backed by
    // a real grant rather than emitting nothing.
    expect(GrantDraft.serializeAll(draft)).toEqual(['patient/Observation.r', 'openid'])
  })
})

describe('GrantDraft.serializeAll', () => {
  test('appends sorted flags and preserved unknowns', () => {
    const g = grant([
      fhirV2('Observation', ['r']),
      Scope.Known.offlineAccess,
      Scope.Known.openid,
      new Scope.Unknown('mystery_scope'),
    ])
    expect(GrantDraft.serializeAll(g)).toEqual([
      'patient/Observation.r',
      'offline_access',
      'openid',
      'mystery_scope',
    ])
  })
})
