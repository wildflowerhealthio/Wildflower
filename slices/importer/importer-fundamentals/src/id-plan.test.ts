import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type * as Identity from '@wildflowerhealthio/fhir-r4/identity'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import { Binary, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Option } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type * as DecodedFileSet from './decoded-file-set.ts'
import * as IdPlan from './id-plan.ts'

/**
 * Covers the id plan of a file set: the id each record is stored under,
 * derived or minted, and the literal reference a logical one resolves to.
 */

// Count every derivation, so a test can pin that a keyed record's id is
// derived once and that a reference the set cannot resolve derives nothing.
vi.mock('@wildflowerhealthio/fhir-r4/identity', async (importOriginal) => {
  const identity = await importOriginal<typeof Identity>()
  return { ...identity, localResourceId: vi.fn(identity.localResourceId) }
})

beforeEach(() => {
  vi.mocked(localResourceId).mockClear()
})

const decodePatient = DetachedResource.decodeUnknown(Patient.Schema)
const decodeBinary = DetachedResource.decodeUnknown(Binary.Schema)

const KEY = { system: 'https://portal.example/patient-id', value: 'pat-7' }

/** A detached Patient whose identifiers are `identifiers`, the first its key when qualified. */
const patientIdentifiedBy = (
  ...identifiers: readonly (typeof IdentifierAndReference.IdentifierSchema.Encoded)[]
): DetachedResource.Type =>
  Effect.runSync(decodePatient({ resourceType: 'Patient', identifier: identifiers }))

/** A detached Patient keyed by `key`. */
const patientKeyedBy = (key: DetachedResource.Key): DetachedResource.Type =>
  patientIdentifiedBy(DetachedResource.keyIdentifierWire(key))

/** A detached Binary: keyless, as every Binary is. */
const binary = (): DetachedResource.Type =>
  Effect.runSync(decodeBinary({ resourceType: 'Binary', contentType: 'text/plain' }))

/** A minter that counts: `minted-1`, `minted-2`, …. */
const countingMinter = (): (() => string) => {
  let minted = 0
  return () => {
    minted += 1
    return `minted-${minted}`
  }
}

/** The id plan of `entries`, its keyless records minted by a {@link countingMinter}. */
const planOf = (...entries: readonly DecodedFileSet.Entry[]): IdPlan.Type =>
  IdPlan.of(entries, countingMinter())

describe('IdPlan.of', () => {
  it('plans a keyed record under the id its key derives, derived once however often it is read', () => {
    const plan = planOf({ fullUrl: 'patient', resource: patientKeyedBy(KEY) })
    const planned = [
      IdPlan.idFor(plan, 'patient'),
      IdPlan.idFor(plan, 'patient'),
      IdPlan.referenceTo(plan, 'Patient', KEY),
    ]

    expect(vi.mocked(localResourceId).mock.calls).toEqual([[KEY.system, 'Patient', KEY.value]])
    const derivedId = localResourceId(KEY.system, 'Patient', KEY.value)
    expect(planned).toEqual([
      IdPlan.Derived({ id: derivedId }),
      IdPlan.Derived({ id: derivedId }),
      Option.some(`Patient/${derivedId}`),
    ])
  })

  it('plans each keyless record under an id mintId mints, one per record, in entry order', () => {
    const plan = planOf(
      { fullUrl: 'first', resource: binary() },
      { fullUrl: 'keyed', resource: patientKeyedBy(KEY) },
      { fullUrl: 'second', resource: patientIdentifiedBy({ value: 'unqualified' }) }
    )

    expect([IdPlan.idFor(plan, 'first'), IdPlan.idFor(plan, 'second')]).toEqual([
      IdPlan.Minted({ id: 'minted-1' }),
      IdPlan.Minted({ id: 'minted-2' }),
    ])
    expect(IdPlan.idFor(plan, 'keyed')._tag).toBe('Derived')
  })

  it('fails to plan a fullUrl it was not built from', () => {
    const plan = planOf({ fullUrl: 'patient', resource: patientKeyedBy(KEY) })
    expect(() => IdPlan.idFor(plan, 'elsewhere')).toThrow('elsewhere')
  })
})

describe('IdPlan.referenceTo', () => {
  it('resolves a key the set holds to the stored reference its record is written under', () => {
    const plan = planOf({ fullUrl: 'patient', resource: patientKeyedBy(KEY) })
    expect(IdPlan.referenceTo(plan, 'Patient', KEY)).toEqual(
      Option.some(DetachedResource.storedReferenceOf('Patient', KEY))
    )
  })

  it('resolves nothing for a key of another type or value, and derives nothing to say so', () => {
    const plan = planOf({ fullUrl: 'patient', resource: patientKeyedBy(KEY) })
    vi.mocked(localResourceId).mockClear()

    expect([
      IdPlan.referenceTo(plan, 'Practitioner', KEY),
      IdPlan.referenceTo(plan, 'Patient', { ...KEY, value: 'pat-8' }),
    ]).toEqual([Option.none(), Option.none()])
    expect(localResourceId).not.toHaveBeenCalled()
  })

  // Only `identifier[0]` keys a record: a qualified identifier behind an
  // unqualified first one names nothing, though the same identifier first does.
  it('never resolves to a keyless record, whatever identifiers it carries', () => {
    const keyless = patientIdentifiedBy({ value: 'unqualified' }, KEY)
    const keyed = patientIdentifiedBy(KEY, { value: 'unqualified' })

    expect([
      IdPlan.referenceTo(planOf({ fullUrl: 'patient', resource: keyless }), 'Patient', KEY),
      Option.isSome(
        IdPlan.referenceTo(planOf({ fullUrl: 'patient', resource: keyed }), 'Patient', KEY)
      ),
    ]).toEqual([Option.none(), true])
  })

  // A system may carry the character a naive `<Type>|<system>|<value>` join
  // would split on: `https://a.example/x|y` and `y|z` would spell alike.
  it('tells apart keys that only a separator inside a system or value would join', () => {
    const joinedAtSystem = { system: 'https://a.example/x|y', value: 'z' }
    const joinedAtValue = { system: 'https://a.example/x', value: 'y|z' }
    const plan = planOf({ fullUrl: 'patient', resource: patientKeyedBy(joinedAtSystem) })

    expect([
      Option.isSome(IdPlan.referenceTo(plan, 'Patient', joinedAtSystem)),
      IdPlan.referenceTo(plan, 'Patient', joinedAtValue),
    ]).toEqual([true, Option.none()])
  })
})
