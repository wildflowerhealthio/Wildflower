import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { type CalendarMedicationInput, deriveCalendarEvents } from './calendar.ts'

const isoInstant = fc
  .date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z') })
  .map((date) => date.toISOString())

const medicationArb: fc.Arbitrary<CalendarMedicationInput> = fc.record({
  id: fc.string({ minLength: 1 }),
  drugName: fc.string({ minLength: 1 }),
  prescriber: fc.oneof(fc.constant<string | null>(null), fc.string({ minLength: 1 })),
  nextFillDate: fc.oneof(fc.constant<string | null>(null), isoInstant),
  hasRefill: fc.boolean(),
})

describe('deriveCalendarEvents', () => {
  test('a medication with no next-fill date contributes no events', () => {
    fc.assert(
      fc.property(medicationArb, (medication) => {
        const events = deriveCalendarEvents([{ ...medication, nextFillDate: null }])
        expect(events).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('a refillable medication contributes one pickup on the next-fill day', () => {
    fc.assert(
      fc.property(medicationArb, isoInstant, (medication, nextFillDate) => {
        const input = { ...medication, nextFillDate, hasRefill: true }
        expect(deriveCalendarEvents([input])).toEqual([
          {
            date: nextFillDate.slice(0, 10),
            kind: 'pickup',
            medicationIds: [input.id],
            title: `Pickup next refill of ${input.drugName}`,
          },
        ])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('a non-refillable medication contributes an appointment and an exhausted marker', () => {
    fc.assert(
      fc.property(medicationArb, isoInstant, (medication, nextFillDate) => {
        const input = { ...medication, nextFillDate, hasRefill: false }
        const events = deriveCalendarEvents([input])
        expect(events).toHaveLength(2)
        const appointment = events.find((event) => event.kind === 'appointment')
        const exhausted = events.find((event) => event.kind === 'exhausted')
        expect(exhausted?.date).toBe(nextFillDate.slice(0, 10))
        expect(exhausted?.title).toBe(`Supply exhausted: ${input.drugName}`)
        const title =
          input.prescriber === null
            ? 'Book appointment with your prescriber'
            : `Book appointment with Dr. ${input.prescriber}`
        expect(appointment?.title).toBe(title)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('the appointment lands exactly seven calendar days before the fill day, across month boundaries', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['2026-03-05T12:00:00Z', '2026-02-26'],
      ['2026-01-03T00:00:00Z', '2025-12-27'],
      ['2026-06-01T00:00:00Z', '2026-05-25'],
      ['2024-03-06T00:00:00Z', '2024-02-28'], // leap-year February
    ]
    for (const [nextFillDate, expected] of cases) {
      const [event] = deriveCalendarEvents([
        { id: 'm', drugName: 'Drug', prescriber: 'Smith', nextFillDate, hasRefill: false },
      ]).filter((entry) => entry.kind === 'appointment')
      expect(event.date).toBe(expected)
    }
  })

  test('merges same-day pickups into one fluently titled event', () => {
    const day = '2026-09-09'
    const pickup = (id: string, drugName: string): CalendarMedicationInput => ({
      id,
      drugName,
      prescriber: null,
      nextFillDate: `${day}T00:00:00Z`,
      hasRefill: true,
    })

    const events = deriveCalendarEvents([
      pickup('a', 'Amoxicillin'),
      pickup('b', 'Ramipril'),
      pickup('c', 'Metformin'),
    ])

    expect(events).toEqual([
      {
        date: day,
        kind: 'pickup',
        medicationIds: ['a', 'b', 'c'],
        title: 'Pickup next refill of Amoxicillin, Ramipril and Metformin',
      },
    ])
  })

  test('merged appointments collapse repeated prescribers and read fluently', () => {
    const nextFillDate = '2026-09-23T00:00:00Z'
    const renewal = (id: string, prescriber: string | null): CalendarMedicationInput => ({
      id,
      drugName: id,
      prescriber,
      nextFillDate,
      hasRefill: false,
    })

    const [appointment] = deriveCalendarEvents([
      renewal('a', 'Rao'),
      renewal('b', 'Rao'),
      renewal('c', null),
    ]).filter((event) => event.kind === 'appointment')

    expect(appointment.medicationIds).toEqual(['a', 'b', 'c'])
    expect(appointment.title).toBe('Book appointment with Dr. Rao and your prescriber')
  })

  test('never emits two events sharing a day and kind', () => {
    fc.assert(
      fc.property(fc.array(medicationArb), (medications) => {
        const events = deriveCalendarEvents(medications)
        const keys = events.map((event) => `${event.date}|${event.kind}`)
        expect(new Set(keys).size).toBe(keys.length)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('preserves every contributing medication id across merged events', () => {
    fc.assert(
      fc.property(fc.array(medicationArb), (medications) => {
        const withDate = medications.filter((medication) => medication.nextFillDate !== null)
        const ids = new Set(withDate.map((medication) => medication.id))
        for (const event of deriveCalendarEvents(medications)) {
          for (const id of event.medicationIds) {
            expect(ids.has(id)).toBe(true)
          }
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('emits events sorted by date then kind', () => {
    fc.assert(
      fc.property(fc.array(medicationArb), (medications) => {
        const events = deriveCalendarEvents(medications)
        for (let index = 1; index < events.length; index += 1) {
          const previous = events[index - 1]
          const current = events[index]
          const ordered =
            previous.date < current.date ||
            (previous.date === current.date && previous.kind <= current.kind)
          expect(ordered).toBe(true)
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
