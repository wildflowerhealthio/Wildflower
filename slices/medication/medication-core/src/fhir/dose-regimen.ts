import type { DateTime } from 'effect'
import type { MedicationRequest } from 'fhir-r4/resources'

import { normalizeName } from '../normalize.ts'
import { amortizedDoseOf } from './amortized-dose.ts'
import { displayNameOf } from './display-name.ts'
import { firstDoseOf, type Dose } from './dosage.ts'
import type { MedicationRequestWithId } from './medication-request-with-id.ts'
import { regimenEndOf, regimenStartOf } from './regimen-period.ts'

/**
 * A `MedicationRequest` read as the regimen a chart draws as one step of a
 * medication's dose line: its dose ({@link regimenDoseOf}) over the period it
 * was in effect ({@link regimenStartOf} to {@link regimenEndOf}).
 */

/**
 * `MedicationRequest.status` codes that never yield a regimen: the order was
 * never in effect (`cancelled`, `entered-in-error`), is not yet one (`draft`),
 * or cannot be placed in time (`unknown`).
 */
const EXCLUDED_REGIMEN_STATUSES: ReadonlySet<MedicationRequest.Type['status']> = new Set([
  'cancelled',
  'entered-in-error',
  'draft',
  'unknown',
])

/**
 * The dose a request's regimen plots: the dose its first dosage instruction
 * states ({@link firstDoseOf}), else its dispensed supply amortized into a
 * daily dose ({@link amortizedDoseOf}). A stated dose always wins.
 *
 * @returns `null` when the request states no dose and its supply cannot be
 *   amortized
 */
const regimenDoseOf = (request: MedicationRequest.Type): Dose | null =>
  firstDoseOf(request) ?? amortizedDoseOf(request)

/**
 * One request's dose over the period it was in effect.
 *
 * @remarks
 * `end` is `null` while an `active` request states no end, and never precedes
 * `start`.
 */
interface DoseRegimen extends Dose {
  /** The `MedicationRequest.id` the regimen is read from. */
  readonly requestId: string
  /** The medication's display name — see {@link displayNameOf}. */
  readonly name: string
  /** `name` through `normalizeName`, so successive requests for one drug compare equal. */
  readonly normalizedName: string
  readonly status: MedicationRequest.Type['status']
  readonly start: DateTime.Utc
  readonly end: DateTime.Utc | null
}

/**
 * Where one request lands in {@link medicationRequestsToDoseRegimens}: a
 * `Regimen`, `Undated` (a usable status and dose but no start), or `Dropped`
 * (an excluded status, or no readable dose).
 */
type RegimenDisposition =
  | { readonly _tag: 'Regimen'; readonly regimen: DoseRegimen }
  | { readonly _tag: 'Undated' }
  | { readonly _tag: 'Dropped' }

/** Sort one request into a regimen or the counter it moves — see {@link RegimenDisposition}. */
const regimenDispositionOf = (request: MedicationRequestWithId): RegimenDisposition => {
  if (EXCLUDED_REGIMEN_STATUSES.has(request.status)) return { _tag: 'Dropped' }
  const regimenDose = regimenDoseOf(request)
  if (regimenDose === null) return { _tag: 'Dropped' }
  const regimenStart = regimenStartOf(request)
  if (regimenStart === null) return { _tag: 'Undated' }
  const displayName = displayNameOf(request)
  return {
    _tag: 'Regimen',
    regimen: {
      ...regimenDose,
      requestId: request.id,
      name: displayName,
      normalizedName: normalizeName(displayName),
      status: request.status,
      start: regimenStart,
      end: regimenEndOf(request, regimenStart),
    },
  }
}

/**
 * Read one decoded `MedicationRequest` as a {@link DoseRegimen}.
 *
 * @returns `null` for a status in {@link EXCLUDED_REGIMEN_STATUSES}, a request
 *   with no readable dose ({@link regimenDoseOf}), or one with no start
 *   ({@link regimenStartOf})
 */
const medicationRequestToDoseRegimen = (request: MedicationRequestWithId): DoseRegimen | null => {
  const disposition = regimenDispositionOf(request)
  return disposition._tag === 'Regimen' ? disposition.regimen : null
}

/** The regimens a batch of requests yields, and how many requests yield none. */
interface DoseRegimenBatch {
  /** One regimen per usable request, in input order. */
  readonly regimens: readonly DoseRegimen[]
  /** Requests with a plottable status and dose but no start to place them at. */
  readonly undated: number
  /**
   * Requests that contribute nothing: an excluded status, or no readable dose —
   * none stated and no supply to amortize.
   */
  readonly dropped: number
}

/**
 * Read a bundle's worth of requests as {@link DoseRegimen}s, counting what
 * cannot be read so the UI can say so rather than silently shrinking. Every
 * request moves at most one counter.
 */
const medicationRequestsToDoseRegimens = (
  requests: readonly MedicationRequestWithId[]
): DoseRegimenBatch => {
  const regimens: DoseRegimen[] = []
  let undated = 0
  let dropped = 0
  for (const request of requests) {
    const disposition = regimenDispositionOf(request)
    switch (disposition._tag) {
      case 'Regimen':
        regimens.push(disposition.regimen)
        break
      case 'Undated':
        undated += 1
        break
      case 'Dropped':
        dropped += 1
        break
    }
  }
  return { regimens, undated, dropped }
}

export {
  EXCLUDED_REGIMEN_STATUSES,
  medicationRequestsToDoseRegimens,
  medicationRequestToDoseRegimen,
  regimenDoseOf,
  type DoseRegimen,
  type DoseRegimenBatch,
}
