import { CanadianCodingSystem } from 'fhir-r4/data-types'
import { describe, expect, test } from 'vite-plus/test'

import { descriptionOf } from './description.ts'
import { decode, rexallRequest, shoppersRequest } from './test-helpers.ts'

describe('descriptionOf', () => {
  test('reads the description out of the narrative once the extension has been promoted', () => {
    // `rexall-be-well-source` promotes the carebook `description` extension
    // into `text.div` and drops the extension. `div` is `xhtml`, so the
    // promoted narrative is markup and the text content is what displays.
    const promoted = {
      ...rexallRequest,
      contained: [
        {
          ...rexallRequest.contained[0],
          text: {
            status: 'generated',
            div: '<div xmlns="http://www.w3.org/1999/xhtml">5 mg &amp; 10 mg &lt;combo&gt;</div>',
          },
          extension: [],
        },
      ],
    }
    expect(descriptionOf(decode(promoted))).toBe('5 mg & 10 mg <combo>')
  })

  test('prefers the description extension over a narrative the promotion stood down for', () => {
    // The fixture carries both: the extension's richer description and a
    // narrative holding something else. Reading the narrative first would show
    // the drug name the card already displays.
    expect(descriptionOf(decode(rexallRequest))).toBe('20 mg - Tablet')
  })

  test('falls back to the joined dosageInstruction sig', () => {
    const request = decode({
      ...shoppersRequest,
      dosageInstruction: [{ text: 'Take 1 tablet by mouth once daily' }, { text: 'With food' }],
    })
    expect(descriptionOf(request)).toBe('Take 1 tablet by mouth once daily\nWith food')
  })

  test('prefers the contained Medication description over the sig fallback', () => {
    const request = decode({
      ...rexallRequest,
      medicationCodeableConcept: {
        coding: [{ system: CanadianCodingSystem.Din, code: 'DO-NOT-USE' }],
      },
      dosageInstruction: [{ text: 'do-not-use sig' }],
    })
    expect(descriptionOf(request)).toBe('20 mg - Tablet')
  })
})
