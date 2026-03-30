import { Schema } from 'effect'
import { expect } from 'vite-plus/test'

import { Meta } from './src/data-types/base/meta.ts'
import { Address } from './src/data-types/complex/address.ts'
import { Annotation } from './src/data-types/complex/annotation.ts'
import { Attachment } from './src/data-types/complex/attachment.ts'
import { CodeableConcept } from './src/data-types/complex/codeable-concept.ts'
import { Coding } from './src/data-types/complex/coding.ts'
import { ContactPoint } from './src/data-types/complex/contact-point.ts'
import { HumanName } from './src/data-types/complex/human-name.ts'
import { Identifier, Reference } from './src/data-types/complex/identifier-and-reference.ts'
import { Period } from './src/data-types/complex/period.ts'
import { Quantity } from './src/data-types/complex/quantity.ts'
import { Range } from './src/data-types/complex/range.ts'
import { SimpleQuantity } from './src/data-types/complex/simple-quantity.ts'
import { Extension } from './src/data-types/special-purpose/extension.ts'
import { Narrative } from './src/data-types/special-purpose/narrative.ts'
// import { CompositionAttester } from './src/resources/Composition/composition-attester.ts'
// import { CompositionSection } from './src/resources/Composition/composition-section.ts'
// import { Composition } from './src/resources/Composition/composition.ts'
// import { DiagnosticReport } from './src/resources/DiagnosticReport/diagnostic-report.ts'
// import { Encounter } from './src/resources/Encounter/encounter.ts'
// import { Location } from './src/resources/Location/location.ts'
// import { Media } from './src/resources/Media/media.ts'
// import { Observation } from './src/resources/Observation/observation.ts'
import { Patient } from './src/resources/Patient/patient.ts'
// import { Practitioner } from './src/resources/Practitioner/practitioner.ts'
// import { Questionnaire } from './src/resources/Questionnaire/questionnaire.ts'
// import { QuestionnaireResponseItemAnswer } from './src/resources/QuestionnaireResponse/questionnaire-response-item.ts'
// import { QuestionnaireResponse } from './src/resources/QuestionnaireResponse/questionnaire-response.ts'

declare global {
  var setupInitialized: boolean | undefined
}

if (!globalThis.setupInitialized) {
  const schemas = {
    // Composition,
    // DiagnosticReport,
    // Encounter,
    // Location,
    // Media,
    // Observation,
    Patient,
    // Practitioner,
    // Questionnaire,
    // QuestionnaireResponse,
    // QuestionnaireResponseItemAnswer,
    // CompositionAttester,
    // CompositionSection,
    Address,
    Annotation,
    Attachment,
    CodeableConcept,
    Coding,
    ContactPoint,
    HumanName,
    Identifier,
    Period,
    Quantity,
    Range,
    Reference,
    SimpleQuantity,
    Extension,
    Meta,
    Narrative,
  } as const

  expect.extend({
    toSchemaEqual(received: unknown, expected: unknown) {
      expect.addEqualityTesters([
        (a: unknown, b: unknown): boolean | undefined => {
          try {
            if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
              if (
                a.constructor === b.constructor &&
                a.constructor.name === b.constructor.name &&
                a.constructor.name in schemas
              ) {
                return Schema.equivalence(
                  // oxlint-disable-next-line typescript/no-explicit-any typescript/no-unsafe-type-assertion
                  schemas[a.constructor.name as keyof typeof schemas] as any
                  // oxlint-disable-next-line typescript/no-explicit-any typescript/no-unsafe-type-assertion
                )(a as any, b as any)
              }
            } else {
              return undefined
            }
          } catch {
            return undefined
          }
        },
      ])
      try {
        expect(received).toEqual(expected)
        return {
          pass: true,
          message: (): string => 'Values are schema-wise equal, as expected.',
          expected,
          actual: received,
        }
      } catch (error) {
        return {
          pass: false,
          message: (): string => {
            let detail: string
            if (error instanceof Error) {
              detail = error.message
            } else {
              detail = String(error)
            }
            return `While Schema-comparing: ${detail}`
          },
          expected,
          actual: received,
        }
      }
    },
  })

  globalThis.setupInitialized = true
}
