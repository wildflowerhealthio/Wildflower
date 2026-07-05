import { describe, expect, test } from 'vite-plus/test'

import { Cell, Grant, Scope, type ScopeRequest } from '../index.ts'

const patient = Scope.Contexts.Fhir.patient
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
      lockReason: { kind: 'wildcard' },
    })
  })

  test('request mode: a control outside the envelope is disabled (§2)', () => {
    const req = request([fhirV2('Observation', ['r'])])
    // 'c' is not in the requested row.
    expect(Cell.forItem(v2, Grant.make([]), req, patient, obs, 'c').state).toBe('disabled')
    // The resource is not requested at all.
    expect(Cell.forItem(v2, Grant.make([]), req, patient, cond, 'r').state).toBe('disabled')
  })

  test('request mode: a wildcard request authorizes the concrete rows beneath it (§2)', () => {
    // A standard SMART wildcard request must let the user grant concrete resources — an
    // exact-match clamp would disable every concrete cell (`requested === undefined`).
    const req = request([fhirV2('*', ['r', 's'])])
    expect(Cell.forItem(v2, Grant.make([]), req, patient, obs, 'r').state).toBe('off')
    expect(Cell.forItem(v2, Grant.make([]), req, patient, obs, 's').state).toBe('off')
    // ...but only for the interactions the wildcard request actually carries.
    expect(Cell.forItem(v2, Grant.make([]), req, patient, obs, 'c').state).toBe('disabled')
  })

  test('request mode: a live grant outside the envelope is shown, never hidden (§2)', () => {
    // The draft holds `Observation.c`, but the request only covers `Observation.r`. The
    // cell must stay visible (`on`) rather than render unchecked+disabled while
    // `serialize` still emits it.
    const req = request([fhirV2('Observation', ['r'])])
    const grant = Grant.make([fhirV2('Observation', ['c'])])
    expect(Cell.forItem(v2, grant, req, patient, obs, 'c').state).toBe('on')
  })

  test('request mode: a required control is locked on (§2)', () => {
    const req = request([fhirV2('Observation', ['r'])], [fhirV2('Observation', ['r'])])
    expect(Cell.forItem(v2, Grant.make([]), req, patient, obs, 'r')).toEqual({
      state: 'locked',
      lockReason: { kind: 'required' },
    })
  })

  test('request mode: an optional in-envelope control toggles on/off from the grant', () => {
    const req = request([fhirV2('Observation', ['r', 'c'])])
    const grant = Grant.make([fhirV2('Observation', ['r'])])
    expect(Cell.forItem(v2, grant, req, patient, obs, 'r').state).toBe('on')
    expect(Cell.forItem(v2, grant, req, patient, obs, 'c').state).toBe('off')
  })

  test('request mode: a higher-context request covers a lower-context cell (system ⊇ patient)', () => {
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
    const system = Scope.Contexts.Fhir.system
    // A system/*.r request authorizes the concrete patient Observation.r cell...
    expect(
      Cell.forItem(v2, Grant.make([]), request([fhirAt('system', '*', ['r'])]), patient, obs, 'r')
        .state
    ).toBe('off')
    // ...but a patient/*.r request does not reach a system-context cell (patient ⊉ system).
    expect(
      Cell.forItem(v2, Grant.make([]), request([fhirV2('*', ['r'])]), system, obs, 'r').state
    ).toBe('disabled')
  })
})
