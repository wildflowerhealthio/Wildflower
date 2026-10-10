import { Schema } from 'effect'

import {
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from '@wildflowerhealthio/kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'

const ProcedurePerformerStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    function: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    actor: Schema.suspend(() => IdentifierAndReference.ReferenceSchema),
    onBehalfOf: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
  })
)

/**
 * Wire schema for FHIR R4 `Procedure.performer` — who performed the procedure,
 * in what role, and on whose behalf.
 *
 * @remarks
 * `actor` is required (1..1); `function` and `onBehalfOf` are optional.
 */
const ProcedurePerformerSchema: Schema.Schema<
  typeof ProcedurePerformerStruct.Type,
  FhirR4.ProcedurePerformer,
  never
> = ProcedurePerformerStruct

export { ProcedurePerformerSchema as Schema }
