import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Either, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import * as HumanName from '../data-types/complex/human-name.ts'
import { PatientMinimal, displayName } from './index.ts'

const decode = Schema.decodeUnknownEither(PatientMinimal.Schema)

describe('PatientMinimal', () => {
  test('a full record keeps its id, names, birth date and gender', () => {
    expect(
      decode({
        resourceType: 'Patient',
        id: 'pat-1',
        name: [{ use: 'official', given: ['Ada'], family: 'Lovelace' }],
        birthDate: '1815-12-10',
        gender: 'female',
        active: true,
      })
    ).toEqual(
      Either.right({
        resourceType: 'Patient',
        id: 'pat-1',
        name: [{ use: 'official', given: ['Ada'], family: 'Lovelace' }],
        birthDate: '1815-12-10',
        gender: 'female',
      })
    )
  })

  test.each([
    ['absent', {}],
    ['null', { name: null, birthDate: null, gender: null }],
  ])('%s optional fields read as none', (_case, fields) => {
    expect(decode({ resourceType: 'Patient', id: 'pat-1', ...fields })).toEqual(
      Either.right({
        resourceType: 'Patient',
        id: 'pat-1',
        name: [],
        birthDate: null,
        gender: null,
      })
    )
  })

  test('a partial birth date is kept as the server wrote it', () => {
    const decoded = decode({ resourceType: 'Patient', id: 'pat-1', birthDate: '1970-05' })
    expect(Either.map(decoded, (patient) => patient.birthDate)).toEqual(Either.right('1970-05'))
  })

  test("a name that doesn't read is left out, and given's null placeholders are dropped", () => {
    const decoded = decode({
      resourceType: 'Patient',
      id: 'pat-1',
      name: [{ given: 'not-an-array' }, { given: [null, 'Jordan'], family: 'Lee' }, 7],
    })
    expect(Either.map(decoded, (patient) => patient.name)).toEqual(
      Either.right([{ given: ['Jordan'], family: 'Lee' }])
    )
  })

  test.each([
    ['without an id', { resourceType: 'Patient' }],
    ['with an empty id', { resourceType: 'Patient', id: '' }],
    ['of another type', { resourceType: 'Practitioner', id: 'pr-1' }],
    ['with a gender that is no FHIR code', { resourceType: 'Patient', id: 'pat-1', gender: 'M' }],
  ])('a resource %s is not a patient', (_case, resource) => {
    expect(Either.isLeft(decode(resource))).toBe(true)
  })

  test("a patient's names go straight to displayName", () => {
    const patient = Schema.decodeUnknownSync(PatientMinimal.Schema)({
      resourceType: 'Patient',
      id: 'pat-1',
      name: [
        { use: 'maiden', given: ['Ada'], family: 'Byron' },
        { use: 'official', given: [null, 'Ada'], family: 'Lovelace' },
      ],
    })
    expect(displayName(patient.name)).toBe('Ada Lovelace')
  })

  test('displayName is HumanName.displayName', () => {
    expect(displayName).toBe(HumanName.displayName)
  })
})

describe('the patient-minimal entry', () => {
  /** The bare specifiers the module at `path` and the relative modules it imports load. */
  const bareImportsFrom = (path: string, seen: Set<string> = new Set()): Set<string> => {
    const bare = new Set<string>()
    if (seen.has(path)) return bare
    seen.add(path)
    const source = readFileSync(path, 'utf8')
    for (const [, specifier = ''] of source.matchAll(/\bfrom '([^']+)'/gu)) {
      if (specifier.startsWith('.')) {
        for (const nested of bareImportsFrom(resolve(dirname(path), specifier), seen)) {
          bare.add(nested)
        }
      } else {
        bare.add(specifier)
      }
    }
    return bare
  }

  test('loads nothing but effect, so no datatype registry', () => {
    const entry = resolve(dirname(fileURLToPath(import.meta.url)), 'index.ts')
    expect([...bareImportsFrom(entry)]).toEqual(['effect'])
  })
})
