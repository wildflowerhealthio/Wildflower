import { Schema } from 'effect'

import { Province } from './province.ts'

/** Which sponsorship program a drug belongs to. */
const SponsorProgram = Schema.Literal('innovicares', 'rxhelp')
type SponsorProgram = typeof SponsorProgram.Type

/** Display labels for each program. */
const sponsorProgramLabels: Readonly<Record<SponsorProgram, string>> = {
  innovicares: 'innoviCares',
  rxhelp: 'RxHelp',
}

/**
 * A sponsored drug, normalized from a program's raw list shape into a single
 * uniform record the matcher and UI both consume. `provinces` is always
 * expanded: a raw entry with no province restriction is stored as
 * {@link allProvinces} so coverage is a simple membership check.
 */
const SponsoredDrug = Schema.Struct({
  sponsor: SponsorProgram,
  /** Stable id within the program (a slug of the brand name). */
  id: Schema.String,
  /** Plain-text brand / trade name, marks stripped (e.g. `"Abilify"`). */
  brandName: Schema.String,
  /** Generic / ingredient name (e.g. `"aripiprazole"`). May be empty. */
  genericName: Schema.String,
  /** Provinces where the program covers this drug (expanded; never empty-means-all). */
  provinces: Schema.Array(Province),
  /** Program brand page, if any. */
  url: Schema.optional(Schema.String),
})
type SponsoredDrug = typeof SponsoredDrug.Type

/**
 * The minimal medication shape the core matches and groups. Adapters map a
 * FHIR `MedicationRequest` (or anything else) onto this — the core stays
 * FHIR-agnostic and trivially testable.
 */
interface Medication {
  readonly id: string
  /** Best available human-readable medication name (used for matching). */
  readonly displayName: string
  /** FHIR `MedicationRequest.status`, if known. */
  readonly status?: string | undefined
  /** ISO date the request was authored, if known. */
  readonly authoredOn?: string | undefined
}

/** Whether this drug's coverage includes the given province. */
const coversProvince = (drug: SponsoredDrug, province: Province): boolean =>
  drug.provinces.includes(province)

export { SponsorProgram, sponsorProgramLabels, SponsoredDrug, coversProvince, type Medication }
