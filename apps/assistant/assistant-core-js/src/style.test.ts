import { DateTime, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { ACADEMIC_VOICE } from './academic-voice.ts'
import * as Style from './style.ts'
import { TELEHEALTH_VOICE } from './telehealth-voice.ts'

const today = DateTime.unsafeMakeZoned('2026-11-08T22:30:00Z', { timeZone: 'America/Toronto' })

describe('Style.systemPromptOf', () => {
  it.each([
    ['telehealth', TELEHEALTH_VOICE],
    ['academic', ACADEMIC_VOICE],
  ] as const)(
    'should build the %s prompt from its voice, the patient, the date and the record access',
    (style, voice) => {
      const prompt = Style.systemPromptOf({
        style,
        patient: {
          kind: 'patient',
          patientId: 'p1',
          name: 'Ada Lovelace',
          birthDate: Option.some('1815-12-10'),
        },
        today,
      })

      expect(prompt.split('\n\n')).toEqual([
        ...voice.split('\n\n'),
        'This chat is about one patient, Ada Lovelace, born 1815-12-10.',
        "Today's date is 2026-11-08.",
        Style.RECORD_ACCESS_PARAGRAPH,
      ])
    }
  )

  it('should say when the record gives no birth date', () => {
    const prompt = Style.systemPromptOf({
      style: 'telehealth',
      patient: { kind: 'patient', patientId: 'p1', name: 'Ada Lovelace', birthDate: Option.none() },
      today,
    })

    expect(prompt).toContain(
      'This chat is about one patient, Ada Lovelace, whose record gives no birth date.'
    )
  })

  it('should say the chat covers every patient for All patients', () => {
    const prompt = Style.systemPromptOf({
      style: 'academic',
      patient: { kind: 'all-patients' },
      today,
    })

    expect(prompt).toContain('"All patients", every patient on the server')
    expect(prompt).not.toContain('This chat is about one patient')
  })

  it('should state the date as the zone it is given has it', () => {
    const prompt = Style.systemPromptOf({
      style: 'telehealth',
      patient: { kind: 'all-patients' },
      today: DateTime.unsafeMakeZoned('2026-11-09T02:00:00Z', { timeZone: 'America/Toronto' }),
    })

    expect(prompt).toContain("Today's date is 2026-11-08.")
  })

  it('should carry the telehealth rules and the academic sample-data reminder', () => {
    expect(TELEHEALTH_VOICE).toContain('not a nurse or a doctor')
    expect(TELEHEALTH_VOICE).toContain('emergency')
    expect(ACADEMIC_VOICE).toContain('sample data')
  })
})
