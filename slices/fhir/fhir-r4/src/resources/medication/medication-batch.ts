import { Schema } from 'effect'

import {
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from '@wildflowerhealthio/kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as FhirString from '../../data-types/base/fhir-string.ts'

// FHIR R4 `Medication.batch` — details about a packaged batch of the product.
const MedicationBatchStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    lotNumber: FhirString.Optional,
    expirationDate: OrNullAsOptional(Schema.DateTimeUtc),
  })
)

const MedicationBatchSchema: Schema.Schema<
  typeof MedicationBatchStruct.Type,
  FhirR4.MedicationBatch,
  never
> = MedicationBatchStruct

export { MedicationBatchSchema as Schema }
