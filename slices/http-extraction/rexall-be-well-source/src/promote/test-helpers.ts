import { Schema } from 'effect'
import * as fc from 'fast-check'
import { Code, type CodeableConcept, Extension, IdentifierAndReference } from 'fhir-r4/data-types'

import { CarebookCodingSystem, CarebookExtension, REXALL_SYSTEM_SOURCE } from '../carebook.ts'

/** Urls that cannot collide with a carebook one, so they must survive promotion. */
const unrelatedUrl = fc.string().map((suffix) => `http://example.org/${suffix}`)

/** The `external-system-source` (Rexall) + `external-store-id` pair, in that order. */
const storeExtensions = (storeIdUrl: string, storeId: string): readonly Extension.Type[] => [
  extensionWith(CarebookExtension.ExternalSystemSource, { valueString: REXALL_SYSTEM_SOURCE }),
  extensionWith(storeIdUrl, { valueString: storeId }),
]

/** The dialect's dual-written remaining-repeats `modifierExtension`s, either copy optional. */
const repeatsModifiers = (copies: {
  readonly v1?: number
  readonly v2?: number
}): readonly Extension.Type[] => [
  ...(copies.v1 === undefined
    ? []
    : [
        extensionWith(CarebookExtension.NumberOfRepeatsAvailable, {
          valuePositiveInt: copies.v1,
        }),
      ]),
  ...(copies.v2 === undefined
    ? []
    : [extensionWith(CarebookExtension.NumberOfRepeatsAvailableV2, { valueDecimal: copies.v2 })]),
]

/** A decoded `CodeableConcept` carrying one carebook vendor DIN coding. */
const decodedVendorDinConcept = (din: string): typeof CodeableConcept.Schema.Type => ({
  id: null,
  extension: [],
  text: 'Atorvastatin 20 mg tablet',
  coding: [
    {
      id: null,
      extension: [],
      code: Code.make(din),
      display: null,
      system: new URL(CarebookCodingSystem.Din),
      userSelected: null,
      version: null,
    },
  ],
})

const extensionWith = (url: string, value: Partial<Extension.Type>): Extension.Type => ({
  ...Extension.emptyValueChoice,
  id: null,
  extension: [],
  url,
  ...value,
})

const emptyReference = IdentifierAndReference.emptyReference

const referenceTo = (id: string): IdentifierAndReference.ReferenceType => ({
  id: null,
  extension: [],
  display: null,
  type: null,
  reference: `rexall-pharmacy-location/${id}`,
  identifier: {
    id: null,
    extension: [],
    assigner: null,
    period: null,
    system: null,
    type: null,
    use: null,
    value: id,
  },
})

const emptyQuantity = {
  id: null,
  extension: [],
  code: null,
  comparator: null,
  system: null,
  unit: null,
  value: null,
}

const emptyDispenseRequest = {
  id: null,
  extension: [],
  modifierExtension: [],
  initialFill: null,
  dispenseInterval: null,
  validityPeriod: null,
  numberOfRepeatsAllowed: null,
  quantity: null,
  expectedSupplyDuration: null,
  performer: null,
}

/** A `contained` Medication in its raw wire shape, as the dialect sends it. */
const containedMedication = (options: {
  readonly id: string
  readonly strength?: string
  readonly description?: string
}): Record<string, unknown> => ({
  resourceType: 'Medication',
  id: options.id,
  code: { text: 'Atorvastatin 20 mg tablet' },
  extension: [
    ...(options.strength === undefined
      ? []
      : [{ url: CarebookExtension.MedicationStrength, valueString: options.strength }]),
    ...(options.description === undefined
      ? []
      : [{ url: CarebookExtension.MedicationDescription, valueString: options.description }]),
  ],
})

const urlsOf = (extensions: readonly Extension.Type[]): readonly string[] =>
  extensions.map((extension) => extension.url)

const decodeRecord = Schema.decodeUnknownSync(
  Schema.Record({ key: Schema.String, value: Schema.Unknown })
)

const firstContained = (resource: {
  readonly contained: readonly unknown[]
}): Record<string, unknown> => decodeRecord(resource.contained[0])

const containedExtensionUrls = (medication: Record<string, unknown>): readonly string[] => {
  const extensions = medication['extension']
  return Array.isArray(extensions)
    ? extensions.map((extension: { readonly url?: string }) => extension.url ?? '')
    : []
}

export {
  containedExtensionUrls,
  containedMedication,
  decodeRecord,
  decodedVendorDinConcept,
  emptyDispenseRequest,
  emptyQuantity,
  emptyReference,
  extensionWith,
  firstContained,
  referenceTo,
  repeatsModifiers,
  storeExtensions,
  unrelatedUrl,
  urlsOf,
}
