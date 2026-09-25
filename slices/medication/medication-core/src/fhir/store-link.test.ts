import * as fc from 'fast-check'
import type { MedicationRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { storeLinkOf } from './store-link.ts'
import { base, decode } from './test-helpers.ts'

describe('storeLinkOf', () => {
  it('should link to the performer page, read as its display', () => {
    // Arrange
    const request = withPerformer({
      reference: 'https://www.rexall.ca/storelocator/store/8174',
      display: 'Rexall (store 8174)',
    })

    // Act
    const storeLink = storeLinkOf(request)

    // Assert
    expect(storeLink).toEqual({
      url: 'https://www.rexall.ca/storelocator/store/8174',
      label: 'Rexall (store 8174)',
    })
  })

  it('should read the link as its URL when the performer has no display', () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.constantFrom(null, ''), (url, display) => {
        // Arrange
        const request = withPerformer({ reference: url, display })

        // Act
        const storeLink = storeLinkOf(request)

        // Assert
        expect(storeLink).toEqual({ url, label: url })
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should read no store link from a request with no performer', () => {
    // Act
    const storeLink = storeLinkOf(decode(base))

    // Assert
    expect(storeLink).toBeNull()
  })

  it('should never link a performer reference that is not an http(s) web page', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.stringMatching(/^[A-Z][a-z]+\/[A-Za-z0-9-]+$/),
          fc.webUrl().map((url) => url.replace(/^https?:/, 'ftp:')),
          fc.constant('')
        ),
        fc.string(),
        (reference, display) => {
          // Arrange
          const request = withPerformer({ reference, display })

          // Act
          const storeLink = storeLinkOf(request)

          // Assert
          expect(storeLink).toBeNull()
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const withPerformer = (performer: {
  readonly reference: string
  readonly display: string | null
}): MedicationRequest.Type => decode({ ...base, dispenseRequest: { performer } })
