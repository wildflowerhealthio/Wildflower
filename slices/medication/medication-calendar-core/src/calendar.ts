import { shiftDay } from './calendar-day.ts'

/** A medication's calendar-relevant fields: the next-fill instant and whether a refill remains. */
interface CalendarMedicationInput {
  readonly id: string
  readonly drugName: string
  readonly prescriber: string | null
  /** Estimated next-fill date as an ISO instant, or `null` when unknown. */
  readonly nextFillDate: string | null
  readonly hasRefill: boolean
}

/**
 * What a derived event marks: a refill `pickup`, an `appointment` to renew, or
 * the day a supply is `exhausted` with no refill left.
 */
type CalendarEventKind = 'pickup' | 'appointment' | 'exhausted'

/**
 * A dated event on the medication calendar. Same-day events of the same kind
 * are merged into one: `medicationIds` carries every contributing medication
 * and `title` reads as one fluent sentence over all of them.
 */
interface CalendarEvent {
  /** The local calendar day (`YYYY-MM-DD`) the event falls on. */
  readonly date: string
  readonly kind: CalendarEventKind
  readonly medicationIds: readonly string[]
  readonly title: string
}

// A raw, per-medication occurrence before same-day same-kind merging. The
// subject is the phrase the merged title lists (a drug name, or a prescriber).
interface Occurrence {
  readonly date: string
  readonly kind: CalendarEventKind
  readonly medicationId: string
  readonly subject: string
}

/** Fluent list join: `"A"`, `"A and B"`, `"A, B and C"`. */
const listPhrase = (items: readonly string[]): string => {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`
}

const titleOf = (kind: CalendarEventKind, subjects: readonly string[]): string => {
  const phrase = listPhrase(subjects)
  if (kind === 'pickup') return `Pickup next refill of ${phrase}`
  if (kind === 'appointment') return `Book appointment with ${phrase}`
  return `Supply exhausted: ${phrase}`
}

// Sort by day, then by kind, for deterministic output regardless of input
// order. Within a merged event, subjects keep input order (dedupe preserves
// first appearance).
const compareEvents = (a: CalendarEvent, b: CalendarEvent): number => {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
  return 0
}

/**
 * Derive the calendar events for a set of medications:
 *
 * - a medication with no `nextFillDate` contributes nothing;
 * - one with a refill left contributes a `pickup` on the next-fill day;
 * - one with no refill left contributes an `appointment` seven days before (to
 *   renew the prescription) and an `exhausted` marker on the day itself.
 *
 * Occurrences of the same kind on the same day merge into a single event whose
 * title lists every subject fluently — `"Pickup next refill of Amoxicillin and
 * Ramipril"`, `"Book appointment with Dr. Rao and your prescriber"` — with
 * repeated subjects (two renewals under one prescriber) collapsed.
 *
 * The next-fill instant is reduced to its local calendar day by taking the date
 * part of the ISO string; the seven-day-before offset is computed in pure
 * calendar-day arithmetic on that day, avoiding time-zone off-by-ones. Events
 * are returned sorted by day then kind.
 */
const deriveCalendarEvents = (
  medications: readonly CalendarMedicationInput[]
): readonly CalendarEvent[] => {
  const occurrences: Occurrence[] = []
  for (const medication of medications) {
    if (medication.nextFillDate === null) continue
    const day = medication.nextFillDate.slice(0, 10)
    if (medication.hasRefill) {
      occurrences.push({
        date: day,
        kind: 'pickup',
        medicationId: medication.id,
        subject: medication.drugName,
      })
    } else {
      occurrences.push({
        date: shiftDay(day, -7),
        kind: 'appointment',
        medicationId: medication.id,
        subject:
          medication.prescriber === null ? 'your prescriber' : `Dr. ${medication.prescriber}`,
      })
      occurrences.push({
        date: day,
        kind: 'exhausted',
        medicationId: medication.id,
        subject: medication.drugName,
      })
    }
  }

  const merged = new Map<string, { occurrence: Occurrence; ids: string[]; subjects: string[] }>()
  for (const occurrence of occurrences) {
    const key = `${occurrence.date}|${occurrence.kind}`
    const bucket = merged.get(key)
    if (bucket === undefined) {
      merged.set(key, {
        occurrence,
        ids: [occurrence.medicationId],
        subjects: [occurrence.subject],
      })
    } else {
      bucket.ids.push(occurrence.medicationId)
      if (!bucket.subjects.includes(occurrence.subject)) bucket.subjects.push(occurrence.subject)
    }
  }

  return [...merged.values()]
    .map(({ occurrence, ids, subjects }): CalendarEvent => ({
      date: occurrence.date,
      kind: occurrence.kind,
      medicationIds: ids,
      title: titleOf(occurrence.kind, subjects),
    }))
    .toSorted(compareEvents)
}

export {
  type CalendarEvent,
  type CalendarEventKind,
  type CalendarMedicationInput,
  deriveCalendarEvents,
}
