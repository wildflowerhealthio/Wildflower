import { describe, expect, test } from 'vite-plus/test'

import { descriptionOf } from './description.ts'
import { decode, rexallRequest, shoppersRequest } from './test-helpers.ts'

describe('descriptionOf', () => {
  test('reads the description out of the narrative a source wrote it into', () => {
    // `rexall-be-well-source` writes the description into a free `text.div`.
    // `div` is `xhtml`, so the narrative is markup and the text content is
    // what displays.
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

  test('prefers the description extension over a narrative holding other content', () => {
    // The fixture carries both: the description on the Wildflower extension,
    // and a narrative holding someone else's content, which is not a
    // description of the drug.
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
      dosageInstruction: [{ text: 'do-not-use sig' }],
    })
    expect(descriptionOf(request)).toBe('20 mg - Tablet')
  })
})
