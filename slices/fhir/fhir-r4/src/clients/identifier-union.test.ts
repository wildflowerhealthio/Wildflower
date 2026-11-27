import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { IdentifierAndReference, type IdentifierType } from '../data-types/index.ts'
import { type FhirResource, Patient } from '../resources/index.ts'
import { missingFrom, union } from './identifier-union.ts'

/**
 * Covers joining one resource's identifiers with the qualified identifiers
 * other resources of its record carry, each once by its search token.
 */

const SOURCE = 'https://source.example/id'
const CLINIC = 'https://clinic.example/mrn'

/** A Patient carrying the wire `identifier`. */
const patientWith = (identifier: readonly object[]): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id: 'p-1', identifier })

/** An identifier of `value` in `system`, as a resource carries it. */
const identifierOf = (system: string, value: string): IdentifierType =>
  Schema.decodeUnknownSync(IdentifierAndReference.IdentifierSchema)({ system, value })

describe('IdentifierUnion.union', () => {
  it('should keep the carried identifiers, then add each qualified one another resource carries, once and in order', () => {
    // Arrange
    const carried = [identifierOf(SOURCE, 'tyra')]
    const others = [
      patientWith([
        { system: SOURCE, value: 'tyra' },
        { system: CLINIC, value: '7' },
      ]),
      patientWith([{ system: CLINIC, value: '7' }, { value: 'no-system' }]),
    ]

    // Act
    const joined = union(carried, others)

    // Assert
    expect(joined.map(({ system, value }) => [system?.href ?? null, value])).toEqual([
      [SOURCE, 'tyra'],
      [CLINIC, '7'],
    ])
  })
})

describe('IdentifierUnion.missingFrom', () => {
  it('should give the qualified identifiers a resource carries that the list lacks, each once', () => {
    // Arrange
    const carried = [identifierOf(SOURCE, 'tyra')]
    const resource = patientWith([
      { system: SOURCE, value: 'tyra' },
      { system: CLINIC, value: '7' },
      { system: CLINIC, value: '7' },
    ])

    // Act
    const missing = missingFrom(carried, resource)

    // Assert
    expect(missing.map(({ value }) => value)).toEqual(['7'])
  })
})
