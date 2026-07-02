import { describe, expect, test } from 'vite-plus/test'

import { Cell, Grant, Scope, type ScopeRequest } from '../index.ts'

const patient = new Scope.Contexts.Fhir('patient')
const obs = Scope.ResourceType.Fhir.parse('Observation')!
const cond = Scope.ResourceType.Fhir.parse('Condition')!
const v2 = Scope.FhirV2.configuration

const fhirV2 = (name: string, l: Scope.Permission.Cruds.Interaction[]): Scope.FhirV2 =>
  new Scope.FhirV2(patient, Scope.ResourceType.Fhir.parse(name)!, new Scope.Permission.Cruds(l))

const request = (
  requested: Scope.Any[],
  required: Scope.Any[] = []
): ScopeRequest.ScopeRequest => ({
  requested: Grant.make(requested),
  required: Grant.make(required),
})

describe('Cell.forItem — §2 clamp + §3 lock', () => {
  test('open mode: a stored interaction reads on, an absent one off', () => {
    const grant = Grant.make([fhirV2('Observation', ['r'])])
    expect(Cell.forItem(v2, grant, null, patient, obs, 'r').state).toBe('on')
    expect(Cell.forItem(v2, grant, null, patient, obs, 'c').state).toBe('off')
  })

  test('open mode: a wildcard-covered cell is locked on a specific row (§3)', () => {
    const grant = Grant.make([fhirV2('*', ['r']), fhirV2('Observation', ['r'])])
    expect(Cell.forItem(v2, grant, null, patient, obs, 'r')).toEqual({
      state: 'locked',
      lockReason: 'Granted by ✶ All record types',
    })
  })

  test('request mode: a control outside the envelope is disabled (§2)', () => {
    const req = request([fhirV2('Observation', ['r'])])
    // 'c' is not in the requested row.
    expect(Cell.forItem(v2, Grant.make([]), req, patient, obs, 'c').state).toBe('disabled')
    // The resource is not requested at all.
    expect(Cell.forItem(v2, Grant.make([]), req, patient, cond, 'r').state).toBe('disabled')
  })

  test('request mode: a required control is locked on (§2)', () => {
    const req = request([fhirV2('Observation', ['r'])], [fhirV2('Observation', ['r'])])
    expect(Cell.forItem(v2, Grant.make([]), req, patient, obs, 'r')).toEqual({
      state: 'locked',
      lockReason: 'Required by the app',
    })
  })

  test('request mode: an optional in-envelope control toggles on/off from the grant', () => {
    const req = request([fhirV2('Observation', ['r', 'c'])])
    const grant = Grant.make([fhirV2('Observation', ['r'])])
    expect(Cell.forItem(v2, grant, req, patient, obs, 'r').state).toBe('on')
    expect(Cell.forItem(v2, grant, req, patient, obs, 'c').state).toBe('off')
  })
})
