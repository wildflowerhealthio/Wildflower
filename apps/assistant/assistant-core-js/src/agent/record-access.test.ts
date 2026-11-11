import { ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Scope } from '@wildflowerhealthio/scopes-core'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as RecordAccess from './record-access.ts'

const RUNS = numRunsFor({ base: 50 })

/** The access `scopes` (scope strings) grant. */
const accessOf = (...scopes: readonly string[]): RecordAccess.Type =>
  RecordAccess.fromGrantedScopes(scopes.map(Scope.parse))

const named = (...types: readonly ResourceType.Type[]): RecordAccess.ResourceTypes => ({
  kind: 'named-types',
  types,
})
const none = named()
const everyType: RecordAccess.ResourceTypes = { kind: 'every-type' }

describe('RecordAccess.fromGrantedScopes', () => {
  it.each([
    [
      ['system/*.cruds'],
      { readable: everyType, searchable: everyType, creatable: everyType, updatable: everyType },
    ],
    [
      ['patient/*.rs'],
      { readable: everyType, searchable: everyType, creatable: none, updatable: none },
    ],
    [
      ['user/*.read'],
      { readable: everyType, searchable: everyType, creatable: none, updatable: none },
    ],
    [
      ['patient/*.write'],
      { readable: none, searchable: none, creatable: everyType, updatable: everyType },
    ],
    [
      [
        'launch',
        'openid',
        'patient/Observation.rs',
        'patient/Condition.r',
        'user/Goal.cu',
        'user/CarePlan.c',
        'user/Condition.u',
      ],
      {
        readable: named('Condition', 'Observation'),
        searchable: named('Observation'),
        creatable: named('CarePlan', 'Goal'),
        updatable: named('Condition', 'Goal'),
      },
    ],
    [
      ['patient/Observation.s', 'patient/Observation.r'],
      {
        readable: named('Observation'),
        searchable: named('Observation'),
        creatable: none,
        updatable: none,
      },
    ],
    [
      ['patient/PrescriptionOrder.rs', 'openid'],
      { readable: none, searchable: none, creatable: none, updatable: none },
    ],
    [[], { readable: none, searchable: none, creatable: none, updatable: none }],
  ] as const)('should read %j as what each type allows', (scopes, access) => {
    expect(accessOf(...scopes)).toEqual(access)
  })

  it('should read every named type a grant lists, once, in order', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...ResourceType.VALUES), { maxLength: 6 }), (types) => {
        const access = accessOf(...types.map((type) => `patient/${type}.rs`))

        expect(access.readable).toEqual(named(...new Set(types.toSorted())))
        expect(access.searchable).toEqual(access.readable)
      }),
      { numRuns: RUNS }
    )
  })
})

describe('RecordAccess.typesOf', () => {
  it('should expand every type to all of R4, and keep named types as they are', () => {
    expect(RecordAccess.typesOf(everyType)).toEqual(ResourceType.VALUES)
    expect(RecordAccess.typesOf(named('Observation'))).toEqual(['Observation'])
  })
})
