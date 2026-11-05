import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type * as Identity from '@wildflowerhealthio/fhir-r4/identity'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import { Binary, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Option } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import * as ResourcePlan from './resource-plan.ts'

/**
 * Covers one record's plan: where it is written, under the id its key
 * derives or one minted for it, and the literal reference that makes.
 */

// Count every derivation, so a test can pin that a keyed record's id is
// derived once, when it is planned.
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

/** A minter for a record that must not mint: it fails the test. */
const unusedMinter = (): string => {
  throw new Error('minted an id for a keyed record')
}

describe('ResourcePlan.of', () => {
  it('plans a keyed record under the id its key derives, derived once, with its key', () => {
    const patient = patientKeyedBy(KEY)
    const plan = ResourcePlan.of(patient, unusedMinter)

    expect(vi.mocked(localResourceId).mock.calls).toEqual([[KEY.system, 'Patient', KEY.value]])
    expect(plan).toEqual(
      ResourcePlan.Derived({
        resourceType: 'Patient',
        id: localResourceId(KEY.system, 'Patient', KEY.value),
        identifier: Option.getOrThrow(DetachedResource.keyIdentifierOf(patient)),
      })
    )
  })

  // Only `identifier[0]` keys a record: a qualified identifier behind an
  // unqualified first one names nothing.
  it('plans each keyless record under an id mintId mints, one per record, in entry order', () => {
    const mintId = countingMinter()
    const plans = [
      binary(),
      patientKeyedBy(KEY),
      patientIdentifiedBy({ value: 'unqualified' }, DetachedResource.keyIdentifierWire(KEY)),
    ].map((resource) => ResourcePlan.of(resource, mintId))

    expect([plans[0], plans[2]]).toEqual([
      ResourcePlan.Minted({ resourceType: 'Binary', id: 'minted-1' }),
      ResourcePlan.Minted({ resourceType: 'Patient', id: 'minted-2' }),
    ])
    expect(plans[1]?._tag).toBe('Derived')
  })
})

describe('ResourcePlan.literalReference', () => {
  it('is the type and id the record is written under, derived or minted', () => {
    expect([
      ResourcePlan.literalReference(ResourcePlan.of(patientKeyedBy(KEY), unusedMinter)),
      ResourcePlan.literalReference(ResourcePlan.of(binary(), () => 'minted-1')),
    ]).toEqual([DetachedResource.storedReferenceOf('Patient', KEY), 'Binary/minted-1'])
  })
})
