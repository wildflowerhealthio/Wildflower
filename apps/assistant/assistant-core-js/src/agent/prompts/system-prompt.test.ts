import { DateTime } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { Scope } from '@wildflowerhealthio/scopes-core'

import { onePatientChat } from '../../test-helpers.ts'
import * as RecordAccess from '../record-access.ts'
import { ACADEMIC_VOICE } from './academic-voice.ts'
import * as RecordAccessParagraph from './record-access-paragraph.ts'
import * as SystemPrompt from './system-prompt.ts'
import { TELEHEALTH_VOICE } from './telehealth-voice.ts'

const today = DateTime.unsafeMakeZoned('2026-11-08T22:30:00Z', { timeZone: 'America/Toronto' })
const recordAccess = RecordAccess.fromGrantedScopes([Scope.parse('system/*.cruds')])

describe('SystemPrompt.of', () => {
  it.each([
    ['telehealth', TELEHEALTH_VOICE],
    ['academic', ACADEMIC_VOICE],
  ] as const)(
    'should build the %s prompt from its voice, the patient, the date and what the grant allows',
    (style, voice) => {
      const prompt = SystemPrompt.of({
        style,
        patient: onePatientChat({
          id: 'p1',
          given: 'Ada',
          family: 'Lovelace',
          birthDate: '1815-12-10',
        }),
        today,
        recordAccess,
      })

      expect(prompt.split('\n\n')).toEqual([
        ...voice.split('\n\n'),
        "This chat is about one patient, Ada Lovelace, born 1815-12-10. Their record is Patient/p1. Your tools keep every search, read and write to this patient's records.",
        "Today's date is 2026-11-08.",
        RecordAccessParagraph.of(recordAccess),
      ])
    }
  )

  it('should say when the record gives no birth date', () => {
    const prompt = SystemPrompt.of({
      style: 'telehealth',
      patient: onePatientChat({ id: 'p1', given: 'Ada', family: 'Lovelace' }),
      today,
      recordAccess,
    })

    expect(prompt).toContain(
      'This chat is about one patient, Ada Lovelace, whose record gives no birth date. Their record is Patient/p1.'
    )
  })

  it('should say when the record gives no name', () => {
    const prompt = SystemPrompt.of({
      style: 'telehealth',
      patient: onePatientChat({ id: 'p1', birthDate: '1815-12-10' }),
      today,
      recordAccess,
    })

    expect(prompt).toContain(
      'This chat is about one patient, whose record gives no name, born 1815-12-10.'
    )
  })

  it('should say the chat covers every patient for All patients', () => {
    const prompt = SystemPrompt.of({
      style: 'academic',
      patient: { kind: 'all-patients' },
      today,
      recordAccess,
    })

    expect(prompt).toContain('"All patients", every patient on the server')
    expect(prompt).not.toContain('This chat is about one patient')
  })

  it('should state the date as the zone it is given has it', () => {
    const prompt = SystemPrompt.of({
      style: 'telehealth',
      patient: { kind: 'all-patients' },
      today: DateTime.unsafeMakeZoned('2026-11-09T02:00:00Z', { timeZone: 'America/Toronto' }),
      recordAccess,
    })

    expect(prompt).toContain("Today's date is 2026-11-08.")
  })

  it('should carry the telehealth rules and the academic sample-data reminder', () => {
    expect(TELEHEALTH_VOICE).toContain('not a nurse or a doctor')
    expect(TELEHEALTH_VOICE).toContain('emergency')
    expect(TELEHEALTH_VOICE).toContain("MedicationRequest's requester")
    expect(TELEHEALTH_VOICE).toContain('generalPractitioner')
    expect(TELEHEALTH_VOICE).toContain('read_record')
    expect(ACADEMIC_VOICE).toContain('sample data')
  })
})
