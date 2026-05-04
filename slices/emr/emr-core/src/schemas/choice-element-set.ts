import { type Arbitrary, type FastCheck, Schema } from 'effect'
import { capitalize } from 'effect/String'

import * as ChoiceElement from './choice-element.ts'
import * as Datatype from './datatype.ts'

import type { SqliteDsl } from '@livestore/livestore'
import { State } from '@livestore/livestore'
import { baseDatatypes } from './datatype-registry.ts'

type ChoiceElementSetSchemaFields<
  Prefix extends string,
  DatatypeNames extends readonly Datatype.Name[],
> = {
  [DatatypeName in DatatypeNames[number] as ChoiceElement.Name<
    Prefix,
    DatatypeName
  >]: Schema.NullOr<Datatype.SchemaFor<DatatypeName>>
}

/**
 * Builds a `Schema.Struct` of flat, prefix-namespaced optional fields for a
 * FHIR `value[x]`-style choice element. Each data type name becomes a single
 * field of type `Schema.NullOr<...>` whose name is
 * `${prefix}${Capitalize<name>}`.
 *
 * Field schemas resolve through the lazy {@link baseDatatypes} registry via
 * `Schema.suspend`, so consumers can compose choice fields before every
 * complex datatype module has self-registered.
 *
 * No mutual exclusion is enforced at the schema level — any combination of
 * the generated fields may be present in a decoded or encoded value. Callers
 * that need "exactly one" semantics must layer that on themselves.
 *
 * @example
 * ```typescript
 * const valueFields = ChoiceElementSet.SchemaFields('value', ['string', 'boolean', 'Quantity'])
 * // Schema fields: { valueString?: string, valueBoolean?: boolean, valueQuantity?: ... }
 *
 * // Spread into a resource:
 * const Observation = Schema.Struct({ code: CodeableConcept.Schema, ...valueFields })
 * ```
 *
 * @param prefix - Prefix for each generated field (e.g. `'value'`, `'effective'`)
 * @param datatypeNames - Array of data type names to include in the choice
 */
function ChoiceElementSetSchemaFields<
  const Prefix extends string,
  const DatatypeNames extends readonly Datatype.Name[],
>(
  prefix: Prefix,
  datatypeNames: DatatypeNames
): ChoiceElementSetSchemaFields<Prefix, DatatypeNames> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries returns Record<string, unknown>; the typed shape is recovered from the prefix/name pairs by construction.
  return Object.fromEntries(
    datatypeNames.map((name) => [
      ChoiceElement.Name(prefix, name),
      // Pin `Arbitrary.make(...)` to always emit `null` on the suspend itself.
      // Choice-element fields inherit `Schema<any, any, never>` from
      // `Datatype.SchemaFor`'s fallback for complex datatypes, which makes the
      // default suspend arbitrary generate any-shaped JS values (objects,
      // arrays, …). For property tests over resources the wide value-prefix
      // space is already covered by each datatype's own tests, so emitting
      // `null` here keeps generated examples small and avoids cross-test cost
      // from re-walking ~50 datatype variants.
      Schema.NullOr(
        Schema.suspend(() => baseDatatypes[name].schema()).annotations({
          arbitrary: (): Arbitrary.LazyArbitrary<null> => (fc: typeof FastCheck) =>
            fc.constant(null),
        })
      ),
    ])
  ) as unknown as ChoiceElementSetSchemaFields<Prefix, DatatypeNames>
}

type Empty<Prefix extends string, DatatypeNames extends readonly Datatype.Name[]> = {
  [K in DatatypeNames[number] as ChoiceElement.Name<Prefix, K>]: null
}

function empty<const Prefix extends string, const DatatypeNames extends readonly Datatype.Name[]>(
  prefix: Prefix,
  datatypeNames: DatatypeNames
): Empty<Prefix, DatatypeNames> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries returns Record<string, null>; the typed shape is recovered from the prefix/name pairs by construction.
  return Object.fromEntries(
    datatypeNames.map((name) => [`${prefix}${capitalize(name)}`, null])
  ) as unknown as Empty<Prefix, DatatypeNames>
}

type ColumnFor<N extends Datatype.Name> = SqliteDsl.ColumnDefinition<
  Datatype.EncodedForDbType<Datatype.DbTypeFor<N>> | null,
  Schema.Schema.Type<Datatype.SchemaFor<N>> | null
>

// `Datatype.baseSchemas` and `Datatype.baseDbTypes` are keyed by strict
// subsets of `Datatype.Name`. We index them with arbitrary names from a
// caller-supplied list, so widen each to a `Record<string, …>` once at the
// boundary instead of per-name conditionals. Mirrors the same widen-and-fall-back
// pattern used in datatype-registry.ts.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment
const baseSchemasByName = Datatype.baseSchemas as unknown as Record<
  string,
  Schema.Schema.AnyNoContext | undefined
>
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment
const baseDbTypesByName = Datatype.baseDbTypes as unknown as Record<
  string,
  Datatype.DbType | undefined
>

const columnFor = (name: Datatype.Name): SqliteDsl.ColumnDefinition.Any => {
  const dbType: Datatype.DbType = baseDbTypesByName[name] ?? 'json'
  const baseSchema = baseSchemasByName[name]

  switch (dbType) {
    case 'boolean': {
      // `State.SQLite.boolean` is a specialized factory and does not accept
      // a custom schema — the boolean column type is already exact.
      return State.SQLite.boolean({ nullable: true })
    }
    case 'integer': {
      if (baseSchema === undefined) return State.SQLite.integer({ nullable: true })
      return State.SQLite.integer({ nullable: true, schema: baseSchema })
    }
    case 'real': {
      if (baseSchema === undefined) return State.SQLite.real({ nullable: true })
      return State.SQLite.real({ nullable: true, schema: baseSchema })
    }
    case 'text': {
      if (baseSchema === undefined) return State.SQLite.text({ nullable: true })
      return State.SQLite.text({ nullable: true, schema: baseSchema })
    }
    case 'json': {
      // Resolve the complex datatype's schema lazily through the registry so
      // tables auto-upgrade to a strict schema once the datatype module
      // self-registers (see datatype-registry.ts). Until then, the registry
      // returns its `FallbackSchema` (PermissivePassthrough with a `null`
      // arbitrary), preserving the prior hand-written behavior.
      return State.SQLite.json({
        nullable: true,
        schema: Schema.suspend(() => baseDatatypes[name].schema()),
      })
    }
    default: {
      const _exhaustive: never = dbType
      throw new Error(`Unhandled column DbType: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Public shape of {@link Columns}: a flat record of livestore column
 * definitions keyed by `${prefix}${Capitalize<datatypeName>}`. Each entry is
 * a `SqliteDsl.ColumnDefinition` parameterized to the datatype's decoded type
 * and the column DbType's encoded type, so callers can spread the result
 * directly into a `State.SQLite.table({ columns })` block while keeping
 * per-key schema types tight.
 */
type Columns<Prefix extends string, DatatypeNames extends readonly Datatype.Name[]> = {
  readonly [N in DatatypeNames[number] as ChoiceElement.Name<Prefix, N>]: ColumnFor<N>
}

/**
 * Builds a flat record of livestore SQLite column definitions for a FHIR
 * `value[x]`-style choice element. Sibling to
 * {@link "../schemas/choice-element-set.ts".SchemaFields | ChoiceElementSet.SchemaFields},
 * which produces the equivalent `Schema.Struct` field set; this one produces
 * the columns you spread into `State.SQLite.table({ columns })`.
 *
 * Each emitted column is `{ nullable: true }`. Column DbType is picked per
 * datatype via {@link Datatype.baseDbTypes} (numeric/boolean primitives land
 * in their native SQLite types; everything else lands in `json`). Primitive
 * schemas come from {@link Datatype.baseSchemas}; complex (`json`) columns
 * resolve their schema lazily through the
 * {@link "../schemas/datatype-registry.ts".baseDatatypes | baseDatatypes}
 * registry so they auto-upgrade once a strict schema is registered.
 *
 * No mutual exclusion is enforced at the column level — FHIR's "exactly one"
 * semantics for `value[x]` must be enforced by the caller (matching
 * `ChoiceElementSet.SchemaFields`).
 *
 * @example
 * ```typescript
 * import * as ChoiceElementSet from '../schemas/choice-element-set.ts'
 * import { Columns as ChoiceElementSetColumns } from './choice-element-set-columns.ts'
 *
 * const columns = {
 *   ...DomainResource.columns,
 *   id: State.SQLite.text({ primaryKey: true }),
 *   ...ChoiceElementSetColumns(
 *     'value',
 *     ChoiceElementSet.FhirR4SetChoices['Observation.value[x]']
 *   ),
 * }
 * ```
 *
 * @param prefix - Prefix for each generated column (e.g. `'value'`)
 * @param datatypeNames - Datatypes to fan out into one column each
 */
const Columns = <const Prefix extends string, const DatatypeNames extends readonly Datatype.Name[]>(
  prefix: Prefix,
  datatypeNames: DatatypeNames
): Columns<Prefix, DatatypeNames> =>
  // `Object.fromEntries` widens to `Record<string, …>`; the per-key
  // `ColumnsResult` shape is recovered by construction over (prefix, name)
  // pairs, matching the same pattern used in `ChoiceElementSet.SchemaFields`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment
  Object.fromEntries(
    datatypeNames.map((name) => [ChoiceElement.Name(prefix, name), columnFor(name)])
  ) as unknown as Columns<Prefix, DatatypeNames>

const fhirR4AllDatatypeNames = [
  // Primitive Types
  'base64Binary',
  'boolean',
  'canonical',
  'code',
  'date',
  'dateTime',
  'decimal',
  'id',
  'instant',
  'integer',
  'markdown',
  'oid',
  'positiveInt',
  'string',
  'time',
  'unsignedInt',
  'uri',
  'url',
  'uuid',
  // Data Types
  'Address',
  'Age',
  'Annotation',
  'Attachment',
  'CodeableConcept',
  'Coding',
  'ContactPoint',
  'Count',
  'Distance',
  'Duration',
  'HumanName',
  'Identifier',
  'Money',
  'Period',
  'Quantity',
  'Range',
  'Ratio',
  'Reference',
  'SampledData',
  'Signature',
  'SimpleQuantity',
  'Timing',
  'MetaDataTypes',
  'ContactDetail',
  'Contributor',
  'DataRequirement',
  'Expression',
  'ParameterDefinition',
  'RelatedArtifact',
  'TriggerDefinition',
  'UsageContext',
  // Special Types
  'Dosage',
  'Meta',
] as const

/**
 * Static mapping from FHIR R4 choice element paths (e.g. `'Observation.value[x]'`)
 * to their allowed data type names. Sourced from `https://hl7.org/fhir/R4/choice-elements.json`.
 *
 * @remarks
 * The wildcard `'*'` key lists every data type that can appear in an
 * unconstrained choice element (e.g. `Task.input.value[x]`). Used at
 * build time to derive typed union schemas via {@link ChoiceElementSetSchemaFields}.
 */
const FhirR4Datatypes = {
  '*': fhirR4AllDatatypeNames,
  'ActivityDefinition.product[x]': ['Reference', 'CodeableConcept'],
  'ActivityDefinition.subject[x]': ['CodeableConcept', 'Reference'],
  'ActivityDefinition.timing[x]': ['Timing', 'dateTime', 'Age', 'Period', 'Range', 'Duration'],
  'AllergyIntolerance.onset[x]': ['dateTime', 'Age', 'Period', 'Range', 'string'],
  'Annotation.author[x]': ['Reference', 'string'],
  'AuditEvent.entity.detail.value[x]': ['string', 'base64Binary'],
  'BiologicallyDerivedProduct.collection.collected[x]': ['dateTime', 'Period'],
  'BiologicallyDerivedProduct.manipulation.time[x]': ['dateTime', 'Period'],
  'BiologicallyDerivedProduct.processing.time[x]': ['dateTime', 'Period'],
  'CarePlan.activity.detail.product[x]': ['CodeableConcept', 'Reference'],
  'CarePlan.activity.detail.scheduled[x]': ['Timing', 'Period', 'string'],
  'ChargeItem.occurrence[x]': ['dateTime', 'Period', 'Timing'],
  'ChargeItem.product[x]': ['Reference', 'CodeableConcept'],
  'Claim.accident.location[x]': ['Address', 'Reference'],
  'Claim.diagnosis.diagnosis[x]': ['CodeableConcept', 'Reference'],
  'Claim.item.location[x]': ['CodeableConcept', 'Address', 'Reference'],
  'Claim.item.serviced[x]': ['date', 'Period'],
  'Claim.procedure.procedure[x]': ['CodeableConcept', 'Reference'],
  'Claim.supportingInfo.timing[x]': ['date', 'Period'],
  'Claim.supportingInfo.value[x]': ['boolean', 'string', 'Quantity', 'Attachment', 'Reference'],
  'ClaimResponse.addItem.location[x]': ['CodeableConcept', 'Address', 'Reference'],
  'ClaimResponse.addItem.serviced[x]': ['date', 'Period'],
  'ClinicalImpression.effective[x]': ['dateTime', 'Period'],
  'CodeSystem.concept.property.value[x]': [
    'code',
    'Coding',
    'string',
    'integer',
    'boolean',
    'dateTime',
    'decimal',
  ],
  'Communication.payload.content[x]': ['string', 'Attachment', 'Reference'],
  'CommunicationRequest.occurrence[x]': ['dateTime', 'Period'],
  'CommunicationRequest.payload.content[x]': ['string', 'Attachment', 'Reference'],
  'Composition.relatesTo.target[x]': ['Identifier', 'Reference'],
  'ConceptMap.source[x]': ['uri', 'canonical'],
  'ConceptMap.target[x]': ['uri', 'canonical'],
  'Condition.abatement[x]': ['dateTime', 'Age', 'Period', 'Range', 'string'],
  'Condition.onset[x]': ['dateTime', 'Age', 'Period', 'Range', 'string'],
  'Consent.source[x]': ['Attachment', 'Reference'],
  'Contract.friendly.content[x]': ['Attachment', 'Reference'],
  'Contract.legal.content[x]': ['Attachment', 'Reference'],
  'Contract.legallyBinding[x]': ['Attachment', 'Reference'],
  'Contract.rule.content[x]': ['Attachment', 'Reference'],
  'Contract.term.action.occurrence[x]': ['dateTime', 'Period', 'Timing'],
  'Contract.term.asset.valuedItem.entity[x]': ['CodeableConcept', 'Reference'],
  'Contract.term.offer.answer.value[x]': [
    'boolean',
    'decimal',
    'integer',
    'date',
    'dateTime',
    'time',
    'string',
    'uri',
    'Attachment',
    'Coding',
    'Quantity',
    'Reference',
  ],
  'Contract.term.topic[x]': ['CodeableConcept', 'Reference'],
  'Contract.topic[x]': ['CodeableConcept', 'Reference'],
  'Coverage.costToBeneficiary.value[x]': ['SimpleQuantity', 'Money'],
  'CoverageEligibilityRequest.item.diagnosis.diagnosis[x]': ['CodeableConcept', 'Reference'],
  'CoverageEligibilityRequest.serviced[x]': ['date', 'Period'],
  'CoverageEligibilityResponse.insurance.item.benefit.allowed[x]': [
    'unsignedInt',
    'string',
    'Money',
  ],
  'CoverageEligibilityResponse.insurance.item.benefit.used[x]': ['unsignedInt', 'string', 'Money'],
  'CoverageEligibilityResponse.serviced[x]': ['date', 'Period'],
  'DataRequirement.dateFilter.value[x]': ['dateTime', 'Period', 'Duration'],
  'DataRequirement.subject[x]': ['CodeableConcept', 'Reference'],
  'DetectedIssue.identified[x]': ['dateTime', 'Period'],
  'DeviceDefinition.manufacturer[x]': ['string', 'Reference'],
  'DeviceRequest.code[x]': ['Reference', 'CodeableConcept'],
  'DeviceRequest.occurrence[x]': ['dateTime', 'Period', 'Timing'],
  'DeviceRequest.parameter.value[x]': ['CodeableConcept', 'Quantity', 'Range', 'boolean'],
  'DeviceUseStatement.timing[x]': ['Timing', 'Period', 'dateTime'],
  'DiagnosticReport.effective[x]': ['dateTime', 'Period'],
  'Dosage.asNeeded[x]': ['boolean', 'CodeableConcept'],
  'Dosage.doseAndRate.dose[x]': ['Range', 'SimpleQuantity'],
  'Dosage.doseAndRate.rate[x]': ['Ratio', 'Range', 'SimpleQuantity'],
  'EventDefinition.subject[x]': ['CodeableConcept', 'Reference'],
  'EvidenceVariable.characteristic.definition[x]': [
    'Reference',
    'canonical',
    'CodeableConcept',
    'Expression',
    'DataRequirement',
    'TriggerDefinition',
  ],
  'EvidenceVariable.characteristic.participantEffective[x]': [
    'dateTime',
    'Period',
    'Duration',
    'Timing',
  ],
  'ExplanationOfBenefit.accident.location[x]': ['Address', 'Reference'],
  'ExplanationOfBenefit.addItem.location[x]': ['CodeableConcept', 'Address', 'Reference'],
  'ExplanationOfBenefit.addItem.serviced[x]': ['date', 'Period'],
  'ExplanationOfBenefit.benefitBalance.financial.allowed[x]': ['unsignedInt', 'string', 'Money'],
  'ExplanationOfBenefit.benefitBalance.financial.used[x]': ['unsignedInt', 'Money'],
  'ExplanationOfBenefit.diagnosis.diagnosis[x]': ['CodeableConcept', 'Reference'],
  'ExplanationOfBenefit.item.location[x]': ['CodeableConcept', 'Address', 'Reference'],
  'ExplanationOfBenefit.item.serviced[x]': ['date', 'Period'],
  'ExplanationOfBenefit.procedure.procedure[x]': ['CodeableConcept', 'Reference'],
  'ExplanationOfBenefit.supportingInfo.timing[x]': ['date', 'Period'],
  'ExplanationOfBenefit.supportingInfo.value[x]': [
    'boolean',
    'string',
    'Quantity',
    'Attachment',
    'Reference',
  ],
  'FamilyMemberHistory.age[x]': ['Age', 'Range', 'string'],
  'FamilyMemberHistory.born[x]': ['Period', 'date', 'string'],
  'FamilyMemberHistory.condition.onset[x]': ['Age', 'Range', 'Period', 'string'],
  'FamilyMemberHistory.deceased[x]': ['boolean', 'Age', 'Range', 'date', 'string'],
  'Goal.start[x]': ['date', 'CodeableConcept'],
  'Goal.target.detail[x]': [
    'Quantity',
    'Range',
    'CodeableConcept',
    'string',
    'boolean',
    'integer',
    'Ratio',
  ],
  'Goal.target.due[x]': ['date', 'Duration'],
  'Group.characteristic.value[x]': ['CodeableConcept', 'boolean', 'Quantity', 'Range', 'Reference'],
  'GuidanceResponse.module[x]': ['uri', 'canonical', 'CodeableConcept'],
  'Immunization.occurrence[x]': ['dateTime', 'string'],
  'Immunization.protocolApplied.doseNumber[x]': ['positiveInt', 'string'],
  'Immunization.protocolApplied.seriesDoses[x]': ['positiveInt', 'string'],
  'ImmunizationEvaluation.doseNumber[x]': ['positiveInt', 'string'],
  'ImmunizationEvaluation.seriesDoses[x]': ['positiveInt', 'string'],
  'ImmunizationRecommendation.recommendation.doseNumber[x]': ['positiveInt', 'string'],
  'ImmunizationRecommendation.recommendation.seriesDoses[x]': ['positiveInt', 'string'],
  'ImplementationGuide.definition.page.name[x]': ['url', 'Reference'],
  'ImplementationGuide.definition.resource.example[x]': ['boolean', 'canonical'],
  'ImplementationGuide.manifest.resource.example[x]': ['boolean', 'canonical'],
  'Invoice.lineItem.chargeItem[x]': ['Reference', 'CodeableConcept'],
  'Library.subject[x]': ['CodeableConcept', 'Reference'],
  'Measure.subject[x]': ['CodeableConcept', 'Reference'],
  'Media.created[x]': ['dateTime', 'Period'],
  'Medication.ingredient.item[x]': ['CodeableConcept', 'Reference'],
  'MedicationAdministration.dosage.rate[x]': ['Ratio', 'SimpleQuantity'],
  'MedicationAdministration.effective[x]': ['dateTime', 'Period'],
  'MedicationAdministration.medication[x]': ['CodeableConcept', 'Reference'],
  'MedicationDispense.medication[x]': ['CodeableConcept', 'Reference'],
  'MedicationDispense.statusReason[x]': ['CodeableConcept', 'Reference'],
  'MedicationKnowledge.administrationGuidelines.indication[x]': ['CodeableConcept', 'Reference'],
  'MedicationKnowledge.administrationGuidelines.patientCharacteristics.characteristic[x]': [
    'CodeableConcept',
    'SimpleQuantity',
  ],
  'MedicationKnowledge.drugCharacteristic.value[x]': [
    'CodeableConcept',
    'string',
    'SimpleQuantity',
    'base64Binary',
  ],
  'MedicationKnowledge.ingredient.item[x]': ['CodeableConcept', 'Reference'],
  'MedicationRequest.medication[x]': ['CodeableConcept', 'Reference'],
  'MedicationRequest.reported[x]': ['boolean', 'Reference'],
  'MedicationRequest.substitution.allowed[x]': ['boolean', 'CodeableConcept'],
  'MedicationStatement.effective[x]': ['dateTime', 'Period'],
  'MedicationStatement.medication[x]': ['CodeableConcept', 'Reference'],
  'MedicinalProduct.specialDesignation.indication[x]': ['CodeableConcept', 'Reference'],
  'MedicinalProductAuthorization.procedure.date[x]': ['Period', 'dateTime'],
  'MedicinalProductContraindication.otherTherapy.medication[x]': ['CodeableConcept', 'Reference'],
  'MedicinalProductIndication.otherTherapy.medication[x]': ['CodeableConcept', 'Reference'],
  'MedicinalProductInteraction.interactant.item[x]': ['Reference', 'CodeableConcept'],
  'MessageDefinition.event[x]': ['Coding', 'uri'],
  'MessageHeader.event[x]': ['Coding', 'uri'],
  'NutritionOrder.enteralFormula.administration.rate[x]': ['SimpleQuantity', 'Ratio'],
  'Observation.component.value[x]': [
    'Quantity',
    'CodeableConcept',
    'string',
    'boolean',
    'integer',
    'Range',
    'Ratio',
    'SampledData',
    'time',
    'dateTime',
    'Period',
  ],
  'Observation.effective[x]': ['dateTime', 'Period', 'Timing', 'instant'],
  'Observation.value[x]': [
    'Quantity',
    'CodeableConcept',
    'string',
    'boolean',
    'integer',
    'Range',
    'Ratio',
    'SampledData',
    'time',
    'dateTime',
    'Period',
  ],
  'Patient.deceased[x]': ['boolean', 'dateTime'],
  'Patient.multipleBirth[x]': ['boolean', 'integer'],
  'PlanDefinition.action.definition[x]': ['canonical', 'uri'],
  'PlanDefinition.action.relatedAction.offset[x]': ['Duration', 'Range'],
  'PlanDefinition.action.subject[x]': ['CodeableConcept', 'Reference'],
  'PlanDefinition.action.timing[x]': ['dateTime', 'Age', 'Period', 'Duration', 'Range', 'Timing'],
  'PlanDefinition.goal.target.detail[x]': ['Quantity', 'Range', 'CodeableConcept'],
  'PlanDefinition.subject[x]': ['CodeableConcept', 'Reference'],
  'Population.age[x]': ['Range', 'CodeableConcept'],
  'Procedure.performed[x]': ['dateTime', 'Period', 'string', 'Age', 'Range'],
  'Provenance.occurred[x]': ['Period', 'dateTime'],
  'Questionnaire.item.answerOption.value[x]': [
    'integer',
    'date',
    'time',
    'string',
    'Coding',
    'Reference',
  ],
  'Questionnaire.item.enableWhen.answer[x]': [
    'boolean',
    'decimal',
    'integer',
    'date',
    'dateTime',
    'time',
    'string',
    'Coding',
    'Quantity',
    'Reference',
  ],
  'Questionnaire.item.initial.value[x]': [
    'boolean',
    'decimal',
    'integer',
    'date',
    'dateTime',
    'time',
    'string',
    'uri',
    'Attachment',
    'Coding',
    'Quantity',
    'Reference',
  ],
  'QuestionnaireResponse.item.answer.value[x]': [
    'boolean',
    'decimal',
    'integer',
    'date',
    'dateTime',
    'time',
    'string',
    'uri',
    'Attachment',
    'Coding',
    'Quantity',
    'Reference',
  ],
  'RequestGroup.action.relatedAction.offset[x]': ['Duration', 'Range'],
  'RequestGroup.action.timing[x]': ['dateTime', 'Age', 'Period', 'Duration', 'Range', 'Timing'],
  'ResearchDefinition.subject[x]': ['CodeableConcept', 'Reference'],
  'ResearchElementDefinition.characteristic.definition[x]': [
    'CodeableConcept',
    'canonical',
    'Expression',
    'DataRequirement',
  ],
  'ResearchElementDefinition.characteristic.participantEffective[x]': [
    'dateTime',
    'Period',
    'Duration',
    'Timing',
  ],
  'ResearchElementDefinition.characteristic.studyEffective[x]': [
    'dateTime',
    'Period',
    'Duration',
    'Timing',
  ],
  'ResearchElementDefinition.subject[x]': ['CodeableConcept', 'Reference'],
  'RiskAssessment.occurrence[x]': ['dateTime', 'Period'],
  'RiskAssessment.prediction.probability[x]': ['decimal', 'Range'],
  'RiskAssessment.prediction.when[x]': ['Period', 'Range'],
  'ServiceRequest.asNeeded[x]': ['boolean', 'CodeableConcept'],
  'ServiceRequest.occurrence[x]': ['dateTime', 'Period', 'Timing'],
  'ServiceRequest.quantity[x]': ['Quantity', 'Ratio', 'Range'],
  'Specimen.collection.collected[x]': ['dateTime', 'Period'],
  'Specimen.collection.fastingStatus[x]': ['CodeableConcept', 'Duration'],
  'Specimen.container.additive[x]': ['CodeableConcept', 'Reference'],
  'Specimen.processing.time[x]': ['dateTime', 'Period'],
  'SpecimenDefinition.typeTested.container.additive.additive[x]': ['CodeableConcept', 'Reference'],
  'SpecimenDefinition.typeTested.container.minimumVolume[x]': ['SimpleQuantity', 'string'],
  'StructureMap.group.rule.source.defaultValue[x]': fhirR4AllDatatypeNames,
  'StructureMap.group.rule.target.parameter.value[x]': [
    'id',
    'string',
    'boolean',
    'integer',
    'decimal',
  ],
  'Substance.ingredient.substance[x]': ['CodeableConcept', 'Reference'],
  'SubstanceAmount.amount[x]': ['Quantity', 'Range', 'string'],
  'SubstanceReferenceInformation.target.amount[x]': ['Quantity', 'Range', 'string'],
  'SubstanceSpecification.moiety.amount[x]': ['Quantity', 'string'],
  'SubstanceSpecification.property.amount[x]': ['Quantity', 'string'],
  'SubstanceSpecification.property.definingSubstance[x]': ['Reference', 'CodeableConcept'],
  'SubstanceSpecification.relationship.amount[x]': ['Quantity', 'Range', 'Ratio', 'string'],
  'SubstanceSpecification.relationship.substance[x]': ['Reference', 'CodeableConcept'],
  'SupplyDelivery.occurrence[x]': ['dateTime', 'Period', 'Timing'],
  'SupplyDelivery.suppliedItem.item[x]': ['CodeableConcept', 'Reference'],
  'SupplyRequest.item[x]': ['CodeableConcept', 'Reference'],
  'SupplyRequest.occurrence[x]': ['dateTime', 'Period', 'Timing'],
  'SupplyRequest.parameter.value[x]': ['CodeableConcept', 'Quantity', 'Range', 'boolean'],
  'Task.input.value[x]': fhirR4AllDatatypeNames,
  'Task.output.value[x]': fhirR4AllDatatypeNames,
  'Timing.repeat.bounds[x]': ['Duration', 'Range', 'Period'],
  'TriggerDefinition.timing[x]': ['Timing', 'Reference', 'date', 'dateTime'],
  'UsageContext.value[x]': ['CodeableConcept', 'Quantity', 'Range', 'Reference'],
  'ValueSet.expansion.parameter.value[x]': [
    'string',
    'boolean',
    'integer',
    'decimal',
    'uri',
    'code',
    'dateTime',
  ],
} as const satisfies Record<string, readonly (Datatype.Name | '*')[]>

export {
  ChoiceElementSetSchemaFields as SchemaFields,
  Columns,
  type Empty,
  empty,
  FhirR4Datatypes as FhirR4SetChoices,
}
