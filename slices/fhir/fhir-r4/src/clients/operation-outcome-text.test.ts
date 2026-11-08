import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { operationOutcomeTextOf } from './index.ts'

describe('operationOutcomeTextOf', () => {
  it("should join every issue's details text and diagnostics", () => {
    expect(
      operationOutcomeTextOf({
        resourceType: 'OperationOutcome',
        issue: [
          { details: { text: 'Not allowed' }, diagnostics: 'scope missing' },
          { diagnostics: 'second issue' },
        ],
      })
    ).toEqual(Option.some('Not allowed; scope missing; second issue'))
  })

  it.each([
    ['an OperationOutcome that says nothing', { resourceType: 'OperationOutcome', issue: [{}] }],
    ['another resource', { resourceType: 'Patient', issue: [] }],
    ['no body', undefined],
  ])('should read nothing from %s', (_case, body) => {
    expect(operationOutcomeTextOf(body)).toEqual(Option.none())
  })
})
