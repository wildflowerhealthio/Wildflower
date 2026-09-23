import { describe, expect, test } from 'vite-plus/test'

import * as Extension from '../special-purpose/extension.ts'
import { empty, FhirR4SetChoices } from './choice-element-set.ts'
import * as Datatype from './datatype.ts'

describe('fhir-r4 datatype name lists', () => {
  test("the wildcard '*' choice list and Datatype.names name the same datatypes", () => {
    expect(new Set(FhirR4SetChoices['*'])).toEqual(new Set(Datatype.names))
  })

  test('neither list repeats a name', () => {
    expect(new Set(Datatype.names).size).toBe(Datatype.names.length)
    expect(new Set(FhirR4SetChoices['*']).size).toBe(FhirR4SetChoices['*'].length)
  })

  // "Metadata Types" is a section heading on https://hl7.org/fhir/R4/datatypes.html,
  // not a datatype; its members (ContactDetail, UsageContext, ...) are listed individually.
  test('the "Metadata Types" spec heading is not treated as a datatype', () => {
    const allNames: ReadonlyArray<string> = [...Datatype.names, ...FhirR4SetChoices['*']]
    expect(allNames).not.toContain('MetaDataTypes')
    expect(Object.keys(empty('value', FhirR4SetChoices['*']))).not.toContain('valueMetaDataTypes')
    expect(Object.keys(Extension.emptyValueChoice)).not.toContain('valueMetaDataTypes')
  })
})
