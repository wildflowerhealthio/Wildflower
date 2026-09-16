import { Either } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { parsePersonName, parseDicomFile } from './parse-dicom-file.ts'
import { dicomHeaderArb, headerToTagMap, writeDicom } from './test-helpers.ts'

describe('parseDicomFile', () => {
  it('round-trips every field through writeDicom', () => {
    fc.assert(
      fc.property(dicomHeaderArb(), (header) => {
        const bytes = writeDicom(headerToTagMap(header))
        const result = parseDicomFile(bytes)

        expect(Either.isRight(result)).toBe(true)
        if (!Either.isRight(result)) return

        const parsed = result.right

        // Required UIDs
        expect(parsed.studyInstanceUid).toBe(header.studyInstanceUid)
        expect(parsed.seriesInstanceUid).toBe(header.seriesInstanceUid)
        expect(parsed.sopInstanceUid).toBe(header.sopInstanceUid)

        // Patient module
        if (header.patientName !== undefined) {
          expect(parsed.patientName).toBeDefined()
          expect(parsed.patientName!.family).toBe(header.patientName.family)
          expect(parsed.patientName!.given).toBe(header.patientName.given)
        } else {
          expect(parsed.patientName).toBeUndefined()
        }
        expect(parsed.patientId).toBe(header.patientId)
        expect(parsed.issuerOfPatientId).toBe(header.issuerOfPatientId)
        expect(parsed.patientBirthDate).toBe(header.patientBirthDate)
        expect(parsed.patientSex).toBe(header.patientSex)

        // Study module
        expect(parsed.studyDate).toBe(header.studyDate)
        expect(parsed.studyTime).toBe(header.studyTime)
        expect(parsed.studyDescription).toBe(header.studyDescription)
        expect(parsed.accessionNumber).toBe(header.accessionNumber)
        expect(parsed.hasRequestAttributesSequence).toBe(header.hasRequestAttributesSequence)
        expect(parsed.requestedProcedureDescription).toBe(header.requestedProcedureDescription)

        // Series module
        expect(parsed.seriesNumber).toBe(header.seriesNumber)
        expect(parsed.seriesDescription).toBe(header.seriesDescription)
        expect(parsed.modality).toBe(header.modality)
        expect(parsed.bodyPartExamined).toBe(header.bodyPartExamined)

        // Instance module
        expect(parsed.sopClassUid).toBe(header.sopClassUid)
        expect(parsed.instanceNumber).toBe(header.instanceNumber)
        expect(parsed.rows).toBe(header.rows)
        expect(parsed.columns).toBe(header.columns)
        expect(parsed.numberOfFrames).toBe(header.numberOfFrames)

        // Equipment module
        expect(parsed.manufacturer).toBe(header.manufacturer)
        expect(parsed.manufacturerModelName).toBe(header.manufacturerModelName)
        expect(parsed.institutionName).toBe(header.institutionName)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('fails on truncated bytes', () => {
    const result = parseDicomFile(new Uint8Array([0x00, 0x01, 0x02]))
    expect(Either.isLeft(result)).toBe(true)
  })

  it('fails when StudyInstanceUID is missing', () => {
    const bytes = writeDicom({
      // No StudyInstanceUID
      SeriesInstanceUID: '1.2.3.4',
      SOPInstanceUID: '1.2.3.5',
    })
    // Remove the study UID element by parsing and checking
    const result = parseDicomFile(bytes)
    // writeDicom without StudyInstanceUID doesn't write the tag, so it fails
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.reason).toContain('StudyInstanceUID')
    }
  })

  it('fails when SeriesInstanceUID is missing', () => {
    const bytes = writeDicom({
      StudyInstanceUID: '1.2.3.4',
      SOPInstanceUID: '1.2.3.5',
    })
    const result = parseDicomFile(bytes)
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.reason).toContain('SeriesInstanceUID')
    }
  })

  it('fails when SOPInstanceUID is missing', () => {
    const bytes = writeDicom({
      StudyInstanceUID: '1.2.3.4',
      SeriesInstanceUID: '1.2.3.5',
    })
    const result = parseDicomFile(bytes)
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.reason).toContain('SOPInstanceUID')
    }
  })
})

describe('parsePersonName', () => {
  it('splits family^given into parts', () => {
    const result = parsePersonName('Smith^John')
    expect(result).toEqual({ family: 'Smith', given: 'John', text: 'Smith John' })
  })

  it('handles family only (no caret)', () => {
    const result = parsePersonName('Smith')
    expect(result).toEqual({ family: 'Smith', given: '', text: 'Smith' })
  })

  it('handles multiple components separated by carets', () => {
    const result = parsePersonName('Smith^John^M^Dr^Jr')
    expect(result).toEqual({ family: 'Smith', given: 'John', text: 'Smith John M Dr Jr' })
  })

  it('handles empty components (padding carets)', () => {
    const result = parsePersonName('Smith^^')
    expect(result).toEqual({ family: 'Smith', given: '', text: 'Smith' })
  })

  it('returns undefined for empty string', () => {
    expect(parsePersonName('')).toBeUndefined()
  })

  it('returns undefined for whitespace-only string', () => {
    expect(parsePersonName('   ')).toBeUndefined()
  })

  it('returns undefined for a delimiters-only value', () => {
    // What a writer emits for an anonymized or absent name. The trimmed value
    // is not empty, so the empty-string guard alone lets it through — and a
    // `{ family: '', given: '', text: '' }` name would reach FHIR synthesis as
    // `name: [{ text: '' }]`, which FHIR `string` forbids, and would derive the
    // same patient id for every such file.
    expect(parsePersonName('^^^')).toBeUndefined()
    expect(parsePersonName('^')).toBeUndefined()
    expect(parsePersonName(' ^ ^ ')).toBeUndefined()
  })

  it('never returns a name whose text is empty', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({
            maxLength: 8,
            unit: fc.constantFrom(...'abc '.split('')),
          }),
          { maxLength: 6 }
        ),
        (components) => {
          const parsed = parsePersonName(components.join('^'))
          if (parsed === undefined) return
          expect(parsed.text.length).toBeGreaterThan(0)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('trims leading/trailing whitespace from components', () => {
    const result = parsePersonName(' Smith ^ John ')
    expect(result).toEqual({ family: 'Smith', given: 'John', text: 'Smith John' })
  })
})
