import { Scope } from '@wildflowerhealthio/scopes-core'
import { describe, expect, it } from 'vite-plus/test'

import * as RecordAccess from '../record-access.ts'
import * as RecordAccessParagraph from './record-access-paragraph.ts'

/** The access `scopes` (scope strings) grant. */
const accessOf = (...scopes: readonly string[]): RecordAccess.Type =>
  RecordAccess.fromGrantedScopes(scopes.map(Scope.parse))

describe('RecordAccessParagraph.of', () => {
  it.each([
    [
      ['system/*.cruds'],
      "You can read every record type. You can create records of every type. You can change records of every type. Every record you create or change is shown to the person first, and saved only if they approve it. Records are never deleted: to retract one entered by mistake, change its status to entered-in-error (or the type's equivalent) with update_record.",
    ],
    [
      ['system/*.rs', 'patient/Observation.c'],
      "You can read every record type. You can create records of these types and no others: Observation. You can't change existing records. Every record you create or change is shown to the person first, and saved only if they approve it. Records are never deleted: to retract one entered by mistake, change its status to entered-in-error (or the type's equivalent) with update_record.",
    ],
    [['system/*.rs'], "You can read every record type. You can't create or change records."],
    [
      ['patient/Observation.s', 'patient/Condition.r'],
      "You can read these record types and no others: Condition, Observation. You can't create or change records.",
    ],
    [
      ['openid'],
      "You can't read any records: the person didn't grant this app access to them. If they ask about their record, say so, and help with what they tell you. You can't create or change records.",
    ],
  ] as const)('should say what %j allows', (scopes, paragraph) => {
    expect(RecordAccessParagraph.of(accessOf(...scopes))).toBe(paragraph)
  })
})
