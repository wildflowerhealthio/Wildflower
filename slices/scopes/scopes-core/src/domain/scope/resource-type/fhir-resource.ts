/**
 * The FHIR resource type and the `FhirResourceScope` union — shared by both the
 * v1 (`readWrite`) and v2 (`cruds`) grammars.
 */

import BaseResourceType from './resource-type.ts'

/**
 * The FHIR resource type a scope addresses — `*` or a named type. The wildcard is
 * a *live* wildcard: it covers current and future resource types of that context
 * (`spec.md §4`), never a snapshot.
 */
abstract class FhirResourceType extends BaseResourceType {
  supersetOf(other: BaseResourceType): boolean {
    if (!(other instanceof FhirResourceType)) return false
    if (this instanceof FhirResourceType.Wildcard) return true
    if (other instanceof FhirResourceType.Wildcard) return false
    if (this instanceof FhirResourceType.Known && other instanceof FhirResourceType.Known) {
      return this.name === other.name
    }

    return false
  }
}

/**
 * Strict 1:1 FHIR `ResourceType` → display name. Extend as resources surface.
 * Insertion order is the display order everywhere ({@link FhirResourceType.catalog}):
 * the most-used types lead, the rest follow.
 */
const fhirResourceLabels: Readonly<Record<string, { label: string; plural: string }>> = {
  Patient: { label: 'Patient demographics', plural: 'Patient demographics' },
  Observation: { label: 'Observation', plural: 'Observations' },
  MedicationRequest: { label: 'Medication request', plural: 'Medication requests' },
  Appointment: { label: 'Appointment', plural: 'Appointments' },
  Condition: { label: 'Condition', plural: 'Conditions' },
  AllergyIntolerance: { label: 'Allergy', plural: 'Allergies' },
  Immunization: { label: 'Immunization', plural: 'Immunizations' },
  Procedure: { label: 'Procedure', plural: 'Procedures' },
  DiagnosticReport: { label: 'Diagnostic report', plural: 'Diagnostic reports' },
  DocumentReference: { label: 'Document', plural: 'Documents' },
  Encounter: { label: 'Encounter', plural: 'Encounters' },
  CarePlan: { label: 'Care plan', plural: 'Care plans' },
  Goal: { label: 'Goal', plural: 'Goals' },
  MedicationStatement: { label: 'Medication statement', plural: 'Medication statements' },
}

// oxlint-disable import/group-exports
namespace FhirResourceType {
  export class Known extends FhirResourceType {
    kind = 'fhirKnown' as const
    name: string

    constructor(name: string) {
      super()
      this.name = name
    }

    serialize(): string {
      return this.name
    }

    singularLabel(): string {
      return fhirResourceLabels[this.name]?.label ?? this.name
    }

    pluralLabel(): string {
      return fhirResourceLabels[this.name]?.plural ?? this.name
    }

    protected equalityKey(): string {
      return this.name
    }

    static parse(name: string): Known | null {
      return new Known(name)
    }
  }

  export class Wildcard extends FhirResourceType {
    kind = 'fhirWildcard' as const

    serialize(): string {
      return '*'
    }

    singularLabel(): string {
      return 'Any Record'
    }

    pluralLabel(): string {
      // Mid-sentence in the running statements ("Read all medical record
      // types") — specific about what set the wildcard reaches.
      return 'all medical record types'
    }

    protected equalityKey(): string {
      return '*'
    }

    static parse(name: string): Wildcard | null {
      if (name === '*') return new Wildcard()

      return null
    }
  }

  export const parse = (name: string): FhirResourceType | null => {
    const wildcard = Wildcard.parse(name)
    if (wildcard !== null) return wildcard

    const known = Known.parse(name)
    if (known !== null) return known

    return null
  }

  /** The `*` wildcard resource as a shared singleton — prefer this to `parse('*')`. */
  export const wildcardResourceType: FhirResourceType = new Wildcard()

  /**
   * The labelled FHIR resource types the picker renders as rows (`spec.md §4`) — the
   * keys of {@link fhirResourceLabels}, in canonical (insertion) order. The picker's
   * counterpart to {@link WildflowerResourceType.Resource.all}. The `*` wildcard row is
   * added by the grid in open mode (`spec.md §3`) and is deliberately not in the catalog.
   */
  export const catalog: readonly string[] = Object.keys(fhirResourceLabels)
}

export default FhirResourceType
